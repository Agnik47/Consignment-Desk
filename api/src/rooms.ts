import crypto from "node:crypto";
import type { ItemRow } from "./supabase.js";
import type { PersonaName } from "../../agent/src/brain.js";

export type RoomStatus = "CREATED" | "OPEN" | "BIDDING_CLOSED" | "REVEALING" | "SETTLED";

export interface Product {
  productId: string;
  name: string;
  description: string;
  imageUrl: string | null;
  baseValue: number;
  /** Seller-chosen floor, public — unlike hiddenTarget, bidders may see this. */
  minSellingAmount: number;
  publicAttributes: Record<string, string | number | boolean>;
  hint: { key: string; value: string };
  hiddenTarget: number;
  targetNonce: string;
  commitment: string;
}

export interface Room {
  roomId: string;
  productId: string;
  status: RoomStatus;
  startTime: number | null;
  deadline: number | null;
  createdAt: number;
}

export interface PublicProduct {
  productId: string;
  name: string;
  description: string;
  imageUrl: string | null;
  baseValue: number;
  minSellingAmount: number;
  publicAttributes: Record<string, string | number | boolean>;
  commitment: string;
  streamUrl: string | null;
}

export interface PublicRoom {
  roomId: string;
  status: RoomStatus;
  startTime: number | null;
  deadline: number | null;
  product: PublicProduct;
}

export interface Participant {
  sessionId: string;
  roomId: string;
  address: string;
  agentId: string;
  persona: PersonaName;
  enteredAt: number;
  entryTxId: string;
}

// Not specified anywhere how long the room stays open for entries before
// bidding closes — placeholder for the demo-mode config Phase 11 will own.
export const DEFAULT_BIDDING_WINDOW_MS = 5 * 60 * 1000;

/**
 * Money is carried as INTEGER CENTS everywhere it crosses the contract
 * boundary. The contract's guess/target are `UInt64` — it has no decimals —
 * while the valuation heuristic works in dollars (28.7). Cents is the lossless
 * meeting point: $28.70 -> 2870.
 */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * commitment = SHA-256(itob(cents) ‖ nonceBytes)
 *
 * This MUST byte-for-byte match `_sha256_commitment` in
 * contracts/bidding_room/contract.py — an 8-byte big-endian uint64 followed by
 * the raw nonce bytes. An earlier version hashed the string `"29:<hex nonce>"`
 * instead, which the contract would have rejected at reveal time with
 * "guess/nonce does not match the commitment". This exact byte layout is the
 * one proven against the real contract by the Phase 6 LocalNet suite.
 */
export function createCommitment(cents: number, nonceHex: string): string {
  const valueBytes = Buffer.alloc(8);
  valueBytes.writeBigUInt64BE(BigInt(cents));
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([valueBytes, Buffer.from(nonceHex, "hex")]))
    .digest("hex");
}

export function verifyCommitment(cents: number, nonceHex: string, commitment: string): boolean {
  return createCommitment(cents, nonceHex) === commitment;
}

// The Jetson rig's grading output has no fixed vocabulary (freeform `condition`
// jsonb, a numeric `grader_confidence`). The paid-hint valuation heuristic
// (agent/src/brain.ts `parseCondition`) only recognizes the four words below
// in the hint text, so grader_confidence (always present, always numeric) is
// what actually picks the grade word; the freeform condition detail is
// appended as human-readable text only. Thresholds are a judgment call, not
// measured.
const GRADE_THRESHOLDS: [number, string][] = [
  [0.85, "excellent"],
  [0.65, "good"],
  [0.4, "fair"],
];

export function gradeFromConfidence(graderConfidence: number | null): string {
  if (graderConfidence == null) return "fair";
  for (const [min, grade] of GRADE_THRESHOLDS) {
    if (graderConfidence >= min) return grade;
  }
  return "poor";
}

function summarizeCondition(condition: unknown): string {
  if (condition && typeof condition === "object") {
    const obj = condition as Record<string, unknown>;
    for (const key of ["summary", "notes", "description", "assessment"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  try {
    return JSON.stringify(condition);
  } catch {
    return "condition data unavailable";
  }
}

// The Jetson pipeline only produces category/name/image/condition — era,
// sealedBox, and listingPhotos have no real source yet, so every room built
// from a capture (or the legacy demo seed) still carries these as static
// filler on top of whatever the Jetson actually graded.
const DEMO_BASE_VALUE = 20;
const FILLER_ATTRIBUTES = { era: "1970s", sealedBox: true, listingPhotos: 3 } as const;

interface GradeInputs {
  imageUrl: string | null;
  category: string | null;
  identifiedAs: string | null;
  condition: unknown;
  graderConfidence: number | null;
}

function buildProduct(
  roomId: string,
  inputs: GradeInputs,
  hiddenTarget: number,
  targetNonce: string,
  minSellingAmount: number,
): Product {
  const grade = gradeFromConfidence(inputs.graderConfidence);
  const confidencePct = Math.round((inputs.graderConfidence ?? 0) * 100);
  return {
    productId: roomId,
    name: inputs.identifiedAs ?? "Untitled item",
    description: "Captured and graded by the on-site Jetson rig — appraise it.",
    imageUrl: inputs.imageUrl,
    baseValue: DEMO_BASE_VALUE,
    minSellingAmount,
    publicAttributes: { ...FILLER_ATTRIBUTES, ...(inputs.category ? { category: inputs.category } : {}) },
    hint: {
      key: "condition",
      value: `${grade} — ${summarizeCondition(inputs.condition)} (grader confidence ${confidencePct}%)`,
    },
    hiddenTarget,
    targetNonce,
    commitment: createCommitment(toCents(hiddenTarget), targetNonce),
  };
}

/** Builds a room's product from a Supabase `items` row (the legacy boot-seed path, see index.ts). */
export function productFromItem(
  item: ItemRow,
  roomId: string,
  hiddenTarget: number,
  targetNonce: string,
  minSellingAmount: number = DEMO_BASE_VALUE,
): Product {
  return buildProduct(
    roomId,
    {
      imageUrl: item.image_url,
      category: item.category,
      identifiedAs: item.identified_as,
      condition: item.condition,
      graderConfidence: item.grader_confidence,
    },
    hiddenTarget,
    targetNonce,
    minSellingAmount,
  );
}

export interface CaptureResult {
  imageUrl: string | null;
  category: string | null;
  identifiedAs: string | null;
  condition: unknown;
  graderConfidence: number | null;
}

/**
 * Builds a new room's product directly from the Jetson's synchronous /capture
 * response. `hiddenTarget` and `minSellingAmount` both come from the seller's
 * own listing-form input (see listings.ts) — the grade card informs the hint
 * text only, not the price range.
 */
export function productFromCapture(
  capture: CaptureResult,
  roomId: string,
  hiddenTarget: number,
  targetNonce: string,
  minSellingAmount: number,
): Product {
  return buildProduct(roomId, capture, hiddenTarget, targetNonce, minSellingAmount);
}

/** The pre-Jetson demo product — used only when no real capture/item is available for the legacy `demo-room` seed. */
export function seedDemoProduct(
  roomId: string,
  hiddenTarget: number,
  targetNonce: string,
  minSellingAmount: number = DEMO_BASE_VALUE,
): Product {
  return {
    productId: roomId,
    name: "Sealed Vintage Polaroid SX-70",
    description: "An estate-sale find, still in its sealed box. Condition and functionality unconfirmed from the listing alone — appraise it.",
    imageUrl: null,
    baseValue: DEMO_BASE_VALUE,
    minSellingAmount,
    publicAttributes: { ...FILLER_ATTRIBUTES, category: "Camera" },
    hint: { key: "condition", value: "excellent — tested, film advances correctly" },
    hiddenTarget,
    targetNonce,
    commitment: createCommitment(toCents(hiddenTarget), targetNonce),
  };
}

interface RoomEntry {
  room: Room;
  product: Product;
  participants: Map<string, Participant>;
}

const rooms = new Map<string, RoomEntry>();

function requireEntry(roomId: string): RoomEntry {
  const entry = rooms.get(roomId);
  if (!entry) throw new Error(`Room ${roomId} not found.`);
  return entry;
}

export function roomExists(roomId: string): boolean {
  return rooms.has(roomId);
}

/** Registers a brand-new room (one per listing — see listings.ts). productId === roomId, 1:1. */
export function createRoom(roomId: string, product: Product): Room {
  const room: Room = {
    roomId,
    productId: product.productId,
    status: "CREATED",
    startTime: null,
    deadline: null,
    createdAt: Date.now(),
  };
  rooms.set(roomId, { room, product, participants: new Map() });
  return room;
}

const VALID_TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  CREATED: ["OPEN"],
  OPEN: ["BIDDING_CLOSED"],
  BIDDING_CLOSED: ["REVEALING"],
  REVEALING: ["SETTLED"],
  SETTLED: [],
};

function transition(roomId: string, next: RoomStatus): void {
  const entry = requireEntry(roomId);
  if (!VALID_TRANSITIONS[entry.room.status].includes(next)) {
    throw new Error(`Invalid room transition: ${entry.room.status} -> ${next}`);
  }
  entry.room = { ...entry.room, status: next };
}

export function getRoom(roomId: string): Room {
  return requireEntry(roomId).room;
}

export function getProduct(roomId: string): Product {
  return requireEntry(roomId).product;
}

// Read live (not cached at module load) so flipping JETSON_STREAM_URL in
// .env and restarting the API is enough to show/hide "Inspect" — no other
// code path needs to know about it. Browser connects to the Jetson directly
// (plain <img src> against an MJPEG endpoint); the API never proxies frames.
function getStreamUrl(): string | null {
  return process.env.JETSON_STREAM_URL || null;
}

export function getPublicView(roomId: string): PublicRoom {
  const { room, product } = requireEntry(roomId);
  return {
    roomId: room.roomId,
    status: room.status,
    startTime: room.startTime,
    deadline: room.deadline,
    product: {
      productId: product.productId,
      name: product.name,
      description: product.description,
      imageUrl: product.imageUrl,
      baseValue: product.baseValue,
      minSellingAmount: product.minSellingAmount,
      publicAttributes: product.publicAttributes,
      commitment: product.commitment,
      streamUrl: getStreamUrl(),
    },
  };
}

export function openRoom(roomId: string, biddingWindowMs: number): Room {
  const entry = requireEntry(roomId);
  const startTime = Date.now();
  transition(roomId, "OPEN");
  entry.room = { ...entry.room, startTime, deadline: startTime + biddingWindowMs };
  return entry.room;
}

export function closeBidding(roomId: string): Room {
  transition(roomId, "BIDDING_CLOSED");
  return getRoom(roomId);
}

export function startReveal(roomId: string): Room {
  transition(roomId, "REVEALING");
  return getRoom(roomId);
}

export function settleRoom(roomId: string): Room {
  transition(roomId, "SETTLED");
  return getRoom(roomId);
}

/**
 * Room entry has no separate "start the room" trigger anywhere in the spec —
 * the first entry attempt opens the room (CREATED -> OPEN, deadline set from
 * this moment). Later entries just require the room to still be OPEN. Throws
 * with a clear reason once bidding has moved past OPEN, so a caller never
 * accidentally charges someone for a room that can't accept them.
 */
export function ensureOpenForEntry(roomId: string, biddingWindowMs = DEFAULT_BIDDING_WINDOW_MS): Room {
  const room = getRoom(roomId);
  if (room.status === "CREATED") {
    return openRoom(roomId, biddingWindowMs);
  }
  if (room.status !== "OPEN") {
    throw new Error(`Room is not accepting entries (status: ${room.status})`);
  }
  return room;
}

export function hasEntered(roomId: string, sessionId: string): boolean {
  return requireEntry(roomId).participants.has(sessionId);
}

export function getParticipant(roomId: string, sessionId: string): Participant | undefined {
  return requireEntry(roomId).participants.get(sessionId);
}

export function recordEntry(
  roomId: string,
  sessionId: string,
  address: string,
  agentId: string,
  entryTxId: string,
  persona: PersonaName,
): Participant {
  const participant: Participant = { sessionId, roomId, address, agentId, persona, enteredAt: Date.now(), entryTxId };
  requireEntry(roomId).participants.set(sessionId, participant);
  return participant;
}

/** Test-only: clears the entire room registry. Tests create their own room via createRoom(). */
export function resetForTests(): void {
  rooms.clear();
}
