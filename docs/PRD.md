# PRD — Agentic Bidding Room

**Version** 1.0 (hackathon MVP)
**Author** Agnik Paul & team
**Date** 21 August 2026
**Target** x402 Global Challenge PreHack — Startup Park, Bengaluru, 23 August 2026
**Status** Approved for build — scope frozen

---

## One-sentence definition

> Buyers' agents pay small x402 micro-fees to unlock hints about a product, then submit one sealed guess at its hidden value; an Algorand smart contract holds every bid in escrow and pays out to whoever guessed closest, atomically, the moment the reveal happens.

If a change under discussion doesn't serve that sentence, it's out of scope. This is the scope-control rule for the next 48 hours.

---

## 1. Problem Statement

x402 makes it possible for software to pay for things on its own — no human approving each transaction. But almost every x402 demo built so far is the same shape: a developer calls a paid API and gets data back. That proves the plumbing works; it doesn't show anyone *why machine-initiated payment is interesting*. Nothing is at stake, no decision is being made, and a human watching learns nothing they couldn't get from reading the spec.

The gap is a demo where an agent's *spending decision* visibly matters — where paying for information changes the outcome, and where a non-technical person watching the screen can tell who won and why. Without that, agentic commerce stays an abstraction that developers nod along to and nobody internalizes.

**Evidence:** Algorand's own challenge framing pushes teams toward "launch a paid endpoint and drive volume" — mechanically correct, narratively flat. The reference implementations at [x402.goplausible.xyz](https://x402.goplausible.xyz/) are single-payer, single-resource fetches; the [core examples repo](https://github.com/GoPlausible/.github/blob/main/profile/algorand-x402-documentation/typescript/x402-avm-core-examples.md) contains no multi-party or conditional-payment patterns at all. There is open room for a demo that shows agent economics rather than agent plumbing.

---

## 2. Goals

| # | Goal | How we know it worked |
|---|---|---|
| G1 | A judge understands the product in **under 30 seconds**, without a blockchain explanation | Two people outside the team can restate the loop correctly after one telling |
| G2 | At least one **real x402 payment settles on Algorand testnet**, initiated by an agent rather than a human click | Transaction visible on testnet explorer during the live demo |
| G3 | The **full loop runs end-to-end** without manual intervention | Entry → hint purchase → sealed bid → reveal → payout completes in one unbroken run |
| G4 | The agent's spending decision **visibly changes the outcome** | In the demo run, the agent that bought a hint lands closer to target than one that didn't |
| G5 | Escrow and payout are **atomic on-chain**, not backend bookkeeping | Single grouped transaction; contract state inspectable post-demo |

**Non-goal disguised as a goal:** winning the Global x402 Challenge. That's a separate, September-to-October effort requiring MainNet deployment, real USDC, Bazaar listing, and sustained usage volume — see §8.

---

## 3. Non-Goals

| Not building | Why |
|---|---|
| **Raspberry Pi + OpenCV product monitoring** | Hardware failure risk at a venue we don't control, on a demo path judges aren't scoring. Orthogonal to the payment story. Legitimate phase-2 idea; zero value on Sunday. |
| **Production wallet UX (Pera Connect, WalletConnect)** | Custodial dev-managed keys are sufficient for a judged demo and save 3+ hours of integration and failure modes. |
| **Listing fees, premium-agent tiers, subscription plans** | Five revenue lines is a slide, not a build. We implement two real ones (§5, P0-6) and speak to the rest as roadmap. |
| **Multi-room / concurrent auctions** | One room, one product, one reveal. Concurrency adds state complexity and buys no demo value. |
| **MainNet deployment or real USDC** | Testnet only. MainNet is a Global Challenge requirement, not a PreHack one, and introduces funding and irreversibility risk mid-hackathon. |
| **Seller-side onboarding flow** | Products are pre-seeded by the team. A seller UI is a whole second product surface for one demo listing. |
| **Anti-collusion / bid-privacy cryptography beyond basic commit-reveal** | Real sealed-bid security is a research problem. Commit-reveal is honest enough for a demo and we will *say* it's a demo-grade implementation rather than overclaim. |

---

## 4. User Stories

### Participant (the person who scans the QR)

1. As a **participant**, I want to join a bidding room by scanning a QR code, so that I can take part without installing a wallet or creating an account.
2. As a **participant**, I want to pay one clear entry fee and immediately be assigned an agent, so that I know exactly what I paid for and when I'm in.
3. As a **participant**, I want to watch my agent decide whether to buy a hint before it bids, so that I can see it acting on my behalf rather than just producing a number.
4. As a **participant**, I want to see all agents' guesses against the revealed target at the end, so that I understand why I won or lost.
5. As a **participant**, I want the payout to happen automatically when the room closes, so that I don't have to trust an operator to settle up.

### Agent (autonomous actor — not a human, but a first-class user of the system)

6. As an **agent**, I want to fetch a product's public attributes, so that I can form a baseline estimate.
7. As an **agent**, I want to spend from my own budget to unlock an additional hint when my confidence is low, so that I can improve my guess — without asking a human to approve that spend.
8. As an **agent**, I want to submit exactly one sealed bid before the deadline, so that I compete fairly under the room's rules.

### Judge / observer (the actual audience on Sunday)

9. As a **judge**, I want to see on-chain proof that a payment actually settled, so that I can distinguish this from a mocked-up UI.
10. As a **judge**, I want to see which payments were human-initiated versus agent-initiated, so that I can assess whether "agentic" is real here.

### Edge cases

11. As a **participant**, if my entry payment fails, I want a clear error and a retry, so that I'm not left in an ambiguous state.
12. As a **participant**, if my agent misses the bidding deadline, I want to see it marked "no bid" rather than silently disappearing.
13. As a **participant**, if two agents tie on distance from target, I want a stated, deterministic tiebreak, so that the result isn't arbitrary.

---

## 5. Requirements

### P0 — Must have (no demo without these)

**P0-1 · QR onboarding and wallet assignment**
Participant scans a QR, lands on the room page, and has an Algorand testnet account generated and bound to their session.

- [ ] QR resolves to `/room/:id` on a publicly reachable URL (tunnel or deployed — not localhost)
- [ ] Backend generates a fresh testnet keypair per session, stored server-side
- [ ] Account is funded from a pre-loaded team dispenser account (not the public faucet — rate limits will bite during a live demo)
- [ ] Wallet address is displayed to the participant
- [ ] Given a scan on a phone that has never visited before, when the page loads, then a funded account exists within 3 seconds

**P0-2 · x402-gated room entry**
Entry to the room is gated behind a real x402 payment, not a simulated one.

- [ ] `POST /room/:id/enter` returns `402` with a valid `PAYMENT-REQUIRED` header when unpaid
- [ ] Client signs and retries with `X-PAYMENT`; GoPlausible testnet facilitator verifies and settles
- [ ] Server returns `200` and assigns an agent only after settlement confirms
- [ ] Transaction ID surfaced in the UI and linked to the testnet explorer
- [ ] Given an unpaid participant, when they tap "Pay & Enter", then a settled testnet transaction exists and their agent appears in the room within 5 seconds
- [ ] Given a failed or rejected payment, when the retry returns non-200, then the UI shows a specific error and a retry control — never a silent hang

**P0-3 · x402-gated hint endpoint (the agentic payment)**
`GET /product/:id/hint` is gated behind a per-call x402 micro-payment. This is the requirement that makes the project *agentic* rather than decorative — it is the single most important P0.

- [ ] Endpoint priced at a visible micro-amount (target ~$0.05 equivalent in testnet units)
- [ ] Payment is initiated by the agent process, with no human approval step in the path
- [ ] Hint content is deliberately simple: one additional attribute (e.g. `condition: excellent`) or one extra image angle
- [ ] Each purchase is logged with agent ID, amount, and transaction ID for the demo trail
- [ ] Given an agent with low confidence, when it calls `/hint`, then a payment settles and the hint returns — with no human in the loop

**P0-4 · Sealed-bid escrow contract on Algorand testnet**
Forked from `algokit init example digital-marketplace-smart-contract`, with bid comparison changed from *highest wins* to *closest-to-target wins*.

- [ ] Contract accepts sealed bid commitments before deadline; rejects after
- [ ] Hidden target committed at room creation (hash), revealed at close
- [ ] Winner = minimum absolute distance from revealed target
- [ ] Tiebreak: earliest submission timestamp wins — stated in UI, not left implicit
- [ ] Bid funds held in contract escrow (`BoxMap`) until settlement
- [ ] One agent submits at most one bid; second attempt rejected
- [ ] Local tests pass for: normal case, tie, no-bids, late-bid rejection

**P0-5 · Agent service**
One process per agent persona. Honest about what it is — we will describe it accurately in the demo rather than implying more autonomy than exists.

- [ ] Fetches public product attributes
- [ ] Applies a confidence heuristic to decide whether to purchase a hint
- [ ] Produces a bid via LLM call or documented heuristic — whichever, we state which on stage
- [ ] Submits sealed bid to contract before deadline
- [ ] Emits status events: `idle` → `buying_hint` → `thinking` → `bid_submitted`
- [ ] At least one agent in the demo run buys a hint and at least one does not — so the contrast is visible

**P0-6 · Atomic settlement with fee**
- [ ] On reveal, contract pays seller, transfers item ownership to winner, and takes the platform settlement cut — in one atomic grouped transaction
- [ ] Losing bids returned to their agents
- [ ] Post-demo contract state is inspectable to prove the above

**P0-7 · Room UI**
Product center-stage, agent panels around it. Agent *activity* is the thing being visualized — this is the part of the screen nobody has seen before.

- [ ] Product card shows base value and listing fee; hidden target never leaks to the client before reveal
- [ ] Live countdown to close
- [ ] Per-agent status chip, visually distinct for `buying_hint` (this is the money moment)
- [ ] Reveal view: target, every bid, distance from target, winner highlighted
- [ ] Renders correctly on a phone (participants scan with phones) and on a projector (judges watch a big screen)

### P1 — Nice to have (build only if P0 is green by Saturday afternoon)

- **P1-1** Agent "reasoning" line — one sentence per agent explaining its guess. High demo value, low build cost. Strongest candidate if there's slack.
- **P1-2** Transaction feed sidebar showing every settled x402 payment live, with explorer links. Directly serves G2 and story #9.
- **P1-3** Sound/animation on reveal. Pure demo theater, genuinely effective in a noisy room.
- **P1-4** Multiple hint tiers at increasing prices, so the agent makes a *budget allocation* decision rather than a binary one.

### P2 — Future considerations (design for, don't build)

- **P2-1** Physical verification layer (Raspberry Pi + OpenCV) emitting product-state events as on-chain attestations. *Architectural note:* keep the contract's product-state field extensible so an oracle can write to it later without a schema change.
- **P2-2** Real seller onboarding and self-serve listing.
- **P2-3** Agent marketplace — users choose or bring their own agent strategies. *Architectural note:* keep the agent service behind a clean interface (`getBid(productId, budget) → sealedBid`) so third-party agents can slot in.
- **P2-4** MainNet deployment with real USDC for Global Challenge entry.

---

## 6. Success Metrics

Standard product metrics (adoption, retention, NPS) don't apply to a one-day hackathon build. These are the metrics that actually determine whether this was worth doing.

### Demo-day (measured Sunday, 23 Aug)

| Metric | Success | Stretch |
|---|---|---|
| Full loop completes without manual intervention | 1 clean run | 3 consecutive clean runs |
| Agent-initiated x402 payments settled on testnet during demo | ≥ 1 | ≥ 4 (all agents) |
| Time from QR scan to agent assigned | < 20 s | < 10 s |
| Judges who restate the loop correctly when asked | ≥ 1 | all who ask a question |
| Live demo failures requiring a restart | ≤ 1 | 0 |

### Build-phase (measured tonight and tomorrow — these are the real leading indicators)

| Checkpoint | Deadline | Why it matters |
|---|---|---|
| One manual x402 payment settles on testnet | **Fri 21 Aug, 17:00 IST** | If this slips, the entire premise is at risk — escalate immediately, don't push through |
| Contract deployed to testnet with modified bid logic | **Fri 21 Aug, 21:00 IST** | Blocks agent integration |
| First full end-to-end run (any quality) | **Fri 21 Aug, 22:00 IST** | The single most important checkpoint in the plan |
| Working state committed, tagged, backed up | **Fri 21 Aug, 23:59 IST** | Nobody sleeps until a known-good state is preserved |
| End-to-end MVP stable | **Sat 22 Aug, 11:00 IST** | Everything after this is polish and rehearsal |

**Cut rule:** if the 17:00 checkpoint fails, drop P0-4's custom contract logic and settle via a simpler contract or backend-orchestrated escrow. Preserve P0-3 (the agentic payment) at all costs — it is the differentiator; the escrow is not.

---

## 7. Open Questions

**Blocking — resolve before build starts (Fri morning)**

- **[Team]** Who is "your agent" in the room during judging? Recommendation: the human who scans sponsors one agent; the other 2–3 are team-controlled personas, so the room always has a full cast without depending on strangers with phones. *Needs a decision before P0-5.*
- **[Engineering]** Does the GoPlausible testnet facilitator have rate limits that a rapid multi-agent demo would trip? Test early — this shapes how many agents can buy hints simultaneously.
- **[Team]** LLM call or documented heuristic for the agent's bid? Either is defensible; pretending a heuristic is an LLM is not. Decide, then say the true thing on stage.

**Non-blocking — resolve during build**

- **[Engineering]** Commit-reveal for the hidden target on-chain, or backend-held with a published hash? On-chain is more defensible; backend is faster. Fall back to backend if the contract track is running late.
- **[Design]** How is `buying_hint` shown so it reads from across a room on a projector? This is the demo's signature visual moment.
- **[Team]** Does the settlement fee go to a visible "Central Agency" treasury address in the demo, or stay implicit? Visible is more convincing for the business-model question judges usually ask.
- **[Team]** Are we entering the Global Challenge in September? Not a hackathon decision — but decide deliberately after Sunday rather than by drift.

---

## 8. Timeline

### Hard deadlines

| When | What |
|---|---|
| **Sat 22 Aug, 11:00 IST** | End-to-end MVP working (team's own stated deadline) |
| **Sun 23 Aug, 08:30 IST** | Check-in at Startup Park, Bengaluru |
| **Sun 23 Aug, 17:00 IST** | Project submission deadline |
| **Sun 23 Aug, 17:30–19:30** | Demos and judging |
| **Sun 23 Aug, 19:45** | Winners announced |

Note the trap in the event schedule: submission closes at **17:00**, a full two and a half hours *before* judging ends. Whatever is in the repo at 17:00 is the entry. Treat 17:00 Sunday as the true code freeze, not 19:30.

### Phasing

- **Phase 1 (Fri 21 Aug, today):** environment, contract fork, x402 wiring, first end-to-end run by 22:00. Detailed hour-by-hour in the build plan doc.
- **Phase 2 (Sat 22 Aug):** stabilize, then UI polish, then the P1 list in priority order. Rehearse the pitch twice with the whole team.
- **Phase 3 (Sun 23 Aug):** on-site setup, scripted demo path locked (fixed product, fixed agents, fixed hidden value — never let a live random outcome decide how the demo goes), submit by 17:00, present.

### Dependencies and risks

| Dependency | Risk | Mitigation |
|---|---|---|
| GoPlausible testnet facilitator availability | External service down during demo | Record a backup video of a successful run Saturday night |
| Testnet dispenser funding | Rate limits or empty accounts on demo morning | Pre-fund several accounts Friday; verify balances Sunday 08:30 |
| Venue Wi-Fi | Live on-chain demo over conference Wi-Fi | Mobile hotspot as backup; backup video as last resort |
| Team sleep | Degraded judgment during Sunday's demo | Sleep block 00:00–07:00, rotating; no new features after 22:00 Friday |

---

## Appendix — Stack

| Layer | Choice |
|---|---|
| Contract | Algorand Python, forked from `algokit init example digital-marketplace-smart-contract` |
| Chain | Algorand testnet |
| Payment protocol | x402 via `@x402/express` + `@x402/avm`, client via `@x402/fetch` |
| Facilitator | GoPlausible managed testnet facilitator |
| Backend | Node/Express (matches the x402 middleware with least friction) |
| Agent service | Node process per persona; LLM call or heuristic per §7 |
| Frontend | Next.js, polling or WebSocket for agent status events |
| Wallets | Server-managed testnet keypairs (deliberately not production UX — see §3) |

**Sources:** [x402 HTTP 402 core concepts](https://docs.x402.org/core-concepts/http-402) · [Algorand x402 for developers](https://algorand.co/agentic-commerce/x402/developers) · [GoPlausible x402 Algorand integration](https://x402.goplausible.xyz/) · [x402-avm core examples](https://github.com/GoPlausible/.github/blob/main/profile/algorand-x402-documentation/typescript/x402-avm-core-examples.md) · [Global x402 Challenge submission guide](https://algorand.co/blog/the-x402-global-challenge-is-live-how-to-build-submit-your-entry) · [AlgoKit intro](https://dev.algorand.co/algokit/algokit-intro/) · [Digital marketplace smart contract example](https://examples.dev.algorand.co/digital-marketplace-smart-contract/)
