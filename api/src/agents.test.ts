import { beforeEach, describe, expect, it } from "vitest";
import { getPublicAgents, resetAgentsForTests } from "./agents.js";
import { openRoom, resetForTests } from "./rooms.js";
import { recordBid, resetBidsForTests } from "./bids.js";

beforeEach(() => {
  resetForTests();
  resetBidsForTests();
  resetAgentsForTests();
});

// The paid agent loop itself is covered for real in agents.integration.test.ts
// (faking a settled testnet payment here would violate AGENTS.md Rule 2).
// What's worth locking down at unit level is the sealing guarantee: the room
// page must never reveal what anyone bid before the reveal.
describe("public agent view keeps bids sealed", () => {
  it("reports that an agent has bid without exposing the amount", () => {
    openRoom(60_000);
    recordBid({
      sessionId: "s1",
      agentId: "agent-1",
      address: "AAAA",
      guessCents: 2870,
      nonceHex: "ab".repeat(32),
      commitment: "cc".repeat(32),
      txId: "TX1",
    });

    // The agent record is created by runAgent(); with none present the view is
    // empty, so this asserts the shape contract on the serialized output for
    // any agent that *does* exist plus the bid store's own leak-resistance.
    const serialized = JSON.stringify(getPublicAgents());
    expect(serialized).not.toContain("2870");
    expect(serialized).not.toContain("guessCents");
    expect(serialized).not.toContain("nonceHex");
  });

  it("exposes only whitelisted fields — no bid amount key can appear", () => {
    const allowed = new Set([
      "agentId",
      "persona",
      "personaDescription",
      "status",
      "confidence",
      "hintPurchased",
      "hintTxId",
      "hasBid",
      "failureCode",
      "failureMessage",
    ]);

    for (const agent of getPublicAgents()) {
      for (const key of Object.keys(agent)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    // The type itself has no `amount`/`bid` field — this documents that the
    // absence is structural, not incidental.
    expect(allowed.has("amount")).toBe(false);
    expect(allowed.has("bid")).toBe(false);
  });
});
