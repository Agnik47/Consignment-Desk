import { beforeEach, describe, expect, it } from "vitest";
import {
  closeBidding,
  createCommitment,
  getProduct,
  getPublicView,
  getRoom,
  openRoom,
  resetForTests,
  settleRoom,
  startReveal,
  verifyCommitment,
} from "./rooms.js";

beforeEach(() => {
  resetForTests();
});

describe("commit-reveal", () => {
  it("verifies a correct target and nonce against the commitment", () => {
    const product = getProduct();
    expect(verifyCommitment(product.hiddenTarget, product.targetNonce, product.commitment)).toBe(true);
  });

  it("rejects a tampered target", () => {
    const product = getProduct();
    expect(verifyCommitment(product.hiddenTarget + 1, product.targetNonce, product.commitment)).toBe(false);
  });

  it("rejects a tampered nonce", () => {
    const product = getProduct();
    expect(verifyCommitment(product.hiddenTarget, "not-the-real-nonce", product.commitment)).toBe(false);
  });

  it("produces different commitments for different nonces (no fixed hash reuse)", () => {
    expect(createCommitment(29, "nonce-a")).not.toBe(createCommitment(29, "nonce-b"));
  });
});

describe("public view never leaks the secret", () => {
  it("excludes hiddenTarget and targetNonce structurally, not just by omission at call time", () => {
    const view = getPublicView();
    const serialized = JSON.stringify(view);
    const product = getProduct();

    expect(view.product).not.toHaveProperty("hiddenTarget");
    expect(view.product).not.toHaveProperty("targetNonce");
    expect(view.product).not.toHaveProperty("hint");
    expect(serialized).not.toContain(product.targetNonce);
    expect(serialized).not.toContain(String(product.hiddenTarget));
  });

  it("still surfaces the commitment publicly — that's the point of committing", () => {
    const view = getPublicView();
    expect(view.product.commitment).toBe(getProduct().commitment);
  });
});

describe("room lifecycle", () => {
  it("starts in CREATED with no timing set", () => {
    const room = getRoom();
    expect(room.status).toBe("CREATED");
    expect(room.startTime).toBeNull();
    expect(room.deadline).toBeNull();
  });

  it("walks the full valid sequence", () => {
    openRoom(60_000);
    expect(getRoom().status).toBe("OPEN");
    closeBidding();
    expect(getRoom().status).toBe("BIDDING_CLOSED");
    startReveal();
    expect(getRoom().status).toBe("REVEALING");
    settleRoom();
    expect(getRoom().status).toBe("SETTLED");
  });

  it("sets deadline relative to when the room actually opens, not process boot", () => {
    const before = Date.now();
    const room = openRoom(120_000);
    expect(room.startTime).toBeGreaterThanOrEqual(before);
    expect(room.deadline).toBe((room.startTime as number) + 120_000);
  });

  it("rejects skipping straight to a later state", () => {
    expect(() => closeBidding()).toThrow(/Invalid room transition/);
    expect(() => startReveal()).toThrow(/Invalid room transition/);
    expect(() => settleRoom()).toThrow(/Invalid room transition/);
  });

  it("rejects moving backward", () => {
    openRoom(60_000);
    closeBidding();
    expect(() => openRoom(60_000)).toThrow(/Invalid room transition/);
  });

  it("rejects transitions once SETTLED", () => {
    openRoom(60_000);
    closeBidding();
    startReveal();
    settleRoom();
    expect(() => openRoom(60_000)).toThrow(/Invalid room transition/);
  });
});
