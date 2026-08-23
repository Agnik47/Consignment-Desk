// The agent worker: runs one agent's full decision loop for a room.
//
// DEVIATION FROM AGENTS.md §3, stated rather than hidden: the documented
// layout implies agents run as separate processes. They run as in-process
// workers here instead, because §4 requires wallets stay server-managed and
// the session's signing key never leaves this process — a separate process
// would need either an IPC key bridge or its own unrelated wallet, and §4
// explicitly warns against the latter. tech-stack.md's own wording ("one
// process/worker per persona… no IPC bridge") permits this reading. The pure
// valuation logic still lives in agent/src/brain.ts as documented, imported
// here by relative path so it stays independently testable and reusable.
import {
  PERSONAS,
  confidence,
  estimate,
  shouldBuyHint,
  type Hint,
  type PersonaName,
  type ProductView,
} from "../../agent/src/brain.js";
import { hintPath, HINT_PRICE_USD } from "./x402.js";
import { payAndFetch, PaymentError } from "./x402client.js";
import { getSession } from "./sessions.js";
import crypto from "node:crypto";
import { getParticipant, getProduct, createCommitment, toCents } from "./rooms.js";
import { recordBid, assertCanBid, assertValidGuess, BidError, getBid } from "./bids.js";
import { getUsdcBalance } from "./chain.js";
import { commitBidOnChain, optInToProduct, assertCanStake } from "./contract.js";

export type AgentStatus = "idle" | "analyzing" | "buying_hint" | "thinking" | "bid_submitted" | "failed";

export interface AgentRecord {
  roomId: string;
  agentId: string;
  sessionId: string;
  persona: PersonaName;
  status: AgentStatus;
  confidence: number | null;
  hintPurchased: boolean;
  hintTxId: string | null;
  bidTxId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  updatedAt: number;
}

/** What the room page may show. Deliberately excludes the bid amount — bids are sealed until reveal. */
export interface PublicAgent {
  agentId: string;
  persona: PersonaName;
  personaDescription: string;
  status: AgentStatus;
  confidence: number | null;
  hintPurchased: boolean;
  hintTxId: string | null;
  hasBid: boolean;
  failureCode: string | null;
  failureMessage: string | null;
}

const agents = new Map<string, AgentRecord>();
const running = new Set<string>();

function key(roomId: string, agentId: string): string {
  return `${roomId}:${agentId}`;
}

/** Agent number from an id like "agent-3". Falls back to 1 for anything unexpected. Display ordering only — persona no longer derives from this. */
function agentNumber(agentId: string): number {
  const n = Number(agentId.split("-")[1]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function setStatus(record: AgentRecord, status: AgentStatus, patch: Partial<AgentRecord> = {}): AgentRecord {
  Object.assign(record, patch, { status, updatedAt: Date.now() });
  console.log(`[agent] room=${record.roomId} agent=${record.agentId} persona=${record.persona} status=${status}`);
  return record;
}

export function getAgent(roomId: string, agentId: string): AgentRecord | undefined {
  return agents.get(key(roomId, agentId));
}

export function getPublicAgents(roomId: string): PublicAgent[] {
  return [...agents.values()]
    .filter((a) => a.roomId === roomId)
    .sort((a, b) => agentNumber(a.agentId) - agentNumber(b.agentId))
    .map((a) => ({
      agentId: a.agentId,
      persona: a.persona,
      personaDescription: PERSONAS[a.persona].description,
      status: a.status,
      confidence: a.confidence,
      hintPurchased: a.hintPurchased,
      hintTxId: a.hintTxId,
      hasBid: getBid(roomId, a.agentId) !== undefined,
      failureCode: a.failureCode,
      failureMessage: a.failureMessage,
    }));
}

function ensureAgent(roomId: string, agentId: string, sessionId: string, persona: PersonaName): AgentRecord {
  const k = key(roomId, agentId);
  const existing = agents.get(k);
  if (existing) return existing;
  const record: AgentRecord = {
    roomId,
    agentId,
    sessionId,
    persona,
    status: "idle",
    confidence: null,
    hintPurchased: false,
    hintTxId: null,
    bidTxId: null,
    failureCode: null,
    failureMessage: null,
    updatedAt: Date.now(),
  };
  agents.set(k, record);
  return record;
}

export class AgentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Runs a session's agent end to end:
 *   analyzing → (buying_hint, only when confidence is low) → thinking → bid_submitted
 *
 * Failures are recorded on the agent as a `failed` status with a reason rather
 * than letting the agent silently vanish (AGENTS.md Phase 10).
 */
export async function runAgent(roomId: string, sessionId: string): Promise<AgentRecord> {
  const session = getSession(sessionId);
  if (!session) {
    throw new AgentError("SESSION_NOT_FOUND", "No session found. Call POST /api/session first.");
  }

  const participant = getParticipant(roomId, sessionId);
  if (!participant) {
    throw new AgentError("NOT_ENTERED", "This session has not entered the room. Pay the entry fee first.");
  }

  const { agentId, persona: personaName } = participant;
  if (getBid(roomId, agentId)) {
    throw new AgentError("ALREADY_BID", `Agent ${agentId} has already submitted its one bid.`);
  }
  if (running.has(key(roomId, agentId))) {
    throw new AgentError("AGENT_RUNNING", `Agent ${agentId} is already running.`);
  }
  running.add(key(roomId, agentId));

  const persona = PERSONAS[personaName];
  const record = ensureAgent(roomId, agentId, sessionId, personaName);

  try {
    const product = getProduct(roomId);
    const view: ProductView = { baseValue: product.baseValue, publicAttributes: product.publicAttributes };

    setStatus(record, "analyzing", { confidence: confidence(view), failureCode: null, failureMessage: null });

    // The agent's real spendable budget, read from chain — not a number we
    // made up server-side. An agent that truly can't afford the hint declines
    // for a real reason.
    const budgetUsd = await getUsdcBalance(session.address);

    let hint: Hint | null = null;
    // The decision this whole project exists to show. No human is asked.
    if (shouldBuyHint(view, persona, budgetUsd, HINT_PRICE_USD)) {
      setStatus(record, "buying_hint");
      try {
        const { response, txId } = await payAndFetch(sessionId, hintPath(roomId));
        hint = (await response.json()) as Hint;
        record.hintPurchased = true;
        record.hintTxId = txId;
        console.log(`[x402] room=${roomId} agent=${agentId} resource=hint amount=$${HINT_PRICE_USD.toFixed(2)} tx=${txId}`);
      } catch (err) {
        const message = err instanceof PaymentError ? err.message : "Hint purchase failed.";
        setStatus(record, "failed", { failureCode: "PAYMENT_FAILED", failureMessage: message });
        throw new AgentError("PAYMENT_FAILED", message);
      }
    }

    setStatus(record, "thinking", { confidence: confidence(view, hint) });
    const guessCents = toCents(estimate(view, persona, hint));

    try {
      assertValidGuess(guessCents);
      assertCanBid(roomId, agentId);
      await assertCanStake(roomId, sessionId);

      // Must hold a product-asset slot to be eligible to win — the contract
      // cannot push the ASA to an account that hasn't opted in.
      await optInToProduct(roomId, sessionId);

      // The guess never goes on-chain; only its commitment does.
      const nonceHex = crypto.randomBytes(32).toString("hex");
      const commitment = createCommitment(guessCents, nonceHex);

      const onChain = await commitBidOnChain(roomId, sessionId, commitment, guessCents, nonceHex);

      recordBid({
        roomId,
        sessionId,
        agentId,
        address: participant.address,
        guessCents,
        nonceHex,
        commitment,
        txId: onChain.txId,
      });
      record.bidTxId = onChain.txId;
      console.log(`[bid] room=${roomId} agent=${agentId} commitment=${commitment.slice(0, 16)}… tx=${onChain.txId} hintPurchased=${record.hintPurchased}`);
    } catch (err) {
      const code = err instanceof BidError ? err.code : "BID_REJECTED";
      const message = err instanceof Error ? err.message : "Bid rejected.";
      setStatus(record, "failed", { failureCode: code, failureMessage: message });
      throw new AgentError(code, message);
    }

    return setStatus(record, "bid_submitted");
  } finally {
    running.delete(key(roomId, agentId));
  }
}

/** Test-only: clears all agent records. */
export function resetAgentsForTests(): void {
  agents.clear();
  running.clear();
}
