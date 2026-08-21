import { getRoom } from "./rooms.js";

export interface Bid {
  agentId: string;
  sessionId: string;
  /** The agent's prediction of the hidden target, in dollars. */
  amount: number;
  submittedAt: number;
}

export class BidError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// INTERIM STORAGE. AGENTS.md §6 is explicit that backend state must not be the
// authoritative settlement record — that belongs on-chain. Phase 6/7 moves
// escrow and winner determination into the contract; until then this holds
// bids so Phase 5's agent loop is runnable and testable end to end. The rules
// enforced here (one bid per agent, nothing after the deadline) are the same
// ones the contract must enforce, so they get proven twice rather than moved.
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

export function submitBid(sessionId: string, agentId: string, amount: number): Bid {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BidError("INVALID_BID", `Bid must be a positive number, got ${amount}.`);
  }

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

  const bid: Bid = { agentId, sessionId, amount, submittedAt: Date.now() };
  bids.set(agentId, bid);
  return bid;
}

/** Test-only: clears all recorded bids. */
export function resetBidsForTests(): void {
  bids.clear();
}
