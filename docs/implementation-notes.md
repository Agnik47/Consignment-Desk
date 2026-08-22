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

---

## 10. Phase 4 — x402 Room Entry findings (22 Aug 2026)

**The real design problem this phase turns on:** `AGENTS.md`'s Phase 4 acceptance test describes a direct HTTP round trip — call `/api/room/:id/enter` unpaid, get `402`, pay, get `200` — but `AGENTS.md` §4 also requires the browser never hold a private key, and Phase 2 already made wallets fully custodial. Those two requirements only fit together if something *other than the browser* plays the role of "the client that signs and retries" — and that something has to be our own server, acting through the session's stored key.

**Architecture landed on:** two distinct endpoints, not one.
- `POST /api/room/demo-room/enter` — the actual x402-gated resource (`api/src/x402.ts`), registered in `RoutesConfig` exactly like Phase 1's test route. It knows nothing about sessions; its only job is "did a real payment settle." Curling it directly, unpaid, still returns a real `402` — the PRD's literal acceptance bullet holds regardless of how anything else is wired.
- `POST /api/session/enter` — the actual browser-facing action (`api/src/entry.ts` + a thin route in `index.ts`). Reads the session cookie, then makes a **genuine loopback HTTP call** to the gated route above using an `x402Client` built from that session's own stored key (`toClientAvmSigner` + `wrapFetchWithPayment`, the exact same pattern `agent/src/test-payment.ts` proved in Phase 1). All business logic — idempotent reuse, recording the participant, opening the room — lives here, in the orchestrator, which already has full context; the gated route stays a pure, reusable, honestly-testable checkpoint.

Chose the real network loopback over an in-process shortcut deliberately: it reuses `wrapFetchWithPayment`'s tested 402-parsing and retry logic rather than re-implementing it, and it means the gated route can never silently drift from what an external caller would actually experience.

**Real edge case, caught by actually racing it, not just reasoning about it:** a double-click (or any concurrent duplicate call) to `/api/session/enter` could race past the "already entered?" check before the first request finishes paying, double-charging the same session. Fixed with an in-flight lock (`Set<string>` of sessionIds mid-entry). Verified live by literally firing two simultaneous `curl` requests at a fresh session: one got a real `200` with a real settled payment, the other got `409 ENTRY_IN_PROGRESS` — confirmed on the actual server, not assumed from reading the code.

**Room-opening trigger, an assumption stated rather than invented silently:** nothing in the docs says what causes `CREATED → OPEN`. Decided: the *first* entry attempt opens the room (`rooms.ensureOpenForEntry()`), setting the deadline from that moment — checked **before** attempting payment, so a room that can't accept entries is never charged against.

**Verified live, four ways:**
1. Direct unpaid `POST /api/room/demo-room/enter` → `402`, decoded: `amount: "500000"` ($0.50), correct `payTo`/asset — the entry price is right.
2. Full flow (create session → `/api/session/enter`) → `200`, `entryTxId` present, room auto-transitioned `CREATED → OPEN` with a correct `deadline`.
3. Settlement cross-checked on the public indexer independent of the app's own report: `sender` is exactly the session's own address, correct amount, `fee: 0` (facilitator sponsored again, consistent with Phases 1–2).
4. Repeat call with the same session cookie → `200` in 93ms, identical `entryTxId` — no second payment. A wrong room id on the gated route → `404`, not `402` — never take money for a room that doesn't exist.

**A real bug caught in my own test, not the product code:** an early version of `rooms.test.ts`'s "no leak" test asserted the serialized public view never contains the string `"29"` (the hidden target). It failed intermittently — not because the target leaked, but because `"29"` is short enough to occasionally appear as a coincidental substring of the (legitimately public) commitment hash, e.g. `...d29c44...`. Confirmed by running the suite three times after removing that specific assertion (kept the structural `toHaveProperty` checks, which are the real, reliable guarantee, and the 64-char nonce substring check, whose collision odds are actually negligible). Worth a comment in the test itself so nobody "fixes" it back to the flaky version.

**Tests:** `api/src/entry.test.ts` (3 cases, unit-level, no network) covers every early-exit path that doesn't touch the x402/algod machinery — unknown session, idempotent reuse, room-not-open — mocking `sessions.ts`/`rooms.ts` per Rule 2 (mocks only for isolated unit tests). `api/src/entry.integration.test.ts` (real testnet, ~11s, requires the dev server already running since it exercises the same loopback a real request would) covers the full paid path plus idempotent re-entry, end to end.

---

## 11. Phase 5 — Agent Client findings (22 Aug 2026)

**This is P0-3 — the requirement the PRD flags as never-cut.** `GET /api/product/demo-product/hint` is x402-gated at `$0.05`, and an agent pays for it *itself*, mid-decision, with no human in the path.

### What landed

- **`agent/src/brain.ts`** — the valuation logic. Pure and deterministic: no I/O, no clock, no randomness, no dependencies. Exports personas, `confidence()`, `estimate()`, `shouldBuyHint()`, `personaForAgentNumber()`.
- **`api/src/agents.ts`** — the worker: `analyzing → buying_hint (conditional) → thinking → bid_submitted`, with a `failed` status carrying a reason rather than letting an agent silently vanish.
- **`api/src/bids.ts`** — one bid per agent, deadline-enforced.
- **`api/src/x402client.ts`** — the 402→sign→retry client mechanics, extracted from `entry.ts` because the hint purchase became a genuine second caller (not speculative dedup — two real callers, non-trivial shared logic).

### Deviation from AGENTS.md §3, stated not hidden

The documented layout implies agents are separate processes. They run as **in-process workers** instead: §4 requires wallets stay server-managed and a session's signing key never leave this process, so a separate process would need either an IPC key bridge or its own unrelated wallet — and §4 explicitly warns against the latter. `tech-stack.md`'s own wording ("one process/**worker** per persona… no IPC bridge") supports this reading. The pure brain still lives at `agent/src/brain.ts` as documented, imported by relative path so it stays independently testable and reusable (PRD P2-3's "third-party agents slot in" seam).

### The heuristic, and why its numbers are what they are

`estimate = baseValue + category + era + packaging + condition`, then scaled by a persona bias. `condition` contributes **0 until a hint reveals it** — that's the entire mechanism by which paying for information changes the number. Confidence is a weighted count of known value-drivers, with `condition` weighted highest (0.45) precisely because it's the unknown the hint sells.

The demo outcome, computed before any code was written and then confirmed live:

| agent | persona | buys hint? | bid | distance from $29 | distance had it *not* bought |
|---|---|---|---|---|---|
| agent-1 | conservative | no | 24.38 | 4.62 | — |
| agent-2 | balanced | **yes** | 28.70 | **0.30** ← winner | 2.50 |
| agent-3 | aggressive | **yes** | 29.85 | 0.85 | 1.44 |

Both information-buyers beat the non-buyer, the winner bought information, and each buyer would have done *worse* without it — that's PRD G4 ("the agent's spending decision visibly changes the outcome") holding, not asserted. `agent/src/brain.test.ts` locks all four of those properties as tests, so a future heuristic tweak that breaks the story fails loudly here instead of on stage.

**Honesty (AGENTS.md Rule 5):** this is a scoring function, not an LLM, and the tuning above is deliberate. That is not cheating — AGENTS.md Phase 11 *requires* determinism ("randomness must not decide whether the demo succeeds"). Say on stage that the valuation is a documented heuristic and that the autonomous part worth watching is the **payment decision**, not the arithmetic.

**The agent's budget is real, not nominal.** `shouldBuyHint` is fed the agent's actual on-chain USDC balance (`chain.getUsdcBalance`), so an agent that genuinely can't afford a hint declines for a real reason.

### Verified live, with independent on-chain evidence

Full three-agent cast run end to end against testnet:
- `agent-1` (conservative) declined the hint, finished in **1s** — no payment at all.
- `agent-2` and `agent-3` each **autonomously bought a hint**, confidence jumping `0.47 → 0.92`, each taking ~5s (real settlement time).
- Both hint purchases cross-checked on the public indexer, independent of our own app's report: `50000` micro-USDC (`$0.05`) each, asset `10458941`, **sender = each agent's own wallet address**, `fee: 0` (facilitator-sponsored, consistent with Phases 1/4), note `x402-payment-v2-…`. Rounds 66536561 and 66536563.
- Structured logs match AGENTS.md §10's requested shape exactly (`[agent] …status=buying_hint`, `[x402] agent=… amount=$0.05 tx=…`, `[bid] agent=… amount=…`).

**Sealed bids verified, not assumed.** The public room view was probed for every bid amount (`28.7`, `24.38`, `29.85`), the target, the nonce, any `amount` key, and the hint's content — all absent. `api/src/agents.test.ts` locks this as a whitelist test so a future field addition can't quietly leak a bid.

Guard rails confirmed live: re-running a finished agent → `409 ALREADY_BID`; running for a session that never entered → `409 NOT_ENTERED`; no session cookie → `400 NO_SESSION`.

### Real operational constraint — testnet funding is scarce, and it bit

The AlgoKit community dispenser enforces a **daily per-account cap** (~10 ALGO), and each session **permanently locks 0.2 ALGO** in min-balance (0.1 base + 0.1 for holding one ASA) for as long as it holds USDC. A full integration run costs ~5 sessions. Today's cap was exhausted mid-suite, and `POST /api/session` began failing with a real algod error: `account … balance 97000 below min 200000`.

Two things worth recording:
1. **This is not a code defect** — the funding path is correct; the funder is empty. Confirmed from the raw algod message, not inferred. Incidentally it also served as an unplanned real-world test of Phase 2's failure path, which behaved correctly: caller got a clean `SESSION_FUNDING_FAILED`, the actual reason went to the log, nothing hung and no key was logged.
2. **Mitigations applied now:** per-session funding tightened `0.3 → 0.25 ALGO` (measured floor is ~0.201, so this is still ~50 transactions of headroom), and `agents.integration.test.ts` was cut from three sessions to **two** — because the only thing that *needs* proving on-chain is "non-buyer pays nothing, buyer settles a real payment, buyer lands closer," which takes one of each. Three-persona coverage is proven for free in the pure brain tests. Cheaper *and* better-targeted.

**Known gap, for Phase 11 (demo mode):** session keys live only in process memory, so a server restart **strands** the ALGO locked in those accounts permanently. Before demo day this needs either pre-provisioned reusable wallets or a close-out/reclaim step that returns a spent session's balance to the dispenser. Flagging now rather than discovering it at 08:30 on Sunday with a rate-limited faucet.

### Test status, stated precisely

- `agent/` — **22/22 passing** (pure brain, no network, ~1.2s), including four tests that guard the demo story itself.
- `api/` — **36/36 unit tests passing** (~2.8s), including the sealed-bid whitelist.
- `api/` integration — `chain` and `entry` suites **passed**. `agents.integration.test.ts` is written and typechecks, but **has not completed a green run**: the dispenser's daily cap was exhausted before it could. The behaviour it asserts *was* verified manually with the on-chain evidence above; the automated version is pending fresh testnet funds. Recorded as not-yet-green rather than counted as passing.

---

## 12. Phase 6 — Smart Contract findings (22 Aug 2026)

`contracts/bidding_room/contract.py` — a purpose-built Algorand Python (algopy) contract implementing sealed-bid, closest-guess-wins escrow with atomic settlement. **7/7 tests passing against real LocalNet**, verified stable across two consecutive runs.

### Decision: written from scratch, not forked from the marketplace example

Phase 0's audit had already found the `digital-marketplace-smart-contract` scaffold has **no deadline, no sealed bid, no commit-reveal, and manual (non-atomic) settlement** — its core mechanic is "highest bid, seller manually accepts", which is structurally the opposite of what this room needs. Retrofitting would have meant deleting most of it. Written fresh using the same idiomatic patterns (BoxMap escrow, inner-transaction settlement) but with the actual required semantics. This diverges from the PRD's literal "forked from…" wording — recorded here rather than glossed over.

### Toolchain: a real version trap

`pip install algorand-python` gives the **stubs** (4.0.0) but `pip install puya` gives a compiler pinned at **0.6.0** — years apart. Compiling with that pair produces a wall of nonsense errors (`not a subclass of puyapy.Contract`, `Unsupported function decorator "algopy._hints.subroutine"`, `FATAL Unhandled puyapy name`) that all look like code bugs and are not. The fix is to let AlgoKit manage the compiler: install `pipx`, then `algokit compile py …`, which fetches the matched **puyapy 5.10.0**. Everything compiled first try afterward. Anyone debugging "impossible" algopy errors should check `pip show puya` against `algorand-python` before touching the contract.

### Contract surface

| Method | Purpose |
|---|---|
| `bootstrap` | Opts the app into USDC, mints a 1-unit product ASA it holds in escrow, records room terms |
| `open_room` | Seller-only; sets the bidding deadline |
| `commit_bid` | Escrows a fixed stake against `sha256(guess‖nonce)`; one per account, pre-deadline only |
| `reveal_bid` | Verifies a commitment post-deadline and records the guess in the clear |
| `settle` | Verifies the room's target commitment, picks the winner, pays out, refunds losers — atomically |
| `noop` | Carries resource references only (see below) |

**On "sealed":** every bidder escrows the *same* fixed stake regardless of guess. The guess is hidden; the payment amount is not, and could not be — Algorand's ledger is public. This is demo-grade commit-reveal exactly as AGENTS.md Rule 6 requires us to say out loud, not research-grade bid privacy.

**Contract-level lifecycle is 3 states** (`CREATED → OPEN → SETTLED`), not the backend's 5. `BIDDING_CLOSED` and `REVEALING` are display states with no separate on-chain transition, because reveal and settle happen in the same atomic moment per PRD P0-6.

### Four real bugs/limits found by running it, not by reading it

1. **Inner-transaction fees are not automatic.** `fee` on an algopy inner transaction defaults to `0` — a Python default, not "let the AVM figure it out" — so every `itxn` failed with `group fee 0.0A too small`. My first fix (omitting `fee=`) changed nothing, because omission *is* the zero default. Correct fix: set `fee=Global.min_txn_fee` explicitly on all seven inner transactions, paid from the app's own funded balance.

2. **You cannot push an ASA to an account that hasn't opted in.** `settle()` failed with `receiver error: must optin` because the winner had no product-asset slot — and separately because the **treasury had never opted into USDC**, so the fee transfer failed. This is a genuine product constraint, not a test artifact: *a bidder must opt into the product asset before settlement in order to be eligible to win*, costing them 0.1 ALGO of min-balance. Phase 7 must make agents opt in at bid time. `deployRoom` now opts the treasury into USDC and the seller into the product asset as part of correct room setup.

3. **`settle()` hits the AVM's resource-reference cap at ~3 bidders.** It touches an account + two boxes per bidder, plus seller/treasury/winner and two assets — beyond what a single app call may reference (`No more transactions below reference limit`). Solved with the standard padding pattern: a `noop` ABI method grouped alongside `settle`, raising the group's combined budget **while keeping settlement atomic** (splitting it would have broken P0-6). This is a real scaling ceiling — worth knowing that a much larger room would need pull-based refunds (losers claim) rather than push-based.

4. **`waitUntilTimestamp` polls passively and hangs on LocalNet.** It never generates blocks, and LocalNet dev mode only cuts a block when a transaction arrives — so with no other traffic it waits forever (every test using it timed out, even for a 2-second deadline). Replaced with an active loop that sends a self-payment per iteration to force blocks.

### LocalNet chain time — the subtlest problem here

The contract compares against `Global.latest_timestamp`, the last **committed block's** timestamp. Three consequences, each of which cost a debugging round:

- `setTimeout` advances nothing. Wall-clock sleeping does not move chain time.
- A fresh LocalNet can run **~70 seconds behind wall clock**, and each block leaps forward to catch up — one transaction was measured advancing chain time **~25s**. So a "3 seconds from now" deadline is blown past by the very first setup transaction, while a wall-clock-derived deadline sits unreachably far in the chain's future.
- Once caught up, block timestamps track wall clock, so advancing N seconds genuinely costs N seconds — a 600s deadline meant a 600s wait (which is exactly what one early run did).

Resolved with `syncChainToWallClock()` at the end of `deployRoom`: drag chain time up to wall clock first, after which deadlines mean what they say and tests are both fast and predictable.

### Tests (`npm run test:contract`, ~130s, real LocalNet — free and not rate-limited, unlike testnet)

Covers every behaviour AGENTS.md Phase 6/7 lists: normal winner (with balances checked on all four sides — winner holds the item, winner's stake consumed, treasury holds the fee, losers refunded to net-zero), duplicate bid rejected, late bid rejected, reveal with a mismatched guess/nonce rejected, settle with a target that doesn't match the room commitment rejected, no-bids settlement returning the item to the seller, and the earliest-commit tie-break.

**Not yet done (Phase 7):** this contract is not wired to the backend. `api/src/bids.ts` still holds bids in memory, which AGENTS.md §6 explicitly forbids as the authoritative settlement record. Phase 7 replaces it — agents must opt into the product asset, commit real on-chain bids, and the winner must come from `settle()`'s return value rather than any backend calculation. Deploying to **testnet** also still pending (LocalNet only so far).

---

## 13. Phase 7 — Agent → Contract Integration findings (22 Aug 2026)

The contract is now **deployed to Algorand testnet and wired to the backend**. Bids are real on-chain commitments with real escrowed USDC, and the winner comes from `settle()`'s return value — the backend no longer decides anything (AGENTS.md §6).

**Deployed:** app [`769662442`](https://lora.algokit.io/testnet/application/769662442), product ASA `769662460` (1 unit, minted by and held in the contract's escrow), treasury `IGJVW4U3ZAXJGRCK3WEJI2YJ63KLO6OXE6R7HRIZPM4UHAC2EMLRZ4TDLU`. Verified on-chain immediately after deploy: the app account holds the product ASA and is opted into USDC.

### A real integration bug caught by reading, before it could cost a demo

`rooms.ts` was committing `sha256("29:<hex nonce>")` while the contract computes `sha256(itob(uint64) ‖ nonceBytes)`. **Structurally incompatible** — every `reveal_bid` would have been rejected on-chain with "guess/nonce does not match the commitment", and the failure would only have surfaced at settlement time, i.e. live on stage. Rewrote the backend's scheme to the contract's exact byte layout and verified it produces identical digests to the implementation already proven against the real contract by the Phase 6 LocalNet suite.

That fix forced a second one: the contract's guess/target are `UInt64` with no decimals, while the valuation heuristic works in dollars (`28.7`). **Integer cents is now the unit at every contract boundary** (`toCents`/`fromCents` in `rooms.ts`); dollars survive only in display.

### Two open questions resolved deliberately, not by drift

- **Bid stake scaled to $0.10.** The PRD's $20 product value is not fundable as real escrow: each session has ~$0.45 spare after the $0.50 entry and $0.05 hint, and Circle's faucet grants 20 USDC per 2 hours. Rather than stall for hours of faucet cycles, the stake is demo-scaled — **every mechanic still runs for real** (escrow, payout, 5% fee split, refunds), just at an amount testnet funding sustains. The $20/$29 product economics remain the display narrative. Say this plainly on stage.
- **Treasury is a distinct, funded address** (resolves PRD §7's open question in favour of the more convincing option): the platform fee is a separate, verifiable on-chain transfer at settlement rather than an implicit bookkeeping entry.

### Architecture

- **`api/src/contract.ts`** — the contract client. Wraps each session's server-held key as a signer, opts agents into the product asset, commits bids, reveals, and settles.
- **`api/src/settlement.ts`** — reveal + settle orchestration. Contains **no winner logic**: it opens each commitment on-chain, calls `settle()`, and reports the address the contract returned.
- **`api/src/bids.ts`** — demoted to an explicit **mirror, not source of truth**. Its remaining job is holding the nonces that open each commitment, which the chain deliberately cannot know. Its duplicate/late/closed checks are kept as *pre-flight* guards so a doomed bid fails with a readable reason instead of burning a real transaction on a raw AVM assert — the contract enforces all of them independently and wins any disagreement.
- **Room opening is now dual**: `ensureOpenForEntry()` opens the backend room *and* calls `open_room` on-chain, because the contract rejects `commit_bid` on an unopened room. A restarted backend resets its in-memory room to `CREATED` while the deployed contract stays `OPEN`; that mismatch is benign (bidding still works) so it logs a warning rather than blocking entry.

### Session funding raised again

Agents must opt into the product asset to be eligible to win (Phase 6's finding), which permanently locks another 0.1 ALGO. Per-session funding went **0.25 → 0.4 ALGO**: 0.1 base + 0.1 USDC slot + 0.1 product slot = 0.3 locked, leaving ~0.1 spendable (~100 transactions of headroom).

### Verified live on testnet

Two agents through the complete loop:

- Both sessions funded, both paid the real `$0.50` x402 entry fee.
- Room opened on-chain (`open_room`, tx `WZX3LTCTODIQ5EEVYO2IK2LLLG6R54GV3IE5IGUKZWJD4GKT7KFA`).
- `agent-1` (conservative) declined the hint; `agent-2` (balanced) autonomously bought one, confidence `0.47 → 0.92`.
- Both submitted **real on-chain sealed bids**, each escrowing `$0.10` USDC.
- Contract account independently checked mid-run: **0.20 USDC escrowed**, product ASA still held, **4 boxes** allocated (one bid record + one index entry per bidder) — the escrow is genuinely on-chain, not bookkeeping.
- Settling before the deadline correctly returned `409 TOO_EARLY`.

### Settlement verified end-to-end on testnet

Settled after the deadline. The contract — not the backend — returned the winner:

```
winner: agent-2  (bought the hint)
  agent-2  guess $28.70  distance 0.30   <- WINNER
  agent-1  guess $24.38  distance 4.62
  target   $29.00
```

Balances before → after, all four parties reconciling exactly:

| party | before | after | change |
|---|---|---|---|
| agent-1 (lost) | 0.40 | 0.50 | **+0.10** — full stake refunded |
| agent-2 (won) | 0.35 | 0.35 **+ product ASA** | stake consumed, item received |
| seller | 1.26 | 1.355 | **+0.095** (95%) |
| treasury | 0.00 | 0.005 | **+0.005** (5% platform fee) |
| contract | 0.20 + item | **0.00, 0 items** | escrow fully drained |

**Atomicity confirmed independently on the public indexer** (tx `AN427KUXNDTD3YDWZCDLVT3GCIOJHONEXFQCN4ZT4XIVHI6RH35A`, round 66552424, group `Su6aegkhExNqBz0ZRarfHegzsonYbipafyK179TQW1E=`) — a single transaction carrying **4 inner transactions**:

```
-> asset 10458941  amt  95000  to seller     (95%)
-> asset 10458941  amt   5000  to treasury   (5% fee)
-> asset 769662460 amt      1  to winner     (the product)
-> asset 10458941  amt 100000  to loser      (refund)
```

That is PRD **P0-6** met literally: winner payout, seller proceeds, platform fee, ownership transfer, and loser refund all in **one atomic grouped transaction**, with the winner determined on-chain.

**Still open for later phases:** the reveal step is operator-driven (the backend holds the nonces and opens each commitment), which is honest demo-grade commit-reveal, not trustless sealed bidding — the operator technically learns guesses at reveal time and could in principle withhold a reveal. Say that plainly rather than overclaiming (AGENTS.md Rule 6). Also unbuilt: the UI (Phase 9) and a one-command E2E harness (Phase 8) — the run above was driven by individual HTTP calls.
