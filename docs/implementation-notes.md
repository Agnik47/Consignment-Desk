# Implementation Notes — Phase 0 Repository Audit

**Written:** 21 Aug 2026, Phase 0 per `AGENTS.md` §7
**Exit criteria this doc satisfies:** actual package versions, confirmed x402 API shape, confirmed facilitator URL, confirmed Algorand Testnet config, unresolved issues.

This audit was done by `npm pack`-ing the real published packages and reading their shipped `.d.ts` files directly — not by trusting the code samples in `tech-stack.md`. Several of those samples turned out to be stale against the current v2.23.0 API. Corrections are called out explicitly below so nobody re-copies the wrong pattern from that doc.

---

## 1. Confirmed package versions (npm, live as of today)

| Package | Latest | Notes |
|---|---|---|
| `@x402/core` | 2.23.0 | dep: `zod@^3.24.2` |
| `@x402/avm` | 2.23.0 | dep: `@algorandfoundation/algokit-utils@10.0.0-alpha.46`, `@x402/core@~2.23.0` |
| `@x402/hono` | 2.23.0 | dep: `@x402/core@~2.23.0`, `@x402/extensions@~2.23.0`; peer: `hono@^4.0.0` (+ optional `@x402/paywall`) |
| `@x402/fetch` | 2.23.0 | client-side `fetch` wrapper — confirmed to exist (PRD appendix mentioned it, tech-stack.md didn't) |
| `@hono/node-server` | 2.1.1 | |
| `hono` | 4.13.3 | |
| `algosdk` | 3.7.0 | not a direct dependency of `@x402/avm` (that uses `algokit-utils`), but useful directly for keypair generation |
| `@algorandfoundation/algokit-utils` | pulled in transitively via `@x402/avm` at `10.0.0-alpha.46` | |
| `socket.io` / `socket.io-client` | 4.8.3 | for Phase 9 (UI), not needed yet |
| `qrcode.react` | 4.2.0 | for Phase 9 |
| `next` | 16.3.2 | for Phase 9 |
| `tailwindcss` | 4.3.3 | for Phase 9 |
| `dotenv` | 17.4.2 | |
| `typescript` | 7.0.2 | |
| `tsx` | 4.23.12 | |

All packages installed match `^2.23.0` at time of writing; pin with `~2.23.0` in `package.json` (matches `@x402/avm`'s own internal pinning strategy) so a minor bump mid-hackathon doesn't silently change behavior.

**Scope correction confirmed:** `@x402/*` (slash) is correct for `core`, `avm`, `hono`, `fetch`. No `@x402-avm/*` (hyphen) package was needed or installed.

---

## 2. Confirmed x402 API shape — and where `tech-stack.md`'s sample code is wrong

### Server side (api/)

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import type { RoutesConfig } from "@x402/core/server";

const facilitatorClient = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL! });

const server = new x402ResourceServer(facilitatorClient)
  .register(ALGORAND_TESTNET_CAIP2, new ExactAvmScheme());

const routes: RoutesConfig = {
  "/api/test-payment": {
    accepts: {
      scheme: "exact",
      network: ALGORAND_TESTNET_CAIP2,
      payTo: process.env.AVM_ADDRESS!,
      price: "$0.01",
    },
    description: "Phase 1 smoke test route",
  },
};

app.use(paymentMiddleware(routes, server));
```

**Corrections vs. `tech-stack.md`:**

1. **`registerExactAvmScheme` does not exist.** Neither `@x402/avm/exact/server` nor `@x402/avm/exact/client` export a `register*` helper function — each exports only the class `ExactAvmScheme`. You instantiate it and pass it to `.register(network, scheme)` on the `x402ResourceServer` / `x402Client` instance. The old doc's `registerExactAvmScheme(server)` call would fail to import.
2. **`paymentMiddleware`'s real signature is `(routes, server, paywallConfig?, paywall?, syncFacilitatorOnStart?)`** — it takes a pre-built `x402ResourceServer` instance, not `(paymentConfig, facilitatorClient, schemesArray)`. The config-first shape the old doc showed is closer to a different function, `paymentMiddlewareFromConfig(routes, facilitatorClients?, schemes?, ...)` — but even that takes `schemes: SchemeRegistration[]` as `{network, server}` pairs where `server` is a `SchemeNetworkServer` instance (e.g. `new ExactAvmScheme()`), not a registration function call. **Decision: use `paymentMiddleware` with an explicitly-built `x402ResourceServer`** — it's the pattern shown in the package's own JSDoc example and is the clearest to reason about.
3. **`RoutesConfig` route keys are paths only** (e.g. `"/api/test-payment"`), not `"METHOD /path"` strings — confirmed from the `RouteConfig`/`RoutesConfig` type shape (`Record<string, RouteConfig>`). The reference repo's README showed `'GET /my-api'` style keys in prose, which may be a display convention rather than the literal key — **verify against the reference repo's actual `endpoints.config.ts` source (not just its README) before final wiring**, flagged as open item below.
4. **`accepts` can be a single `PaymentOption` or an array** (`PaymentOption | PaymentOption[]`). The official reference repo's `endpoints.config.ts` uses an **array** with an explicit `extra: { asset: USDC_TESTNET_ASA_ID }` — meaning it does not rely on `price: "$X"` implicitly resolving to USDC by default and pins the asset explicitly. **We will do the same** (pin `extra.asset = USDC_TESTNET_ASA_ID` on every route) rather than trust implicit default-asset resolution.

### Client / agent side (agent/)

```typescript
import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner, ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { wrapFetchWithPayment } from "@x402/fetch";

const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);
const client = new x402Client().register(ALGORAND_TESTNET_CAIP2, new ExactAvmScheme(signer, {
  algodUrl: process.env.ALGOD_URL!,
}));

const fetchWithPay = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPay(`${API_URL}/api/test-payment`);
```

**Corrections vs. `tech-stack.md`:**

5. **There is no built-in `client.fetch()` method on `x402Client`.** The 402→sign→retry wrapping the old doc's sample attributed to `client.fetch(...)` actually lives in the separate `@x402/fetch` package, via `wrapFetchWithPayment(fetch, client)`. This matches the PRD appendix (which correctly listed `@x402/fetch` as the client library) but not `tech-stack.md`'s inline code sample (which invented a method that doesn't exist on the class). **Use `wrapFetchWithPayment`.**
6. `toClientAvmSigner(privateKeyBase64)` is confirmed correct and takes algosdk's native secret-key format: **base64-encoded 64-byte key = 32-byte seed + 32-byte public key** — i.e. exactly `algosdk.generateAccount().sk` base64-encoded. No separate mnemonic parsing needed.

### CAIP-2 network identifier — verified against the LIVE facilitator (supersedes an earlier draft of this note)

An earlier draft of this section concluded the opposite of what's below, reasoning from the CAIP-2 spec's short form alone rather than checking what the live facilitator actually advertises. Corrected after Phase 1's hard-gate run surfaced a real `RouteConfigurationError` — leaving the wrong version in place here would have cost someone else the same hour it cost me.

`GET https://facilitator.goplausible.xyz/supported` (queried live 21 Aug 2026) returns Algorand testnet as:
```
algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=
```
— the **full base64 genesis hash**, matching `tech-stack.md`'s original config table. `@x402/avm`'s exported `ALGORAND_TESTNET_CAIP2` constant is the **truncated 32-char form** per the CAIP-2 Algorand namespace spec (`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`) and does **not** match what this facilitator advertises.

Route registration (`x402ResourceServer.register(network, scheme)` → `x402HTTPResourceServer.initialize()`) does a **literal string match** against the facilitator's `/supported` response, with no normalization. Registering with the short `ALGORAND_TESTNET_CAIP2` constant against this facilitator throws `RouteConfigurationError: Facilitator does not support scheme "exact" on network "..."` at server startup — reproduced directly in `api/`.

**Fix applied in `api/src/x402.ts` and `agent/src/test-payment.ts`:** build the network id from the exported `ALGORAND_TESTNET_GENESIS_HASH` constant (`` `algorand:${ALGORAND_TESTNET_GENESIS_HASH}` ``) rather than the short-form `ALGORAND_TESTNET_CAIP2` — satisfies Rule 4 (no hand-typed hashes) while actually matching the live facilitator. **Do not use `ALGORAND_TESTNET_CAIP2` for this facilitator.** Server and client must register the identical string, or the client's 402 parsing / payload construction won't find a matching registered scheme either.

**Bonus finding from the same `/supported` response:** the Algorand entry includes `extra.feePayer`, meaning GoPlausible sponsors the fee-payer transaction — the paying account likely does not need its own ALGO for tx fees, only enough ALGO for USDC opt-in minimum balance plus the USDC itself. Confirm this empirically once a funded account is available (Phase 1 hard gate is not yet fully closed — see §6).

---

## 3. Facilitator — confirmed live

`https://facilitator.goplausible.xyz` responds and reports "All systems operational v2.0.0". Confirmed endpoints: `/verify`, `/settle`, `/health`, `/supported`, plus discovery routes. Confirmed supported networks: Algorand (AVM), Base (EVM), Solana (SVM), each with mainnet/testnet — Algorand testnet is in scope. `HTTPFacilitatorClient` must be constructed with `{ url: process.env.FACILITATOR_URL }` explicitly — its default target is `x402.org/facilitator`, which does not settle Algorand (per `tech-stack.md`, and consistent with the SDK not hardcoding GoPlausible).

USDC testnet ASA id confirmed: `10458941`, 6 decimals (matches `tech-stack.md`; also present as `USDC_TESTNET_ASA_ID` exported from `@x402/avm`).

---

## 4. Algorand Testnet config — confirmed

```bash
ALGOD_URL=https://testnet-api.algonode.cloud
FACILITATOR_URL=https://facilitator.goplausible.xyz
```

`ALGORAND_TESTNET_CAIP2` and `ALGORAND_TESTNET_GENESIS_HASH` are both exported constants from `@x402/avm` root — import them, don't hardcode (see §2 correction above).

---

## 5. Reference contract scaffold (`algokit init example digital-marketplace-smart-contract`) — bigger delta than the PRD implies

**Not yet run** — Phase 6 per `AGENTS.md` ordering ("Only after the x402 path is proven"). Researched via the AlgoKit examples doc site only. Findings relevant to planning:

- State is `BoxMap`-based: `deposited` (per-user ALGO balance), `sales` (active listings by seller+asset), `receipt_book` (per-user bid records).
- Bidding flow is **`bid()` → `accept_bid()`**: bids must exceed the current highest, and the **seller manually calls `accept_bid()`** to settle — there is no auction deadline, no sealed/hidden commitment, and no automatic close.
- **This means the PRD's framing — "bid comparison changed from highest wins to closest-to-target wins" — undersells the actual delta.** The scaffold has no concept of: a bidding deadline, a hidden-target commit/reveal, an automatic reveal-triggered settlement, or a tie-break rule. All four are net-new contract logic on top of the fork, not a one-line comparator swap. Flagging this now, per `AGENTS.md` Phase 0 exit criteria ("unresolved issues"), so it's sized correctly before Friday 21:00's contract-deployment checkpoint rather than discovered mid-build.
- This raises the real risk already named in the PRD's own cut rule (§6): if the modified contract logic isn't tractable by 21:00, fall back to backend-computed winner + a plain atomic transfer for settlement, preserving the x402 differentiator.

---

## 6. Unresolved issues (blocking items carried from PRD §7, not resolved by this audit)

1. ~~Route key format in `RoutesConfig`~~ **Resolved.** Bare paths (`"/api/test-payment"`, no method prefix) are correct — confirmed live: the server started, registered the route, and returned a well-formed `402` with a valid `PAYMENT-REQUIRED` header (decoded and checked: correct `network`, `amount: "10000"` for $0.01 at 6 decimals, correct `asset`/`payTo`).
2. ~~Testnet funding path~~ **Resolved 21 Aug 2026.** Funding chain used: `algokit dispenser login` (GitHub OAuth device flow, human-completed) → `algokit dispenser fund` (2 ALGO to each address) → `agent/src/optin.ts` (new utility; opts an address into an ASA) run against both addresses for USDC `10458941` → [Circle's public testnet faucet](https://faucet.circle.com/) (no login required, supports Algorand Testnet directly in its network selector) for 20 USDC to the paying agent. All four steps confirmed on-chain via the public indexer before proceeding, not just trusted from CLI output.
3. **Phase 1 hard gate — PASSED, verified independently.** `agent/src/test-payment.ts` ran 402 → sign → facilitator settle → 200. Cross-checked against `https://testnet-idx.algonode.cloud` directly (not just the script's own report): confirmed round `66535100`, `asset-transfer-transaction` for `10000` units of asset `10458941` from the paying agent to the resource server, note field decodes to `x402-payment-v2-1787335827153` (a genuine x402 protocol marker), and **`fee: 0`** — empirically confirming the Phase 0 "bonus finding" that GoPlausible sponsors the fee-payer transaction. Balances moved exactly as expected (payer `20.00 → 19.99 USDC`, resource server `0 → 0.01 USDC`). Transaction: [Lora explorer](https://lora.algokit.io/testnet/transaction/SWUJKNFNLMUSZ3PDII2QIXNKFAW5PSZC3RDR6HIGX5VSL53KEJYQ).
3. **Agent brain: heuristic vs. LLM** — not decided yet; `tech-stack.md` recommends heuristic-first. Not blocking for Phase 1 (no agent decision logic needed yet, just a raw payment smoke test). Will decide at Phase 5.
4. **"Who is your agent" during judging** — team decision, doesn't block any Phase 0/1 engineering.

---

## 7. `.env.example` — created

See `/.env.example` at repo root. Values for `AVM_ADDRESS` / `AVM_PRIVATE_KEY` are placeholders generated fresh per §6 item 2 above; they are **unfunded** until a human completes the dispenser/faucet step.
