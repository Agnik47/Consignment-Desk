import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sessions.js", () => ({
  getSession: vi.fn(),
  getSigningKey: vi.fn(),
}));

vi.mock("./contract.js", () => ({ openRoomOnChain: vi.fn() }));

vi.mock("./rooms.js", () => ({
  ensureOpenForEntry: vi.fn(),
  getRoom: vi.fn(() => ({ status: "OPEN", deadline: null })),
  hasEntered: vi.fn(() => false),
  getParticipant: vi.fn(() => undefined),
  recordEntry: vi.fn(),
}));

const { enterRoom, EntryError } = await import("./entry.js");
const { getSession } = await import("./sessions.js");
const { ensureOpenForEntry, getParticipant } = await import("./rooms.js");

const ROOM_ID = "test-room";
const PERSONA = "balanced" as const;

// These cover every early-exit path in enterRoom() that returns or throws
// before touching the x402 client / algod — i.e. before any real network
// call would be needed. The paid happy path is covered for real in
// entry.integration.test.ts; faking a signed testnet payment here would
// violate AGENTS.md Rule 2 for no real benefit over the real thing.
describe("enterRoom — early-exit paths (no network)", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(ensureOpenForEntry).mockReset();
    vi.mocked(getParticipant).mockReset().mockReturnValue(undefined);
  });

  it("rejects a session that doesn't exist", async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    await expect(enterRoom(ROOM_ID, "no-such-session", PERSONA)).rejects.toThrow(EntryError);
    await expect(enterRoom(ROOM_ID, "no-such-session", PERSONA)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("returns the existing participant instead of paying again", async () => {
    const existing = {
      sessionId: "s1",
      roomId: ROOM_ID,
      address: "ADDR",
      agentId: "agent-1",
      persona: PERSONA,
      enteredAt: 1,
      entryTxId: "TX1",
    };
    vi.mocked(getSession).mockReturnValue({ sessionId: "s1", address: "ADDR", agentId: "agent-1", createdAt: 1 });
    vi.mocked(getParticipant).mockReturnValue(existing);

    const result = await enterRoom(ROOM_ID, "s1", PERSONA);
    expect(result).toEqual(existing);
    expect(ensureOpenForEntry).not.toHaveBeenCalled();
  });

  it("surfaces a clear error when the room can't accept entries", async () => {
    vi.mocked(getSession).mockReturnValue({ sessionId: "s2", address: "ADDR", agentId: "agent-2", createdAt: 1 });
    vi.mocked(ensureOpenForEntry).mockImplementation(() => {
      throw new Error("Room is not accepting entries (status: SETTLED)");
    });

    await expect(enterRoom(ROOM_ID, "s2", PERSONA)).rejects.toMatchObject({ code: "ROOM_NOT_OPEN" });
  });
});
