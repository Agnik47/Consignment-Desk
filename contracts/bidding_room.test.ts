import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { algo, AppClient, ALGORAND_ZERO_ADDRESS_STRING } from "@algorandfoundation/algokit-utils";
import { deployRoom, loadArc56, chainNow } from "./deploy.js";
import type { DeployedRoom } from "./deploy.js";

// Real LocalNet throughout — contract logic (deadlines, commitments, escrow,
// atomic settlement) is exactly what AGENTS.md Rule 2 says must never be faked.
// `algokit localnet start` must be running. Unlike the testnet suites, these
// cost nothing and aren't dispenser rate-limited.

const TARGET = 29;

// Enough real time to fund/opt-in/bid for several bidders before expiry, but
// short enough that advancePastDeadline() doesn't idle long afterward.
// deployRoom() syncs chain time to wall clock first, so this is genuinely ~N
// seconds rather than an unpredictable number of catch-up jumps.
const GENEROUS_DEADLINE_SECS = 30;

function commitment(value: number, nonceHex: string): Uint8Array {
  // Must match contract.py's _sha256_commitment: sha256(itob(uint64) || nonce).
  const valueBytes = Buffer.alloc(8);
  valueBytes.writeBigUInt64BE(BigInt(value));
  return new Uint8Array(
    crypto.createHash("sha256").update(Buffer.concat([valueBytes, Buffer.from(nonceHex, "hex")])).digest(),
  );
}

function randomNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function client(room: DeployedRoom) {
  return new AppClient({ algorand: room.algorand, appId: room.appId, appSpec: loadArc56() });
}

/**
 * Pushes CHAIN time past a deadline by actively producing blocks.
 *
 * Two things make this necessary, both learned the hard way:
 *  1. The contract reads `Global.latest_timestamp` — the last COMMITTED
 *     block's timestamp — so `setTimeout` advances nothing. LocalNet dev mode
 *     only cuts a block when a transaction arrives.
 *  2. `algorand.network.waitUntilTimestamp` polls *passively*. With no other
 *     traffic on LocalNet no blocks are ever produced, so it waits forever
 *     (every test using it hit its timeout, even for a 2-second deadline).
 *
 * So: send a cheap self-payment per iteration to force a block. Each block
 * takes its timestamp from wall clock, so a chain running behind catches up in
 * large jumps (~25s per block was measured), and once caught up advances
 * roughly in real time. The varying note keeps each transaction unique —
 * identical ones are rejected as "already in ledger".
 */
async function advancePastDeadline(room: DeployedRoom, deadline: number) {
  const dispenser = await room.algorand.account.localNetDispenser();
  for (let i = 0; i < 240; i++) {
    if ((await chainNow(room.algorand)) > deadline) return;
    await room.algorand.send.payment({
      sender: dispenser,
      receiver: dispenser.addr,
      amount: algo(0),
      note: new TextEncoder().encode(`advance-${deadline}-${i}`),
    });
    // Blocks are cut instantly and stamped from wall clock, so once the chain
    // has caught up, spamming blocks advances time by ~0 — real time genuinely
    // has to elapse. Pause between blocks instead of burning CPU on no-ops.
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`chain time never passed ${deadline} (now ${await chainNow(room.algorand)})`);
}

/**
 * A funded bidder, opted into BOTH assets.
 *
 * The product opt-in is not optional bookkeeping — Algorand cannot push an ASA
 * to an account that hasn't opted in, so a bidder who might win must opt into
 * the product asset BEFORE settlement or settle() fails outright with
 * "receiver error: must optin". Every bidder pays 0.1 ALGO of min-balance for
 * that slot; it's the real cost of being eligible to win.
 */
async function createBidder(room: DeployedRoom, usdcAmount = 2n) {
  const dispenser = await room.algorand.account.localNetDispenser();
  const account = room.algorand.account.random();
  await room.algorand.account.ensureFunded(account, dispenser, algo(5));
  await room.algorand.send.assetOptIn({ sender: account, assetId: room.usdcAssetId });
  await room.algorand.send.assetOptIn({ sender: account, assetId: room.productAssetId });
  await room.algorand.send.assetTransfer({
    sender: room.seller,
    receiver: account.addr,
    assetId: room.usdcAssetId,
    amount: room.bidStake * usdcAmount,
  });
  return account;
}

/**
 * Calls settle() in an atomic group padded with no-op app calls.
 *
 * A lone settle() blows the AVM's per-app-call resource-reference cap once
 * there are ~3 bidders (it touches an account + two boxes per bidder, plus
 * seller/treasury/winner and two assets) and fails with "No more transactions
 * below reference limit". Extra app calls in the SAME group raise the combined
 * budget while keeping settlement atomic, as PRD P0-6 requires.
 */
async function settleWithPadding(room: DeployedRoom, c: AppClient, target: number, nonce: string, padding: number) {
  const composer = room.algorand.newGroup();
  const method = (name: string) => c.getABIMethod(name);

  for (let i = 0; i < padding; i++) {
    composer.addAppCallMethodCall({
      appId: room.appId,
      method: method("noop"),
      args: [],
      sender: room.seller.addr,
      signer: room.seller.signer,
      note: new TextEncoder().encode(`pad-${i}`),
    });
  }

  composer.addAppCallMethodCall({
    appId: room.appId,
    method: method("settle"),
    args: [target, Buffer.from(nonce, "hex")],
    sender: room.seller.addr,
    signer: room.seller.signer,
  });

  const result = await composer.send();
  // settle() is the last call in the group, so its ABI return is the last one.
  return result.returns![result.returns!.length - 1]!.returnValue;
}

async function commitBid(room: DeployedRoom, c: AppClient, bidder: Awaited<ReturnType<typeof createBidder>>, guess: number, nonce: string) {
  const stakeTxn = room.algorand.createTransaction.assetTransfer({
    sender: bidder.addr,
    receiver: room.appAddress,
    assetId: room.usdcAssetId,
    amount: room.bidStake,
  });
  return c.send.call({
    method: "commit_bid",
    args: [commitment(guess, nonce), stakeTxn],
    sender: bidder.addr,
    signer: bidder.signer,
  });
}

describe("BiddingRoom contract (real LocalNet)", () => {
  it("closest guess wins: winner gets the item, seller+treasury get paid, losers fully refunded", async () => {
    const nonce = randomNonce();
    const room = await deployRoom({ targetCommitment: commitment(TARGET, nonce) });
    const c = client(room);

    const deadline = (await chainNow(room.algorand)) + GENEROUS_DEADLINE_SECS;
    await c.send.call({ method: "open_room", args: [deadline], sender: room.seller.addr, signer: room.seller.signer });

    const guesses = [
      { guess: 24, nonce: randomNonce() }, // furthest — the "didn't buy a hint" shape
      { guess: 29, nonce: randomNonce() }, // exact — should win
      { guess: 30, nonce: randomNonce() }, // close, not closest
    ];

    const bidders = [];
    for (const g of guesses) {
      const bidder = await createBidder(room);
      await commitBid(room, c, bidder, g.guess, g.nonce);
      bidders.push({ account: bidder, ...g });
    }

    await advancePastDeadline(room, deadline);

    for (const b of bidders) {
      await c.send.call({
        method: "reveal_bid",
        args: [b.account.addr.toString(), b.guess, Buffer.from(b.nonce, "hex")],
        sender: room.seller.addr,
        signer: room.seller.signer,
      });
    }

    // 3 bidders -> pad the group so settle() has enough reference budget.
    const settleReturn = await settleWithPadding(room, c, TARGET, nonce, 3);

    const winner = bidders[1];
    expect(settleReturn).toBe(winner.account.addr.toString());

    // Winner actually holds the product now — ownership transferred on-chain.
    const winnerProduct = await room.algorand.asset.getAccountInformation(winner.account.addr, room.productAssetId);
    expect(winnerProduct.balance).toBe(1n);

    // Winner's stake was consumed (not refunded): started 2x, staked 1x, got 0 back.
    const winnerUsdc = await room.algorand.asset.getAccountInformation(winner.account.addr, room.usdcAssetId);
    expect(winnerUsdc.balance).toBe(room.bidStake);

    // Platform fee reached the treasury.
    const feeAmount = (room.bidStake * room.feeBps) / 10_000n;
    const treasuryUsdc = await room.algorand.asset.getAccountInformation(room.treasury.addr, room.usdcAssetId);
    expect(treasuryUsdc.balance).toBe(feeAmount);

    // Losers made whole — full stake back, net zero.
    for (const loser of [bidders[0], bidders[2]]) {
      const balance = await room.algorand.asset.getAccountInformation(loser.account.addr, room.usdcAssetId);
      expect(balance.balance).toBe(room.bidStake * 2n);
    }
  }, 120_000);

  it("rejects a second bid from the same account", async () => {
    const nonce = randomNonce();
    const room = await deployRoom({ targetCommitment: commitment(TARGET, nonce) });
    const c = client(room);
    const deadline = (await chainNow(room.algorand)) + GENEROUS_DEADLINE_SECS;
    await c.send.call({ method: "open_room", args: [deadline], sender: room.seller.addr, signer: room.seller.signer });

    const bidder = await createBidder(room, 3n);
    await commitBid(room, c, bidder, 20, randomNonce());
    await expect(commitBid(room, c, bidder, 25, randomNonce())).rejects.toThrow();
  }, 60_000);

  it("rejects a bid submitted after the deadline", async () => {
    const nonce = randomNonce();
    const room = await deployRoom({ targetCommitment: commitment(TARGET, nonce) });
    const c = client(room);
    const deadline = (await chainNow(room.algorand)) + 2;
    await c.send.call({ method: "open_room", args: [deadline], sender: room.seller.addr, signer: room.seller.signer });

    const bidder = await createBidder(room);
    await advancePastDeadline(room, deadline);

    await expect(commitBid(room, c, bidder, 20, randomNonce())).rejects.toThrow();
  }, 60_000);

  it("rejects a reveal whose guess/nonce doesn't match the commitment", async () => {
    const nonce = randomNonce();
    const room = await deployRoom({ targetCommitment: commitment(TARGET, nonce) });
    const c = client(room);
    const deadline = (await chainNow(room.algorand)) + GENEROUS_DEADLINE_SECS;
    await c.send.call({ method: "open_room", args: [deadline], sender: room.seller.addr, signer: room.seller.signer });

    const bidder = await createBidder(room);
    const bidNonce = randomNonce();
    await commitBid(room, c, bidder, 27, bidNonce);
    await advancePastDeadline(room, deadline);

    // Same nonce, different guess — must not verify.
    await expect(
      c.send.call({
        method: "reveal_bid",
        args: [bidder.addr.toString(), 99, Buffer.from(bidNonce, "hex")],
        sender: room.seller.addr,
        signer: room.seller.signer,
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("rejects a settle whose target doesn't match the room's commitment", async () => {
    const nonce = randomNonce();
    const room = await deployRoom({ targetCommitment: commitment(TARGET, nonce) });
    const c = client(room);
    const deadline = (await chainNow(room.algorand)) + 2;
    await c.send.call({ method: "open_room", args: [deadline], sender: room.seller.addr, signer: room.seller.signer });
    await advancePastDeadline(room, deadline);

    // Operator tries to claim a different target than the one committed to.
    await expect(
      c.send.call({
        method: "settle",
        args: [99, Buffer.from(nonce, "hex")],
        sender: room.seller.addr,
        signer: room.seller.signer,
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("settles cleanly with no bids at all — the item returns to the seller", async () => {
    const nonce = randomNonce();
    const room = await deployRoom({ targetCommitment: commitment(TARGET, nonce) });
    const c = client(room);

    const deadline = (await chainNow(room.algorand)) + 2;
    await c.send.call({ method: "open_room", args: [deadline], sender: room.seller.addr, signer: room.seller.signer });
    await advancePastDeadline(room, deadline);

    const settleResult = await c.send.call({
      method: "settle",
      args: [TARGET, Buffer.from(nonce, "hex")],
      sender: room.seller.addr,
      signer: room.seller.signer,
    });

    expect(settleResult.return).toBe(ALGORAND_ZERO_ADDRESS_STRING);

    const sellerProduct = await room.algorand.asset.getAccountInformation(room.seller.addr, room.productAssetId);
    expect(sellerProduct.balance).toBe(1n);
  }, 60_000);

  it("breaks a tie by earliest commit — the first equally-close bidder wins", async () => {
    const nonce = randomNonce();
    const room = await deployRoom({ targetCommitment: commitment(TARGET, nonce) });
    const c = client(room);
    const deadline = (await chainNow(room.algorand)) + GENEROUS_DEADLINE_SECS;
    await c.send.call({ method: "open_room", args: [deadline], sender: room.seller.addr, signer: room.seller.signer });

    // Both guess 28 — identical distance from 29.
    const bidders = [];
    for (let i = 0; i < 2; i++) {
      const bidder = await createBidder(room);
      const bidNonce = randomNonce();
      await commitBid(room, c, bidder, 28, bidNonce);
      bidders.push({ account: bidder, guess: 28, nonce: bidNonce });
    }

    await advancePastDeadline(room, deadline);

    for (const b of bidders) {
      await c.send.call({
        method: "reveal_bid",
        args: [b.account.addr.toString(), b.guess, Buffer.from(b.nonce, "hex")],
        sender: room.seller.addr,
        signer: room.seller.signer,
      });
    }

    const settleReturn = await settleWithPadding(room, c, TARGET, nonce, 2);

    expect(settleReturn).toBe(bidders[0].account.addr.toString());
  }, 120_000);
});
