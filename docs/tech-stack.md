# Tech Stack — Agentic Bidding Room

**For:** x402 Global Challenge PreHack, Bengaluru, 23 Aug 2026
**Rule for every choice below:** does it get us to a working end-to-end demo tonight? Nothing here is picked for elegance or for what we'd choose with a month.

---

## ⚠️ Update — package scope is now confirmed, and the framework choice changed

The organizers circulated an official reference repo ([`marotipatre/x402-Project`](https://github.com/marotipatre/x402-Project)) as "the expected setup and implementation." Its real `package.json` settles the naming confusion from the earlier draft of this doc:

```json
"dependencies": {
  "@hono/node-server": "^2.0.2",
  "@x402-avm/extensions": "^2.6.1",
  "@x402/avm": "^2.12.0",
  "@x402/core": "^2.12.0",
  "@x402/hono": "^2.12.0"
}
```

Two corrections to what this doc said before:

1. **The scope is `@x402/*` (slash) for `core`, `avm`, and the framework middleware.** `@x402-avm` (hyphen) only exists for the optional `extensions` package, which we don't need. Every code sample below is now updated to `@x402/*`.
2. **The reference implementation uses Hono, not Express.** There's a documented `@x402/express` package too, but it's untested by us and unverified against a working repo. The judges' own template runs on `@hono/node-server`. On a 24-hour clock, matching the thing the judges already know works beats a marginally more familiar framework — **switch the API from Express to Hono.** It's a small surface (routing + middleware), not a rewrite.

This also directly answers your question about whether the current plan matches the eval criteria — see the note at the very bottom of this doc.

---

## The stack at a glance

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Chain | **Algorand testnet** | Required by the challenge. 2–3s finality means the demo doesn't stall while a judge watches. |
| Contract language | **Algorand Python (algopy)** | The forkable marketplace example is written in it. Not PyTeal (older), not TEAL (masochism). |
| Contract scaffold | **`algokit init example digital-marketplace-smart-contract`** | Already has bidding, escrow via BoxMap, atomic settlement. We modify, not author. |
| Payment protocol | **x402 via `@x402/hono` + `@x402/avm` + `@x402/core`** | The gated-endpoint middleware is the whole point of the event. |
| Facilitator | **GoPlausible managed** — `https://facilitator.goplausible.xyz` | Self-hosting a facilitator in 24h is a project, not a task. |
| Backend | **Node + Hono (TypeScript)** | This is what the judges' own reference repo runs. Matching it removes a whole class of "does this untested combo work" risk. |
| Agent runtime | **Node, one process/worker per persona** | Shares the x402 client library with the backend. No second language, no IPC bridge. |
| Frontend | **Next.js (App Router) + Tailwind** | Fast scaffolding; App Router is what the x402 Next docs target if you need gated routes client-side. |
| Realtime | **Socket.IO** | Agent status must animate live. Polling looks broken on a projector. |
| State store | **In-memory (a plain JS object) + SQLite only if needed** | One room, one demo. A Postgres container is 45 minutes you don't have. |
| Wallets | **Server-managed testnet keypairs via algosdk** | Deliberately not Pera/WalletConnect — see PRD §3. |
| Tunnel | **ngrok or Cloudflare Tunnel** | The QR must resolve from a phone on mobile data. `localhost` kills the demo. |
| LLM (if used) | **One API, one call, hard timeout** | See "the agent brain" below. |

---

## Confirmed configuration values

These come from GoPlausible's docs and are the ones you'll need in `.env`:

```bash
# Resource server (the side that RECEIVES payments)
AVM_ADDRESS=<your 58-char Algorand address>
FACILITATOR_URL=https://facilitator.goplausible.xyz

# Client / agent (the side that PAYS)
AVM_PRIVATE_KEY=<base64 private key>
RESOURCE_SERVER_URL=http://localhost:4021

# Algod
ALGOD_URL=https://testnet-api.algonode.cloud
```

**Network identifiers (CAIP-2):**

| Network | Identifier |
|---|---|
| Testnet | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |
| Mainnet | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |

**USDC on testnet:** ASA ID `10458941`, 6 decimals.

Use the exported constant `ALGORAND_TESTNET_CAIP2` rather than pasting the string — one wrong character produces an error message that won't tell you what's wrong.

---

## The three services

Three processes, three ports, three people. Deliberately separate so nobody blocks anybody.

```
┌──────────────────────────────────────────────────────────┐
│  web        :3000   Next.js + Tailwind + Socket.IO client│
│                     QR landing, room view, reveal view    │
├──────────────────────────────────────────────────────────┤
│  api        :4021   Hono + @hono/node-server + @x402/hono │
│                     x402-gated: /enter, /hint             │
│                     open: /room/:id, /product/:id         │
│                     Socket.IO server, contract calls      │
├──────────────────────────────────────────────────────────┤
│  agent      (no port, N workers)                          │
│                     @x402/core client + signer            │
│                     decides → pays for hint → bids        │
└──────────────────────────────────────────────────────────┘
              ↓ algosdk
     Algorand testnet + BiddingRoom contract
              ↓
     facilitator.goplausible.xyz
```

### Repo layout

```
agentic-bidding-room/
├── contracts/          # algokit project — Algorand Python
│   └── bidding_room/
│       └── contract.py         # forked marketplace, modified bid logic
├── api/                # Hono + x402 middleware
│   ├── src/x402.ts             # middleware config, routes table
│   ├── src/rooms.ts            # in-memory room state
│   ├── src/chain.ts            # algosdk wrappers
│   └── src/sockets.ts
├── agent/              # agent workers
│   ├── src/brain.ts            # decide → maybe buy hint → bid
│   └── src/client.ts           # x402 client + signer
├── web/                # Next.js App Router
│   └── app/room/[id]/page.tsx
└── .env
```

Single repo, not three. Merge conflicts in a shared repo are cheaper than cross-repo dependency pain at 2 AM.

---

## Server side — gating an endpoint

This mirrors the judges' reference repo almost line for line — Hono, not Express. Two gated routes: entry and hint.

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware } from "@x402/hono";
import { registerExactAvmScheme } from "@x402/avm/exact/server";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";

const app = new Hono();

const paymentConfig = {
  "/api/room/enter": {
    accepts: {
      scheme: "exact",
      network: ALGORAND_TESTNET_CAIP2,
      payTo: process.env.AVM_ADDRESS!,
      price: "$0.50",
    },
    description: "Bidding room entry — assigns your agent",
  },
  "/api/product/hint": {
    accepts: {
      scheme: "exact",
      network: ALGORAND_TESTNET_CAIP2,
      payTo: process.env.AVM_ADDRESS!,
      price: "$0.05",
    },
    description: "One additional product attribute",
  },
};

const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL!,   // GoPlausible — default is x402.org, not what we want
});

const server = new x402ResourceServer(facilitatorClient);
registerExactAvmScheme(server);

app.use(paymentMiddleware(paymentConfig, facilitatorClient, [
  { network: "algorand:*", server },
]));

app.post("/api/room/enter", (c) => { /* assign agent */ });
app.get("/api/product/hint", (c) => { /* return the hint */ });

serve({ fetch: app.fetch, port: 4021 });
```

**The trap:** `HTTPFacilitatorClient` defaults to `x402.org/facilitator`, which does not settle Algorand. Pass the GoPlausible URL explicitly or you'll get failures that look like network errors. Exact route/param names above are illustrative — confirm against `endpoints.config.ts` in the reference repo, which is the actual pattern the judges will recognize.

---

## Agent side — the part that makes this "agentic"

```typescript
import { x402Client } from "@x402/core/client";
import { registerExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";

const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);

const client = new x402Client({ schemes: [] });
registerExactAvmScheme(client, {
  signer,
  algodConfig: { algodUrl: process.env.ALGOD_URL! },
});

// The agent decides on its own — no human in this path.
const estimate = baseline(product);
if (confidence(estimate) < THRESHOLD && budget >= HINT_COST) {
  emit("buying_hint");
  const hint = await client.fetch(`${API}/api/product/${product.id}/hint`);
  // ↑ 402 → sign → retry with X-PAYMENT → settle → 200, all inside this one call
  estimate = refine(estimate, await hint.json());
}
emit("bid_submitted");
await submitSealedBid(estimate);
```

`client.fetch` handling the 402/sign/retry internally is the whole reason this is a day of work and not a week. That one `await` is the demo's centerpiece — make sure the UI has time to show `buying_hint` before it resolves, or the most important moment flashes by unseen.

### The agent brain — decide tonight

Two honest options. Pick one, say the true one on stage:

**Heuristic** — a scoring function over product attributes plus noise. Zero latency, zero cost, zero failure modes, fully deterministic for a scripted demo. Defensible: "the agent's *payment* decision is the autonomous part, the valuation is a simple model."

**LLM call** — one call, prompt with product attrs, parse a number out. More impressive-sounding, but adds an API key, latency, a parsing failure mode, and a dependency on venue Wi-Fi.

**Recommendation:** build the heuristic first as the guaranteed path, then add an LLM behind a flag if Saturday has slack. If you demo the LLM version, keep the heuristic as a one-env-var fallback. A demo that hangs on an API call at 18:00 Sunday is worse than a demo that used a scoring function.

Whichever ships: with an LLM, set a hard 5s timeout and a fallback value. Never let a network call decide whether your demo works.

---

## Contract layer

```bash
algokit init example digital-marketplace-smart-contract
```

What you inherit for free: bid submission, escrow via `BoxMap`, refunds, atomic asset-and-payment settlement, a deployment pipeline, tests.

What you change:

1. **Bid comparison** — `highest wins` → `min(abs(bid - target))`
2. **Hidden target** — store `sha256(target + nonce)` at room creation; reveal at close and verify against the hash
3. **Tiebreak** — earliest submission wins, and show that rule in the UI
4. **Fee split** — settlement cut to the treasury address in the same atomic group

```bash
algokit project deploy testnet
algokit dispenser fund   # pre-fund several accounts TODAY, not Sunday morning
```

**On the dispenser:** fund 5–6 accounts Friday and record the mnemonics. The public faucet rate-limits, and discovering that at 08:30 Sunday with judges arriving is the kind of failure that has nothing to do with your code.

### Contract fallback

If the modified contract isn't deployed by **21:00 tonight**, cut to: backend computes the winner, contract does a plain atomic transfer. You lose "trustless winner determination," you keep atomic on-chain settlement, and the x402 story — the actual differentiator — is untouched. Decide this at 21:00 by the clock, not by how close it feels.

---

## Frontend

Next.js App Router + Tailwind. Socket.IO client subscribing to one room channel.

Three routes:

```
app/room/[id]/page.tsx      # entry gate → live room
app/room/[id]/reveal/page.tsx
app/page.tsx                # QR generator for the physical printout
```

Agent status as a state machine — `idle → buying_hint → thinking → bid_submitted` — with `buying_hint` given the loudest visual treatment on the page. It's the only state that has never appeared on a screen before.

Two constraints that are easy to forget and expensive to fix late: it must be legible on a **phone** (participants scan) and on a **projector across a room** (judges watch). Test both Saturday, not Sunday.

For the QR itself, `qrcode.react` — five minutes, no thought required.

---

## What we are explicitly not using

| Not using | Why |
|---|---|
| Postgres / Prisma | One room, one demo. In-memory object. Migrations are not a good use of tonight. |
| Docker Compose | Three `npm run dev` terminals start faster and fail more legibly. |
| Pera / WalletConnect | Server-managed keys. Real UX is a phase-2 problem. |
| Redis | Nothing needs a queue at this scale. |
| PyTeal / Beaker | The forkable example is Algorand Python. Don't fight the scaffold. |
| Python backend | The judges' reference implementation is TypeScript/Hono. `x402-avm` for Python exists, but don't split the payment layer across two languages or diverge from the reference. |
| Express | Works per the docs, but the judges' own reference repo runs Hono — mirror what's verified, not what's marginally more familiar. |
| Auth (JWT, sessions) | Session ID in a cookie. There is no threat model here. |
| Raspberry Pi / OpenCV | Cut. See PRD §3. |

---

## Setup — first 90 minutes, in order

```bash
# 1. Contract track
algokit init example digital-marketplace-smart-contract
cd digital-marketplace-smart-contract && algokit project bootstrap all
algokit dispenser fund          # fund 5-6 accounts, save mnemonics

# 2. API track — clone the reference repo's server as your starting point
git clone https://github.com/marotipatre/x402-Project.git reference
# then either build api/ from scratch against the versions below, or
# copy x402-demo-server/ out of reference/ and strip it down to /enter + /hint
mkdir api && cd api && npm init -y
npm i hono @hono/node-server socket.io algosdk dotenv
npm i @x402/core @x402/avm @x402/hono
npm i -D typescript tsx @types/node

# 3. Web track
npx create-next-app@latest web --ts --tailwind --app
cd web && npm i socket.io-client qrcode.react

# 4. Tunnel (do this early — it validates the QR path)
ngrok http 3000
```

**Order matters.** The single highest-risk item is a real x402 payment settling through the GoPlausible facilitator. Get *one manual payment* working — curl or a script, no UI, no agent, no contract — **before 17:00 today**. Everything else in this stack is ordinary web development that this team can do. That one integration is the thing that either works or doesn't, and you want to know which by mid-afternoon.

---

## Does this match the announced final-round evaluation criteria?

**Yes — and it matches because we scoped it that way from the start,** not by luck. Point by point, against what the organizers just circulated:

| Judges will check | Where this stack already covers it |
|---|---|
| x402 payment flow live on Algorand testnet | Both `/api/room/enter` and `/api/product/hint` are real x402-gated routes, not mocked. This was P0-2 and P0-3 in the PRD from the start. |
| Demonstrable via [Lora](https://lora.algokit.io/testnet) | **New action item, not previously in the plan:** Lora is Algorand's own testnet block explorer. During the build, after each settled payment, look up the transaction ID on Lora and confirm it resolves — don't wait until Sunday to discover the demo needs an explorer tab open. Add "pull up the settled tx on Lora live" as a beat in the demo script. |
| Payment flow through GoPlausible facilitator | Already the only facilitator in this doc — `facilitator.goplausible.xyz`, explicitly passed (not the default). |
| `package.json` shows real `@x402` / `avm` dependencies | Now corrected above to `@x402/core`, `@x402/avm`, `@x402/hono` — matching the judges' own reference repo's `package.json` exactly. |
| Genuinely integrated, not just conceptual | This is the whole reason P0-3 (the agent autonomously paying for a hint) was flagged as the one requirement to never cut, back in the PRD. It's the literal thing they're describing when they say "not simply mentioned as part of the concept." |

**One scope question this raises that we haven't answered yet:** the message says "if your current submission is built on another chain or still at the idea stage, that's fine *for this round*" — implying PreHack submissions were being judged more loosely, and *this* bar applies to a **later, final round**, not necessarily Sunday. Worth confirming with organizers whether Sunday's PreHack judging already uses this bar, or whether this is prep guidance for something after — it changes how hard to push the Lora/on-chain-proof polish for Sunday specifically versus treating it as due later.

---

## Sources

[x402 core concepts](https://docs.x402.org/core-concepts/http-402) · [Algorand x402 for developers](https://algorand.co/agentic-commerce/x402/developers) · [GoPlausible x402 integration](https://x402.goplausible.xyz/) · [Official reference repo — marotipatre/x402-Project](https://github.com/marotipatre/x402-Project) · [Core/client examples](https://github.com/GoPlausible/.github/blob/main/profile/algorand-x402-documentation/typescript/x402-avm-core-examples.md) · [AlgoKit intro](https://dev.algorand.co/algokit/algokit-intro/) · [Digital marketplace contract example](https://examples.dev.algorand.co/digital-marketplace-smart-contract/) · [Lora testnet explorer](https://lora.algokit.io/testnet)
