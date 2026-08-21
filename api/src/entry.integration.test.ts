import { describe, expect, it } from "vitest";
import { createSession } from "./sessions.js";
import { enterRoom } from "./entry.js";
import { getRoom, getParticipant, resetForTests } from "./rooms.js";

// Real testnet calls throughout: real session funding, then a real x402
// entry-fee payment. Costs real (test) ALGO/USDC and several seconds. Run
// explicitly: `npm run test:integration`.
//
// Prerequisite: the api dev server must already be running on API_PORT.
// entry.ts pays by making a real loopback HTTP call to its own x402-gated
// route (see entry.ts's module comment for why) — this test exercises that
// same loopback, so there has to be a live server on the other end of it.
describe("enterRoom (real Algorand testnet)", () => {
  it("pays the entry fee, opens the room, and records the participant", async () => {
    resetForTests();
    const session = await createSession();

    const participant = await enterRoom(session.sessionId);

    expect(participant.sessionId).toBe(session.sessionId);
    expect(participant.address).toBe(session.address);
    expect(participant.agentId).toBe(session.agentId);
    expect(participant.entryTxId).not.toBe("unknown");
    expect(getRoom().status).toBe("OPEN");

    // Idempotent re-entry: must not attempt a second payment.
    const again = await enterRoom(session.sessionId);
    expect(again).toEqual(participant);
    expect(getParticipant(session.sessionId)).toEqual(participant);
  });
});
