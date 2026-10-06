"use client";

import { useEffect } from "react";

import type { NetworkKey } from "@/lib/networks";
import { useNetwork } from "./network-provider";
import { AppHeader } from "./header";

/**
 * Every screen sits on the same gradient, in the same column, with the same
 * header — so the wallet and network controls are in one place on every page.
 *
 * The default footer says the contract enforces settlement, which is true of
 * every page that has one. The zero-contract pages pass their own, because on
 * those there is no CrewPay contract to do any enforcing and the line would be
 * a straight lie.
 */
export function Shell({
  children,
  back,
  footer = "CrewPay · settlement enforced by the contract on Tempo",
}: {
  children: React.ReactNode;
  back?: string;
  footer?: string;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-4 pb-10 pt-5">
      <AppHeader back={back} />
      <div className="flex flex-1 flex-col gap-4">{children}</div>
      <footer className="pt-6 text-center text-xs text-white/80">{footer}</footer>
    </main>
  );
}

/**
 * A link names its network, and opening it takes the whole app to that network.
 * That is the guard against mixing testnet and mainnet: there is no state in
 * which a testnet job is displayed while the header offers a mainnet payment.
 */
export function useFollowLinkNetwork(networkKey: NetworkKey) {
  const { setNetwork } = useNetwork();
  useEffect(() => {
    setNetwork(networkKey);
  }, [networkKey, setNetwork]);
}
