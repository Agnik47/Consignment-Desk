import { readFileSync } from "node:fs";
import { AlgorandClient, AppFactory, algo } from "@algorandfoundation/algokit-utils";
import type { Address } from "@algorandfoundation/algokit-utils";
import type { AddressWithTransactionSigner } from "@algorandfoundation/algokit-utils/transact";

export function loadArc56() {
  return JSON.parse(readFileSync(new URL("./bidding_room/BiddingRoom.arc56.json", import.meta.url), "utf-8"));
}

/**
 * The chain's own current time — the last committed block's timestamp, which
 * is exactly what `Global.latest_timestamp` reads inside the contract.
 *
 * Deadlines MUST be derived from this, never from `Date.now()`: LocalNet's
 * chain clock runs well behind wall clock (measured ~70s behind on a freshly
 * started node, catching up a few seconds per block). A wall-clock deadline is
 * therefore far in the chain's future and effectively unreachable.
 */
export async function chainNow(algorand: AlgorandClient): Promise<number> {
  const status = await algorand.client.algod.status();
  const blk = await algorand.client.algod.block(status.lastRound);
  return Number((blk as { block: { header: { timestamp: bigint } } }).block.header.timestamp);
}

/**
 * Drags chain time up to (near) wall clock by producing blocks.
 *
 * A freshly started LocalNet can sit well behind wall clock, and every block
 * it cuts leaps forward to catch up — a single transaction was measured
 * advancing chain time ~25s. That makes any deadline set from `chainNow`
 * wildly unpredictable: a "45 seconds from now" window can be consumed by
 * three setup transactions. Once the chain is caught up, block timestamps
 * track wall clock, so deadlines behave the way a reader expects.
 */
export async function syncChainToWallClock(algorand: AlgorandClient): Promise<void> {
  const dispenser = await algorand.account.localNetDispenser();
  for (let i = 0; i < 40; i++) {
    const drift = Math.floor(Date.now() / 1000) - (await chainNow(algorand));
    if (drift <= 2) return;
    await algorand.send.payment({
      sender: dispenser,
      receiver: dispenser.addr,
      amount: algo(0),
      note: new TextEncoder().encode(`sync-${Date.now()}-${i}`),
    });
  }
}

export interface DeployedRoom {
  algorand: AlgorandClient;
  appId: bigint;
  appAddress: string;
  usdcAssetId: bigint;
  productAssetId: bigint;
  seller: Address & AddressWithTransactionSigner;
  treasury: Address & AddressWithTransactionSigner;
  bidStake: bigint;
  feeBps: bigint;
}

export interface DeployRoomOptions {
  bidStake?: bigint;
  feeBps?: bigint;
  targetCommitment: Uint8Array;
}

/**
 * Deploys a fresh BiddingRoom against LocalNet in three separate steps —
 * NOT one grouped call — because the app's address isn't known (and so can't
 * be paid) until *after* it's created:
 *   1. bare create (runs __init__, app id/address now exist)
 *   2. fund the app account (MBR for base + USDC opt-in + asset creation,
 *      plus headroom for settle()'s inner-transaction fees)
 *   3. bootstrap() — now-fundable ABI call that opts into USDC and mints
 *      the product ASA
 * Does NOT open the room — callers control that so tests can bid against a
 * known deadline.
 */
export async function deployRoom(opts: DeployRoomOptions): Promise<DeployedRoom> {
  const bidStake = opts.bidStake ?? 20_000_000n; // 20.00 test-USDC, matches the demo product's base value
  const feeBps = opts.feeBps ?? 500n; // 5%

  const algorand = AlgorandClient.defaultLocalNet();
  const dispenser = await algorand.account.localNetDispenser();

  const seller = algorand.account.random();
  const treasury = algorand.account.random();
  await algorand.account.ensureFunded(seller, dispenser, algo(10));
  await algorand.account.ensureFunded(treasury, dispenser, algo(10));

  const usdc = await algorand.send.assetCreate({
    sender: seller,
    total: 1_000_000_000_000n,
    decimals: 6,
    assetName: "Test USDC",
    unitName: "tUSDC",
  });
  const usdcAssetId = usdc.confirmation.assetId!;

  const factory = new AppFactory({
    algorand,
    appSpec: loadArc56(),
    defaultSender: seller.addr,
    defaultSigner: seller.signer,
  });

  const { appClient, result: createResult } = await factory.send.bare.create();

  // 0.1 base MBR + 0.1 USDC opt-in + 0.1 asset creation + headroom for
  // settle()'s inner-transaction fees (up to ~7 for a handful of bidders).
  await appClient.fundAppAccount({ amount: algo(1) });

  const bootstrapResult = await appClient.send.call({
    method: "bootstrap",
    args: [
      seller.addr.toString(),
      treasury.addr.toString(),
      usdcAssetId,
      opts.targetCommitment,
      bidStake,
      feeBps,
      "Sealed Vintage Polaroid SX-70",
    ],
  });

  const productAssetId = bootstrapResult.return as bigint;

  // Settlement pushes assets to these accounts, and Algorand cannot transfer
  // an ASA to an account that hasn't opted in — an un-opted-in receiver makes
  // settle() fail outright ("receiver error: must optin"). So the payout
  // targets must hold opt-in slots before any settlement can happen:
  //   - treasury needs USDC to receive the platform fee
  //   - seller needs the product asset to receive the item back if it goes unsold
  // (The seller already holds USDC implicitly, having created that asset.)
  await algorand.send.assetOptIn({ sender: treasury, assetId: usdcAssetId });
  await algorand.send.assetOptIn({ sender: seller, assetId: productAssetId });

  // Leave the chain clock aligned with wall clock so callers' deadlines mean
  // what they say (see syncChainToWallClock).
  await syncChainToWallClock(algorand);

  return {
    algorand,
    appId: createResult.appId,
    appAddress: createResult.appAddress.toString(),
    usdcAssetId,
    productAssetId,
    seller,
    treasury,
    bidStake,
    feeBps,
  };
}
