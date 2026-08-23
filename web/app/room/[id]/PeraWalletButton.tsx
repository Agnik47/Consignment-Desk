"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PeraWalletConnect } from "@perawallet/connect";

// 416001 MainNet, 416002 TestNet, 416003 BetaNet — confirmed against the
// installed @perawallet/connect@1.6.0 AlgorandChainIDs type.
const TESTNET_CHAIN_ID = 416002;

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Connect-and-view only: lets a visitor connect their own Pera Wallet to see
 * it talking to this site and inspect the address on testnet. It does NOT
 * sign or pay anything — the room's entry/hint/bid payments still go through
 * the app's server-managed custodial session wallet (see AGENTS.md §4). This
 * is deliberately kept separate from that flow rather than wired into it.
 */
export default function PeraWalletButton() {
  const walletRef = useRef<PeraWalletConnect | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDisconnect = useCallback(() => {
    setAddress(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Dynamic import: PeraWalletConnect touches window/localStorage at
    // construction time, which doesn't exist during Next's server render —
    // only ever instantiate it once we're actually running in the browser.
    import("@perawallet/connect").then(({ PeraWalletConnect }) => {
      if (cancelled) return;
      const wallet = new PeraWalletConnect({ chainId: TESTNET_CHAIN_ID });
      walletRef.current = wallet;
      wallet.reconnectSession().then((accounts) => {
        if (cancelled) return;
        if (accounts.length > 0) {
          wallet.connector?.on("disconnect", handleDisconnect);
          setAddress(accounts[0]);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [handleDisconnect]);

  const handleConnect = useCallback(async () => {
    const wallet = walletRef.current;
    if (!wallet) return;
    setConnecting(true);
    setError(null);
    try {
      const accounts = await wallet.connect();
      wallet.connector?.on("disconnect", handleDisconnect);
      setAddress(accounts[0] ?? null);
    } catch (err) {
      const type = (err as { data?: { type?: string } } | undefined)?.data?.type;
      if (type !== "CONNECT_MODAL_CLOSED") {
        setError("Could not connect Pera Wallet.");
      }
    } finally {
      setConnecting(false);
    }
  }, [handleDisconnect]);

  const handleDisconnectClick = useCallback(() => {
    walletRef.current?.disconnect();
    setAddress(null);
  }, []);

  if (address) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <a
          href={`https://lora.algokit.io/testnet/account/${address}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-full bg-zinc-900 px-3 py-1.5 font-mono text-zinc-300 transition hover:text-amber-300"
          title="View this account on the Lora testnet explorer"
        >
          {shortAddress(address)}
        </a>
        <button
          onClick={handleDisconnectClick}
          className="rounded-full border border-zinc-700 px-3 py-1.5 text-zinc-400 transition hover:border-red-400 hover:text-red-300"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="rounded-full border border-zinc-700 bg-zinc-900 px-4 py-1.5 font-semibold text-zinc-200 transition disabled:cursor-not-allowed disabled:opacity-50 hover:border-amber-400 hover:text-amber-300"
      >
        {connecting ? "Connecting…" : "Connect Pera Wallet"}
      </button>
      {error && <span className="text-red-300">{error}</span>}
    </div>
  );
}
