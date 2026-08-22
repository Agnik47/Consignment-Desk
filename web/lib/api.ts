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

export interface PublicProduct {
  productId: string;
  name: string;
  description: string;
  baseValue: number;
  publicAttributes: Record<string, string | number | boolean>;
  commitment: string;
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
  address: string;
  agentId: string;
  enteredAt: number;
  entryTxId: string;
}

export function enterRoom(): Promise<EnterResult> {
  return request<EnterResult>("/api/session/enter", { method: "POST" });
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

export function runAgent(): Promise<AgentRunResult> {
  return request<AgentRunResult>("/api/session/agent/run", { method: "POST" });
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
