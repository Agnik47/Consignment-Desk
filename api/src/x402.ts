import { ExactAvmScheme } from "@x402/avm/exact/server";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { RoutesConfig, RouteConfig } from "@x402/core/server";
import { ALGORAND_TESTNET_GENESIS_HASH, USDC_TESTNET_ASA_ID } from "@x402/avm";
import { ROOM_ID, PRODUCT_ID } from "./rooms.js";

// The GoPlausible facilitator's live /supported response advertises Algorand
// testnet under the FULL genesis-hash CAIP-2 form, not @x402/avm's exported
// ALGORAND_TESTNET_CAIP2 (which is the spec's truncated 32-char form). Route
// registration is a literal string match against what the facilitator
// advertises, so this must match the facilitator, not the CAIP-2 spec's
// preferred short form. Confirmed live 2026-08-21 — see docs/implementation-notes.md §2.
// Exported so agent-side x402 clients (entry.ts, agent/) register the identical string.
export const AVM_TESTNET_NETWORK = `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

const AVM_ADDRESS: string = requireEnv("AVM_ADDRESS");

export const facilitatorClient = new HTTPFacilitatorClient({ url: requireEnv("FACILITATOR_URL") });

export const resourceServer = new x402ResourceServer(facilitatorClient).register(
  AVM_TESTNET_NETWORK,
  new ExactAvmScheme(),
);

function usdcRoute(price: string, description: string): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      network: AVM_TESTNET_NETWORK,
      payTo: AVM_ADDRESS,
      price,
      extra: { asset: USDC_TESTNET_ASA_ID },
    },
    description,
  };
}

export const ENTER_ROOM_PATH = `/api/room/${ROOM_ID}/enter`;
export const HINT_PATH = `/api/product/${PRODUCT_ID}/hint`;

/** Kept as a number too so the agent can compare it against its real budget. */
export const HINT_PRICE_USD = 0.05;

export const routes: RoutesConfig = {
  "/api/test-payment": usdcRoute("$0.01", "Phase 1 x402 smoke test — proves the facilitator settles a real testnet payment"),
  [ENTER_ROOM_PATH]: usdcRoute("$0.50", "Room entry fee — assigns the paying session's agent"),
  // P0-3, the requirement the PRD flags as never-cut: the agent pays for this
  // one itself, mid-decision, with no human in the path.
  [HINT_PATH]: usdcRoute(`$${HINT_PRICE_USD.toFixed(2)}`, "One additional product attribute — purchased autonomously by an agent"),
};
