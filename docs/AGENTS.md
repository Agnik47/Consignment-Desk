# AGENTS.md --- Agentic Bidding Room

## 0. Mission

You are Claude Code working on the **Agentic Bidding Room** hackathon
MVP.

The single highest-priority objective is:

> **Build and prove one complete end-to-end run on Algorand Testnet,
> with a real agent-initiated x402 payment, a sealed bid, reveal, winner
> selection, and on-chain settlement.**

Do not optimize for architecture elegance. Optimize for a **working,
repeatable, observable E2E demo**.

The authoritative product scope is the PRD. The tech stack is the
implementation guide. If they conflict, follow the rules in this file
and document the discrepancy.

------------------------------------------------------------------------

## 1. Product Definition

The system demonstrates:

1.  A participant joins a room through a QR code.
2.  A server-managed Algorand Testnet wallet is created/assigned to that
    session.
3.  The participant enters the room through a real x402 payment.
4.  An autonomous agent acts on behalf of the participant.
5.  The agent evaluates the product.
6.  If its confidence is low and its budget allows, the agent
    autonomously pays an x402 micro-fee for a hidden product hint.
7.  The agent submits exactly one sealed prediction/bid before the
    deadline.
8.  The hidden target is revealed.
9.  The contract determines the winner using the documented
    closest-to-target rule.
10. Algorand performs escrow/refund/settlement.
11. The UI shows the complete flow and exposes transaction IDs/explorer
    links.

The core differentiator is **agentic payment for information**, not
merely blockchain bidding.

------------------------------------------------------------------------

# 2. Non-Negotiable Engineering Principles

### Rule 1 --- E2E first

Before polishing UI, build a testable vertical slice:

`agent -> x402 -> facilitator -> Algorand -> hint -> bid -> contract -> reveal -> settlement`

Every phase must end with a runnable verification.

### Rule 2 --- Never fake blockchain success

Do not mock:

-   x402 payment settlement
-   Algorand transaction IDs
-   facilitator verification
-   contract settlement

Mocks/stubs are allowed only for isolated unit tests.

### Rule 3 --- Prefer the verified x402 stack

Use:

-   `@x402/core`
-   `@x402/avm`
-   `@x402/hono`
-   `@hono/node-server`

Do not introduce the older `@x402-avm/*` package family unless the
actual working reference environment requires it.

Use the current x402 v2 APIs from the installed package/reference
implementation. Do not copy stale examples blindly.

### Rule 4 --- Never hardcode protocol constants unnecessarily

Use exported constants such as the Algorand Testnet CAIP-2 identifier
from `@x402/avm`.

Verify all package APIs against the installed versions before
implementing.

### Rule 5 --- Keep the agent honest

The agent may use a deterministic heuristic for the MVP.

Do not claim it is an LLM if it is not.

The important autonomous behavior is:

> The agent decides whether buying information is worth the cost and
> signs the x402 payment without human approval.

### Rule 6 --- No production claims

This is a Testnet hackathon prototype.

Wallets are server-managed custodial testnet wallets.

Commit-reveal is demo-grade.

Do not describe this as production-grade sealed-bid privacy or
decentralized identity.

### Rule 7 --- Do not expand scope

Do NOT add unless P0 is green:

-   Pera/WalletConnect
-   production authentication
-   Postgres/Prisma
-   Redis
-   Docker orchestration
-   multi-room auctions
-   seller dashboard
-   subscription tiers
-   MainNet
-   real USDC
-   Raspberry Pi/OpenCV
-   complex AI infrastructure

------------------------------------------------------------------------

# 3. Required Architecture

Use a single repository:

``` text
agentic-bidding-room/
├── contracts/
│   └── bidding_room/
│       └── contract.py
├── api/
│   └── src/
│       ├── x402.ts
│       ├── rooms.ts
│       ├── chain.ts
│       └── sockets.ts
├── agent/
│   └── src/
│       ├── brain.ts
│       └── client.ts
├── web/
│   └── app/
│       ├── page.tsx
│       └── room/[id]/
│           ├── page.tsx
│           └── reveal/page.tsx
├── tests/
├── scripts/
├── .env.example
└── AGENTS.md
```

Services:

``` text
Web       :3000
API       :4021
Agents    no public port
Algorand  Testnet
x402      GoPlausible facilitator
```

Backend:

-   Node.js
-   TypeScript
-   Hono
-   `@hono/node-server`
-   `@x402/hono`
-   `@x402/core`
-   `@x402/avm`
-   algosdk
-   Socket.IO if needed for live status

Frontend:

-   Next.js App Router
-   Tailwind
-   Socket.IO client
-   QR generation

Contract:

-   Algorand Python / algopy
-   Start from the Algorand digital marketplace example where practical.

------------------------------------------------------------------------

# 4. Wallet Model --- Remove Ambiguity

Use this MVP model:

``` text
Participant Session
       |
       v
Server-managed Testnet Wallet
       |
       v
Assigned Agent
       |
       +--> x402 payments
       |
       +--> bid transaction
```

The wallet belongs to the participant session and is controlled
server-side for the demo.

Do NOT silently create a second unrelated "agent wallet" unless required
by the actual x402 client implementation.

Record:

-   session ID
-   participant wallet address
-   agent ID
-   wallet funding transaction
-   x402 transaction IDs
-   bid transaction ID
-   settlement transaction ID

Never log private keys or mnemonics.

------------------------------------------------------------------------

# 5. Bidding Rules

For the MVP, use a **single hidden target value**, not a hidden range.

Example:

``` text
Base product value: $20
Entry fee: $0.50
Hint fee: $0.05
Hidden target: $29.00
```

Agents see public product information but NOT the target.

Each agent submits exactly one prediction.

Winner:

``` text
winner = argmin(abs(prediction - hiddenTarget))
```

Tie-break:

``` text
earliest valid bid wins
```

The target must be committed before bids are accepted.

Recommended commitment:

``` text
commitment = SHA-256(target || cryptographically-random nonce)
```

The nonce must be cryptographically random and remain secret until
reveal.

At reveal:

1.  publish target + nonce
2.  recompute commitment
3.  verify equality
4.  calculate winner
5.  settle

If the product concept later needs a target RANGE such as `$28–$30`, do
not invent a new scoring rule silently. Make the range semantics
explicit first. For this MVP, keep the single-target closest-prediction
model because it is deterministic and easy to demonstrate.

------------------------------------------------------------------------

# 6. Payment Rules

There are two separate payment layers.

## x402

Use x402 for:

-   room entry
-   hint purchase

Example:

``` text
POST /api/room/:id/enter
$0.50

GET /api/product/:id/hint
$0.05
```

The hint payment MUST originate from the agent process.

No human button should be required for the hint.

The actual x402 request/response headers and middleware API MUST be
taken from the installed current v2 packages/reference implementation.
Do not assume legacy `X-PAYMENT` behavior.

## Algorand contract

Use the smart contract for:

-   bid escrow
-   winner determination
-   loser refunds
-   seller payment
-   platform fee
-   asset/payment settlement

Do not use backend database state as the authoritative settlement
record.

------------------------------------------------------------------------

# 7. Phase-by-Phase Implementation

## Phase 0 --- Repository Audit

Before writing application code:

-   Inspect all existing files.
-   Read the PRD and tech-stack documents.
-   Check `package.json` and installed package versions.
-   Check the actual x402 reference implementation available to the
    repository.
-   Confirm Hono + `@x402/hono` works.
-   Confirm `@x402/avm` exports required server/client helpers.
-   Confirm Algorand Testnet configuration.
-   Create `.env.example`.

### Exit criteria

A written `docs/implementation-notes.md` exists with:

-   actual package versions
-   confirmed x402 API shape
-   confirmed facilitator URL
-   confirmed Algorand Testnet
-   unresolved issues, if any

Do not proceed with guessed APIs.

------------------------------------------------------------------------

## Phase 1 --- Smallest Real x402 Payment

Build the smallest possible paid endpoint first.

Example:

``` text
GET /api/test-payment
```

It returns a real x402 402 response when unpaid.

Create a tiny agent/client script that:

1.  requests the endpoint
2.  receives 402
3.  creates/signs the payment
4.  retries
5.  facilitator verifies/settles
6.  receives 200

### Required E2E test

``` text
agent
 -> HTTP 402
 -> payment signature
 -> facilitator
 -> Algorand Testnet settlement
 -> HTTP 200
```

Capture:

-   HTTP status before payment
-   HTTP status after payment
-   payment transaction ID
-   Algorand explorer URL

### HARD GATE

Do not spend time on UI polish or complex contract work until this works
against the real Testnet.

------------------------------------------------------------------------

## Phase 2 --- Wallet Provisioning

Implement:

``` text
POST /api/session
```

Responsibilities:

1.  create session ID
2.  generate Algorand Testnet keypair
3.  store private key securely in server memory for the demo
4.  fund the account from a pre-funded team account
5.  return public address
6.  assign agent ID

### Tests

-   new session creates a unique wallet
-   wallet is funded
-   address is valid
-   private key is never returned to browser
-   private key is never logged

------------------------------------------------------------------------

## Phase 3 --- Room and Product State

Create one deterministic room.

Example:

``` text
roomId = demo-room
productId = demo-product
```

Product:

``` text
name
description
baseValue
publicAttributes
hint
hiddenTarget
targetNonce
commitment
startTime
deadline
status
```

Room states:

``` text
CREATED
OPEN
BIDDING_CLOSED
REVEALING
SETTLED
```

Do not build multi-room support.

------------------------------------------------------------------------

## Phase 4 --- x402 Room Entry

Protect:

``` text
POST /api/room/:id/enter
```

Flow:

``` text
Participant
 -> room page
 -> Pay & Enter
 -> x402
 -> facilitator
 -> Algorand
 -> agent assignment
```

The browser should NOT handle private agent keys.

The backend creates/assigns the server-managed wallet.

### E2E test

Given a fresh session:

1.  open room
2.  call enter without payment
3.  assert 402
4.  perform real payment
5.  assert 200
6.  assert agent assigned
7.  assert payment transaction exists

------------------------------------------------------------------------

## Phase 5 --- Agent Client

Implement the agent as a deterministic worker.

State machine:

``` text
idle
  ↓
analyzing
  ↓
buying_hint       (only when confidence is low)
  ↓
thinking
  ↓
bid_submitted
```

Agent behavior:

``` text
fetch public product
      ↓
baseline estimate
      ↓
confidence
      ↓
if low confidence:
    pay x402 hint fee
    receive hint
      ↓
refine estimate
      ↓
submit exactly one bid
```

Use a deterministic heuristic first.

Example:

``` text
estimate = baseValue
          + categoryAdjustment
          + conditionAdjustment
          + demandAdjustment
```

Create at least three personas:

-   `conservative`
-   `balanced`
-   `aggressive`

At least one MUST buy a hint.

At least one MUST NOT buy a hint.

This is required for the demo story.

------------------------------------------------------------------------

## Phase 6 --- Smart Contract

Only after the x402 path is proven.

Implement or adapt the Algorand Python marketplace contract.

Required contract behavior:

### Create room

Stores:

-   room ID
-   target commitment
-   deadline
-   treasury
-   seller
-   product/asset information

### Submit sealed bid

Checks:

-   room open
-   before deadline
-   caller has not already bid
-   commitment format valid
-   escrow amount present

### Close/reveal

Checks:

-   deadline passed
-   target + nonce matches commitment
-   determines minimum absolute distance
-   applies earliest-bid tie-break

### Settle

Must:

-   pay winner/product ownership as defined by the MVP
-   pay seller
-   send platform fee to treasury
-   refund losers
-   close room

Do not rely on frontend/backend calculations for the authoritative
winner.

------------------------------------------------------------------------

## Phase 7 --- Agent → Contract Integration

Connect the real agent to the contract.

Required path:

``` text
Agent
 -> product
 -> valuation
 -> optional x402 hint
 -> sealed bid
 -> Algorand transaction
 -> contract
```

Create tests for:

-   valid bid
-   duplicate bid rejected
-   late bid rejected
-   no bids
-   normal winner
-   tie
-   reveal mismatch
-   loser refund
-   winner settlement
-   fee transfer

------------------------------------------------------------------------

## Phase 8 --- Full E2E Test Harness

This is the most important development phase.

Create a script such as:

``` bash
npm run test:e2e
```

It must execute the complete demo without human intervention.

Expected output:

``` text
[1/12] Create room                    PASS
[2/12] Create participant wallet     PASS
[3/12] Fund participant wallet       PASS
[4/12] x402 room entry               PASS
[5/12] Assign agent                  PASS
[6/12] Agent reads product            PASS
[7/12] Agent buys hint via x402       PASS
[8/12] Second agent skips hint        PASS
[9/12] Submit sealed bids             PASS
[10/12] Reveal target                 PASS
[11/12] Determine winner              PASS
[12/12] On-chain settlement           PASS
```

The script must print transaction IDs and explorer URLs.

### E2E acceptance criteria

A clean run must prove:

-   at least one real x402 payment
-   at least one agent initiated payment
-   at least two agents participated
-   one agent bought a hint
-   one agent did not
-   each agent submitted at most one bid
-   target remained hidden until reveal
-   winner is deterministic
-   loser funds are returned
-   seller/treasury/winner settlement is on-chain
-   no manual intervention is needed

------------------------------------------------------------------------

## Phase 9 --- UI

Only after `npm run test:e2e` is green.

Build:

### QR page

Shows:

-   room QR
-   room ID
-   demo URL

### Room page

Shows:

-   product
-   base value
-   listing information if applicable
-   countdown
-   agent cards
-   agent status
-   "buying hint" as the most visually obvious event

Never show the hidden target before reveal.

### Reveal page

Shows:

-   hidden target
-   every agent prediction
-   distance
-   winner
-   x402 payment events
-   contract settlement transaction
-   explorer links

The UI is an observer of real state, not the source of truth.

------------------------------------------------------------------------

## Phase 10 --- Failure Handling

Implement visible errors for:

-   wallet funding failure
-   x402 payment rejection
-   facilitator unavailable
-   insufficient balance
-   duplicate bid
-   late bid
-   invalid reveal
-   contract failure
-   agent timeout

Never show:

``` text
"Something went wrong"
```

when a useful error reason is available.

Agents should fail visibly:

``` text
NO_BID
PAYMENT_FAILED
BID_REJECTED
TIMEOUT
```

rather than disappearing.

------------------------------------------------------------------------

## Phase 11 --- Repeatability and Demo Mode

Create a deterministic demo seed.

The demo should use:

-   fixed product
-   fixed target
-   fixed agent personas
-   deterministic heuristic
-   controlled timing

Randomness must not decide whether the demo succeeds.

Provide:

``` bash
npm run demo:reset
npm run demo:start
npm run test:e2e
```

The reset command should restore the room to a known state.

------------------------------------------------------------------------

## Phase 12 --- Final Verification

Before declaring the project complete:

### Automated

``` bash
npm run lint
npm run typecheck
npm test
npm run test:contract
npm run test:e2e
```

All must pass.

### Manual

Verify:

-   QR works on a phone
-   room works on mobile
-   room works on projector
-   transaction IDs resolve
-   explorer links work
-   target is hidden before reveal
-   hint purchase is visibly agent initiated
-   winner is correct
-   settlement balances are correct
-   no private key appears in browser/network logs
-   `.env` is not committed

------------------------------------------------------------------------

# 8. E2E Test Strategy

The project is NOT finished because individual unit tests pass.

The definition of done is:

> A fresh environment can execute the real business loop from
> participant creation to on-chain settlement.

Use three test levels:

## Unit tests

For:

-   valuation heuristic
-   confidence calculation
-   target commitment
-   winner calculation
-   tie-break
-   room state transitions

## Integration tests

For:

-   x402 middleware
-   facilitator communication
-   Algorand client
-   contract calls
-   wallet funding

## E2E

For:

``` text
QR/session
→ wallet
→ x402 entry
→ agent
→ product
→ x402 hint
→ sealed bid
→ reveal
→ settlement
```

E2E has priority over UI tests.

------------------------------------------------------------------------

# 9. Security Rules

Even though this is a hackathon:

-   Never commit `.env`.
-   Never print private keys.
-   Never send private keys to the browser.
-   Never expose mnemonics in API responses.
-   Never use production/MainNet keys.
-   Use dedicated Testnet accounts.
-   Validate all amounts and IDs.
-   Validate room state transitions.
-   Prevent duplicate bids.
-   Enforce deadlines server-side and contract-side.
-   Treat all browser input as untrusted.
-   Keep the target server-side/on-chain commitment until reveal.

------------------------------------------------------------------------

# 10. Observability

Every important action must have structured logs.

Use IDs:

``` text
sessionId
agentId
roomId
productId
paymentId
txId
bidId
```

Example:

``` text
[agent] agent=agent-balanced status=buying_hint
[x402] agent=agent-balanced payment=... tx=...
[bid] agent=agent-balanced bid=...
[reveal] target revealed
[settlement] winner=agent-balanced tx=...
```

Never log secrets.

------------------------------------------------------------------------

# 11. Demo Narrative

The UI and logs should make this sequence obvious:

``` text
1. "Agent A joins the room."
2. "Agent A estimates the product."
3. "Agent A is uncertain."
4. "Agent A decides to spend $0.05 for more information."
5. "HTTP 402 appears."
6. "Agent signs the payment."
7. "Algorand settles it."
8. "Agent receives the hint."
9. "Agent updates its prediction."
10. "Agents submit sealed bids."
11. "Target is revealed."
12. "Closest prediction wins."
13. "Algorand settles the outcome."
```

The moment between steps 5--7 is the key x402 moment.

Do not hide it behind an instant UI transition.

------------------------------------------------------------------------

# 12. Scope Cut Rules

If something breaks, cut in this order:

### Cut first

1.  LLM
2.  fancy animations
3.  multiple hint tiers
4.  reasoning text
5.  OpenCV
6.  extra UI
7.  multi-agent scaling beyond the scripted cast

### Preserve at all costs

1.  Real x402 payment
2.  Agent-initiated hint payment
3.  Real Algorand Testnet transaction
4.  Sealed bid
5.  Reveal
6.  Winner calculation
7.  Settlement
8.  E2E test

If the custom contract becomes the blocker, use the simplest defensible
on-chain settlement path available, but do NOT fake x402.

------------------------------------------------------------------------

# 13. Working Agreement for Claude Code

Before making a major architectural change:

1.  Check the PRD.
2.  Check this file.
3.  Check actual installed package APIs.
4.  Prefer the smallest implementation.
5.  Run the relevant test.
6.  Keep the E2E path green.

Do not:

-   rewrite the project unnecessarily
-   upgrade dependencies just for convenience
-   introduce a framework because it is personally preferred
-   invent x402 APIs
-   invent Algorand contract APIs
-   replace real Testnet calls with mocks in the E2E path
-   add features because they "might be useful"

When uncertain, inspect the installed package/reference implementation
and verify.

------------------------------------------------------------------------

# 14. Definition of Done

The MVP is DONE only when:

``` text
QR
 ↓
Participant session
 ↓
Testnet wallet
 ↓
Real x402 entry payment
 ↓
Agent assigned
 ↓
Agent analyzes product
 ↓
Agent autonomously buys hint with real x402 payment
 ↓
Hint returned
 ↓
Multiple agents submit exactly one sealed bid
 ↓
Bidding closes
 ↓
Target revealed
 ↓
Winner determined
 ↓
Losers refunded
 ↓
Seller + treasury + winner settlement executed on Algorand
 ↓
Explorer transaction IDs visible
 ↓
Automated E2E test passes
```

The final command that matters most is:

``` bash
npm run test:e2e
```

It must pass against the real Algorand Testnet.

**Do not call the project complete until the entire chain above has been
executed successfully.**
