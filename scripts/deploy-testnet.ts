/**
 * CLI wrapper for a one-off manual room deployment.
 *
 *   npx tsx --env-file=.env scripts/deploy-testnet.ts
 *
 * Prints the app id / addresses to paste into .env for a long-running dev
 * server. For an autonomous, no-manual-intervention run (Phase 8), use
 * `npm run test:e2e` instead — it calls deployRoom() itself, against its own
 * short-lived server, so it never depends on or clobbers this configuration.
 */
import algosdk from "algosdk";
import { deployRoom } from "./deployRoom.js";

if (!process.env.TREASURY_MNEMONIC) {
  const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
  console.log("No TREASURY_MNEMONIC set — generated a fresh treasury account.");
  console.log("Fund it with ALGO, then set this in .env and re-run:");
  console.log(`  TREASURY_MNEMONIC="${mnemonic}"`);
  console.log("\nStopping here: an unfunded treasury cannot opt into USDC, and");
  console.log("settle() would fail at the fee transfer with 'must optin'.");
  process.exit(1);
}

const room = await deployRoom({ log: true });

console.log("\n=== paste into .env ===");
console.log(`BIDDING_ROOM_APP_ID=${room.appId}`);
console.log(`BIDDING_ROOM_PRODUCT_ASA_ID=${room.productAssetId}`);
console.log(`BIDDING_ROOM_TREASURY_ADDRESS=${room.treasuryAddress}`);
console.log(`DEMO_TARGET_CENTS=${room.targetCents}`);
console.log(`DEMO_TARGET_NONCE=${room.targetNonce}`);
console.log(`\nexplorer: ${room.explorerUrl}`);
