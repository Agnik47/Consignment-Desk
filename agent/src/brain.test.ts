import { describe, expect, it } from "vitest";
import {
  PERSONAS,
  PERSONA_ORDER,
  confidence,
  estimate,
  parseCondition,
  shouldBuyHint,
  type Hint,
  type ProductView,
} from "./brain.js";

// Mirrors the seeded demo product in api/src/rooms.ts. Kept local so the brain
// stays dependency-free; the demo-outcome test below is what would catch these
// drifting apart in a way that breaks the story.
const PRODUCT: ProductView = {
  baseValue: 20,
  publicAttributes: { category: "Camera", era: "1970s", sealedBox: true, listingPhotos: 3 },
};
const HINT: Hint = { key: "condition", value: "excellent — tested, film advances correctly" };
const HIDDEN_TARGET = 29;
const HINT_COST = 0.05;

describe("parseCondition", () => {
  it("extracts a known grade from the hint's prose", () => {
    expect(parseCondition(HINT)).toBe("excellent");
  });

  it("returns null with no hint, or for a hint about something else", () => {
    expect(parseCondition(null)).toBeNull();
    expect(parseCondition({ key: "colour", value: "excellent" })).toBeNull();
  });

  it("returns null for a condition grade it doesn't recognise", () => {
    expect(parseCondition({ key: "condition", value: "indeterminate" })).toBeNull();
  });
});

describe("confidence", () => {
  it("is lower without the hint than with it", () => {
    expect(confidence(PRODUCT)).toBeLessThan(confidence(PRODUCT, HINT));
  });

  it("attributes the largest single jump to learning the condition", () => {
    const withoutHint = confidence(PRODUCT);
    const withHint = confidence(PRODUCT, HINT);
    expect(withHint - withoutHint).toBeCloseTo(0.45, 5);
  });

  it("credits more listing photos with more confidence", () => {
    const fewPhotos = confidence({ ...PRODUCT, publicAttributes: { ...PRODUCT.publicAttributes, listingPhotos: 1 } });
    const manyPhotos = confidence({ ...PRODUCT, publicAttributes: { ...PRODUCT.publicAttributes, listingPhotos: 5 } });
    expect(manyPhotos).toBeGreaterThan(fewPhotos);
  });

  it("stays within [0,1] even for an unrecognised product", () => {
    const unknown = confidence({ baseValue: 10, publicAttributes: {} });
    expect(unknown).toBeGreaterThanOrEqual(0);
    expect(unknown).toBeLessThanOrEqual(1);
  });
});

describe("estimate", () => {
  it("raises the estimate once the hint reveals excellent condition", () => {
    const persona = PERSONAS.balanced;
    expect(estimate(PRODUCT, persona, HINT)).toBeGreaterThan(estimate(PRODUCT, persona));
  });

  it("orders personas conservative < balanced < aggressive on the same information", () => {
    const low = estimate(PRODUCT, PERSONAS.conservative, HINT);
    const mid = estimate(PRODUCT, PERSONAS.balanced, HINT);
    const high = estimate(PRODUCT, PERSONAS.aggressive, HINT);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("is deterministic — the same inputs always produce the same number", () => {
    const runs = Array.from({ length: 5 }, () => estimate(PRODUCT, PERSONAS.balanced, HINT));
    expect(new Set(runs).size).toBe(1);
  });

  it("falls back to base value plus known adjustments for an unrecognised product", () => {
    expect(estimate({ baseValue: 10, publicAttributes: {} }, PERSONAS.balanced)).toBe(10);
  });
});

describe("shouldBuyHint", () => {
  const budget = 1;

  it("has conservative decline and both others buy — the contrast the demo needs", () => {
    expect(shouldBuyHint(PRODUCT, PERSONAS.conservative, budget, HINT_COST)).toBe(false);
    expect(shouldBuyHint(PRODUCT, PERSONAS.balanced, budget, HINT_COST)).toBe(true);
    expect(shouldBuyHint(PRODUCT, PERSONAS.aggressive, budget, HINT_COST)).toBe(true);
  });

  it("refuses to buy when the agent genuinely cannot afford it", () => {
    expect(shouldBuyHint(PRODUCT, PERSONAS.aggressive, 0.01, HINT_COST)).toBe(false);
  });

  it("buys when it can afford it exactly", () => {
    expect(shouldBuyHint(PRODUCT, PERSONAS.aggressive, HINT_COST, HINT_COST)).toBe(true);
  });

  it("declines once a hint has already made it confident", () => {
    // confidence() with the hint applied exceeds every persona's threshold.
    const informed = confidence(PRODUCT, HINT);
    for (const persona of Object.values(PERSONAS)) {
      expect(informed).toBeGreaterThanOrEqual(persona.hintThreshold);
    }
  });
});

// This is the test that guards the demo's whole point (PRD G4: "the agent that
// bought a hint lands closer to target than one that didn't"). If a heuristic
// tweak ever breaks the story, this fails loudly rather than the failure being
// discovered on stage.
describe("the demo story holds", () => {
  const cast = PERSONA_ORDER.map((name, i) => {
    const persona = PERSONAS[name];
    const buys = shouldBuyHint(PRODUCT, persona, 1, HINT_COST);
    const bid = estimate(PRODUCT, persona, buys ? HINT : null);
    return { agentId: `agent-${i + 1}`, persona, buys, bid, distance: Math.abs(bid - HIDDEN_TARGET) };
  });

  it("has at least one agent buying a hint and at least one not", () => {
    expect(cast.some((a) => a.buys)).toBe(true);
    expect(cast.some((a) => !a.buys)).toBe(true);
  });

  it("is won by an agent that paid for information", () => {
    const winner = [...cast].sort((a, b) => a.distance - b.distance)[0];
    expect(winner.buys).toBe(true);
  });

  it("has every hint-buyer beat every non-buyer", () => {
    const worstBuyer = Math.max(...cast.filter((a) => a.buys).map((a) => a.distance));
    const bestNonBuyer = Math.min(...cast.filter((a) => !a.buys).map((a) => a.distance));
    expect(worstBuyer).toBeLessThan(bestNonBuyer);
  });

  it("would have left each buyer worse off had it skipped the hint", () => {
    for (const agent of cast.filter((a) => a.buys)) {
      const uninformed = Math.abs(estimate(PRODUCT, agent.persona) - HIDDEN_TARGET);
      expect(agent.distance).toBeLessThan(uninformed);
    }
  });

  it("produces no exact ties, so the winner is unambiguous", () => {
    const distances = cast.map((a) => a.distance);
    expect(new Set(distances).size).toBe(distances.length);
  });
});
