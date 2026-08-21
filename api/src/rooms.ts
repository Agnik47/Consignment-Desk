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

export const ROOM_ID = "demo-room";
export const PRODUCT_ID = "demo-product";

/** commitment = SHA-256(target || nonce), serialized with an explicit delimiter to avoid any concatenation ambiguity. */
export function createCommitment(target: number, nonce: string): string {
  return crypto.createHash("sha256").update(`${target}:${nonce}`).digest("hex");
}

export function verifyCommitment(target: number, nonce: string, commitment: string): boolean {
  return createCommitment(target, nonce) === commitment;
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
    commitment: createCommitment(hiddenTarget, targetNonce),
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

/** Test-only: resets the singleton room/product to a fresh CREATED state. */
export function resetForTests(): void {
  product = seedProduct();
  room = { roomId: ROOM_ID, productId: PRODUCT_ID, status: "CREATED", startTime: null, deadline: null, createdAt: Date.now() };
}
