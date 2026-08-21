// Server-side x402 *client*. The browser never holds a private key (custodial
// model, AGENTS.md §4), so when a session or its agent needs to pay for a
// gated resource, this process signs on their behalf using the session's own
// stored key and makes a genuine loopback HTTP call to our own gated route.
//
// Real loopback rather than an in-process shortcut, deliberately: it reuses
// @x402/fetch's tested 402-parse/sign/retry path instead of reimplementing it,
// and it means our gated routes can never silently drift from what an external
// caller would actually experience (Phase 1's hard gate curled them directly).
import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { AVM_TESTNET_NETWORK } from "./x402.js";
import { getSigningKey } from "./sessions.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

const ALGOD_URL: string = requireEnv("ALGOD_URL");
const API_PORT = Number(process.env.API_PORT ?? 4021);

export const SELF_URL = `http://localhost:${API_PORT}`;

export class PaymentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PaidFetchResult {
  response: Response;
  /** Settlement transaction id, or "unknown" if the receipt header couldn't be read. */
  txId: string;
}

/**
 * Pays for and fetches an x402-gated resource on a session's behalf.
 * Throws PaymentError on anything short of a settled 200.
 */
export async function payAndFetch(sessionId: string, path: string, init?: RequestInit): Promise<PaidFetchResult> {
  const sk = getSigningKey(sessionId);
  if (!sk) {
    // Unreachable in practice — a session retains its key for the process lifetime.
    throw new PaymentError("SESSION_KEY_MISSING", "Session has no signing key on file.");
  }

  const signer = toClientAvmSigner(Buffer.from(sk).toString("base64"));
  const client = new x402Client().register(AVM_TESTNET_NETWORK, new ExactAvmScheme(signer, { algodUrl: ALGOD_URL }));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  let response: Response;
  try {
    response = await fetchWithPay(`${SELF_URL}${path}`, init);
  } catch (err) {
    throw new PaymentError("PAYMENT_FAILED", err instanceof Error ? err.message : "Payment failed.");
  }

  if (response.status !== 200) {
    const body = await response.text().catch(() => "");
    throw new PaymentError("PAYMENT_FAILED", `Payment did not settle (HTTP ${response.status}). ${body}`.trim());
  }

  return { response, txId: readSettlementTxId(response) };
}

function readSettlementTxId(response: Response): string {
  const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  if (!header) return "unknown";
  try {
    const settlement = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    return typeof settlement.transaction === "string" ? settlement.transaction : "unknown";
  } catch {
    // The payment already settled — a header-parsing hiccup must not fail the request.
    return "unknown";
  }
}
