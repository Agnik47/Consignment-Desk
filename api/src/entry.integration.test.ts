import { describe, expect, it } from "vitest";
import { createSession } from "./sessions.js";
import { enterRoom } from "./entry.js";
import { getRoom, getParticipant, createRoom, seedDemoProduct, resetForTests, fromCents } from "./rooms.js";
import { registerRoomChainConfig } from "./contract.js";

// Real testnet calls throughout: real session funding, then a real x402
// entry-fee payment. Costs real (test) ALGO/USDC and several seconds. Run
// explicitly: `npm run test:integration`.
//
// Prerequisite: the api dev server must already be running on API_PORT, with
// the legacy BIDDING_ROOM_APP_ID/etc. env vars set (see .env.example) — that's
// what makes the dev server register the SAME "demo-room" this test also
// registers locally. entry.ts pays by making a real loopback HTTP call to its
// own x402-gated route (see entry.ts's module comment for why), so there has
// to be a live server, with a matching room, on the other end of it.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — deploy a room and set it in .env (see .env.example)`);
  return v;
}

const ROOM_ID = "demo-room";

function seedLocalRoom(): void {
  const targetCents = Number(requireEnv("DEMO_TARGET_CENTS"));
  const targetNonce = requireEnv("DEMO_TARGET_NONCE");
  createRoom(ROOM_ID, seedDemoProduct(ROOM_ID, fromCents(targetCents), targetNonce));
  registerRoomChainConfig(ROOM_ID, {
    appId: BigInt(requireEnv("BIDDING_ROOM_APP_ID")),
    productAssetId: BigInt(requireEnv("BIDDING_ROOM_PRODUCT_ASA_ID")),
    targetCents,
    targetNonce,
    bidStakeMicroUsdc: BigInt(process.env.BID_STAKE_MICRO_USDC ?? 100_000),
  });
}

describe("enterRoom (real Algorand testnet)", () => {
  it("pays the entry fee, opens the room, and records the participant", async () => {
    resetForTests();
    seedLocalRoom();
    const session = await createSession();

    const participant = await enterRoom(ROOM_ID, session.sessionId, "balanced");

    expect(participant.sessionId).toBe(session.sessionId);
    expect(participant.address).toBe(session.address);
    expect(participant.agentId).toBe(session.agentId);
    expect(participant.persona).toBe("balanced");
    expect(participant.entryTxId).not.toBe("unknown");
    expect(getRoom(ROOM_ID).status).toBe("OPEN");

    // Idempotent re-entry: must not attempt a second payment.
    const again = await enterRoom(ROOM_ID, session.sessionId, "balanced");
    expect(again).toEqual(participant);
    expect(getParticipant(ROOM_ID, session.sessionId)).toEqual(participant);
  });
});
