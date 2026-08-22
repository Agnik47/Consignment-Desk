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
  explorerUrl: string;
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
  const productName = opts.productName ?? "Sealed Vintage Polaroid SX-70";

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
  // 0.8 ALGO leaves ~90% margin — cheap insurance, since every underfunded
  // attempt still creates the app on-chain and permanently raises the
  // seller's own min-balance requirement even though the run fails (see
  // docs/implementation-notes.md "seller min-balance creep").
  log("funding app account…");
  await appClient.fundAppAccount({ amount: algo(0.8) });

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
  log("opting seller into the product asset…");
  await algorand.send.assetOptIn({ sender: seller, assetId: productAssetId });

  return {
    appId: createResult.appId,
    appAddress: createResult.appAddress.toString(),
    productAssetId,
    treasuryAddress: treasury.addr.toString(),
    targetCents,
    targetNonce,
    explorerUrl: `https://lora.algokit.io/testnet/application/${createResult.appId}`,
  };
}
