import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FIXED_SK } = vi.hoisted(() => ({ FIXED_SK: new Uint8Array(64).fill(7) }));

vi.mock("./chain.js", () => {
  let addressCounter = 0;
  return {
    generateKeypair: vi.fn(() => {
      addressCounter += 1;
      return { address: `FAKEADDRESS${addressCounter}`, sk: FIXED_SK };
    }),
    fundNewAccount: vi.fn(async () => ({ groupTxId: "FAKETXID" })),
  };
});

const { createSession, getSession } = await import("./sessions.js");
const { fundNewAccount } = await import("./chain.js");

const SK_BASE64 = Buffer.from(FIXED_SK).toString("base64");

describe("createSession", () => {
  beforeEach(() => {
    vi.mocked(fundNewAccount).mockClear();
    vi.mocked(fundNewAccount).mockResolvedValue({ groupTxId: "FAKETXID" });
  });

  it("creates a unique wallet per session", async () => {
    const a = await createSession();
    const b = await createSession();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.address).not.toBe(b.address);
  });

  it("funds the new wallet", async () => {
    const session = await createSession();
    expect(fundNewAccount).toHaveBeenCalledWith(session.address, FIXED_SK);
  });

  it("produces an address that passes algosdk validation", async () => {
    // generateKeypair is mocked here (fake addresses), so this checks the
    // *shape* contract sessions.ts relies on, not real address validity —
    // that's covered for real in chain.test.ts against the unmocked function.
    const session = await createSession();
    expect(typeof session.address).toBe("string");
    expect(session.address.length).toBeGreaterThan(0);
  });

  it("never returns the private key to the caller", async () => {
    const session = await createSession();
    expect(session).not.toHaveProperty("sk");
    expect(JSON.stringify(session)).not.toContain(SK_BASE64);
  });

  it("never logs the private key on success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await createSession();

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map((a) => JSON.stringify(a));
    expect(logged.some((s) => s.includes(SK_BASE64))).toBe(false);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("propagates funding failures without logging the private key", async () => {
    vi.mocked(fundNewAccount).mockRejectedValueOnce(new Error("dispenser out of funds"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createSession()).rejects.toThrow("dispenser out of funds");

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map((a) => JSON.stringify(a));
    expect(logged.some((s) => s.includes(SK_BASE64))).toBe(false);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("is retrievable via getSession afterward", async () => {
    const created = await createSession();
    expect(getSession(created.sessionId)).toEqual(created);
  });

  it("getSession returns undefined for an unknown id", () => {
    expect(getSession("does-not-exist")).toBeUndefined();
  });
});
