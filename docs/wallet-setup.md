# Wallet Setup — Algorand Testnet

How to create, fund, and wire in the testnet wallets this project needs. Follow this whenever a new person is setting up their own local `.env`, or when a wallet's private key has been lost and needs replacing.

---

## The two wallet roles

This project uses two distinct wallets. They are not interchangeable — mixing them up breaks the x402 payment flow.

| Role | Env vars | What it does |
|---|---|---|
| **Resource server** | `AVM_ADDRESS`, `RESOURCE_SERVER_PRIVATE_KEY` | The app's own wallet (`api/`). It **receives** x402 payments (entry fee, hint fee), and doubles as the "dispenser" that funds newly-created participant session wallets (`api/src/chain.ts`). |
| **Agent / payer** | `AVM_PRIVATE_KEY` | A wallet that **pays** x402 fees on someone's behalf (`agent/`) — used for manual testing (`agent/src/test-payment.ts`, `npm run dev:agent`). |

> [!WARNING]
> `AVM_ADDRESS` is the resource server's *receiving* address. Overwriting it with an agent wallet's address will misroute where the app expects payments to land. Only ever set `AVM_ADDRESS` together with its matching `RESOURCE_SERVER_PRIVATE_KEY`.

**Real demo participants don't need any of this.** When someone scans the QR code, `POST /api/session` auto-generates and auto-funds their wallet server-side (funded from the resource-server dispenser, in one atomic group). The manual process below is only for the resource-server wallet itself and for dev/test agent wallets.

---

## Prerequisites

- Node 22+, dependencies installed (`npm install` from repo root, once)
- [AlgoKit CLI](https://dev.algorand.co/algokit/algokit-intro/) installed (`algokit --version` to check)

---

## Step-by-step: create one wallet

Repeat this whole sequence once per wallet you need (once for the resource server, once per agent/test wallet).

### 1. Generate a keypair

```bash
npm run keygen --workspace agent
```

Prints:
```
address:    <58-char Algorand address>
secretKey:  <base64-encoded secret key>
mnemonic:   <25-word mnemonic>
```

> [!IMPORTANT]
> **Save the `secretKey` immediately.** It is printed exactly once and cannot be recovered from the address afterward. Losing it means generating a brand-new wallet from scratch — see [Recovering from a lost key](#recovering-from-a-lost-key) below.

### 2. Log into the AlgoKit testnet dispenser (one-time per machine)

```bash
algokit dispenser login
```

Opens a device-code browser flow. Only needs to be done once per machine, not once per wallet.

### 3. Fund it with testnet ALGO

```bash
algokit dispenser fund -r <ADDRESS> -a 2 --whole-units
```

2 ALGO is comfortably more than the ~0.3 ALGO floor (base min-balance + USDC opt-in + product-ASA opt-in) plus transaction fees.

### 4. Opt the wallet into testnet USDC

Required before the wallet can hold or receive USDC (ASA `10458941`). Needs ALGO in the wallet first (step 3).

```bash
cd agent
npx tsx src/optin.ts <ADDRESS> <SECRET_KEY_BASE64>
```

### 5. Get testnet USDC into the wallet

Only the **resource server** and **agent/payer** wallets need this (a resource server needs USDC on hand to fund new session wallets; an agent needs USDC to actually pay fees).

**Option A — Circle's faucet (no extra setup):**
Go to https://faucet.circle.com, select **Algorand Testnet**, paste the address, submit. Delivers 20 USDC.

**Option B — transfer from an already-funded wallet you control:**
If you already hold another wallet's private key with spare USDC, send some directly on-chain instead of hitting the faucet again — see [scripts/send-usdc-example.md](#appendix-scripted-usdc-transfer) below.

### 6. Verify on-chain

```bash
curl -s "https://testnet-api.algonode.cloud/v2/accounts/<ADDRESS>" | python3 -m json.tool
```

Check `amount` (microAlgos) and the `assets` array for an entry with `asset-id: 10458941` (USDC, 6 decimals — divide by `1_000_000` for dollars).

### 7. Wire it into `.env`

Copy `.env.example` to `.env` if you haven't already. Then, depending on the wallet's role:

**Resource server:**
```bash
AVM_ADDRESS=<address>
RESOURCE_SERVER_PRIVATE_KEY=<secretKey>
```

**Agent / payer:**
```bash
AVM_PRIVATE_KEY=<secretKey>
```

### 8. Sanity-check

```bash
npm run dev:api
curl -i http://localhost:4021/api/test-payment
```

A real `HTTP/1.1 402 Payment Required` with a `payment-required` header confirms the resource-server wallet is correctly configured.

> [!NOTE]
> The full API also requires `BIDDING_ROOM_APP_ID` (and related contract env vars) from a deployed BiddingRoom contract — a separate setup step (`npm run deploy:testnet`, needs a funded `TREASURY_MNEMONIC`), not part of wallet funding. The API will fail to boot without it even if both wallets above are correctly configured.

---

## Setting up multiple wallets

Once the **resource-server wallet** itself is funded (steps 1–7 above, done once), you don't need to repeat the manual AlgoKit-login / Circle-faucet dance for every additional wallet — it can fund others directly.

### Recommended: batch-provision with `scripts/provision-wallets.ts`

```bash
npm run provision-wallets -- <count> [outFile]
# e.g.
npm run provision-wallets -- 5 wallets.generated.json
```

This generates `<count>` fresh keypairs and funds each one — ALGO, USDC opt-in, and USDC — in a single atomic transaction group per wallet, drawn straight from the resource server's own balance (`AVM_ADDRESS` / `RESOURCE_SERVER_PRIVATE_KEY` in `.env`). It's the exact same funding primitive `api/src/chain.ts` uses for real session wallets, just callable in bulk from the command line.

- It checks the dispenser's ALGO and USDC balance **before** starting, and refuses the whole batch with a clear shortfall message rather than funding some wallets and failing partway through.
- Results (address, secret key, mnemonic, funding tx id) are written to `outFile` (default `wallets.generated.json`) — gitignored, but treat it as a credentials file, same as `.env`.
- If the dispenser itself runs low, top it up the same way you funded it originally: `algokit dispenser fund` for ALGO, https://faucet.circle.com for USDC.

### When you don't need to provision anything manually

- **Real demo participants** are auto-provisioned by `POST /api/session` at QR-scan time, using this same funding logic inside the running API — no script needed.
- **`npm run test:e2e`** provisions and funds its own two agent wallets automatically as part of the harness.

### Manual fallback

If you'd rather not draw from the resource-server's balance (e.g. you want a wallet independent of this project's dispenser), repeat steps 1–7 above per wallet instead, funding each from AlgoKit's dispenser / Circle's faucet directly.

---

## Recovering from a lost key

If a wallet's address is on record (e.g. in `.env` or docs) but its secret key was never saved, **it cannot be recovered** — a private key is not derivable from its address. Before assuming it's lost, check:

```bash
grep -rn "<ADDRESS>" ~/.zsh_history ~/.bash_history 2>/dev/null
git log --all -p | grep -B2 -A2 "<ADDRESS>"
grep -rl "<ADDRESS>" . --exclude-dir=node_modules --exclude-dir=.git
```

If nothing turns up, generate a fresh wallet (steps 1–7 above) and update `.env` to match the new address. This happened during initial project setup — the original `AVM_ADDRESS` had no matching `RESOURCE_SERVER_PRIVATE_KEY` saved anywhere, so a new resource-server wallet was generated to replace it.

---

## Appendix: scripted USDC transfer

Useful when you already hold a funded wallet's private key and don't want another manual faucet round-trip. Run from inside `agent/src/` (or anywhere `algosdk` resolves) so imports work, then delete it:

```typescript
import algosdk from "algosdk";

const ALGOD_URL = "https://testnet-api.algonode.cloud";
const USDC_ASA_ID = 10458941;

const SENDER_ADDR = "<funded wallet address>";
const SENDER_SK = new Uint8Array(Buffer.from("<funded wallet secretKey base64>", "base64"));
const RECEIVER_ADDR = "<destination address>";
const AMOUNT_USDC_UNITS = 5_000_000; // 5.00 USDC

const algod = new algosdk.Algodv2("", ALGOD_URL, "");
const suggestedParams = await algod.getTransactionParams().do();

const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: SENDER_ADDR,
  receiver: RECEIVER_ADDR,
  amount: AMOUNT_USDC_UNITS,
  assetIndex: USDC_ASA_ID,
  suggestedParams,
});

const signed = txn.signTxn(SENDER_SK);
const { txid } = await algod.sendRawTransaction(signed).do();
await algosdk.waitForConfirmation(algod, txid, 4);
console.log(`sent: https://lora.algokit.io/testnet/transaction/${txid}`);
```

Save as an `.mts` file (top-level `await` needs ESM), run with `npx tsx <file>.mts`.
