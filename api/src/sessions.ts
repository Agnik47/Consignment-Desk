import crypto from "node:crypto";
import { generateKeypair, fundNewAccount } from "./chain.js";

export interface SessionRecord {
  sessionId: string;
  address: string;
  agentId: string;
  createdAt: number;
}

interface StoredSession extends SessionRecord {
  sk: Uint8Array;
}

const sessions = new Map<string, StoredSession>();
let agentCounter = 0;

function nextAgentId(): string {
  agentCounter += 1;
  return `agent-${agentCounter}`;
}

function toPublicRecord(s: StoredSession): SessionRecord {
  return { sessionId: s.sessionId, address: s.address, agentId: s.agentId, createdAt: s.createdAt };
}

export function getSession(sessionId: string): SessionRecord | undefined {
  const s = sessions.get(sessionId);
  return s ? toPublicRecord(s) : undefined;
}

/** The signing key never leaves the process — for later phases (agent payments, bidding) to sign with. */
export function getSigningKey(sessionId: string): Uint8Array | undefined {
  return sessions.get(sessionId)?.sk;
}

export async function createSession(): Promise<SessionRecord> {
  const sessionId = crypto.randomUUID();
  const { address, sk } = generateKeypair();
  await fundNewAccount(address, sk);

  const record: StoredSession = { sessionId, address, agentId: nextAgentId(), createdAt: Date.now(), sk };
  sessions.set(sessionId, record);
  return toPublicRecord(record);
}
