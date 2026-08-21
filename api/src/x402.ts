import { ExactAvmScheme } from "@x402/avm/exact/server";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { ALGORAND_TESTNET_GENESIS_HASH, USDC_TESTNET_ASA_ID } from "@x402/avm";

// The GoPlausible facilitator's live /supported response advertises Algorand
// testnet under the FULL genesis-hash CAIP-2 form, not @x402/avm's exported
// ALGORAND_TESTNET_CAIP2 (which is the spec's truncated 32-char form). Route
// registration is a literal string match against what the facilitator
// advertises, so this must match the facilitator, not the CAIP-2 spec's
// preferred short form. Confirmed live 2026-08-21 — see docs/implementation-notes.md §2.
const AVM_TESTNET_NETWORK = `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`;

const AVM_ADDRESS = process.env.AVM_ADDRESS;
const FACILITATOR_URL = process.env.FACILITATOR_URL;

if (!AVM_ADDRESS) throw new Error("AVM_ADDRESS is not set — see .env.example");
if (!FACILITATOR_URL) throw new Error("FACILITATOR_URL is not set — see .env.example");

export const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

export const resourceServer = new x402ResourceServer(facilitatorClient).register(
  AVM_TESTNET_NETWORK,
  new ExactAvmScheme(),
);

// Phase 1 — smallest possible paid endpoint. Real room/hint routes (Phase 4, Phase 5+)
// get added here once this settles against the live facilitator.
export const routes: RoutesConfig = {
  "/api/test-payment": {
    accepts: {
      scheme: "exact",
      network: AVM_TESTNET_NETWORK,
      payTo: AVM_ADDRESS,
      price: "$0.01",
      extra: { asset: USDC_TESTNET_ASA_ID },
    },
    description: "Phase 1 x402 smoke test — proves the facilitator settles a real testnet payment",
  },
};
