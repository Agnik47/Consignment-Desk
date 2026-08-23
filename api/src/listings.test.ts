import { describe, expect, it } from "vitest";
import { assertValidPriceRange, ListingError } from "./listings.js";

// createListing() itself hits a real Jetson HTTP endpoint and deploys a real
// contract instance — not unit-testable without violating AGENTS.md Rule 2
// (never mock blockchain/network success). What's worth locking down at unit
// level is the seller's price-range validation, which is pure.
describe("assertValidPriceRange", () => {
  it("accepts a valid min <= max range", () => {
    expect(() => assertValidPriceRange(20, 29)).not.toThrow();
  });

  it("accepts min === max", () => {
    expect(() => assertValidPriceRange(25, 25)).not.toThrow();
  });

  it("rejects min > max", () => {
    expect(() => assertValidPriceRange(30, 20)).toThrow(ListingError);
    expect(() => assertValidPriceRange(30, 20)).toThrow(/cannot exceed/);
  });

  it("rejects a non-positive minimum", () => {
    expect(() => assertValidPriceRange(0, 20)).toThrow(/Minimum price/);
    expect(() => assertValidPriceRange(-5, 20)).toThrow(/Minimum price/);
  });

  it("rejects a non-positive maximum", () => {
    expect(() => assertValidPriceRange(10, 0)).toThrow(/Maximum price/);
    expect(() => assertValidPriceRange(10, -5)).toThrow(/Maximum price/);
  });

  it("rejects non-finite values", () => {
    expect(() => assertValidPriceRange(NaN, 20)).toThrow(/Minimum price/);
    expect(() => assertValidPriceRange(10, Infinity)).toThrow(/Maximum price/);
  });

  it("throws with code INVALID_PRICE_RANGE", () => {
    try {
      assertValidPriceRange(30, 20);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ListingError);
      expect((err as ListingError).code).toBe("INVALID_PRICE_RANGE");
    }
  });
});
