<div align="center">

<img src="docs/assets/hero.svg" alt="Agentic Bidding Room — agents that pay real money for what they don't know" width="100%">

<br>

![Chain](https://img.shields.io/badge/chain-Algorand_Testnet-000000?style=for-the-badge&logo=algorand&logoColor=white)
![Protocol](https://img.shields.io/badge/protocol-x402-2DE2C5?style=for-the-badge&logoColor=black)
![Runtime](https://img.shields.io/badge/runtime-Node_%2B_Hono-F2B14C?style=for-the-badge&logo=node.js&logoColor=black)
![Contract](https://img.shields.io/badge/contract-Algorand_Python-3B82F6?style=for-the-badge&logo=python&logoColor=white)
![Status](https://img.shields.io/badge/status-building-EF4444?style=for-the-badge)

**x402 Global Challenge PreHack · Startup Park, Bengaluru · 23 Aug 2026**

</div>

---

## The one sentence

> **Buyers' agents pay small x402 micro-fees to unlock hints about a product, then submit one sealed guess at its hidden value. An Algorand smart contract holds every bid in escrow and pays out to whoever guessed closest — atomically, the moment the reveal happens.**

Everything in this repo serves that sentence. If a feature doesn't, it got cut. On purpose. ([see what we cut ↓](#-what-were-deliberately-not-building))

---

## 🎯 The problem with every x402 demo you've seen

x402 makes it possible for software to pay for things on its own — no human approving each transaction. It's a genuinely new primitive.

And almost every demo built on it is the same shape:

```
  developer  →  calls a paid API  →  gets data back  →  🥱
```

That proves the plumbing works. It doesn't show anyone **why machine-initiated payment is interesting**. Nothing is at stake. No decision is being made. A human watching learns nothing they couldn't get from reading the spec.

**The gap:** a demo where an agent's *spending decision visibly changes the outcome* — and where a non-technical person watching the screen can tell who won and why.

That's what this is.

---

## 💡 What actually happens in the room

<table>
<tr><td width="60px" align="center">

### 1️⃣
</td><td>

**A participant scans a QR code.** No wallet install, no account. A funded Algorand testnet wallet is generated and bound to their session server-side.

</td></tr>
<tr><td align="center">

### 2️⃣
</td><td>

**They pay one entry fee — over x402.** `POST /api/room/enter` returns a real `402`. The client signs, retries, the facilitator settles on testnet. Only then is an agent assigned.

</td></tr>
<tr><td align="center">

### 3️⃣
</td><td>

**Their agent sizes up the product** from its public attributes and forms a baseline estimate — plus a confidence score.

</td></tr>
<tr><td align="center">

### 💸
</td><td>

**Here's the part nobody has seen.** If the agent isn't confident enough, *it decides on its own* to spend **$0.05 of its own budget** on a hint — one more attribute about the product. It signs that payment itself. **No human approves it.** No button. It just decides that information is worth more than the money.

</td></tr>
<tr><td align="center">

### 4️⃣
</td><td>

**Every agent submits exactly one sealed bid** before the deadline. Funds go into contract escrow. One bid each — a second attempt is rejected on-chain.

</td></tr>
<tr><td align="center">

### 5️⃣
</td><td>

**The hidden target is revealed** and verified against the commitment published before bidding opened.

</td></tr>
<tr><td align="center">

### 🏆
</td><td>

**Closest guess wins.** The contract pays the winner, pays the seller, takes the platform cut, and refunds every loser — **in one atomic grouped transaction.** Not backend bookkeeping. On-chain, inspectable, with explorer links.

</td></tr>
</table>

**The story that lands in 30 seconds:** *the agent that paid for information beat the agent that didn't.*

---

## ⚡ The money moment

Steps 5→7 of the loop are the whole pitch. One `await`, no human in the path:

<div align="center">
<img src="docs/assets/flow.svg" alt="Agent hits 402, signs the payment, facilitator settles on Algorand, hint comes back" width="100%">
</div>

```typescript
const estimate = baseline(product);

if (confidence(estimate) < THRESHOLD && budget >= HINT_COST) {
  emit("buying_hint");                              // ← the UI lights up here
  const hint = await fetchWithPay(`${API}/api/product/${id}/hint`);
  //           ^^^^^^^^^^^^^^^^^^
  //           402 → sign → retry → facilitator → Algorand → 200
  //           all inside this single call. No human. No approval step.
  estimate = refine(estimate, await hint.json());
}

await submitSealedBid(estimate);
```

> [!NOTE]
> The UI deliberately holds on `buying_hint` long enough for a room to *see* it. The most important moment in the demo is a network round-trip — if it flashes by in 200ms, nobody learns anything.

---

## 🔍 Why this isn't another paid-API demo

| | Typical x402 demo | Agentic Bidding Room |
|---|---|---|
| **Who initiates payment** | A developer, running a script | An **agent**, mid-decision, unprompted |
| **What's at stake** | Nothing | Real escrowed funds and a winner |
| **Does the spend matter** | No — you always get the data | **Yes** — buying the hint changes who wins |
| **Payers** | One | Multiple, competing, in one room |
| **Settlement** | Single transfer | **Atomic** payout + refunds + fee split |
| **Can a non-dev follow it** | No | Yes — "closest guess wins" |

---

## 🏗️ Architecture

```mermaid
flowchart LR
    P["Participant<br/>phone + QR"]

    subgraph services ["Three processes"]
        W["web :3000<br/>Next.js + Tailwind"]
        A["api :4021<br/>Hono + x402 middleware"]
        AG["agent workers<br/>heuristic brain + signer"]
    end

    F["GoPlausible<br/>facilitator"]

    subgraph chain ["Algorand Testnet"]
        C["BiddingRoom contract<br/>escrow · reveal · payout"]
    end

    P -->|scan QR| W
    W <-->|socket.io| A
    AG -->|"402-gated calls<br/>+ signed payment"| A
    A -->|verify + settle| F
    F -->|settles USDC| chain
    AG -->|sealed bid| C

    style AG fill:#1B1408,stroke:#F2B14C,color:#F2B14C
    style F fill:#0F1B2E,stroke:#2DE2C5,color:#2DE2C5
    style C fill:#082018,stroke:#2DE2C5,color:#2DE2C5
```

### The full loop, in order

```mermaid
sequenceDiagram
    autonumber
    actor P as Participant
    participant A as API (x402)
    participant AG as Agent
    participant F as Facilitator
    participant C as Contract

    P->>A: POST /room/enter
    A-->>P: 402 Payment Required
    P->>A: retry, signed
    A->>F: verify + settle
    F-->>A: settled (tx id)
    A-->>P: 200 — agent assigned

    Note over AG: reads product, scores confidence

    AG->>A: GET /product/hint
    A-->>AG: 402 Payment Required
    Note over AG: signs payment itself —<br/>no human approval
    AG->>A: retry, signed
    A->>F: verify + settle
    F-->>A: settled (tx id)
    A-->>AG: 200 — hint unlocked

    AG->>C: sealed bid (one only)
    Note over C: deadline passes
    C->>C: reveal + verify commitment
    C->>C: closest wins · refund losers ·<br/>pay seller + treasury — atomic
```

### Repo layout

```
agentic-bidding-room/
├── api/                    # Hono + @x402/hono — the gated endpoints
│   └── src/
│       ├── x402.ts         #   middleware config + routes table
│       ├── chain.ts        #   algosdk wrappers — keygen, atomic funding
│       ├── sessions.ts     #   in-memory session store
│       ├── rooms.ts        #   room/product state machine + commit-reveal
│       ├── entry.ts        #   pays room entry on a session's behalf
│       └── sockets.ts      #   live agent status             (planned)
├── agent/                  # agent workers — the autonomous payers
│   └── src/
│       ├── test-payment.ts #   Phase 1 hard-gate E2E check
│       ├── keygen.ts       #   testnet keypair utility
│       ├── optin.ts        #   ASA opt-in utility
│       ├── brain.ts        #   decide → maybe buy hint → bid (planned)
│       └── client.ts       #   x402 client + signer          (planned)
├── contracts/              # Algorand Python — sealed-bid escrow (planned)
├── web/                    # Next.js App Router — the room UI    (planned)
├── docs/                   # PRD · tech stack · agent rules · audit notes
└── .env                    # never committed
```

---

## 📐 The rules (stated up front, not buried)

```
Base product value   $20.00
Entry fee            $0.50      ← x402, human-initiated
Hint fee             $0.05      ← x402, AGENT-initiated
Hidden target        committed before bidding opens
```

**Winner** — minimum absolute distance from the revealed target:

```
winner = argmin | prediction[i] − target |
           i
```

**Tiebreak** — earliest valid bid wins. Shown in the UI, never left implicit.

**Commitment** — `SHA-256(target ‖ nonce)` published at room creation, with a cryptographically random nonce kept secret until reveal. At reveal: publish target + nonce → recompute → verify → settle.

> [!IMPORTANT]
> This is **demo-grade** commit-reveal, and we say so on stage. Real sealed-bid privacy is a research problem — the operator technically knows the target before reveal. We're not claiming otherwise. Custodial server-managed testnet wallets, same deal: deliberately not production wallet UX.

---

## 🚀 Quickstart

**Prerequisites** — Node 22+, a funded Algorand testnet account.

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env

# 3. generate a testnet keypair (prints address + base64 secret key)
npm run keygen --workspace agent
#    → paste the address into AVM_ADDRESS
#    → paste the secret key into AVM_PRIVATE_KEY
```

**4. Fund it.** Both the resource-server address and the paying agent address need testnet ALGO, and both must opt in to USDC (ASA `10458941`). The paying account also needs testnet USDC.

```bash
algokit dispenser login && algokit dispenser fund   # or the faucet, manually
```

**5. Run the loop.**

```bash
npm run dev:api        # terminal 1 — starts the gated API on :4021
npm run dev:agent      # terminal 2 — runs the 402 → pay → 200 hard-gate check
```

A passing run prints the settlement transaction id and a [Lora explorer](https://lora.algokit.io/testnet) link.

<details>
<summary><b>Verify the gate yourself, without spending anything</b></summary>

```bash
curl -i http://localhost:4021/api/test-payment
```

You should get `HTTP/1.1 402 Payment Required` with a `payment-required` header. Decode it:

```bash
curl -si http://localhost:4021/api/test-payment \
  | grep -i '^payment-required:' | cut -d' ' -f2 | base64 -d | python -m json.tool
```

That shows the exact network, amount, asset and `payTo` the server is demanding — real protocol output, no payment needed to see it.

</details>

---

## 📊 Build status — honestly

This is a hackathon build in progress. Here's exactly where it stands. Nothing below is rounded up.

| Phase | What | Status |
|---|---|:--|
| **0** | Repo audit — real package APIs verified against shipped types | ✅ **Done** |
| **1** | Smallest real x402 payment — `402` gate + real settlement on testnet | ✅ **Done — settled tx verified on-chain** |
| **2** | Wallet provisioning — session-bound testnet keypairs | ✅ **Done — funding verified on-chain** |
| **3** | Room + product state machine | ✅ **Done — verified live via `GET /api/room/:id`** |
| **4** | x402-gated room entry | ✅ **Done — real payment settled, race condition tested live** |
| **5** | Agent workers — 3 personas, heuristic brain | ⬜ Not started |
| **6** | Sealed-bid escrow contract | ⬜ Not started |
| **7** | Agent → contract integration | ⬜ Not started |
| **8** | Full E2E harness (`npm run test:e2e`) | ⬜ Not started |
| **9** | Room UI + reveal view | ⬜ Not started |

**What is genuinely proven right now:** a real agent-initiated x402 payment has settled on Algorand testnet, end to end — `402` → signed payment → facilitator verify/settle → `200`. Independently cross-checked against the public indexer (not just trusted from the client script): confirmed round, correct USDC transfer amount, and a `fee: 0` on the payer's transaction — empirically confirming the facilitator sponsors the fee-payer leg.

> **[View the settled transaction on Lora →](https://lora.algokit.io/testnet/transaction/SWUJKNFNLMUSZ3PDII2QIXNKFAW5PSZC3RDR6HIGX5VSL53KEJYQ)**
> `10000` units of USDC (`$0.01`), agent → resource server, note `x402-payment-v2-…` — real protocol traffic, not a mock.

Both services typecheck clean against the real `@x402/*` v2.23.0 types. This is P0-3 from the PRD — the requirement flagged as "never cut, above all else" — and it's real.

**Also real:** `POST /api/session` mints a fresh testnet wallet, funds it with ALGO + USDC in one atomic transaction group, and never returns or logs the private key — verified against real on-chain balances, not mocked (`AGENTS.md` Rule 2 bans mocking this layer, and the integration test caught a real `overspend` error mid-build when the first funding-amount guess was too generous for the dispenser). One honest gap: funding measures **5–6s**, not the PRD's narrow "within 3 seconds" bullet — a real constraint of Algorand's ~3s block time, not a bug, and one that still fits comfortably inside the PRD's actual judged metric for the whole QR-to-agent-assigned flow (<20s). Detail in [`docs/implementation-notes.md` §8](docs/implementation-notes.md).

**Also real:** `GET /api/room/:id` serves the room/product state machine (`CREATED → OPEN → BIDDING_CLOSED → REVEALING → SETTLED`, guarded — invalid transitions throw) with a working commit-reveal scheme for the hidden target. Checked structurally, not just "the code doesn't return it": the hidden target, its nonce, and the paid hint are verifiably absent from the public response, while the commitment hash *is* shown (that's the point of committing before bidding opens). Detail in [`docs/implementation-notes.md` §9](docs/implementation-notes.md).

**Also real:** room entry — `POST /api/room/demo-room/enter` is genuinely x402-gated (curl it unpaid, get a real `402` for `$0.50`); `POST /api/session/enter` is the browser-facing action that pays it server-side using the session's own custodial key, via a real loopback HTTP call reusing the exact 402→sign→retry pattern Phase 1 proved. First entry auto-opens the room. A double-click race was tested for real — fired two simultaneous requests at a fresh session, got one real settled `200` and one clean `409`, not a double charge. Detail in [`docs/implementation-notes.md` §10](docs/implementation-notes.md).

<details>
<summary><b>Two real bugs the audit caught (worth knowing if you're building on x402 + Algorand)</b></summary>

**1. The exported CAIP-2 constant doesn't match what the facilitator advertises.**
`@x402/avm` exports `ALGORAND_TESTNET_CAIP2` as the spec's truncated 32-char form. The live GoPlausible facilitator advertises Algorand testnet under the **full base64 genesis hash**. Route registration is a literal string match with no normalization — using the exported constant throws `RouteConfigurationError: Facilitator does not support scheme "exact"` at startup. Build the id from `ALGORAND_TESTNET_GENESIS_HASH` instead.

**2. Three APIs in circulating example code don't exist.**
`registerExactAvmScheme()` — not exported by anything; instantiate `ExactAvmScheme` and pass it to `.register()`. `client.fetch()` — not a method on `x402Client`; the 402/sign/retry wrapper lives in `@x402/fetch` as `wrapFetchWithPayment(fetch, client)`. And `paymentMiddleware`'s real signature is `(routes, server, ...)`, taking a pre-built `x402ResourceServer`.

Full detail, with the verified-correct call shapes: [`docs/implementation-notes.md`](docs/implementation-notes.md).

</details>

---

## ✂️ What we're deliberately not building

Scope discipline is a feature. Each of these was considered and cut for a stated reason:

| Not building | Why |
|---|---|
| **Raspberry Pi + OpenCV product verification** | Hardware failure risk at a venue we don't control, on a path judges aren't scoring |
| **Pera / WalletConnect** | Custodial dev keys are sufficient for a judged demo and save 3+ hours of failure modes |
| **Multi-room / concurrent auctions** | One room, one product, one reveal. Concurrency buys zero demo value |
| **MainNet / real USDC** | Testnet only. Irreversibility risk mid-hackathon, and not a PreHack requirement |
| **Seller onboarding UI** | A whole second product surface for one demo listing |
| **Postgres, Redis, Docker** | One room, one demo. An in-memory object is the correct data layer here |
| **Real bid-privacy cryptography** | A research problem. Commit-reveal is honest enough — *if you say it's demo-grade* |

---

## 🛣️ Roadmap

**If P0 goes green early** — agent reasoning line (one sentence per agent explaining its guess), a live transaction feed with explorer links, multiple hint tiers so the agent makes a *budget allocation* decision rather than a binary one.

**Beyond the hackathon** — physical verification oracle writing product state on-chain, real seller onboarding, an agent marketplace where users bring their own bidding strategies, and MainNet deployment for the Global Challenge in September.

The contract's product-state field and the agent interface (`getBid(productId, budget) → sealedBid`) are both kept extensible so those slot in without a schema change.

---

## 🧰 Stack

| Layer | Choice | Why this one |
|---|---|---|
| Chain | Algorand Testnet | 2–3s finality — the demo doesn't stall while a judge watches |
| Contract | Algorand Python (`algopy`) | The forkable marketplace example is written in it |
| Payments | `@x402/core` · `@x402/avm` · `@x402/hono` · `@x402/fetch` `2.23.0` | Matches the judges' own reference repo |
| Facilitator | [GoPlausible](https://facilitator.goplausible.xyz) managed | Self-hosting a facilitator in 24h is a project, not a task |
| Backend | Node + Hono + TypeScript | What the reference implementation runs — removes a class of risk |
| Frontend | Next.js App Router + Tailwind | Fast scaffolding, phone *and* projector legible |
| Realtime | Socket.IO | Agent status must animate live; polling looks broken on a projector |
| State | In-memory object | One room, one demo. Migrations are not a good use of tonight |

---

## 📚 Docs

| | |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements — scope, goals, user stories, success metrics |
| [`docs/tech-stack.md`](docs/tech-stack.md) | Stack decisions and rationale |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Engineering rules and phase-by-phase build plan |
| [`docs/implementation-notes.md`](docs/implementation-notes.md) | **Phase 0 audit** — verified package APIs, corrections, open blockers |

---

<div align="center">

**Built for the [x402 Global Challenge](https://algorand.co/blog/the-x402-global-challenge-is-live-how-to-build-submit-your-entry) PreHack**

*Testnet prototype. Custodial demo wallets. Demo-grade commit-reveal.*
*We'd rather say that out loud than have a judge find it.*

</div>
