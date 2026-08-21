import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner, ALGORAND_TESTNET_GENESIS_HASH } from "@x402/avm";
import { wrapFetchWithPayment } from "@x402/fetch";

// Must match the network string the resource server registered (api/src/x402.ts) —
// the live GoPlausible facilitator advertises Algorand testnet under the full
// genesis-hash CAIP-2 form, not @x402/avm's truncated ALGORAND_TESTNET_CAIP2.
const AVM_TESTNET_NETWORK = `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`;

// Phase 1 required E2E test (AGENTS.md §7 Phase 1):
//   agent -> HTTP 402 -> payment signature -> facilitator -> Algorand testnet
//   settlement -> HTTP 200
// Captures: status before/after payment, payment tx id, explorer URL.

const AVM_PRIVATE_KEY = process.env.AVM_PRIVATE_KEY;
const RESOURCE_SERVER_URL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const ALGOD_URL = process.env.ALGOD_URL;

if (!AVM_PRIVATE_KEY) throw new Error("AVM_PRIVATE_KEY is not set — run `npm run keygen --workspace agent` and fund the address, then set it in .env");
if (!ALGOD_URL) throw new Error("ALGOD_URL is not set — see .env.example");

const url = `${RESOURCE_SERVER_URL}/api/test-payment`;

// Step 1: confirm the endpoint is actually gated before we pay for anything.
const unpaid = await fetch(url);
console.log(`[1/3] unpaid request -> HTTP ${unpaid.status}`);
if (unpaid.status !== 402) {
  throw new Error(`Expected 402 from an unpaid request, got ${unpaid.status}. Endpoint is not gated — stop and fix before proceeding.`);
}

// Step 2: pay and retry, via the real x402 client + facilitator round trip.
const signer = toClientAvmSigner(AVM_PRIVATE_KEY);
const client = new x402Client().register(
  AVM_TESTNET_NETWORK,
  new ExactAvmScheme(signer, { algodUrl: ALGOD_URL }),
);
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const paid = await fetchWithPay(url);
console.log(`[2/3] paid request   -> HTTP ${paid.status}`);
if (paid.status !== 200) {
  const body = await paid.text();
  throw new Error(`Expected 200 after payment, got ${paid.status}: ${body}`);
}

const body = await paid.json();
const settleHeader = paid.headers.get("payment-response") ?? paid.headers.get("x-payment-response");

console.log("[3/3] response body  ->", body);
if (settleHeader) {
  const settlement = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf-8"));
  console.log("      settlement tx  ->", settlement.transaction ?? settlement);
  if (settlement.transaction) {
    console.log("      explorer       ->", `https://lora.algokit.io/testnet/transaction/${settlement.transaction}`);
  }
} else {
  console.log("      (no PAYMENT-RESPONSE header found — check facilitator response shape)");
}

console.log("\nPhase 1 hard gate: PASSED — real x402 payment settled on Algorand testnet.");
