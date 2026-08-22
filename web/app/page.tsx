"use client";

import { useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";

// One room, hardcoded — matches ROOM_ID in api/src/rooms.ts. This MVP
// genuinely serves a single room; a room picker here would be speculative.
const ROOM_ID = "demo-room";

// window.location is only known once mounted in the browser — no
// subscription needed (it never changes underneath us), so this is a
// snapshot read, not a real subscription. useSyncExternalStore (rather than
// an effect calling setState on mount) is the pattern React itself
// recommends for "client-only value, no hydration mismatch, no effect".
function noopSubscribe() {
  return () => {};
}

function useRoomUrl(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      // The QR must resolve to a URL the scanning phone can actually reach —
      // window.location.origin is whatever this page is being viewed from
      // (a tunnel/deployed host on demo day, localhost only in dev), which is
      // the honest answer without hand-configuring a public URL. An explicit
      // override is still available for when the visible address bar URL
      // differs from the publicly reachable one (e.g. behind a reverse proxy).
      const base = process.env.NEXT_PUBLIC_DEMO_URL ?? window.location.origin;
      return `${base}/room/${ROOM_ID}`;
    },
    () => null, // server snapshot — resolved client-side only
  );
}

export default function QrLandingPage() {
  const roomUrl = useRoomUrl();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 bg-zinc-950 px-6 py-16 text-center text-zinc-50">
      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-400">Agentic Bidding Room</p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Scan to join the room</h1>
        <p className="mx-auto max-w-md text-lg text-zinc-400">
          Your agent pays for hints and bids on your behalf — no wallet, no install.
        </p>
      </div>

      <div className="rounded-3xl bg-white p-6 shadow-2xl">
        {roomUrl ? (
          <QRCodeSVG value={roomUrl} size={280} marginSize={2} level="M" />
        ) : (
          <div className="flex h-[280px] w-[280px] items-center justify-center text-zinc-400">Loading…</div>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-sm text-zinc-500">Room ID</p>
        <p className="font-mono text-lg text-zinc-200">{ROOM_ID}</p>
      </div>

      {roomUrl && (
        <p className="max-w-md break-all font-mono text-xs text-zinc-600">{roomUrl}</p>
      )}
    </div>
  );
}
