/**
 * The full demo, end to end, with no human in the loop.
 *
 *   npm run test:e2e
 *
 * A contract can only settle once (Phase 6/7), so this owns its OWN fresh
 * contract deployment and its OWN short-lived api server process — it never
 * touches whatever is configured in the shared .env or already running on
 * :4021. That is what makes "no manual intervention" literally true: nobody
 * has to deploy anything, start anything, or fund anything by hand first.
 *
 * AGENTS.md Phase 8 calls this the single most important phase. It prints
 * exactly the 12 numbered steps that doc asks for, with real transaction ids
 * and explorer links, and it asserts every item in the E2E acceptance list —
 * a step that merely "looks right" in printed output is not the same as a
 * verified one, so each step below checks real on-chain or real API state,
 * not just that an HTTP call returned 200.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import algosdk from "algosdk";
import { deployRoom } from "./deployRoom.js";

const TOTAL_STEPS = 12;
const PORT = Number(process.env.E2E_API_PORT ?? 4099);
const BASE_URL = `http://localhost:${PORT}`;
const BIDDING_WINDOW_MS = 60_000; // short enough to run fast, long enough for 2 agents to enter + bid
const USDC_ASSET_ID = 10458941n;

let stepIndex = 0;
const failures: string[] = [];

function logStep(label: string, ok: boolean, detail?: string) {
  const tag = `[${++stepIndex}/${TOTAL_STEPS}]`.padEnd(9);
  console.log(`${tag}${label.padEnd(32)}${ok ? "PASS" : "FAIL"}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function step<T>(label: string, fn: () => Promise<{ detail?: string; value: T }>): Promise<T> {
  try {
    const { detail, value } = await fn();
    logStep(label, true, detail);
    return value;
  } catch (err) {
    logStep(label, false, err instanceof Error ? err.message : String(err));
    throw new Error(`Step failed: ${label}`);
  }
}

function explorer(txId: string) {
  return `https://lora.algokit.io/testnet/transaction/${txId}`;
}

/** Minimal per-agent HTTP client: fetch() doesn't manage cookies across calls the way a browser does. */
class AgentClient {
  private cookie: string | undefined;

  async post(path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return { status: res.status, body: await res.json() };
  }
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`api server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${BASE_URL}/api/test-payment`);
      if (res.status === 402) return; // gated route responding = server + x402 middleware are up
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`api server did not become ready on :${PORT} within 30s`);
}

/**
 * child.kill() looked like it worked last run (no error thrown) but the
 * process kept answering on :4099 afterward — see the spawn comment above.
 * Don't trust it silently again: wait for the real exit event, and if it
 * doesn't fire in time, force it down via taskkill instead of assuming.
 */
async function killServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 3_000)),
  ]);
  if (timedOut && child.pid && process.platform === "win32") {
    console.error(`  child.kill() didn't stop pid ${child.pid} in time — forcing with taskkill`);
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  }
}

async function usdcBalance(address: string): Promise<number> {
  const info = await fetch(`https://testnet-api.algonode.cloud/v2/accounts/${address}`).then((r) => r.json());
  const holding = info.assets?.find((a: { "asset-id": number }) => a["asset-id"] === Number(USDC_ASSET_ID));
  return (holding?.amount ?? 0) / 1e6;
}

async function algoBalance(address: string): Promise<number> {
  const info = await fetch(`https://testnet-api.algonode.cloud/v2/accounts/${address}`).then((r) => r.json());
  return info.amount / 1e6;
}

async function main() {
  console.log("Agentic Bidding Room — full E2E run\n");

  // --- [1/12] Create room --------------------------------------------
  const room = await step("Create room", async () => {
    const r = await deployRoom({ log: true });
    const appInfo = await fetch(
      `https://testnet-api.algonode.cloud/v2/accounts/${algosdk.getApplicationAddress(r.appId)}`,
    ).then((res) => res.json());
    const holdsProduct = appInfo.assets?.some(
      (a: { "asset-id": number; amount: number }) => a["asset-id"] === Number(r.productAssetId) && a.amount === 1,
    );
    if (!holdsProduct) throw new Error("deployed contract does not hold the product ASA it just minted");
    return { value: r, detail: `app=${r.appId} ${r.explorerUrl}` };
  });

  // Spawn tsx's own CLI script directly via `node`, not `npx tsx` — resolving
  // npx on Windows needs shell:true (it's npx.cmd), and shell:true spawns a
  // shell -> cmd.exe -> node process TREE where child.kill() only signals the
  // shell, leaving the real server running forever (found by actually
  // checking the port after the "cleaned up" run — it was still answering).
  // This way the child IS the node process, so kill() actually kills it.
  const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: fileURLToPath(new URL("../api", import.meta.url)),
    env: {
      ...process.env,
      API_PORT: String(PORT),
      BIDDING_WINDOW_MS: String(BIDDING_WINDOW_MS),
      BIDDING_ROOM_APP_ID: String(room.appId),
      BIDDING_ROOM_PRODUCT_ASA_ID: String(room.productAssetId),
      BIDDING_ROOM_TREASURY_ADDRESS: room.treasuryAddress,
      DEMO_TARGET_CENTS: String(room.targetCents),
      DEMO_TARGET_NONCE: room.targetNonce,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout?.on("data", (d) => (serverLog += d.toString()));
  child.stderr?.on("data", (d) => (serverLog += d.toString()));
  child.on("error", (err) => {
    serverLog += `\n[spawn error] ${err.message}`;
  });

  try {
    await waitForServer(child);

    // --- [2/12] Create participant wallets ----------------------------
    const agents = [new AgentClient(), new AgentClient()];
    const sessions = await step("Create participant wallets", async () => {
      const results = [];
      for (const a of agents) {
        const { status, body } = await a.post("/api/session");
        if (status !== 201) throw new Error(`session creation returned ${status}`);
        results.push(body);
      }
      if (results[0].address === results[1].address) throw new Error("both sessions got the same address");
      return { value: results, detail: results.map((s) => s.agentId).join(", ") };
    });

    // --- [3/12] Fund participant wallets -------------------------------
    await step("Fund participant wallets", async () => {
      for (const s of sessions) {
        const [algo, usdc] = await Promise.all([algoBalance(s.address), usdcBalance(s.address)]);
        if (algo <= 0) throw new Error(`${s.agentId} has no ALGO on chain`);
        if (usdc <= 0) throw new Error(`${s.agentId} has no USDC on chain`);
      }
      return { value: null, detail: "verified real on-chain balances for both wallets" };
    });

    // --- [4/12] x402 room entry -----------------------------------------
    // conservative declines the hint, balanced buys it — the same contrast
    // the old agent-number-derived assignment produced, now picked explicitly
    // since persona is a bidder choice (the UI's persona picker), not
    // auto-assigned from arrival order.
    const PERSONAS = ["conservative", "balanced"] as const;
    const entries = await step("x402 room entry", async () => {
      const results = [];
      for (let i = 0; i < agents.length; i++) {
        const { status, body } = await agents[i].post("/api/session/enter", { roomId: "demo-room", persona: PERSONAS[i] });
        if (status !== 200) throw new Error(`entry for ${sessions[i].agentId} returned ${status}: ${JSON.stringify(body)}`);
        if (!body.entryTxId || body.entryTxId === "unknown") throw new Error("no real settlement tx id returned");
        results.push(body);
      }
      return { value: results, detail: results.map((e) => explorer(e.entryTxId)).join(" | ") };
    });

    // --- [5/12] Assign agent ---------------------------------------------
    await step("Assign agent", async () => {
      const ids = entries.map((e) => e.agentId);
      if (new Set(ids).size !== ids.length) throw new Error("duplicate agentId assigned");
      return { value: null, detail: ids.join(", ") };
    });

    // --- [6/12] Agent reads product ---------------------------------------
    await step("Agent reads product", async () => {
      const view = await fetch(`${BASE_URL}/api/room/demo-room`).then((r) => r.json());
      if (typeof view.product?.baseValue !== "number") throw new Error("product view missing baseValue");
      const raw = JSON.stringify(view);
      if (/hiddenTarget|targetNonce/.test(raw)) throw new Error("target leaked in the public product view");
      return { value: null, detail: `"${view.product.name}" — target correctly hidden` };
    });

    // --- [7/12] Agent buys hint via x402 -----------------------------------
    const runs: any[] = [];
    const buyer = await step("Agent buys hint via x402", async () => {
      const { status, body } = await agents[1].post("/api/session/agent/run", { roomId: "demo-room" }); // agent-2: balanced persona, buys
      if (status !== 200) throw new Error(`agent run returned ${status}: ${JSON.stringify(body)}`);
      if (!body.hintPurchased) throw new Error(`${body.agentId} (persona=${body.persona}) did not buy a hint`);
      runs[1] = body;
      return { value: body, detail: `${body.agentId} (${body.persona}) tx=${body.hintTxId}` };
    });

    // --- [8/12] Second agent skips hint --------------------------------
    const skipper = await step("Second agent skips hint", async () => {
      const { status, body } = await agents[0].post("/api/session/agent/run", { roomId: "demo-room" }); // agent-1: conservative, skips
      if (status !== 200) throw new Error(`agent run returned ${status}: ${JSON.stringify(body)}`);
      if (body.hintPurchased) throw new Error(`${body.agentId} bought a hint — expected it to skip`);
      runs[0] = body;
      return { value: body, detail: `${body.agentId} (${body.persona}) confidence=${body.confidence}` };
    });

    // --- [9/12] Submit sealed bids -----------------------------------------
    await step("Submit sealed bids", async () => {
      for (const r of [buyer, skipper]) {
        if (r.status !== "bid_submitted" || !r.bidTxId) throw new Error(`${r.agentId} did not reach bid_submitted with a real tx`);
      }
      const escrow = await usdcBalance(room.appAddress);
      const expected = 0.2; // 2 bidders x $0.10 stake
      if (Math.abs(escrow - expected) > 1e-9) throw new Error(`contract escrow is $${escrow}, expected $${expected}`);
      return { value: null, detail: `both bids on-chain, escrow=$${escrow} (verified)` };
    });

    // Wait out the bidding deadline — the ONE thing that takes real time,
    // and the harness handles it itself rather than a human watching a clock.
    // +5s margin: the window starts counting from first entry, not from now.
    console.log(`          waiting for the bidding deadline (~${Math.ceil(BIDDING_WINDOW_MS / 1000)}s)…`);
    await new Promise((r) => setTimeout(r, BIDDING_WINDOW_MS + 5_000));

    // --- [10/12] Reveal target -----------------------------------------
    // --- [11/12] Determine winner ----------------------------------------
    // --- [12/12] On-chain settlement -------------------------------------
    // One HTTP call drives all three — settle() reveals, determines the
    // winner ON-CHAIN, and pays out atomically in a single call. They're
    // reported as three steps because AGENTS.md's list treats reveal,
    // winner-determination, and settlement as distinct concerns to verify,
    // even though the contract (correctly) does them as one atomic action.
    const settleRes = await fetch(`${BASE_URL}/api/room/demo-room/settle`, { method: "POST" });
    const report = await settleRes.json();
    if (settleRes.status !== 200) throw new Error(`settle returned ${settleRes.status}: ${JSON.stringify(report)}`);

    await step("Reveal target", async () => {
      if (report.bids.length !== 2) throw new Error(`expected 2 revealed bids, got ${report.bids.length}`);
      return { value: null, detail: `target=$${report.target}, ${report.bids.length} bids revealed` };
    });

    const winnerAgentId = await step("Determine winner", async () => {
      if (!report.winnerAgentId) throw new Error("no winner returned by the contract");
      const winnerBid = report.bids.find((b: any) => b.agentId === report.winnerAgentId);
      const closest = [...report.bids].sort((a: any, b: any) => a.distance - b.distance)[0];
      if (winnerBid.agentId !== closest.agentId) throw new Error("contract's winner is not the closest guess — determinism broken");
      return { value: report.winnerAgentId, detail: `${report.winnerAgentId} (distance $${winnerBid.distance})` };
    });

    await step("On-chain settlement", async () => {
      if (report.settlementTxs.length === 0) throw new Error("no settlement transactions returned");
      const [winnerAlgoUsdc, loserEntry] = [
        report.bids.find((b: any) => b.isWinner),
        report.bids.find((b: any) => !b.isWinner),
      ];
      if (!winnerAlgoUsdc || !loserEntry) throw new Error("could not identify winner/loser in the settlement report");

      const winnerAddress = entries.find((e) => e.agentId === winnerAgentId)?.address;
      const loserEntryRecord = entries.find((e) => e.agentId === loserEntry.agentId);
      if (!winnerAddress || !loserEntryRecord) throw new Error("could not resolve settlement addresses");

      const [winnerProductBalance, loserUsdc, treasuryUsdc] = await Promise.all([
        fetch(`https://testnet-api.algonode.cloud/v2/accounts/${winnerAddress}`)
          .then((r) => r.json())
          .then((d) => d.assets?.find((a: any) => a["asset-id"] === Number(room.productAssetId))?.amount ?? 0),
        usdcBalance(loserEntryRecord.address),
        usdcBalance(room.treasuryAddress),
      ]);

      if (winnerProductBalance !== 1) throw new Error(`winner does not hold the product ASA (has ${winnerProductBalance})`);
      if (treasuryUsdc <= 0) throw new Error("treasury received no platform fee");

      return {
        value: null,
        detail: `winner holds item, treasury fee=$${treasuryUsdc}, ${report.settlementTxs.length} settlement txs — ${report.settlementTxs[0]}`,
      };
    });

    console.log("\nAll 12 steps passed. Full loop verified end to end, no manual intervention.");
    console.log(`Contract: ${room.explorerUrl}`);
  } catch (err) {
    console.error("\n" + serverLog.split("\n").slice(-25).join("\n"));
    console.error(`\nE2E run FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await killServer(child);
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} step(s) failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

await main();
