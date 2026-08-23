/**
 * Batch-provisions N testnet wallets in one script run, funded atomically
 * from the resource server's own dispenser account (AVM_ADDRESS /
 * RESOURCE_SERVER_PRIVATE_KEY) — the same fund-ALGO + opt-in + fund-USDC
 * group api/src/chain.ts's fundNewAccount() uses for real session wallets.
 * Reimplemented here rather than imported since scripts/ doesn't cross-import
 * api/src (see deployRoom.ts for the same pattern).
 *
 * Needs the dispenser wallet itself already funded — see docs/wallet-setup.md.
 *
 *   npx tsx --env-file=.env scripts/provision-wallets.ts <count> [outFile]
 */
import algosdk from "algosdk";
import { writeFileSync } from "node:fs";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see .env.example`);
  return v;
}

const ALGOD_URL = process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";
const USDC_TESTNET_ASA_ID = 10458941;

// Matches api/src/chain.ts's per-wallet funding amounts exactly, so a batch
// of wallets provisioned here behaves identically to real session wallets.
const FUND_ALGO_MICROALGOS = 400_000; // 0.4 ALGO
const FUND_USDC_UNITS = 1_000_000; // 1.00 USDC

const count = Number(process.argv[2] ?? 1);
const outFile = process.argv[3] ?? "wallets.generated.json";

if (!Number.isInteger(count) || count < 1) {
  console.error("Usage: npx tsx --env-file=.env scripts/provision-wallets.ts <count> [outFile]");
  process.exit(1);
}

const algod = new algosdk.Algodv2("", ALGOD_URL, "");
const DISPENSER_ADDRESS = requireEnv("AVM_ADDRESS");
const dispenserSk = new Uint8Array(Buffer.from(requireEnv("RESOURCE_SERVER_PRIVATE_KEY"), "base64"));

// Fail fast rather than mid-batch: a partially-funded batch is harder to
// clean up than a clear "top up the dispenser first" error.
const dispenserInfo = await algod.accountInformation(DISPENSER_ADDRESS).do();
const dispenserAlgo = Number(dispenserInfo.amount);
const dispenserUsdc = Number(
  dispenserInfo.assets?.find((a) => Number(a.assetId) === USDC_TESTNET_ASA_ID)?.amount ?? 0,
);
const neededAlgo = count * FUND_ALGO_MICROALGOS;
const neededUsdc = count * FUND_USDC_UNITS;
if (dispenserAlgo < neededAlgo || dispenserUsdc < neededUsdc) {
  console.error(
    `Dispenser (${DISPENSER_ADDRESS}) can't cover ${count} wallet(s):\n` +
      `  ALGO: has ${dispenserAlgo / 1e6}, needs ${neededAlgo / 1e6}\n` +
      `  USDC: has ${dispenserUsdc / 1e6}, needs ${neededUsdc / 1e6}\n` +
      `Top it up first (algokit dispenser fund for ALGO, faucet.circle.com for USDC).`,
  );
  process.exit(1);
}

interface ProvisionedWallet {
  address: string;
  secretKey: string;
  mnemonic: string;
  fundTxId: string;
}

const results: ProvisionedWallet[] = [];

for (let i = 0; i < count; i++) {
  const account = algosdk.generateAccount();
  const address = account.addr.toString();
  const suggestedParams = await algod.getTransactionParams().do();

  const fundAlgoTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: DISPENSER_ADDRESS,
    receiver: address,
    amount: FUND_ALGO_MICROALGOS,
    suggestedParams,
  });
  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    assetIndex: USDC_TESTNET_ASA_ID,
    suggestedParams,
  });
  const fundUsdcTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: DISPENSER_ADDRESS,
    receiver: address,
    amount: FUND_USDC_UNITS,
    assetIndex: USDC_TESTNET_ASA_ID,
    suggestedParams,
  });

  const group = algosdk.assignGroupID([fundAlgoTxn, optInTxn, fundUsdcTxn]);
  const signed = [group[0].signTxn(dispenserSk), group[1].signTxn(account.sk), group[2].signTxn(dispenserSk)];

  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 4);

  results.push({
    address,
    secretKey: Buffer.from(account.sk).toString("base64"),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
    fundTxId: txid,
  });
  console.log(`[${i + 1}/${count}] ${address} funded — https://lora.algokit.io/testnet/transaction/${txid}`);
}

writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nWrote ${results.length} wallet(s) to ${outFile}.`);
console.log("This file holds live secret keys — it's gitignored, but treat it like a credentials file.");
