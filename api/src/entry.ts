// The browser never holds a private key (custodial wallet model, AGENTS.md
// §4) but AGENTS.md's own Phase 4 acceptance test expects a real HTTP
// 402 -> sign -> retry -> 200 round trip against /api/room/:id/enter. This
// module is that round trip's client side: it acts as "the participant's
// agent" using the session's server-held key, via a genuine loopback HTTP
// call to this same process's x402-gated route — not an in-process shortcut,
// so the gated route stays honestly testable by curling it directly (as
// Phase 1's hard gate was), and the settlement path is never duplicated in
// two different code shapes.
import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { AVM_TESTNET_NETWORK, ENTER_ROOM_PATH } from "./x402.js";
import { getSession, getSigningKey } from "./sessions.js";
import { ensureOpenForEntry, hasEntered, getParticipant, recordEntry } from "./rooms.js";
import type { Participant } from "./rooms.js";

const ALGOD_URL = process.env.ALGOD_URL;
if (!ALGOD_URL) throw new Error("ALGOD_URL is not set — see .env.example");

const API_PORT = Number(process.env.API_PORT ?? 4021);
const SELF_URL = `http://localhost:${API_PORT}`;

export class EntryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Guards against a double-click (or any concurrent duplicate call) racing
// past the "already entered" check before the first request has finished
// paying — without this, both could see hasEntered() === false and pay twice.
const pending = new Set<string>();

/**
 * Pays the room's x402 entry fee on behalf of an existing session, using the
 * session's own server-held signing key, and records the resulting
 * participant. The browser never sees a private key or a raw 402 — this is
 * the orchestration layer between "a person clicked Pay & Enter" and the
 * x402-gated resource at ENTER_ROOM_PATH.
 */
export async function enterRoom(sessionId: string): Promise<Participant> {
  const session = getSession(sessionId);
  if (!session) {
    throw new EntryError("SESSION_NOT_FOUND", "No session found. Call POST /api/session first.");
  }

  const existing = getParticipant(sessionId);
  if (existing) {
    return existing;
  }

  if (pending.has(sessionId)) {
    throw new EntryError("ENTRY_IN_PROGRESS", "Entry is already being processed for this session.");
  }
  pending.add(sessionId);

  try {
    if (!hasEntered(sessionId)) {
      try {
        ensureOpenForEntry();
      } catch (err) {
        throw new EntryError("ROOM_NOT_OPEN", err instanceof Error ? err.message : "Room is not accepting entries.");
      }
    }

    const sk = getSigningKey(sessionId);
    if (!sk) {
      // Unreachable in practice — a session always retains its key for the process lifetime.
      throw new EntryError("SESSION_KEY_MISSING", "Session has no signing key on file.");
    }

    const signer = toClientAvmSigner(Buffer.from(sk).toString("base64"));
    const client = new x402Client().register(AVM_TESTNET_NETWORK, new ExactAvmScheme(signer, { algodUrl: ALGOD_URL }));
    const fetchWithPay = wrapFetchWithPayment(fetch, client);

    let response: Response;
    try {
      response = await fetchWithPay(`${SELF_URL}${ENTER_ROOM_PATH}`, { method: "POST" });
    } catch (err) {
      throw new EntryError("PAYMENT_FAILED", err instanceof Error ? err.message : "Entry payment failed.");
    }

    if (response.status !== 200) {
      const body = await response.text().catch(() => "");
      throw new EntryError("PAYMENT_FAILED", `Entry payment did not settle (HTTP ${response.status}). ${body}`.trim());
    }

    const settleHeader = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
    let entryTxId = "unknown";
    if (settleHeader) {
      try {
        const settlement = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf-8"));
        if (settlement.transaction) entryTxId = settlement.transaction;
      } catch {
        // Payment already settled — a header-parsing hiccup shouldn't fail the request over it.
      }
    }

    return recordEntry(sessionId, session.address, session.agentId, entryTxId);
  } finally {
    pending.delete(sessionId);
  }
}
