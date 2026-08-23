// The agent's valuation logic. Pure and deterministic by design: no I/O, no
// network, no keys, no clock, no randomness. That keeps it trivially testable,
// keeps the demo reproducible (AGENTS.md Phase 11 — "randomness must not decide
// whether the demo succeeds"), and gives third-party agents a clean seam to
// slot into later (PRD P2-3).
//
// HONESTY NOTE (AGENTS.md Rule 5): this is a scoring function, not an LLM.
// Say that on stage. The autonomous part worth demonstrating is the agent
// deciding, unprompted, that information is worth paying for — not the
// sophistication of the arithmetic below.

export type PersonaName = "conservative" | "balanced" | "aggressive";

export interface Persona {
  name: PersonaName;
  /** Multiplier on the raw estimate — how this persona bids relative to what it actually believes. */
  bias: number;
  /** Buys a hint when confidence falls below this. */
  hintThreshold: number;
  description: string;
}

export const PERSONAS: Record<PersonaName, Persona> = {
  conservative: {
    name: "conservative",
    bias: 0.92,
    hintThreshold: 0.4,
    description: "Guards its budget — won't spend on information, and bids under its own estimate.",
  },
  balanced: {
    name: "balanced",
    bias: 1.0,
    hintThreshold: 0.6,
    description: "Buys information when uncertain, then bids exactly what it believes.",
  },
  aggressive: {
    name: "aggressive",
    bias: 1.04,
    hintThreshold: 0.7,
    description: "Buys information readily and bids above its estimate to win.",
  },
};

export const PERSONA_ORDER: PersonaName[] = ["conservative", "balanced", "aggressive"];

export interface ProductView {
  baseValue: number;
  publicAttributes: Record<string, string | number | boolean>;
}

export interface Hint {
  key: string;
  value: string;
}

// Value adjustments, in dollars, on top of the product's base value.
const CATEGORY_ADJUSTMENTS: Record<string, number> = { Camera: 3 };
const ERA_ADJUSTMENTS: Record<string, number> = { "1970s": 2 };
const SEALED_BOX_ADJUSTMENT = 1.5;
export const CONDITION_ADJUSTMENTS: Record<string, number> = { excellent: 2.2, good: 1.0, fair: -1.0, poor: -3.0 };

// How much of the product's value each driver explains. Sums to 1.0.
// `condition` dominates deliberately: it is the single biggest unknown, and
// it is exactly what the paid hint reveals. That's what makes an agent's
// confidence low enough to be worth spending money to fix.
const DRIVER_WEIGHTS = { category: 0.15, era: 0.1, packaging: 0.1, condition: 0.45, photos: 0.2 } as const;
const PHOTOS_FOR_FULL_CREDIT = 5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Extracts a known condition grade from a hint, or null if the hint isn't one we understand. */
export function parseCondition(hint: Hint | null): string | null {
  if (!hint || hint.key !== "condition") return null;
  const value = hint.value.toLowerCase();
  return Object.keys(CONDITION_ADJUSTMENTS).find((grade) => value.includes(grade)) ?? null;
}

/**
 * How much of the product's value the agent believes it can currently account
 * for, in [0,1]. Low confidence is what justifies spending money on a hint.
 */
export function confidence(product: ProductView, hint: Hint | null = null): number {
  const attrs = product.publicAttributes;
  let score = 0;

  if (typeof attrs.category === "string" && attrs.category in CATEGORY_ADJUSTMENTS) score += DRIVER_WEIGHTS.category;
  if (typeof attrs.era === "string" && attrs.era in ERA_ADJUSTMENTS) score += DRIVER_WEIGHTS.era;
  if (typeof attrs.sealedBox === "boolean") score += DRIVER_WEIGHTS.packaging;
  if (parseCondition(hint)) score += DRIVER_WEIGHTS.condition;

  const photos = typeof attrs.listingPhotos === "number" ? attrs.listingPhotos : 0;
  score += DRIVER_WEIGHTS.photos * (Math.min(photos, PHOTOS_FOR_FULL_CREDIT) / PHOTOS_FOR_FULL_CREDIT);

  return round2(score);
}

/**
 * estimate = baseValue + category + era + packaging + condition, then scaled
 * by the persona's bias. Condition contributes 0 until a hint reveals it —
 * which is precisely why buying the hint moves the number.
 */
export function estimate(product: ProductView, persona: Persona, hint: Hint | null = null): number {
  const attrs = product.publicAttributes;
  let value = product.baseValue;

  if (typeof attrs.category === "string") value += CATEGORY_ADJUSTMENTS[attrs.category] ?? 0;
  if (typeof attrs.era === "string") value += ERA_ADJUSTMENTS[attrs.era] ?? 0;
  if (attrs.sealedBox === true) value += SEALED_BOX_ADJUSTMENT;

  const grade = parseCondition(hint);
  if (grade) value += CONDITION_ADJUSTMENTS[grade];

  return round2(value * persona.bias);
}

/**
 * The decision this whole project exists to demonstrate: is more information
 * worth real money right now? Nobody is asked for approval.
 */
export function shouldBuyHint(product: ProductView, persona: Persona, budget: number, hintCost: number): boolean {
  if (budget < hintCost) return false;
  return confidence(product) < persona.hintThreshold;
}
