import algosdk from "algosdk";

// One-off Phase 1 admin utility: opts an account into an ASA (default: testnet
// USDC, 10458941) so it can subsequently receive that asset. An account must
// hold ALGO before it can opt in (the opt-in itself is a 0-amount self-transfer
// and costs a normal tx fee) — run `algokit dispenser fund` first.
//
// Usage: tsx src/optin.ts <address> <base64-secret-key> [assetId]

const ALGOD_URL = process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";
const USDC_TESTNET_ASA_ID = 10458941;

const [, , addressArg, secretKeyArg, assetIdArg] = process.argv;
if (!addressArg || !secretKeyArg) {
  console.error("Usage: tsx src/optin.ts <address> <base64-secret-key> [assetId]");
  process.exit(1);
}

const assetId = assetIdArg ? Number(assetIdArg) : USDC_TESTNET_ASA_ID;
const sk = new Uint8Array(Buffer.from(secretKeyArg, "base64"));

const algod = new algosdk.Algodv2("", ALGOD_URL, "");

const info = await algod.accountInformation(addressArg).do();
const alreadyOptedIn = info.assets?.some((a) => Number(a.assetId) === assetId);
if (alreadyOptedIn) {
  console.log(`${addressArg} is already opted in to asset ${assetId}.`);
  process.exit(0);
}

const suggestedParams = await algod.getTransactionParams().do();
const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: addressArg,
  receiver: addressArg,
  amount: 0,
  assetIndex: assetId,
  suggestedParams,
});

const signed = txn.signTxn(sk);
const { txid } = await algod.sendRawTransaction(signed).do();
console.log(`opt-in submitted: ${txid}`);
await algosdk.waitForConfirmation(algod, txid, 4);
console.log(`${addressArg} opted in to asset ${assetId}. https://lora.algokit.io/testnet/transaction/${txid}`);
