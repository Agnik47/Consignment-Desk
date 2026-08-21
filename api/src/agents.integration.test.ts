import { describe, expect, it } from "vitest";
import { createSession } from "./sessions.js";
import { enterRoom } from "./entry.js";
import { runAgent, resetAgentsForTests } from "./agents.js";
import { getBid, resetBidsForTests } from "./bids.js";
import { getProduct, resetForTests } from "./rooms.js";

// Real testnet: real session funding, a real x402 entry fee each, and a real
// agent-initiated x402 hint purchase for the persona that decides to buy.
// Run with `npm run test:integration`; the api dev server must already be
// running on API_PORT, since payments go through a real loopback call.
//
// Deliberately TWO agents, not the full three-persona cast. Every testnet
// session permanently locks ~0.2 ALGO in min-balance and the AlgoKit dispenser
// enforces a daily cap, so on-chain tests are a genuinely scarce resource —
// spend them only on what can *only* be proven on-chain. What this test exists
// to prove is that the hint purchase is a real settled payment and that buying
// it changes the outcome, which needs exactly one buyer and one non-buyer.
// That all three personas exist and that the winner is a buyer is proven for
// free, deterministically, in agent/src/brain.test.ts.
describe("agent hint purchase (real Algorand testnet)", () => {
  it("has the non-buyer pay nothing, the buyer settle a real $0.05 payment, and land closer", async () => {
    resetForTests();
    resetBidsForTests();
    resetAgentsForTests();

    const target = getProduct().hiddenTarget;
    const cast = [];

    // agent-1 → conservative (declines the hint), agent-2 → balanced (buys it).
    for (let i = 0; i < 2; i++) {
      const session = await createSession();
      await enterRoom(session.sessionId);
      const agent = await runAgent(session.sessionId);
      const bid = getBid(agent.agentId);

      expect(agent.status).toBe("bid_submitted");
      expect(bid).toBeDefined();
      cast.push({ agent, distance: Math.abs(bid!.amount - target) });
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
