import { beforeEach, describe, expect, it } from "vitest";
import { submitBid, getBid, getAllBids, hasBid, resetBidsForTests } from "./bids.js";
import { closeBidding, openRoom, resetForTests } from "./rooms.js";

beforeEach(() => {
  resetForTests();
  resetBidsForTests();
});

describe("submitBid", () => {
  it("accepts a valid bid while the room is open", () => {
    openRoom(60_000);
    const bid = submitBid("s1", "agent-1", 28.7);

    expect(bid).toMatchObject({ sessionId: "s1", agentId: "agent-1", amount: 28.7 });
    expect(getBid("agent-1")).toEqual(bid);
    expect(hasBid("agent-1")).toBe(true);
  });

  it("rejects a second bid from the same agent — exactly one bid each", () => {
    openRoom(60_000);
    submitBid("s1", "agent-1", 28.7);

    expect(() => submitBid("s1", "agent-1", 30)).toThrow(/already submitted/i);
    expect(getBid("agent-1")?.amount).toBe(28.7);
    expect(getAllBids()).toHaveLength(1);
  });

  it("still allows a different agent to bid", () => {
    openRoom(60_000);
    submitBid("s1", "agent-1", 24.38);
    submitBid("s2", "agent-2", 28.7);
    expect(getAllBids()).toHaveLength(2);
  });

  it("rejects a bid before the room has opened", () => {
    expect(() => submitBid("s1", "agent-1", 28.7)).toThrow(/not accepting bids/i);
  });

  it("rejects a bid once bidding has closed", () => {
    openRoom(60_000);
    closeBidding();
    expect(() => submitBid("s1", "agent-1", 28.7)).toThrow(/not accepting bids/i);
  });

  it("rejects a bid submitted after the deadline", () => {
    openRoom(-1); // deadline already in the past
    expect(() => submitBid("s1", "agent-1", 28.7)).toThrow(/deadline has passed/i);
  });

  it("rejects non-positive and non-finite amounts", () => {
    openRoom(60_000);
    expect(() => submitBid("s1", "agent-1", 0)).toThrow(/positive number/i);
    expect(() => submitBid("s1", "agent-1", -5)).toThrow(/positive number/i);
    expect(() => submitBid("s1", "agent-1", Number.NaN)).toThrow(/positive number/i);
  });

  it("records a rejected bid nowhere — a failed submit leaves no trace", () => {
    openRoom(60_000);
    expect(() => submitBid("s1", "agent-1", -5)).toThrow();
    expect(hasBid("agent-1")).toBe(false);
    expect(getAllBids()).toHaveLength(0);
  });
});
