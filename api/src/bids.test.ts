import { beforeEach, describe, expect, it } from "vitest";
import { recordBid, assertCanBid, assertValidGuess, getBid, getAllBids, hasBid, resetBidsForTests } from "./bids.js";
import { closeBidding, openRoom, resetForTests } from "./rooms.js";

beforeEach(() => {
  resetForTests();
  resetBidsForTests();
});

const SAMPLE = {
  sessionId: "s1",
  agentId: "agent-1",
  address: "AAAA",
  guessCents: 2870,
  nonceHex: "ab".repeat(32),
  commitment: "cc".repeat(32),
  txId: "TX1",
};

// These guard the *pre-flight* checks that stop us burning a real transaction
// on a bid the contract would reject anyway. The contract enforces the same
// rules independently and remains the authority — see bids.ts and the
// LocalNet suite in contracts/bidding_room.test.ts.
describe("assertCanBid", () => {
  it("permits a bid while the room is open", () => {
    openRoom(60_000);
    expect(() => assertCanBid("agent-1")).not.toThrow();
  });

  it("rejects a second bid from the same agent — exactly one bid each", () => {
    openRoom(60_000);
    recordBid(SAMPLE);
    expect(() => assertCanBid("agent-1")).toThrow(/already submitted/i);
  });

  it("still permits a different agent to bid", () => {
    openRoom(60_000);
    recordBid(SAMPLE);
    expect(() => assertCanBid("agent-2")).not.toThrow();
  });

  it("rejects a bid before the room has opened", () => {
    expect(() => assertCanBid("agent-1")).toThrow(/not accepting bids/i);
  });

  it("rejects a bid once bidding has closed", () => {
    openRoom(60_000);
    closeBidding();
    expect(() => assertCanBid("agent-1")).toThrow(/not accepting bids/i);
  });

  it("rejects a bid submitted after the deadline", () => {
    openRoom(-1); // deadline already in the past
    expect(() => assertCanBid("agent-1")).toThrow(/deadline has passed/i);
  });
});

describe("assertValidGuess", () => {
  it("rejects non-positive, fractional, and non-finite amounts", () => {
    expect(() => assertValidGuess(0)).toThrow(/positive whole number/i);
    expect(() => assertValidGuess(-5)).toThrow(/positive whole number/i);
    expect(() => assertValidGuess(28.7)).toThrow(/positive whole number/i);
    expect(() => assertValidGuess(Number.NaN)).toThrow(/positive whole number/i);
  });

  it("accepts a positive whole number of cents", () => {
    expect(() => assertValidGuess(2870)).not.toThrow();
  });
});

describe("recordBid", () => {
  it("stores the nonce needed to open the commitment at reveal", () => {
    openRoom(60_000);
    const bid = recordBid(SAMPLE);

    expect(bid).toMatchObject({ agentId: "agent-1", guessCents: 2870, txId: "TX1" });
    expect(getBid("agent-1")?.nonceHex).toBe(SAMPLE.nonceHex);
    expect(hasBid("agent-1")).toBe(true);
    expect(getAllBids()).toHaveLength(1);
  });
});
