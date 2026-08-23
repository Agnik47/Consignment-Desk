// Orchestrates "a person clicked Pay & Enter": reads the session, pays the
// x402 entry fee on its behalf (see x402client.ts for why that's a real
// loopback call), and records the participant. The gated route itself
// (POST /api/room/:id/enter) stays session-agnostic — its only job is
// "did a real payment settle" — so it remains honestly curl-testable.
import { enterRoomPath } from "./x402.js";
import { payAndFetch, PaymentError } from "./x402client.js";
import { getSession } from "./sessions.js";
import { ensureOpenForEntry, getParticipant, recordEntry, getRoom } from "./rooms.js";
import { openRoomOnChain } from "./contract.js";
import type { Participant } from "./rooms.js";
import type { PersonaName } from "../../agent/src/brain.js";

export class EntryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Guards against a double-click (or any concurrent duplicate call) racing past
// the "already entered" check before the first request has finished paying —
// without this, both could see no participant and pay twice. Keyed per
// (room, session) since the same browser could in principle enter two
// different rooms.
const pending = new Set<string>();

export async function enterRoom(roomId: string, sessionId: string, persona: PersonaName): Promise<Participant> {
  const session = getSession(sessionId);
  if (!session) {
    throw new EntryError("SESSION_NOT_FOUND", "No session found. Call POST /api/session first.");
  }

  const existing = getParticipant(roomId, sessionId);
  if (existing) {
    return existing;
  }

  const pendingKey = `${roomId}:${sessionId}`;
  if (pending.has(pendingKey)) {
    throw new EntryError("ENTRY_IN_PROGRESS", "Entry is already being processed for this session.");
  }
  pending.add(pendingKey);

  try {
    const wasUnopened = getRoom(roomId).status === "CREATED";
    let room;
    try {
      room = ensureOpenForEntry(
        roomId,
        process.env.BIDDING_WINDOW_MS ? Number(process.env.BIDDING_WINDOW_MS) : undefined,
      );
    } catch (err) {
      throw new EntryError("ROOM_NOT_OPEN", err instanceof Error ? err.message : "Room is not accepting entries.");
    }

    // The backend room and the on-chain room must open together, or the
    // contract rejects every commit_bid with "room is not open for bids".
    if (wasUnopened && room.deadline !== null) {
      try {
        const txId = await openRoomOnChain(roomId, Math.floor(room.deadline / 1000));
        console.log(`[room] room=${roomId} opened on-chain deadline=${room.deadline} tx=${txId}`);
      } catch (err) {
        // A restarted backend resets its in-memory room to CREATED while the
        // deployed contract is already OPEN. That's benign — bidding still
        // works — so log it rather than blocking entry.
        console.warn("[room] on-chain open_room skipped:", err instanceof Error ? err.message : "unknown");
      }
    }

    let entryTxId: string;
    try {
      ({ txId: entryTxId } = await payAndFetch(sessionId, enterRoomPath(roomId), { method: "POST" }));
    } catch (err) {
      if (err instanceof PaymentError) throw new EntryError(err.code, err.message);
      throw err;
    }

    console.log(`[entry] room=${roomId} session=${sessionId} agent=${session.agentId} persona=${persona} fee=$0.50 tx=${entryTxId}`);
    return recordEntry(roomId, sessionId, session.address, session.agentId, entryTxId, persona);
  } finally {
    pending.delete(pendingKey);
  }
}
