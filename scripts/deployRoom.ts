/**
 * Deploys a fresh BiddingRoom contract on Algorand testnet and bootstraps it.
 * Extracted from deploy-testnet.ts so the E2E harness (test-e2e.ts) can call
 * it directly — a contract can only settle once, so a "no manual
 * intervention" end-to-end run needs its own fresh instance every time, not
 * the one already sitting SETTLED from a prior manual run.
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

export interface DeployRoomOptions {
  targetDollars?: number;
  bidStakeMicroUsdc?: bigint;
  feeBps?: bigint;
  productName?: string;
  /** Print progress lines. Off by default so callers can control their own output. */
  log?: boolean;
}

export interface DeployedRoomConfig {
  appId: bigint;
  appAddress: string;
  productAssetId: bigint;
  treasuryAddress: string;
  targetCents: number;
  targetNonce: string;
  bidStakeMicroUsdc: bigint;
  explorerUrl: string;
}

// Algorand's ASA name field is protocol-capped at 32 bytes (contract.py's
// bootstrap() sets it directly from this string as asset_name) — a real
// Jetson-identified item name routinely exceeds that (e.g. "black track
// jacket with white piping" is 37 bytes), which fails deep inside the
// contract's inner AssetConfig transaction with an opaque "value is too
// long" AVM error rather than a readable one. Trim by whole characters, not
// bytes, so a multi-byte UTF-8 character never gets split into invalid
// trailing bytes.
function truncateAssetName(name: string, maxBytes = 32): string {
  let result = name;
  while (Buffer.byteLength(result, "utf-8") > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function commitment(cents: number, nonceHex: string): Uint8Array {
  const valueBytes = Buffer.alloc(8);
  valueBytes.writeBigUInt64BE(BigInt(cents));
  return new Uint8Array(
    crypto.createHash("sha256").update(Buffer.concat([valueBytes, Buffer.from(nonceHex, "hex")])).digest(),
  );
}

export async function deployRoom(opts: DeployRoomOptions = {}): Promise<DeployedRoomConfig> {
  const log = opts.log ? console.log : () => {};
  const targetDollars = opts.targetDollars ?? Number(process.env.DEMO_TARGET ?? 29);
  const bidStake = opts.bidStakeMicroUsdc ?? 100_000n; // $0.10 — see docs/implementation-notes.md §13
  const feeBps = opts.feeBps ?? 500n; // 5%
  const productName = truncateAssetName(opts.productName ?? "Sealed Vintage Polaroid SX-70");

  const algorand = AlgorandClient.testNet();

  const sellerSk = new Uint8Array(Buffer.from(requireEnv("RESOURCE_SERVER_PRIVATE_KEY"), "base64"));
  const seller = algorand.account.fromMnemonic(algosdk.secretKeyToMnemonic(sellerSk));

  const treasuryMnemonic = requireEnv("TREASURY_MNEMONIC");
  const treasury = algorand.account.fromMnemonic(treasuryMnemonic);

  const targetCents = Math.round(targetDollars * 100);
  const targetNonce = crypto.randomBytes(32).toString("hex");

  log(`target: $${targetDollars} (${targetCents} cents)`);

  const appSpec = JSON.parse(
    readFileSync(new URL("../contracts/bidding_room/BiddingRoom.arc56.json", import.meta.url), "utf-8"),
  );

  const factory = new AppFactory({
    algorand,
    appSpec,
    defaultSender: seller.addr,
    defaultSigner: seller.signer,
  });

  log("creating app…");
  const { appClient, result: createResult } = await factory.send.bare.create();
  log(`  appId=${createResult.appId} appAddr=${createResult.appAddress}`);

  // Computed, not guessed: base MBR (100k) + USDC opt-in (100k) + self-held
  // product ASA (100k) = 300k, plus box MBR for 2 bidders' BidRecord + index
  // boxes (~113k) and settle()'s inner-txn fees (~6k) = ~419k real need.
  // 0.42 ALGO is a slim margin over that — trimmed down from an earlier 0.8
  // ALGO (90% margin) once testnet ALGO became the scarce resource across
  // multiple listings. Do NOT cut this further: below ~419k, box creation for
  // the second bidder can fail mid-demo, and PRD's E2E acceptance requires
  // at least two agents participating. (The seller's OWN opt-in cost, a
  // separate ~0.1 ALGO, is no longer paid here at all — see
  // contract.ts's ensureSellerOptedIntoProduct, deferred to settle-time and
  // only spent if the room genuinely gets zero revealed bids.)
  log("funding app account…");
  await appClient.fundAppAccount({ amount: algo(0.42) });

  log("bootstrapping room…");
  const bootstrap = await appClient.send.call({
    method: "bootstrap",
    args: [
      seller.addr.toString(),
      treasury.addr.toString(),
      USDC_TESTNET_ASA_ID,
      commitment(targetCents, targetNonce),
      bidStake,
      feeBps,
      productName,
    ],
  });
  const productAssetId = bootstrap.return as bigint;
  log(`  productAssetId=${productAssetId}`);

  // Idempotent: a treasury reused across runs is already opted into USDC
  // after its first deploy, and re-submitting an opt-in is a harmless no-op
  // on Algorand — but check first to avoid burning a transaction on every run.
  const treasuryInfo = await algorand.account.getInformation(treasury.addr);
  if (!treasuryInfo.assets?.some((a) => a.assetId === USDC_TESTNET_ASA_ID)) {
    log("opting treasury into USDC…");
    await algorand.send.assetOptIn({ sender: treasury, assetId: USDC_TESTNET_ASA_ID });
  }
  // The seller does NOT opt into the product ASA here anymore — that opt-in
  // is only needed for settle()'s no-revealed-bids fallback (item returned to
  // seller), and costs 0.1 ALGO of permanent min-balance. Paying it for every
  // listing regardless of outcome was wasted spend on a scarce testnet
  // account; api/src/contract.ts's ensureSellerOptedIntoProduct() now does it
  // lazily, only when a room genuinely settles with zero revealed bids.

  return {
    appId: createResult.appId,
    appAddress: createResult.appAddress.toString(),
    productAssetId,
    treasuryAddress: treasury.addr.toString(),
    targetCents,
    targetNonce,
    bidStakeMicroUsdc: bidStake,
    explorerUrl: `https://lora.algokit.io/testnet/application/${createResult.appId}`,
  };
}
