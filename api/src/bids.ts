import { getRoom } from "./rooms.js";

export interface Bid {
  agentId: string;
  sessionId: string;
  /** Bidder's on-chain address — the identity the contract knows it by. */
  address: string;
  /** The agent's prediction of the hidden target, in integer cents. */
  guessCents: number;
  /** Secret until reveal; needed to open this bid's on-chain commitment. */
  nonceHex: string;
  commitment: string;
  /** Transaction that put this bid + its escrowed stake on chain. */
  txId: string;
  submittedAt: number;
}

export class BidError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// MIRROR, NOT SOURCE OF TRUTH. The authoritative bid record is the contract's
// BoxMap on-chain (AGENTS.md §6) — the contract independently rejects
// duplicate and late bids, and `settle()` alone decides the winner. This map
// exists so the UI and the reveal step know which nonce opens which
// commitment, since the chain deliberately cannot see the guesses.
const bids = new Map<string, Bid>();

export function getBid(agentId: string): Bid | undefined {
  return bids.get(agentId);
}

export function getAllBids(): Bid[] {
  return [...bids.values()];
}

export function hasBid(agentId: string): boolean {
  return bids.has(agentId);
}

export interface RecordBidInput {
  sessionId: string;
  agentId: string;
  address: string;
  guessCents: number;
  nonceHex: string;
  commitment: string;
  txId: string;
}

/**
 * Validates locally, then records a bid that has ALREADY settled on-chain.
 *
 * The checks below duplicate ones the contract enforces itself. That's
 * deliberate, not redundant: catching a closed room or a duplicate bid here
 * fails fast with a readable reason instead of burning a real transaction and
 * surfacing a raw AVM assert. The contract remains the actual authority — if
 * these ever disagree, the contract wins.
 */
export function recordBid(input: RecordBidInput): Bid {
  const bid: Bid = { ...input, submittedAt: Date.now() };
  bids.set(input.agentId, bid);
  return bid;
}

/** Pre-flight guard: throws a readable error before we spend a transaction. */
export function assertCanBid(agentId: string): void {
  const room = getRoom();
  if (room.status !== "OPEN") {
    throw new BidError("BIDDING_CLOSED", `Room is not accepting bids (status: ${room.status}).`);
  }
  if (room.deadline !== null && Date.now() > room.deadline) {
    throw new BidError("LATE_BID", "Bidding deadline has passed.");
  }
  if (bids.has(agentId)) {
    throw new BidError("DUPLICATE_BID", `Agent ${agentId} has already submitted a bid.`);
  }
}

export function assertValidGuess(guessCents: number): void {
  if (!Number.isInteger(guessCents) || guessCents <= 0) {
    throw new BidError("INVALID_BID", `Bid must be a positive whole number of cents, got ${guessCents}.`);
  }
}

/** Test-only: clears all recorded bids. */
export function resetBidsForTests(): void {
  bids.clear();
}
