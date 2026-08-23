"use client";

import { useEffect, useState } from "react";
import { ApiError, getReveal, getRoom, usdToAlgo, type PublicAgent, type RevealView as RevealData } from "@/lib/api";

const POLL_MS = 2000;

export default function RevealView({ roomId }: { roomId: string }) {
  const [reveal, setReveal] = useState<RevealData | null>(null);
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const [revealData, roomData] = await Promise.all([getReveal(roomId), getRoom(roomId)]);
        if (!cancelled) {
          setReveal(revealData);
          setAgents(roomData.agents);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "NOT_SETTLED") {
          setReveal(null); // keep polling silently — this is the expected pre-settlement state
        } else if (err instanceof ApiError) {
          setError(`${err.message} (${err.code})`);
        } else {
          setError("Could not load the reveal.");
        }
      } finally {
        inFlight = false;
      }
    };

    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [roomId]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-950 px-6 text-center text-red-300">{error}</div>
    );
  }

  if (!reveal) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-zinc-950 px-6 text-center text-zinc-400">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-400" />
        <p>Waiting for the room to settle…</p>
      </div>
    );
  }

  const hintByAgent = new Map(agents.map((a) => [a.agentId, a]));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 bg-zinc-950 px-6 py-12 text-zinc-50 sm:px-10">
      <header className="space-y-2 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-400">{reveal.productName}</p>
        <h1 className="text-5xl font-bold tracking-tight">Target: {usdToAlgo(reveal.target).toFixed(4)} ALGO</h1>
        {reveal.winnerAgentId ? (
          <p className="text-xl text-emerald-300">
            🏆 <span className="font-semibold">{reveal.winnerAgentId}</span> wins
          </p>
        ) : (
          <p className="text-xl text-zinc-400">No revealed bids — the item stayed with the seller.</p>
        )}
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-500">Every prediction</h2>
        <div className="space-y-2">
          {reveal.bids.map((bid) => {
            const agent = hintByAgent.get(bid.agentId);
            return (
              <div
                key={bid.agentId}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 ${
                  bid.isWinner ? "border-emerald-400/60 bg-emerald-500/10" : "border-zinc-800 bg-zinc-900"
                }`}
              >
                <div>
                  <p className="font-semibold">
                    {bid.agentId} {bid.isWinner && <span className="text-emerald-300">— WINNER</span>}
                  </p>
                  {agent && <p className="text-xs uppercase tracking-wide text-zinc-500">{agent.persona}</p>}
                </div>
                <div className="text-right">
                  <p className="text-lg font-mono">{usdToAlgo(bid.guess).toFixed(4)} ALGO</p>
                  <p className="text-xs text-zinc-500">distance {usdToAlgo(bid.distance).toFixed(4)} ALGO</p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {agent?.hintPurchased && agent.hintTxId && (
                    <a
                      href={`https://lora.algokit.io/testnet/transaction/${agent.hintTxId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full bg-amber-900/40 px-2 py-1 text-amber-300 hover:underline"
                    >
                      hint payment ↗
                    </a>
                  )}
                  <a
                    href={bid.revealTx}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full bg-zinc-800 px-2 py-1 text-zinc-300 hover:underline"
                  >
                    reveal tx ↗
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-500">Settlement — atomic, on-chain</h2>
        <div className="flex flex-wrap gap-2">
          {reveal.settlementTxs.map((tx) => (
            <a
              key={tx}
              href={tx}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 hover:underline"
            >
              settlement tx ↗
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
