import crypto from "node:crypto";

export type RoomStatus = "CREATED" | "OPEN" | "BIDDING_CLOSED" | "REVEALING" | "SETTLED";

export interface Product {
  productId: string;
  name: string;
  description: string;
  baseValue: number;
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
  baseValue: number;
  publicAttributes: Record<string, string | number | boolean>;
  commitment: string;
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
  address: string;
  agentId: string;
  enteredAt: number;
  entryTxId: string;
}

export const ROOM_ID = "demo-room";
export const PRODUCT_ID = "demo-product";

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

function seedProduct(): Product {
  const hiddenTarget = 29;
  const targetNonce = crypto.randomBytes(32).toString("hex");
  return {
    productId: PRODUCT_ID,
    name: "Sealed Vintage Polaroid SX-70",
    description: "An estate-sale find, still in its sealed box. Condition and functionality unconfirmed from the listing alone — appraise it.",
    baseValue: 20,
    publicAttributes: { category: "Camera", era: "1970s", sealedBox: true, listingPhotos: 3 },
    hint: { key: "condition", value: "excellent — tested, film advances correctly" },
    hiddenTarget,
    targetNonce,
    commitment: createCommitment(toCents(hiddenTarget), targetNonce),
  };
}

const VALID_TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  CREATED: ["OPEN"],
  OPEN: ["BIDDING_CLOSED"],
  BIDDING_CLOSED: ["REVEALING"],
  REVEALING: ["SETTLED"],
  SETTLED: [],
};

let product: Product = seedProduct();
let room: Room = {
  roomId: ROOM_ID,
  productId: PRODUCT_ID,
  status: "CREATED",
  startTime: null,
  deadline: null,
  createdAt: Date.now(),
};
const participants = new Map<string, Participant>();

function transition(next: RoomStatus): void {
  if (!VALID_TRANSITIONS[room.status].includes(next)) {
    throw new Error(`Invalid room transition: ${room.status} -> ${next}`);
  }
  room = { ...room, status: next };
}

export function getRoom(): Room {
  return room;
}

export function getProduct(): Product {
  return product;
}

export function getPublicView(): PublicRoom {
  return {
    roomId: room.roomId,
    status: room.status,
    startTime: room.startTime,
    deadline: room.deadline,
    product: {
      productId: product.productId,
      name: product.name,
      description: product.description,
      baseValue: product.baseValue,
      publicAttributes: product.publicAttributes,
      commitment: product.commitment,
    },
  };
}

export function openRoom(biddingWindowMs: number): Room {
  const startTime = Date.now();
  transition("OPEN");
  room = { ...room, startTime, deadline: startTime + biddingWindowMs };
  return room;
}

export function closeBidding(): Room {
  transition("BIDDING_CLOSED");
  return room;
}

export function startReveal(): Room {
  transition("REVEALING");
  return room;
}

export function settleRoom(): Room {
  transition("SETTLED");
  return room;
}

/**
 * Room entry has no separate "start the room" trigger anywhere in the spec —
 * the first entry attempt opens the room (CREATED -> OPEN, deadline set from
 * this moment). Later entries just require the room to still be OPEN. Throws
 * with a clear reason once bidding has moved past OPEN, so a caller never
 * accidentally charges someone for a room that can't accept them.
 */
export function ensureOpenForEntry(biddingWindowMs = DEFAULT_BIDDING_WINDOW_MS): Room {
  if (room.status === "CREATED") {
    return openRoom(biddingWindowMs);
  }
  if (room.status !== "OPEN") {
    throw new Error(`Room is not accepting entries (status: ${room.status})`);
  }
  return room;
}

export function hasEntered(sessionId: string): boolean {
  return participants.has(sessionId);
}

export function getParticipant(sessionId: string): Participant | undefined {
  return participants.get(sessionId);
}

export function recordEntry(sessionId: string, address: string, agentId: string, entryTxId: string): Participant {
  const participant: Participant = { sessionId, address, agentId, enteredAt: Date.now(), entryTxId };
  participants.set(sessionId, participant);
  return participant;
}

/** Test-only: resets the singleton room/product to a fresh CREATED state. */
export function resetForTests(): void {
  product = seedProduct();
  room = { roomId: ROOM_ID, productId: PRODUCT_ID, status: "CREATED", startTime: null, deadline: null, createdAt: Date.now() };
  participants.clear();
}
