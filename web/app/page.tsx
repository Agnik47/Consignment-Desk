"use client";

import { useCallback, useState } from "react";
import { useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ApiError, createListing, VIRTUAL_ALGO_TO_USD, type PublicProduct } from "@/lib/api";

type Phase =
  | { status: "idle" }
  | { status: "capturing" }
  | { status: "ready"; roomId: string; product: PublicProduct; sellerMinAlgo: number; sellerMaxAlgo: number }
  | { status: "error"; message: string; code: string };

function describeError(err: unknown): { message: string; code: string } {
  if (err instanceof ApiError) return { message: err.message, code: err.code };
  return { message: "Could not create the listing. Please try again.", code: "UNKNOWN" };
}

function noopSubscribe() {
  return () => {};
}

/**
 * The QR must resolve to a URL the scanning phone can actually reach —
 * window.location.origin is whatever this page is being viewed from (a
 * tunnel/deployed host on demo day, localhost only in dev), which is the
 * honest answer without hand-configuring a public URL. An explicit override
 * is still available for when the visible address bar URL differs from the
 * publicly reachable one (e.g. behind a reverse proxy).
 */
function useOrigin(): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => process.env.NEXT_PUBLIC_DEMO_URL ?? window.location.origin,
    () => null, // server snapshot — resolved client-side only
  );
}

export default function ListingPage() {
  const origin = useOrigin();
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const [minAlgoInput, setMinAlgoInput] = useState("0.01");
  const [maxAlgoInput, setMaxAlgoInput] = useState("0.0145");

  const minAlgo = Number(minAlgoInput);
  const maxAlgo = Number(maxAlgoInput);
  const priceError =
    !Number.isFinite(minAlgo) || minAlgo <= 0
      ? "Minimum price must be a positive number of ALGO."
      : !Number.isFinite(maxAlgo) || maxAlgo <= 0
        ? "Maximum price must be a positive number of ALGO."
        : minAlgo > maxAlgo
          ? "Minimum price cannot exceed maximum price."
          : null;

  const handleList = useCallback(async () => {
    if (priceError) return;
    setPhase({ status: "capturing" });
    try {
      const result = await createListing({
        minPrice: minAlgo * VIRTUAL_ALGO_TO_USD,
        maxPrice: maxAlgo * VIRTUAL_ALGO_TO_USD,
      });
      setPhase({ status: "ready", roomId: result.roomId, product: result.product, sellerMinAlgo: minAlgo, sellerMaxAlgo: maxAlgo });
    } catch (err) {
      const { message, code } = describeError(err);
      setPhase({ status: "error", message, code });
    }
  }, [minAlgo, maxAlgo, priceError]);

  const reset = useCallback(() => setPhase({ status: "idle" }), []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 bg-zinc-950 px-6 py-16 text-center text-zinc-50">
      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-amber-400">Agentic Bidding Room</p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">List a product</h1>
        <p className="mx-auto max-w-md text-lg text-zinc-400">
          Set your price range, capture the item on the camera rig, then hand bidders a QR into its own live auction room.
        </p>
      </div>

      {phase.status === "idle" && (
        <div className="flex w-full max-w-sm flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 text-left">
            <label className="flex flex-col gap-1 text-sm text-zinc-400">
              Minimum price (ALGO)
              <input
                type="number"
                min="0"
                step="0.0001"
                value={minAlgoInput}
                onChange={(e) => setMinAlgoInput(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-amber-400"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-zinc-400">
              Maximum price (ALGO)
              <input
                type="number"
                min="0"
                step="0.0001"
                value={maxAlgoInput}
                onChange={(e) => setMaxAlgoInput(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-amber-400"
              />
            </label>
          </div>
          <p className="text-xs text-zinc-500">
            Priced in this system&apos;s virtual ALGO scale (0.01 ALGO = $20), not live market rate. Bidders will see the
            minimum. The maximum is your hidden target — revealed only when bidding closes.
          </p>
          {priceError && <p className="text-sm text-red-300">{priceError}</p>}
          <button
            onClick={handleList}
            disabled={!!priceError}
            className="rounded-full bg-amber-500 px-8 py-4 text-lg font-semibold text-black transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-amber-400"
          >
            List this item
          </button>
        </div>
      )}

      {phase.status === "capturing" && (
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-700 border-t-amber-400" />
          <p className="text-zinc-400">Capturing photo and deploying room… this can take up to 30s.</p>
        </div>
      )}

      {phase.status === "error" && (
        <div className="max-w-md space-y-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-6">
          <p className="text-red-300">{phase.message}</p>
          <p className="font-mono text-xs text-red-400/70">{phase.code}</p>
          <button
            onClick={handleList}
            className="rounded-full bg-zinc-800 px-5 py-2 font-semibold text-zinc-100 transition hover:bg-zinc-700"
          >
            Try again
          </button>
        </div>
      )}

      {phase.status === "ready" && (
        <div className="flex flex-col items-center gap-6">
          {phase.product.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={phase.product.imageUrl}
              alt={phase.product.name}
              className="max-h-48 rounded-2xl border border-zinc-800 object-cover"
            />
          )}
          <p className="text-lg font-semibold text-zinc-100">{phase.product.name}</p>
          <p className="text-sm text-zinc-500">
            Price range {phase.sellerMinAlgo} – {phase.sellerMaxAlgo} ALGO{" "}
            <span className="text-zinc-600">(the maximum is your hidden target — bidders never see it before reveal)</span>
          </p>

          <div className="rounded-3xl bg-white p-6 shadow-2xl">
            {origin ? (
              <QRCodeSVG value={`${origin}/room/${phase.roomId}`} size={280} marginSize={2} level="M" />
            ) : (
              <div className="flex h-[280px] w-[280px] items-center justify-center text-zinc-400">Loading…</div>
            )}
          </div>

          {origin && <p className="max-w-md break-all font-mono text-xs text-zinc-600">{`${origin}/room/${phase.roomId}`}</p>}

          <button
            onClick={reset}
            className="rounded-full border border-zinc-700 px-6 py-2 font-semibold text-zinc-200 transition hover:border-amber-400 hover:text-amber-300"
          >
            List another item
          </button>
        </div>
      )}
    </div>
  );
}
