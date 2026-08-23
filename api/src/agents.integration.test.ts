import { describe, expect, it } from "vitest";
import { createSession } from "./sessions.js";
import { enterRoom } from "./entry.js";
import { runAgent, resetAgentsForTests } from "./agents.js";
import { getBid, resetBidsForTests } from "./bids.js";
import { getProduct, createRoom, seedDemoProduct, resetForTests, toCents, fromCents } from "./rooms.js";
import { registerRoomChainConfig } from "./contract.js";
import type { PersonaName } from "../../agent/src/brain.js";

// Real testnet: real session funding, a real x402 entry fee each, and a real
// agent-initiated x402 hint purchase for the persona that decides to buy.
// Run with `npm run test:integration`; the api dev server must already be
// running on API_PORT (with the legacy room env vars set — see
// entry.integration.test.ts's module comment), since payments go through a
// real loopback call against that server's own registered "demo-room".
//
// Deliberately TWO agents, not the full three-persona cast. Every testnet
// session permanently locks ~0.2 ALGO in min-balance and the AlgoKit dispenser
// enforces a daily cap, so on-chain tests are a genuinely scarce resource —
// spend them only on what can *only* be proven on-chain. What this test exists
// to prove is that the hint purchase is a real settled payment and that buying
// it changes the outcome, which needs exactly one buyer and one non-buyer.
// That all three personas exist and that the winner is a buyer is proven for
// free, deterministically, in agent/src/brain.test.ts.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — deploy a room and set it in .env (see .env.example)`);
  return v;
}

const ROOM_ID = "demo-room";
// conservative declines the hint (threshold 0.4), balanced buys it (threshold
// 0.6) — the same contrast the old agent-number-derived assignment produced,
// now picked explicitly since persona is a bidder choice, not auto-assigned.
const PERSONAS: PersonaName[] = ["conservative", "balanced"];

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

describe("agent hint purchase (real Algorand testnet)", () => {
  it("has the non-buyer pay nothing, the buyer settle a real $0.05 payment, and land closer", async () => {
    resetForTests();
    resetBidsForTests();
    resetAgentsForTests();
    seedLocalRoom();

    const targetCents = toCents(getProduct(ROOM_ID).hiddenTarget);
    const cast = [];

    for (const persona of PERSONAS) {
      const session = await createSession();
      await enterRoom(ROOM_ID, session.sessionId, persona);
      const agent = await runAgent(ROOM_ID, session.sessionId);
      const bid = getBid(ROOM_ID, agent.agentId);

      expect(agent.status).toBe("bid_submitted");
      expect(bid).toBeDefined();
      cast.push({ agent, distance: Math.abs(bid!.guessCents - targetCents) });
    }

    const [nonBuyer, buyer] = cast;

    expect(nonBuyer.agent.persona).toBe("conservative");
    expect(nonBuyer.agent.hintPurchased).toBe(false);
    expect(nonBuyer.agent.hintTxId).toBeNull();

    // The differentiator: a real settled x402 payment, agent-initiated.
    expect(buyer.agent.persona).toBe("balanced");
    expect(buyer.agent.hintPurchased).toBe(true);
    expect(buyer.agent.hintTxId).toBeTruthy();
    expect(buyer.agent.hintTxId).not.toBe("unknown");

    // Buying information raised its confidence and moved it closer (PRD G4).
    expect(buyer.agent.confidence).toBeGreaterThan(nonBuyer.agent.confidence!);
    expect(buyer.distance).toBeLessThan(nonBuyer.distance);
  });
});
