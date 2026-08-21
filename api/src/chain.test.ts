import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { generateKeypair } from "./chain.js";

describe("generateKeypair", () => {
  it("produces a valid Algorand address", () => {
    const { address } = generateKeypair();
    expect(algosdk.isValidAddress(address)).toBe(true);
  });

  it("produces a 64-byte secret key", () => {
    const { sk } = generateKeypair();
    expect(sk).toBeInstanceOf(Uint8Array);
    expect(sk.length).toBe(64);
  });

  it("produces a unique address on every call", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.address).not.toBe(b.address);
  });
});
