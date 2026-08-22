"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  createSession,
  enterRoom,
  getRoom,
  runAgent,
  type AgentStatus,
  type PublicAgent,
  type RoomView as RoomViewData,
  type SessionRecord,
} from "@/lib/api";

const POLL_MS = 1500;

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  return fallback;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const STATUS_STYLE: Record<AgentStatus, { label: string; className: string }> = {
  idle: { label: "Idle", className: "bg-zinc-800 text-zinc-400" },
  analyzing: { label: "Analyzing", className: "bg-sky-900/60 text-sky-300 animate-pulse" },
  // The money moment — PRD calls this out explicitly as the most visually
  // important status: an agent spending its own money, on its own decision.
  buying_hint: { label: "Buying hint (x402)", className: "bg-amber-500 text-black font-bold animate-pulse ring-2 ring-amber-300" },
  thinking: { label: "Thinking", className: "bg-indigo-900/60 text-indigo-300 animate-pulse" },
  bid_submitted: { label: "Bid submitted", className: "bg-emerald-900/60 text-emerald-300" },
  failed: { label: "Failed", className: "bg-red-900/60 text-red-300" },
};

export default function RoomView({ roomId }: { roomId: string }) {
  const router = useRouter();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [room, setRoom] = useState<RoomViewData | null>(null);
  const [entering, setEntering] = useState(false);
  const [entered, setEntered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const agentRunTriggered = useRef(false);

  useEffect(() => {
    createSession()
      .then(setSession)
      .catch((err) => setError(describeError(err, "Could not create your wallet session.")));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const view = await getRoom(roomId);
        if (!cancelled) setRoom(view);
      } catch (err) {
        if (!cancelled) setError(describeError(err, "Could not load room state."));
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

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (room?.status === "SETTLED") {
      router.push(`/room/${roomId}/reveal`);
    }
  }, [room?.status, roomId, router]);

  const hasAgentRecord = session ? (room?.agents ?? []).some((a) => a.agentId === session.agentId) : false;
  const alreadyIn = entered || hasAgentRecord;

  useEffect(() => {
    if (!alreadyIn || agentRunTriggered.current) return;
    agentRunTriggered.current = true;
    runAgent().catch((err) => setError(describeError(err, "Your agent could not run.")));
  }, [alreadyIn]);

  const handleEnter = useCallback(async () => {
    setEntering(true);
    setError(null);
    try {
      await enterRoom();
      setEntered(true);
    } catch (err) {
      setError(describeError(err, "Payment failed — could not enter the room."));
    } finally {
      setEntering(false);
    }
  }, []);

  if (error && !room) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-950 px-6 py-16 text-center text-zinc-50">
        <p className="max-w-md text-red-300">{error}</p>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-950 text-zinc-400">
        Loading room…
      </div>
    );
  }

  const remainingMs = room.deadline ? Math.max(0, room.deadline - now) : null;
  const you = session?.agentId;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 bg-zinc-950 px-6 py-10 text-zinc-50 sm:px-10">
      <header className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-400">{room.roomId}</p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{room.product.name}</h1>
          </div>
          <StatusChip status={room.status} remainingMs={remainingMs} />
        </div>
        <p className="max-w-2xl text-zinc-400">{room.product.description}</p>
        <div className="flex flex-wrap gap-3 text-sm">
          <span className="rounded-full bg-zinc-900 px-3 py-1 text-zinc-300">
            Base value <span className="font-semibold text-zinc-50">${room.product.baseValue}</span>
          </span>
          {Object.entries(room.product.publicAttributes).map(([key, value]) => (
            <span key={key} className="rounded-full bg-zinc-900 px-3 py-1 text-zinc-400">
              {key}: <span className="text-zinc-200">{String(value)}</span>
            </span>
          ))}
        </div>
      </header>

      {!alreadyIn && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
          <p className="mb-3 text-zinc-200">
            {session ? (
              <>
                Your wallet <span className="font-mono text-amber-300">{shortAddress(session.address)}</span> is ready.
                Pay the entry fee to get an agent assigned.
              </>
            ) : (
              "Setting up your wallet…"
            )}
          </p>
          <button
            onClick={handleEnter}
            disabled={!session || entering || (room.status !== "OPEN" && room.status !== "CREATED")}
            className="rounded-full bg-amber-500 px-6 py-3 font-semibold text-black transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-amber-400"
          >
            {entering ? "Paying…" : "Pay $0.50 & Enter"}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-500">Agents in the room</h2>
        {room.agents.length === 0 ? (
          <p className="text-zinc-500">No agents have entered yet — be the first to scan and pay.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {room.agents.map((agent) => (
              <AgentCard key={agent.agentId} agent={agent} isYou={agent.agentId === you} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function StatusChip({ status, remainingMs }: { status: RoomViewData["status"]; remainingMs: number | null }) {
  if (status === "CREATED") {
    return <span className="rounded-full bg-zinc-800 px-3 py-1 text-sm text-zinc-400">Waiting for first entry</span>;
  }
  if (status === "OPEN" && remainingMs !== null) {
    return (
      <span className="rounded-full bg-emerald-900/60 px-4 py-1.5 font-mono text-lg text-emerald-300">
        {formatCountdown(remainingMs)}
      </span>
    );
  }
  if (status === "BIDDING_CLOSED" || status === "REVEALING") {
    return <span className="rounded-full bg-indigo-900/60 px-3 py-1 text-sm text-indigo-300 animate-pulse">Revealing…</span>;
  }
  return <span className="rounded-full bg-zinc-800 px-3 py-1 text-sm text-zinc-400">{status}</span>;
}

function AgentCard({ agent, isYou }: { agent: PublicAgent; isYou: boolean }) {
  const style = STATUS_STYLE[agent.status];
  return (
    <div
      className={`rounded-2xl border p-5 ${isYou ? "border-amber-400/60 bg-amber-500/5" : "border-zinc-800 bg-zinc-900"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-semibold text-zinc-100">
            {agent.agentId} {isYou && <span className="text-amber-400">(you)</span>}
          </p>
          <p className="text-xs uppercase tracking-wide text-zinc-500">{agent.persona}</p>
        </div>
      </div>
      <p className="mt-2 text-sm text-zinc-400">{agent.personaDescription}</p>
      <div className={`mt-4 inline-block rounded-full px-3 py-1 text-xs ${style.className}`}>{style.label}</div>
      {agent.confidence !== null && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full bg-sky-400" style={{ width: `${Math.round(agent.confidence * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">confidence {Math.round(agent.confidence * 100)}%</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {agent.hintPurchased && <span className="rounded-full bg-zinc-800 px-2 py-1 text-amber-300">hint bought</span>}
        {agent.hasBid && <span className="rounded-full bg-zinc-800 px-2 py-1 text-emerald-300">bid sealed</span>}
        {agent.failureCode && (
          <span className="rounded-full bg-red-900/60 px-2 py-1 text-red-300">{agent.failureMessage ?? agent.failureCode}</span>
        )}
      </div>
    </div>
  );
}
