/**
 * Deploys the BiddingRoom contract to Algorand TESTNET and bootstraps one room.
 *
 * Run once per demo room:
 *   npx tsx --env-file=.env scripts/deploy-testnet.ts
 *
 * Prints the app id / addresses to paste into .env. Deliberately NOT automatic
 * on server start — deployment costs real (test) ALGO and mints a new product
 * ASA each time, so it must be an explicit, deliberate act.
 */
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import algosdk from "algosdk";
import { AlgorandClient, AppFactory, algo } from "@algorandfoundation/algokit-utils";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see .env.example`);
  return v;
}

const USDC_TESTNET_ASA_ID = 10458941n;

// Demo-scaled: every mechanic (escrow, payout, refund, fee split) runs for
// real, just at an amount testnet funding can actually sustain. The product's
// headline $20 value is display economics; this is the escrowed stake.
const BID_STAKE_MICRO_USDC = 100_000n; // $0.10
const FEE_BPS = 500n; // 5%

const PRODUCT_NAME = "Sealed Vintage Polaroid SX-70";

function commitment(cents: number, nonceHex: string): Uint8Array {
  const valueBytes = Buffer.alloc(8);
  valueBytes.writeBigUInt64BE(BigInt(cents));
  return new Uint8Array(
    crypto.createHash("sha256").update(Buffer.concat([valueBytes, Buffer.from(nonceHex, "hex")])).digest(),
  );
}

const algorand = AlgorandClient.testNet();

const sellerSk = new Uint8Array(Buffer.from(requireEnv("RESOURCE_SERVER_PRIVATE_KEY"), "base64"));
const seller = algorand.account.fromMnemonic(algosdk.secretKeyToMnemonic(sellerSk));

// The treasury is a DISTINCT address so the platform fee is a visible,
// verifiable on-chain transfer at settlement rather than an implicit
// bookkeeping entry (resolves the open question in PRD §7).
const treasuryMnemonic = process.env.TREASURY_MNEMONIC ?? algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
const treasury = algorand.account.fromMnemonic(treasuryMnemonic);

console.log("seller  :", seller.addr.toString());
console.log("treasury:", treasury.addr.toString());

if (!process.env.TREASURY_MNEMONIC) {
  console.log("\nNo TREASURY_MNEMONIC set — generated a fresh treasury account.");
  console.log("Fund it with ALGO, then set this in .env and re-run:");
  console.log(`  TREASURY_MNEMONIC="${treasuryMnemonic}"`);
  console.log("\nStopping here: an unfunded treasury cannot opt into USDC, and");
  console.log("settle() would fail at the fee transfer with 'must optin'.");
  process.exit(1);
}

// --- hidden target -----------------------------------------------------
const targetDollars = Number(process.env.DEMO_TARGET ?? 29);
const targetCents = Math.round(targetDollars * 100);
const targetNonce = crypto.randomBytes(32).toString("hex");

console.log(`\ntarget  : $${targetDollars} (${targetCents} cents)`);

// --- deploy ------------------------------------------------------------
const appSpec = JSON.parse(
  readFileSync(new URL("../contracts/bidding_room/BiddingRoom.arc56.json", import.meta.url), "utf-8"),
);

const factory = new AppFactory({
  algorand,
  appSpec,
  defaultSender: seller.addr,
  defaultSigner: seller.signer,
});

console.log("\ncreating app…");
const { appClient, result: createResult } = await factory.send.bare.create();
console.log("  appId  :", createResult.appId.toString());
console.log("  appAddr:", createResult.appAddress.toString());

// Covers base MBR + USDC opt-in + product ASA creation + per-bid box storage
// (~0.06 ALGO per bidder) + settle()'s inner-transaction fees.
console.log("funding app account…");
await appClient.fundAppAccount({ amount: algo(1.5) });

console.log("bootstrapping room…");
const bootstrap = await appClient.send.call({
  method: "bootstrap",
  args: [
    seller.addr.toString(),
    treasury.addr.toString(),
    USDC_TESTNET_ASA_ID,
    commitment(targetCents, targetNonce),
    BID_STAKE_MICRO_USDC,
    FEE_BPS,
    PRODUCT_NAME,
  ],
});
const productAssetId = bootstrap.return as bigint;
console.log("  productAssetId:", productAssetId.toString());

console.log("\nopting treasury into USDC and seller into the product asset…");
await algorand.send.assetOptIn({ sender: treasury, assetId: USDC_TESTNET_ASA_ID });
await algorand.send.assetOptIn({ sender: seller, assetId: productAssetId });

console.log("\n=== paste into .env ===");
console.log(`BIDDING_ROOM_APP_ID=${createResult.appId}`);
console.log(`BIDDING_ROOM_PRODUCT_ASA_ID=${productAssetId}`);
console.log(`BIDDING_ROOM_TREASURY_ADDRESS=${treasury.addr}`);
console.log(`DEMO_TARGET_CENTS=${targetCents}`);
console.log(`DEMO_TARGET_NONCE=${targetNonce}`);
console.log(`\nexplorer: https://lora.algokit.io/testnet/application/${createResult.appId}`);
