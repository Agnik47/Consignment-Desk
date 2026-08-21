import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware } from "@x402/hono";
import { resourceServer, routes } from "./x402.js";

const app = new Hono();

app.use(paymentMiddleware(routes, resourceServer));

app.get("/api/test-payment", (c) => {
  return c.json({ ok: true, message: "payment settled — you paid for this" });
});

const port = Number(process.env.API_PORT ?? 4021);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
  console.log(`[api] gated route: GET /api/test-payment`);
});
