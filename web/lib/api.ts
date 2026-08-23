// Thin client for the api/ Hono server. No framework magic — plain fetch
// with credentials so the session cookie (set by POST /api/session) travels
// on every call, matching how api/src/index.ts reads it.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4021";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "UNKNOWN", body?.message ?? `Request to ${path} failed with ${res.status}`);
  }
  return body as T;
}

export interface SessionRecord {
  sessionId: string;
  address: string;
  agentId: string;
  createdAt: number;
}

export function createSession(): Promise<SessionRecord> {
  return request<SessionRecord>("/api/session", { method: "POST" });
}

export type RoomStatus = "CREATED" | "OPEN" | "BIDDING_CLOSED" | "REVEALING" | "SETTLED";
export type AgentStatus = "idle" | "analyzing" | "buying_hint" | "thinking" | "bid_submitted" | "failed";

// This system's own virtual exchange rate — NOT a live market price. The
// API/contract layer works entirely in USD cents internally (that's what's
// wired into the on-chain target commitment and the valuation heuristic);
// every dollar figure the UI receives is converted to this system's ALGO
// scale for display only.
export const VIRTUAL_ALGO_TO_USD = 2000; // 0.01 ALGO = $20
export const usdToAlgo = (usd: number) => usd / VIRTUAL_ALGO_TO_USD;

export type PersonaName = "conservative" | "balanced" | "aggressive";

/** Mirrors agent/src/brain.ts's PERSONAS — duplicated here since web/ shares no package with agent/. */
export const PERSONAS: { name: PersonaName; description: string }[] = [
  { name: "conservative", description: "Guards its budget — won't spend on information, and bids under its own estimate." },
  { name: "balanced", description: "Buys information when uncertain, then bids exactly what it believes." },
  { name: "aggressive", description: "Buys information readily and bids above its estimate to win." },
];

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

export interface PublicAgent {
  agentId: string;
  persona: string;
  personaDescription: string;
  status: AgentStatus;
  confidence: number | null;
  hintPurchased: boolean;
  hintTxId: string | null;
  hasBid: boolean;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface RoomView {
  roomId: string;
  status: RoomStatus;
  startTime: number | null;
  deadline: number | null;
  product: PublicProduct;
  agents: PublicAgent[];
}

export function getRoom(roomId: string): Promise<RoomView> {
  return request<RoomView>(`/api/room/${roomId}`);
}

export interface EnterResult {
  sessionId: string;
  roomId: string;
  address: string;
  agentId: string;
  persona: PersonaName;
  enteredAt: number;
  entryTxId: string;
}

export function enterRoom(roomId: string, persona: PersonaName): Promise<EnterResult> {
  return request<EnterResult>("/api/session/enter", { method: "POST", body: JSON.stringify({ roomId, persona }) });
}

export interface AgentRunResult {
  agentId: string;
  persona: string;
  status: AgentStatus;
  confidence: number | null;
  hintPurchased: boolean;
  hintTxId: string | null;
  bidTxId: string | null;
}

export function runAgent(roomId: string): Promise<AgentRunResult> {
  return request<AgentRunResult>("/api/session/agent/run", { method: "POST", body: JSON.stringify({ roomId }) });
}

export interface RevealedBid {
  agentId: string;
  guess: number;
  distance: number;
  isWinner: boolean;
  revealTx: string;
}

export interface RevealView {
  target: number;
  productName: string;
  winnerAgentId: string | null;
  winnerAddress: string | null;
  bids: RevealedBid[];
  settlementTxs: string[];
}

export function getReveal(roomId: string): Promise<RevealView> {
  return request<RevealView>(`/api/room/${roomId}/reveal`);
}

export interface CreateListingResult {
  roomId: string;
  product: PublicProduct;
}

export interface CreateListingInput {
  minPrice: number;
  maxPrice: number;
}

export function createListing(input: CreateListingInput): Promise<CreateListingResult> {
  return request<CreateListingResult>("/api/listings", { method: "POST", body: JSON.stringify(input) });
}
