import algosdk from "algosdk";

const ALGOD_URL = process.env.ALGOD_URL;
if (!ALGOD_URL) throw new Error("ALGOD_URL is not set — see .env.example");

export const algod = new algosdk.Algodv2("", ALGOD_URL, "");

export const USDC_TESTNET_ASA_ID = 10458941;

// The dispenser reuses the x402 resource server's own account (AVM_ADDRESS /
// RESOURCE_SERVER_PRIVATE_KEY) rather than standing up a third funded testnet
// account for the MVP. Deliberate simplification — see docs/implementation-notes.md.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

const DISPENSER_ADDRESS: string = requireEnv("AVM_ADDRESS");
const dispenserSk = new Uint8Array(Buffer.from(requireEnv("RESOURCE_SERVER_PRIVATE_KEY"), "base64"));

// Not specified in the PRD/tech-stack — chosen deliberately small: the floor
// is opt-in fee (0.001 ALGO) + the min-balance increase for holding one ASA
// (0.1 ALGO) = 0.101 ALGO. 0.3 ALGO leaves headroom for a few more tx fees
// (e.g. the sealed-bid submission in a later phase) without draining the
// dispenser fast — first version of this used 0.5 and emptied a 2-ALGO
// dispenser in under 4 sessions during testing. 1.00 USDC covers the $0.50
// entry + $0.05 hint fee with buffer.
const FUND_ALGO_MICROALGOS = 300_000;
const FUND_USDC_UNITS = 1_000_000;

export interface GeneratedKeypair {
  address: string;
  sk: Uint8Array;
}

export function generateKeypair(): GeneratedKeypair {
  const account = algosdk.generateAccount();
  return { address: account.addr.toString(), sk: account.sk };
}

export interface FundResult {
  groupTxId: string;
}

/**
 * Funds a freshly generated participant/agent wallet in one atomic group:
 * dispenser sends ALGO -> new account opts into USDC -> dispenser sends USDC.
 * Algorand executes grouped transactions in order with each seeing prior
 * group members' balance changes, so this is one submission and one ~3s
 * confirmation wait rather than three sequential round trips — the PRD's
 * "funded within 3 seconds" target doesn't survive three separate finalities.
 */
export async function fundNewAccount(newAddress: string, newAccountSk: Uint8Array): Promise<FundResult> {
  const suggestedParams = await algod.getTransactionParams().do();

  const fundAlgoTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: DISPENSER_ADDRESS,
    receiver: newAddress,
    amount: FUND_ALGO_MICROALGOS,
    suggestedParams,
  });

  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: newAddress,
    receiver: newAddress,
    amount: 0,
    assetIndex: USDC_TESTNET_ASA_ID,
    suggestedParams,
  });

  const fundUsdcTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: DISPENSER_ADDRESS,
    receiver: newAddress,
    amount: FUND_USDC_UNITS,
    assetIndex: USDC_TESTNET_ASA_ID,
    suggestedParams,
  });

  const group = algosdk.assignGroupID([fundAlgoTxn, optInTxn, fundUsdcTxn]);
  const signed = [group[0].signTxn(dispenserSk), group[1].signTxn(newAccountSk), group[2].signTxn(dispenserSk)];

  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 4);
  return { groupTxId: txid };
}
