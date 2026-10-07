"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useChainId } from "wagmi";

import { PAY_NETWORK, NETWORKS } from "@/lib/networks";
import {
  ensureChain,
  errorMessage,
  isUserRejection,
  providerForConnector,
} from "@/lib/wallet";
import { Button, Note } from "./ui";

type Phase =
  | { state: "idle" }
  | { state: "switching" }
  | { state: "failed"; error: string };

type RequestProvider = {
  request: (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;
};

/**
 * Keeps the connected wallet on Tempo Moderato Testnet before Pay can sign.
 *
 * Pay uses exactly one network, so this guard handles the network switch
 * directly through the provider belonging to the connected wagmi connector.
 *
 * We deliberately do NOT call wagmi's switchChainAsync() after ensureChain().
 * ensureChain() already performs wallet_switchEthereumChain / wallet_addEthereumChain
 * and verifies the wallet's actual eth_chainId afterwards.
 */
export function TempoGuard() {
  const config = NETWORKS[PAY_NETWORK];
  const { isConnected, connector } = useAccount();
  const chainId = useChainId();

  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [mounted, setMounted] = useState(false);

  // Prevent repeated automatic prompts while the wallet is still on the
  // same wrong chain. The user can explicitly retry with the button.
  const asked = useRef<number | null>(null);
  const running = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const ask = useCallback(async () => {
    if (running.current) return;

    if (!connector) {
      setPhase({
        state: "failed",
        error: `No wallet connector is available. Connect a wallet to continue on ${config.label}.`,
      });
      return;
    }

    running.current = true;
    setPhase({ state: "switching" });

    try {
      // Use the provider belonging to the wallet the user actually connected.
      const provider = await providerForConnector(connector);

      if (!provider) {
        throw new Error(
          "The connected wallet did not expose a usable provider."
        );
      }

      // ensureChain:
      // 1. reads eth_chainId
      // 2. requests wallet_switchEthereumChain
      // 3. adds Tempo if the wallet returns 4902
      // 4. retries the switch after adding
      // 5. reads eth_chainId again
      await ensureChain(provider, config);

      // Verify one final time using the SAME provider.
      const requestProvider = provider as RequestProvider;

      const current = await requestProvider.request({
        method: "eth_chainId",
      });

      const actual =
        typeof current === "string"
          ? Number.parseInt(current, 16)
          : Number.NaN;

      if (actual !== config.chainId) {
        throw new Error(
          `Your wallet still reports chain ${
            typeof current === "string" ? current : "unknown"
          }. FlowPay pays on ${config.label}, chain ${config.chainId}.`
        );
      }

      // The wallet is now definitely on Tempo. Let wagmi catch up through
      // its normal account/chain events rather than issuing another switch.
      setPhase({ state: "idle" });
      asked.current = null;
    } catch (caught) {
      if (isUserRejection(caught)) {
        setPhase({
          state: "failed",
          error: `Your wallet declined the switch to ${config.label}. FlowPay can only pay from ${config.label}.`,
        });
      } else {
        setPhase({
          state: "failed",
          error:
            errorMessage(caught) ||
            `Your wallet would not switch to ${config.label}.`,
        });
      }
    } finally {
      running.current = false;
    }
  }, [config, connector]);

  useEffect(() => {
    if (!mounted) return;

    if (!isConnected) {
      asked.current = null;
      setPhase({ state: "idle" });
      return;
    }

    // Already on the correct network.
    if (chainId === config.chainId) {
      asked.current = null;
      setPhase({ state: "idle" });
      return;
    }

    // Don't repeatedly open wallet prompts for the same wrong chain.
    if (asked.current === chainId) return;

    asked.current = chainId;
    void ask();
  }, [ask, chainId, config.chainId, isConnected, mounted]);

  if (!mounted || !isConnected || phase.state === "idle") {
    return null;
  }

  if (phase.state === "switching") {
    return (
      <Note tone="plain">
        Asking your wallet to switch to {config.label}…
      </Note>
    );
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