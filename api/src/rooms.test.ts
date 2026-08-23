import { beforeEach, describe, expect, it } from "vitest";
import {
  closeBidding,
  createCommitment,
  createRoom,
  toCents,
  getProduct,
  getPublicView,
  getRoom,
  openRoom,
  resetForTests,
  seedDemoProduct,
  settleRoom,
  startReveal,
  verifyCommitment,
} from "./rooms.js";

const ROOM_ID = "test-room";

beforeEach(() => {
  resetForTests();
  createRoom(ROOM_ID, seedDemoProduct(ROOM_ID, 29, "aa".repeat(32)));
});

describe("commit-reveal", () => {
  it("verifies a correct target and nonce against the commitment", () => {
    const product = getProduct(ROOM_ID);
    expect(verifyCommitment(toCents(product.hiddenTarget), product.targetNonce, product.commitment)).toBe(true);
  });

  it("rejects a tampered target", () => {
    const product = getProduct(ROOM_ID);
    expect(verifyCommitment(toCents(product.hiddenTarget) + 1, product.targetNonce, product.commitment)).toBe(false);
  });

  it("rejects a tampered nonce", () => {
    const product = getProduct(ROOM_ID);
    expect(verifyCommitment(toCents(product.hiddenTarget), "deadbeef".repeat(8), product.commitment)).toBe(false);
  });

  it("produces different commitments for different nonces (no fixed hash reuse)", () => {
    expect(createCommitment(2900, "aa".repeat(32))).not.toBe(createCommitment(2900, "bb".repeat(32)));
  });
});

describe("public view never leaks the secret", () => {
  it("excludes hiddenTarget and targetNonce structurally, not just by omission at call time", () => {
    const view = getPublicView(ROOM_ID);
    const serialized = JSON.stringify(view);
    const product = getProduct(ROOM_ID);

    expect(view.product).not.toHaveProperty("hiddenTarget");
    expect(view.product).not.toHaveProperty("targetNonce");
    expect(view.product).not.toHaveProperty("hint");
    // The 64-hex-char nonce is checked as a substring too: collision odds
    // against the (legitimately public) commitment hash are negligible.
    // hiddenTarget is a short number (e.g. "29") and is NOT checked this way
    // — it can coincidentally appear as a substring of that same hash
    // (caught exactly this: a run with commitment "...d29c44..." false-failed
    // on hiddenTarget=29). The toHaveProperty checks above are the real,
    // reliable guarantee for that field.
    expect(serialized).not.toContain(product.targetNonce);
  });

  it("still surfaces the commitment publicly — that's the point of committing", () => {
    const view = getPublicView(ROOM_ID);
    expect(view.product.commitment).toBe(getProduct(ROOM_ID).commitment);
  });
});

describe("room lifecycle", () => {
  it("starts in CREATED with no timing set", () => {
    const room = getRoom(ROOM_ID);
    expect(room.status).toBe("CREATED");
    expect(room.startTime).toBeNull();
    expect(room.deadline).toBeNull();
  });

  it("walks the full valid sequence", () => {
    openRoom(ROOM_ID, 60_000);
    expect(getRoom(ROOM_ID).status).toBe("OPEN");
    closeBidding(ROOM_ID);
    expect(getRoom(ROOM_ID).status).toBe("BIDDING_CLOSED");
    startReveal(ROOM_ID);
    expect(getRoom(ROOM_ID).status).toBe("REVEALING");
    settleRoom(ROOM_ID);
    expect(getRoom(ROOM_ID).status).toBe("SETTLED");
  });

  it("sets deadline relative to when the room actually opens, not process boot", () => {
    const before = Date.now();
    const room = openRoom(ROOM_ID, 120_000);
    expect(room.startTime).toBeGreaterThanOrEqual(before);
    expect(room.deadline).toBe((room.startTime as number) + 120_000);
  });

  it("rejects skipping straight to a later state", () => {
    expect(() => closeBidding(ROOM_ID)).toThrow(/Invalid room transition/);
    expect(() => startReveal(ROOM_ID)).toThrow(/Invalid room transition/);
    expect(() => settleRoom(ROOM_ID)).toThrow(/Invalid room transition/);
  });

  it("rejects moving backward", () => {
    openRoom(ROOM_ID, 60_000);
    closeBidding(ROOM_ID);
    expect(() => openRoom(ROOM_ID, 60_000)).toThrow(/Invalid room transition/);
  });

  it("rejects transitions once SETTLED", () => {
    openRoom(ROOM_ID, 60_000);
    closeBidding(ROOM_ID);
    startReveal(ROOM_ID);
    settleRoom(ROOM_ID);
    expect(() => openRoom(ROOM_ID, 60_000)).toThrow(/Invalid room transition/);
  });
});
