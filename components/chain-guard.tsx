"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

import { PAY_NETWORK, NETWORKS } from "@/lib/networks";
import { ensureChain, errorMessage, isUserRejection, providerForConnector } from "@/lib/wallet";
import { Button, Note } from "./ui";

/**
 * Puts the wallet on Tempo Moderato before anything is signed.
 *
 * FlowPay Pay settles on one network, so a wallet connected to another EVM
 * chain is not a situation to explain — it is a situation to fix, once, without
 * the client having to know what a chain id is. This runs the moment a wallet
 * connects or its chain changes, asks for the switch, and re-reads
 * `eth_chainId` afterwards rather than trusting the request to have worked.
 *
 * What it deliberately does not do is tell anyone to go and switch manually and
 * reload. That instruction is the app giving up and calling it a user error: the
 * client did nothing wrong, and the page can ask the wallet itself.
 *
 * A rejected switch is not a dead end either. The banner stays with a Try again
 * button, and the payment page keeps working the moment the switch lands.
 */

type Phase = { state: "idle" } | { state: "switching" } | { state: "failed"; error: string };

export function TempoGuard() {
  const config = NETWORKS[PAY_NETWORK];
  const { isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [mounted, setMounted] = useState(false);

  // The chain we last asked about. Without this, a wallet that refuses the
  // switch would be asked again on every render — a prompt loop, which is a
  // worse experience than the wrong network.
  const asked = useRef<number | null>(null);
  const running = useRef(false);

  useEffect(() => setMounted(true), []);

  const ask = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase({ state: "switching" });
    try {
      const provider = await providerForConnector(connector);
      // `ensureChain` covers both cases: the wallet knows Tempo and just needs
      // to move to it, or it has never heard of it (error 4902) and needs the
      // chain added first. Both payloads come from networks.json.
      await ensureChain(provider, config);
      // Keep wagmi's own view of the chain in step with the wallet's, so
      // `useWalletClient({ chainId })` below resolves instead of staying null.
      if (switchChainAsync) {
        try {
          await switchChainAsync({ chainId: config.chainId });
        } catch {
          /* the wallet is already there — the re-read below is what decides */
        }
      }
      // The wallet is the authority on which chain it is on, so ask it again
      // rather than assuming the request was honoured.
      const request = (provider as { request?: (args: { method: string }) => Promise<unknown> } | undefined)?.request;
      const now = request ? await request({ method: "eth_chainId" }) : undefined;
      const actual = typeof now === "string" ? Number.parseInt(now, 16) : Number.NaN;
      if (actual === config.chainId) {
        // `asked` is deliberately left pointing at the chain we came from. wagmi
        // learns about the new chain from the wallet's own `chainChanged` event,
        // which lands a moment later; clearing the marker here would let the
        // effect fire a second prompt in that gap. It is cleared for real once
        // wagmi reports the right chain.
        setPhase((prev) => (prev.state === "idle" ? prev : { state: "idle" }));
        return;
      }
      setPhase({
        state: "failed",
        error: `Your wallet still reports chain ${typeof now === "string" ? now : "unknown"}. FlowPay pays on ${config.label}, chain ${config.chainId}.`,
      });
    } catch (caught) {
      if (isUserRejection(caught)) {
        setPhase({
          state: "failed",
          error: `Your wallet declined the switch to ${config.label}. FlowPay can only pay from ${config.label} — the transaction is signed there.`,
        });
      } else {
        setPhase({ state: "failed", error: errorMessage(caught) || `Your wallet would not switch to ${config.label}.` });
      }
    } finally {
      running.current = false;
    }
  }, [config, connector, switchChainAsync]);

  useEffect(() => {
    if (!mounted) return;
    // These two `setPhase` calls run on every render where the wallet is fine,
    // so they return the existing object instead of a fresh one — a new object
    // here would re-render, re-run this effect, and loop forever.
    const settle = () => setPhase((prev) => (prev.state === "idle" ? prev : { state: "idle" }));
    if (!isConnected) {
      asked.current = null;
      settle();
      return;
    }
    if (chainId === config.chainId) {
      asked.current = null;
      settle();
      return;
    }
    if (asked.current === chainId) return;
    asked.current = chainId;
    void ask();
  }, [ask, chainId, config.chainId, isConnected, mounted]);

  if (!mounted || !isConnected || phase.state === "idle") return null;

  if (phase.state === "switching") {
    return <Note tone="plain">Asking your wallet to switch to {config.label}…</Note>;
  }

  return (
    <div className="flex flex-col gap-2">
      <Note tone="warn">{phase.error}</Note>
      <Button
        variant="ghost"
        full
        onClick={() => {
          asked.current = null;
          void ask();
        }}
      >
        Try the switch again
      </Button>
    </div>
  );
}
