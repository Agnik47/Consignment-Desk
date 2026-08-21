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
4. **Agent brain: heuristic vs. LLM** — not decided yet; `tech-stack.md` recommends heuristic-first. Not blocking for Phase 1 (no agent decision logic needed yet, just a raw payment smoke test). Will decide at Phase 5.
5. **"Who is your agent" during judging** — team decision, doesn't block any Phase 0/1 engineering.

---

## 7. `.env.example` — created

See `/.env.example` at repo root. Values for `AVM_ADDRESS` / `AVM_PRIVATE_KEY` are placeholders generated fresh per §6 item 2 above; they are **unfunded** until a human completes the dispenser/faucet step.

---

## 8. Phase 2 — Wallet Provisioning findings (21 Aug 2026)

**`POST /api/session`** implemented (`api/src/chain.ts`, `api/src/sessions.ts`, route in `api/src/index.ts`). Generates a keypair, funds it from a server-held dispenser account, stores the private key server-side only, returns `{sessionId, address, agentId, createdAt}` — no `sk` field, ever. Session id also set as an `HttpOnly`/`SameSite=Lax` cookie; a repeat request carrying that cookie returns the existing session instead of minting and funding a new wallet (checked live — second call returned in 74ms vs. 5s for the first).

**Dispenser design decision:** reused the x402 resource server's own account (`AVM_ADDRESS` / `RESOURCE_SERVER_PRIVATE_KEY`) as the session-funding dispenser, rather than standing up a third funded account. Simplest defensible choice for an MVP with one demo room; revisit only if the revenue-vs-treasury conflation becomes an actual problem.

**Real finding — funding an account atomically, not sequentially.** Funding requires three logically-dependent operations (send ALGO → new account opts into USDC → send USDC), and running them as three separate transactions would cost three separate confirmation waits against Algorand's real ~3s block time — nowhere near the PRD's "funded within 3 seconds" bar. Algorand's atomic transaction groups execute members in order with each seeing prior members' balance changes within the *same* group, so `fundNewAccount()` builds and submits all three as one group, one signature round (dispenser signs 2, the new account signs its own opt-in), one confirmation wait. This is exactly the kind of complexity that "looks like one line but isn't" — worth naming explicitly rather than discovering as three sequential await calls later.

**Real finding — the 3-second target is not achievable against public testnet, and that's fine.** Measured **5.0–6.1s** for `POST /api/session` across five live runs, consistently — not a fluke, not a bug. Algorand testnet's block time is ~2.8–3.3s; waiting for one transaction group's confirmation can cost up to two full rounds depending on submission timing relative to the round boundary, so a hard "under 3s" ceiling isn't physically achievable for "wait until actually confirmed and spendable," regardless of implementation. This technically misses the narrow P0-1 acceptance-criterion bullet, but comfortably fits inside the PRD's actual judged demo metric (§6: "Time from QR scan to agent assigned," success `<20s`, stretch `<10s`, for the *whole* flow — of which wallet funding is one step). Not treating this as a blocker; flagging as a known, measured gap between one specific written bullet and physical reality. If the 3s bullet turns out to matter more than it currently seems to, the fix is pre-provisioning a small pool of already-funded wallets ahead of time (pop-from-pool is instant) rather than funding synchronously per request — not built now since it's real added infrastructure nobody has asked for yet.

**Real finding — funding amount tuning, caught by actually running the integration test twice.** First version funded each session with 0.5 ALGO; the *second* funding call already made the dispenser's spendable balance too thin, and the integration test's third `fundNewAccount` call failed with a real `overspend` error from algod (not a mock — this only surfaces by actually submitting to the network, which is why `AGENTS.md` Rule 2 bans mocking this layer even in "should be fine" cases). Root-caused to the amount being needlessly generous: opt-in fee (0.001 ALGO) + one ASA's min-balance increase (0.1 ALGO) is the real floor. Reduced to 0.3 ALGO/session (still ~0.2 ALGO of headroom) and topped up the dispenser via `algokit dispenser fund` (also surfaced a real, useful constraint: the AlgoKit community dispenser enforces a **daily** fund limit per account, checkable with `algokit dispenser limit` — currently not a concern at 0.3 ALGO/session, but would matter for a long rehearsal day with many resets).

**Tests** (`api/src/chain.test.ts`, `api/src/sessions.test.ts` — `npm test`, all mocked-network unit tests, run in ~1.4s; `api/src/chain.integration.test.ts` — `npm run test:integration`, real testnet, ~5.6s) cover every bullet AGENTS.md Phase 2 lists: unique wallet per session, wallet is actually funded (integration test asserts real on-chain balances), address validity (`algosdk.isValidAddress` against a real unmocked keypair), private key never in the returned JSON, and private key never logged — on both the success path and a simulated funding-failure path.

---

## 9. Phase 3 — Room and Product State findings (21–22 Aug 2026)

**`api/src/rooms.ts`** implemented: one deterministic singleton room (`demo-room` / `demo-product`, module-level state, no `Map` — a `Map` keyed by room id would be premature generality for something `AGENTS.md` explicitly says never grows past one entry). Room status is a guarded 5-state machine (`CREATED → OPEN → BIDDING_CLOSED → REVEALING → SETTLED`) driven by an explicit transition table — invalid moves (skipping ahead, going backward, anything after `SETTLED`) throw rather than silently succeeding. New read-only route: `GET /api/room/:id` (unauthenticated, matching `tech-stack.md`'s architecture table which lists `/room/:id` as an open route distinct from Phase 4's x402-gated ones).

**Interpretation call, stated rather than silently assumed:** `AGENTS.md`'s Phase 3 field list puts `startTime`/`deadline`/`status` under "Product," but the very next section is titled "Room states" for the same three concepts. Modeled them on **Room**, not duplicated onto Product — one lifecycle, one place it can drift out of sync from itself. `deadline` is computed when `openRoom()` actually runs (`startTime + biddingWindowMs`), not at process boot, since a boot-time deadline would already be stale if the server starts hours before the demo does.

**Demo content invented, not specified anywhere:** name/description/attributes/hint text for `demo-product` don't appear in any doc. Picked a sealed vintage camera (justifies "condition unconfirmed, appraise it" naturally) using the **exact** `$20 base / $29 hidden target` figures `AGENTS.md` §5 already gives as its own worked example, rather than inventing new numbers that would then disagree with that section.

**Commit-reveal, implemented literally then made unambiguous:** `commitment = SHA-256(target || nonce)` per `AGENTS.md` §5, serialized as `` `${target}:${nonce}` `` — an explicit delimiter rather than bare concatenation. With a fixed-length (32-byte) nonce this is moot in practice, but costs nothing and removes any doubt about `target=2,nonce="9…"` vs. `target=29,nonce="…"` colliding.

**Verified live, not just unit-tested:** `GET /api/room/demo-room` → `200`, correct `CREATED` status, `commitment` present, and — checked explicitly, not assumed — `hint`, `hiddenTarget`, `targetNonce` all structurally absent from the response body. `GET /api/room/anything-else` → `404` with a clear message (there is genuinely only one room; pretending otherwise would be dishonest, not friendlier). Regression-checked Phase 1's `/api/test-payment` and Phase 2's `/api/session` still behave correctly after wiring the new route into the same Hono app.

**False alarm worth recording so it isn't re-investigated:** the first live check of the new route appeared to show a mangled em-dash (`â€”`) in the product description — looked exactly like a real double-UTF-8-encoding bug. Traced it by comparing raw bytes at each hop: the source file (`rooms.ts`) was correctly UTF-8 encoded, and the raw HTTP response bytes from curl were *also* correctly UTF-8 encoded (`\xe2\x80\x94`, the right em-dash bytes). The mangling was introduced entirely by `curl | python -m json.tool` in this Windows/Git-Bash environment — a verification-tooling artifact, not a product bug. Worth remembering before re-diagnosing the same false trail later: check raw response bytes directly (`curl -o file` + read as binary) rather than trusting a `json.tool`-prettified pipe on this setup.

**Tests** (`api/src/rooms.test.ts`, 12 cases, unit-level, no network — `npm test`): commitment round-trips correctly and rejects a tampered target or nonce; the public view is checked structurally (not just "doesn't include field X" but "the serialized JSON doesn't contain the secret values anywhere") for leaking `hiddenTarget`/`targetNonce`/`hint`, while confirming `commitment` **is** exposed (that's the point of committing publicly); the full valid transition sequence succeeds; skipping ahead, moving backward, and transitioning past `SETTLED` are all rejected; `deadline` is verified to be relative to actual open-time, not a fixed offset.
