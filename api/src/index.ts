import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { paymentMiddleware } from "@x402/hono";
import { resourceServer, routes } from "./x402.js";
import { createSession, getSession } from "./sessions.js";
import { ROOM_ID, PRODUCT_ID, getPublicView, getProduct } from "./rooms.js";
import { enterRoom, EntryError } from "./entry.js";
import { runAgent, AgentError, getPublicAgents } from "./agents.js";
import { revealAndSettle, revealView, getLastSettlement, SettlementError } from "./settlement.js";

const app = new Hono();

// The web app (Phase 9) runs on a different port, so this is a genuine
// cross-origin caller, not localhost-to-itself — and it must send the
// session cookie (credentials), so the origin can't be the CORS wildcard.
app.use(
  cors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  }),
);

app.use(paymentMiddleware(routes, resourceServer));

app.get("/api/test-payment", (c) => {
  return c.json({ ok: true, message: "payment settled — you paid for this" });
});

const SESSION_COOKIE = "bidding_session";

app.post("/api/session", async (c) => {
  const existingId = getCookie(c, SESSION_COOKIE);
  const existing = existingId ? getSession(existingId) : undefined;
  if (existing) {
    return c.json(existing);
  }

  try {
    const session = await createSession();
    setCookie(c, SESSION_COOKIE, session.sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 6,
    });
    return c.json(session, 201);
  } catch (err) {
    console.error("[session] funding failed:", err instanceof Error ? err.message : "unknown error");
    return c.json({ error: "SESSION_FUNDING_FAILED", message: "Could not fund a new wallet. Please try again." }, 500);
  }
});

app.get("/api/room/:id", (c) => {
  const id = c.req.param("id");
  if (id !== ROOM_ID) {
    return c.json({ error: "ROOM_NOT_FOUND", message: `No room with id "${id}". This MVP serves a single room: "${ROOM_ID}".` }, 404);
  }
  return c.json({ ...getPublicView(), agents: getPublicAgents() });
});

// The x402-gated resource. Only reachable with a real settled payment — the
// middleware intercepts everything else with a 402 before this ever runs.
// It deliberately knows nothing about sessions; entry.ts (the caller, via
// /api/session/enter below) already has all that context and records the
// participant itself once this confirms payment succeeded.
app.post("/api/room/:id/enter", (c) => {
  const id = c.req.param("id");
  if (id !== ROOM_ID) {
    return c.json({ error: "ROOM_NOT_FOUND", message: `No room with id "${id}". This MVP serves a single room: "${ROOM_ID}".` }, 404);
  }
  return c.json({ ok: true });
});

// The x402-gated hint — P0-3. Only reachable with a real settled $0.05
// payment; the middleware returns 402 to everyone else before this runs.
app.get("/api/product/:id/hint", (c) => {
  const id = c.req.param("id");
  if (id !== PRODUCT_ID) {
    return c.json({ error: "PRODUCT_NOT_FOUND", message: `No product with id "${id}".` }, 404);
  }
  return c.json(getProduct().hint);
});

const ENTRY_ERROR_STATUS: Record<string, 404 | 409 | 500 | 502> = {
  SESSION_NOT_FOUND: 404,
  ROOM_NOT_OPEN: 409,
  ENTRY_IN_PROGRESS: 409,
  PAYMENT_FAILED: 502,
  SESSION_KEY_MISSING: 500,
};

// The actual browser-facing "Pay & Enter" action. Reads the session cookie,
// pays the entry fee server-side using that session's own custodial key —
// the browser never touches a private key or a raw 402.
app.post("/api/session/enter", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) {
    return c.json({ error: "NO_SESSION", message: "Call POST /api/session first." }, 400);
  }

  try {
    const participant = await enterRoom(sessionId);
    return c.json(participant);
  } catch (err) {
    if (err instanceof EntryError) {
      console.error(`[entry] ${err.code}:`, err.message);
      return c.json({ error: err.code, message: err.message }, ENTRY_ERROR_STATUS[err.code] ?? 500);
    }
    console.error("[entry] unexpected error:", err instanceof Error ? err.message : "unknown error");
    return c.json({ error: "ENTRY_FAILED", message: "Could not complete room entry. Please try again." }, 500);
  }
});

const AGENT_ERROR_STATUS: Record<string, 400 | 404 | 409 | 500 | 502> = {
  SESSION_NOT_FOUND: 404,
  NOT_ENTERED: 409,
  ALREADY_BID: 409,
  AGENT_RUNNING: 409,
  DUPLICATE_BID: 409,
  BIDDING_CLOSED: 409,
  LATE_BID: 409,
  INVALID_BID: 400,
  PAYMENT_FAILED: 502,
};

// Runs this session's agent: analyze → maybe buy a hint → bid.
app.post("/api/session/agent/run", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) {
    return c.json({ error: "NO_SESSION", message: "Call POST /api/session first." }, 400);
  }

  try {
    const agent = await runAgent(sessionId);
    return c.json(agent);
  } catch (err) {
    if (err instanceof AgentError) {
      console.error(`[agent] ${err.code}:`, err.message);
      return c.json({ error: err.code, message: err.message }, AGENT_ERROR_STATUS[err.code] ?? 500);
    }
    console.error("[agent] unexpected error:", err instanceof Error ? err.message : "unknown error");
    return c.json({ error: "AGENT_FAILED", message: "Agent run failed. Please try again." }, 500);
  }
});

const SETTLEMENT_ERROR_STATUS: Record<string, 409 | 500> = {
  ROOM_NOT_OPEN: 409,
  TOO_EARLY: 409,
};

// Reveals every commitment on-chain, then settles atomically. The winner in
// the response is whatever the CONTRACT returned — never computed here.
app.post("/api/room/:id/settle", async (c) => {
  const id = c.req.param("id");
  if (id !== ROOM_ID) {
    return c.json({ error: "ROOM_NOT_FOUND", message: `No room with id "${id}".` }, 404);
  }

  try {
    const report = await revealAndSettle();
    return c.json(revealView(report));
  } catch (err) {
    if (err instanceof SettlementError) {
      console.error(`[settlement] ${err.code}:`, err.message);
      return c.json({ error: err.code, message: err.message }, SETTLEMENT_ERROR_STATUS[err.code] ?? 500);
    }
    console.error("[settlement] unexpected error:", err instanceof Error ? err.message : "unknown error");
    return c.json({ error: "SETTLEMENT_FAILED", message: "Could not settle the room." }, 500);
  }
});

// The reveal page's data source. Separate from POST /settle (which performs
// the action) because a browser that wasn't the one that called settle —
// a phone that scanned earlier, a projector, a page refresh — still needs a
// way to see the result. Read-only, safe to poll.
app.get("/api/room/:id/reveal", (c) => {
  const id = c.req.param("id");
  if (id !== ROOM_ID) {
    return c.json({ error: "ROOM_NOT_FOUND", message: `No room with id "${id}".` }, 404);
  }
  const report = getLastSettlement();
  if (!report) {
    return c.json({ error: "NOT_SETTLED", message: "This room has not been settled yet." }, 404);
  }
  return c.json(revealView(report));
});

const port = Number(process.env.API_PORT ?? 4021);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
  console.log(`[api] gated routes: GET /api/test-payment, POST /api/room/${ROOM_ID}/enter, GET /api/product/${PRODUCT_ID}/hint`);
});
