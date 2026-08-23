/**
 * Client for deployed BiddingRoom contract instances — one per room (see
 * scripts/deployRoom.ts and listings.ts). This is what makes the contract —
 * not `bids.ts` — the authoritative settlement record (AGENTS.md §6). The
 * backend never decides who won: it reveals commitments, calls `settle()`,
 * and reports whatever address the contract returns.
 */
import { readFileSync } from "node:fs";
import algosdk from "algosdk";
import { AlgorandClient, AppClient } from "@algorandfoundation/algokit-utils";
import type { AddressWithTransactionSigner } from "@algorandfoundation/algokit-utils/transact";
import { getSigningKey } from "./sessions.js";
import { USDC_TESTNET_ASA_ID } from "./chain.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run scripts/deploy-testnet.ts, see .env.example`);
  return v;
}

const USDC_ASA = BigInt(USDC_TESTNET_ASA_ID);

const appSpec = JSON.parse(
  readFileSync(new URL("../../contracts/bidding_room/BiddingRoom.arc56.json", import.meta.url), "utf-8"),
);

export const algorand = AlgorandClient.testNet();

/** The seller/operator account — same key the x402 resource server uses (see chain.ts). One operator across every room. */
export const operator = algorand.account.fromMnemonic(
  algosdk.secretKeyToMnemonic(new Uint8Array(Buffer.from(requireEnv("RESOURCE_SERVER_PRIVATE_KEY"), "base64"))),
);

/**
 * Each room gets its OWN deployed contract app instance (contract.py's state
 * is scoped to exactly one room per app — see scripts/deployRoom.ts's
 * docstring). This registry is what makes every chain-call function below
 * room-scoped instead of pointing at a single global app.
 */
export interface RoomChainConfig {
  appId: bigint;
  productAssetId: bigint;
  targetCents: number;
  targetNonce: string;
  bidStakeMicroUsdc: bigint;
}

const roomConfigs = new Map<string, RoomChainConfig>();

export function registerRoomChainConfig(roomId: string, config: RoomChainConfig): void {
  roomConfigs.set(roomId, config);
}

function requireRoomConfig(roomId: string): RoomChainConfig {
  const config = roomConfigs.get(roomId);
  if (!config) throw new Error(`No on-chain config registered for room ${roomId}.`);
  return config;
}

export function getRoomTargetCents(roomId: string): number {
  return requireRoomConfig(roomId).targetCents;
}

function appClient(roomId: string): AppClient {
  return new AppClient({ algorand, appId: requireRoomConfig(roomId).appId, appSpec });
}

/** Wraps a session's server-held key as a signer this contract client can use. */
function signerFor(sessionId: string): AddressWithTransactionSigner {
  const sk = getSigningKey(sessionId);
  if (!sk) throw new Error(`Session ${sessionId} has no signing key on file.`);
  return algorand.account.fromMnemonic(algosdk.secretKeyToMnemonic(sk));
}

export async function openRoomOnChain(roomId: string, deadlineUnixSeconds: number): Promise<string> {
  const result = await appClient(roomId).send.call({
    method: "open_room",
    args: [deadlineUnixSeconds],
    sender: operator.addr,
    signer: operator.signer,
  });
  return result.txIds[0]!;
}

/**
 * Opts an agent into the product asset.
 *
 * Mandatory before that agent can win: Algorand cannot transfer an ASA to an
 * account without an opt-in slot, so `settle()` would abort with
 * "receiver error: must optin" (found the hard way in Phase 6). Costs the
 * agent 0.1 ALGO of min-balance — the real price of being eligible to win.
 */
export async function optInToProduct(roomId: string, sessionId: string): Promise<void> {
  const { productAssetId } = requireRoomConfig(roomId);
  const signer = signerFor(sessionId);
  const info = await algorand.account.getInformation(signer.addr);
  if (info.assets?.some((a) => a.assetId === productAssetId)) return;
  await algorand.send.assetOptIn({ sender: signer, assetId: productAssetId });
}

/**
 * Opts the seller/operator into a room's product ASA — needed ONLY for
 * settle()'s no-revealed-bids fallback (contract.py returns the unsold item
 * to `self.seller`). Deliberately NOT done eagerly at deploy time: every
 * listing that gets at least one revealed bid never needs this, and it
 * permanently costs the seller 0.1 ALGO of min-balance — real money on a
 * scarce testnet account that also funds every session wallet and every
 * other room's deploy. Called from settlement.ts, and only when the reveal
 * loop actually comes back empty.
 */
export async function ensureSellerOptedIntoProduct(roomId: string): Promise<void> {
  const { productAssetId } = requireRoomConfig(roomId);
  const info = await algorand.account.getInformation(operator.addr);
  if (info.assets?.some((a) => a.assetId === productAssetId)) return;
  await algorand.send.assetOptIn({ sender: operator, assetId: productAssetId });
}

export interface OnChainBid {
  txId: string;
  /** The guess, in integer cents, that this commitment hides. */
  guessCents: number;
  nonceHex: string;
}

/**
 * Submits a real sealed bid: a fixed USDC stake into contract escrow, grouped
 * atomically with the commitment. The guess itself never goes on-chain here —
 * only `sha256(itob(cents) ‖ nonce)`.
 */
export async function commitBidOnChain(
  roomId: string,
  sessionId: string,
  commitmentHex: string,
  guessCents: number,
  nonceHex: string,
): Promise<OnChainBid> {
  const { appId, bidStakeMicroUsdc } = requireRoomConfig(roomId);
  const signer = signerFor(sessionId);

  const stakeTxn = algorand.createTransaction.assetTransfer({
    sender: signer.addr,
    receiver: algosdk.getApplicationAddress(appId).toString(),
    assetId: USDC_ASA,
    amount: bidStakeMicroUsdc,
  });

  const result = await appClient(roomId).send.call({
    method: "commit_bid",
    args: [Buffer.from(commitmentHex, "hex"), stakeTxn],
    sender: signer.addr,
    signer: signer.signer,
  });

  return { txId: result.txIds[result.txIds.length - 1]!, guessCents, nonceHex };
}

export async function revealBidOnChain(roomId: string, bidderAddress: string, guessCents: number, nonceHex: string): Promise<string> {
  const result = await appClient(roomId).send.call({
    method: "reveal_bid",
    args: [bidderAddress, guessCents, Buffer.from(nonceHex, "hex")],
    sender: operator.addr,
    signer: operator.signer,
  });
  return result.txIds[0]!;
}

export interface SettlementResult {
  /** Winner as determined BY THE CONTRACT — never computed in the backend. */
  winnerAddress: string;
  txIds: string[];
  groupId: string | undefined;
}

/**
 * Settles the room atomically and returns the contract's verdict.
 *
 * `paddingCalls` no-op app calls are grouped ahead of `settle()` because a
 * lone settle exceeds the AVM's per-app-call resource-reference limit at ~3
 * bidders — it touches an account plus two boxes per bidder, on top of
 * seller/treasury/winner and two assets. Padding raises the group's combined
 * budget while keeping settlement in ONE atomic group, as PRD P0-6 requires.
 */
export async function settleOnChain(roomId: string, paddingCalls: number): Promise<SettlementResult> {
  const { appId, targetCents, targetNonce } = requireRoomConfig(roomId);
  const client = appClient(roomId);
  const composer = algorand.newGroup();

  for (let i = 0; i < paddingCalls; i++) {
    composer.addAppCallMethodCall({
      appId,
      method: client.getABIMethod("noop"),
      args: [],
      sender: operator.addr,
      signer: operator.signer,
      note: new TextEncoder().encode(`pad-${i}`),
    });
  }

  composer.addAppCallMethodCall({
    appId,
    method: client.getABIMethod("settle"),
    args: [targetCents, Buffer.from(targetNonce, "hex")],
    sender: operator.addr,
    signer: operator.signer,
  });

  const result = await composer.send();
  const returns = result.returns ?? [];
  const winnerAddress = String(returns[returns.length - 1]?.returnValue ?? "");

  return { winnerAddress, txIds: result.txIds, groupId: result.groupId };
}

/** Ensures a session can actually afford to stake, with a clear reason if not. */
export async function assertCanStake(roomId: string, sessionId: string): Promise<void> {
  const { bidStakeMicroUsdc } = requireRoomConfig(roomId);
  const signer = signerFor(sessionId);
  const holding = await algorand.asset.getAccountInformation(signer.addr, USDC_ASA);
  if (holding.balance < bidStakeMicroUsdc) {
    throw new Error(
      `Insufficient USDC to stake: has ${Number(holding.balance) / 1e6}, needs ${Number(bidStakeMicroUsdc) / 1e6}.`,
    );
  }
}
