/**
 * Reveal + settle: the moment the contract, not this backend, decides who won.
 *
 * AGENTS.md §6 is explicit that backend state must never be the authoritative
 * settlement record. Nothing here computes a winner — it opens each bid's
 * commitment on-chain, calls `settle()`, and reports the address the contract
 * returns. The local bid mirror supplies only the nonces, which the chain
 * deliberately cannot know.
 */
import { getAllBids } from "./bids.js";
import { closeBidding, startReveal, settleRoom, getRoom, getProduct } from "./rooms.js";
import { revealBidOnChain, settleOnChain, TARGET_CENTS } from "./contract.js";
import { ALGORAND_ZERO_ADDRESS_STRING } from "@algorandfoundation/algokit-utils";

export class SettlementError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RevealedBid {
  agentId: string;
  address: string;
  guessCents: number;
  /** Absolute distance from the revealed target, in cents. */
  distanceCents: number;
  revealTxId: string;
  isWinner: boolean;
}

export interface SettlementReport {
  targetCents: number;
  /** Winner as returned BY THE CONTRACT. Null when nobody bid. */
  winnerAddress: string | null;
  winnerAgentId: string | null;
  bids: RevealedBid[];
  settleTxIds: string[];
  settleGroupId: string | undefined;
}

const explorer = (txId: string) => `https://lora.algokit.io/testnet/transaction/${txId}`;

/**
 * Drives the room from OPEN to SETTLED.
 *
 * Reveals happen as separate transactions before the settle group because the
 * contract needs each commitment opened first, and packing a variable number
 * of reveals plus settle into one group would hit the AVM's reference limits
 * even faster than settle alone does. Settlement itself — payout, fee, product
 * transfer, and every refund — stays in ONE atomic group, which is what PRD
 * P0-6 actually requires.
 */
export async function revealAndSettle(): Promise<SettlementReport> {
  const room = getRoom();
  if (room.status !== "OPEN") {
    throw new SettlementError("ROOM_NOT_OPEN", `Room cannot be settled from status ${room.status}.`);
  }
  if (room.deadline !== null && Date.now() <= room.deadline) {
    throw new SettlementError("TOO_EARLY", "Bidding deadline has not passed yet.");
  }

  closeBidding();
  startReveal();

  const bids = getAllBids();
  const revealed: Omit<RevealedBid, "isWinner">[] = [];

  for (const bid of bids) {
    try {
      const revealTxId = await revealBidOnChain(bid.address, bid.guessCents, bid.nonceHex);
      console.log(`[reveal] agent=${bid.agentId} guess=${bid.guessCents}c tx=${revealTxId}`);
      revealed.push({
        agentId: bid.agentId,
        address: bid.address,
        guessCents: bid.guessCents,
        distanceCents: Math.abs(bid.guessCents - TARGET_CENTS),
        revealTxId,
      });
    } catch (err) {
      // A bid that can't be opened simply stays unrevealed and is excluded
      // from settlement by the contract — it must not abort everyone else's.
      console.error(`[reveal] agent=${bid.agentId} FAILED:`, err instanceof Error ? err.message : "unknown");
    }
  }

  // One padding call per bidder keeps settle() inside the AVM's resource
  // reference budget (see contract.ts).
  const settlement = await settleOnChain(Math.max(bids.length, 1));

  // The contract returns the zero address when nobody's bid was revealed.
  const winnerAddress =
    settlement.winnerAddress && settlement.winnerAddress !== ALGORAND_ZERO_ADDRESS_STRING
      ? settlement.winnerAddress
      : null;
  const winnerAgentId = revealed.find((r) => r.address === winnerAddress)?.agentId ?? null;

  settleRoom();

  console.log(`[settlement] winner=${winnerAgentId ?? "none"} address=${winnerAddress ?? "none"}`);
  for (const tx of settlement.txIds) console.log(`[settlement] tx=${tx} ${explorer(tx)}`);

  return {
    targetCents: TARGET_CENTS,
    winnerAddress,
    winnerAgentId,
    bids: revealed
      .map((r) => ({ ...r, isWinner: r.address === winnerAddress }))
      .sort((a, b) => a.distanceCents - b.distanceCents),
    settleTxIds: settlement.txIds,
    settleGroupId: settlement.groupId,
  };
}

/** Post-settlement view for the reveal page — safe to expose everything now. */
export function revealView(report: SettlementReport) {
  const product = getProduct();
  return {
    target: TARGET_CENTS / 100,
    productName: product.name,
    winnerAgentId: report.winnerAgentId,
    winnerAddress: report.winnerAddress,
    bids: report.bids.map((b) => ({
      agentId: b.agentId,
      guess: b.guessCents / 100,
      distance: b.distanceCents / 100,
      isWinner: b.isWinner,
      revealTx: explorer(b.revealTxId),
    })),
    settlementTxs: report.settleTxIds.map(explorer),
  };
}
