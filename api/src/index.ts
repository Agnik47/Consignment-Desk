import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getCookie, setCookie } from "hono/cookie";
import { paymentMiddleware } from "@x402/hono";
import { resourceServer, routes } from "./x402.js";
import { createSession, getSession } from "./sessions.js";
import { ROOM_ID, getPublicView } from "./rooms.js";

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

const port = Number(process.env.API_PORT ?? 4021);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
  console.log(`[api] gated route: GET /api/test-payment`);
});
