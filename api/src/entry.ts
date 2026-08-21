// Orchestrates "a person clicked Pay & Enter": reads the session, pays the
// x402 entry fee on its behalf (see x402client.ts for why that's a real
// loopback call), and records the participant. The gated route itself
// (POST /api/room/:id/enter) stays session-agnostic — its only job is
// "did a real payment settle" — so it remains honestly curl-testable.
import { ENTER_ROOM_PATH } from "./x402.js";
import { payAndFetch, PaymentError } from "./x402client.js";
import { getSession } from "./sessions.js";
import { ensureOpenForEntry, getParticipant, recordEntry } from "./rooms.js";
import type { Participant } from "./rooms.js";

export class EntryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Guards against a double-click (or any concurrent duplicate call) racing past
// the "already entered" check before the first request has finished paying —
// without this, both could see no participant and pay twice.
const pending = new Set<string>();

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
    try {
      ensureOpenForEntry();
    } catch (err) {
      throw new EntryError("ROOM_NOT_OPEN", err instanceof Error ? err.message : "Room is not accepting entries.");
    }

    let entryTxId: string;
    try {
      ({ txId: entryTxId } = await payAndFetch(sessionId, ENTER_ROOM_PATH, { method: "POST" }));
    } catch (err) {
      if (err instanceof PaymentError) throw new EntryError(err.code, err.message);
      throw err;
    }

    console.log(`[entry] session=${sessionId} agent=${session.agentId} fee=$0.50 tx=${entryTxId}`);
    return recordEntry(sessionId, session.address, session.agentId, entryTxId);
  } finally {
    pending.delete(sessionId);
  }
}
