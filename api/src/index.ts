import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getCookie, setCookie } from "hono/cookie";
import { paymentMiddleware } from "@x402/hono";
import { resourceServer, routes } from "./x402.js";
import { createSession, getSession } from "./sessions.js";
import { ROOM_ID, getPublicView } from "./rooms.js";
import { enterRoom, EntryError } from "./entry.js";

const app = new Hono();

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
  return c.json(getPublicView());
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

const port = Number(process.env.API_PORT ?? 4021);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
  console.log(`[api] gated routes: GET /api/test-payment, POST /api/room/${ROOM_ID}/enter`);
});
