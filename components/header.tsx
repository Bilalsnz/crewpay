"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shortAddress } from "@/lib/format";
import { NETWORKS, type NetworkKey } from "@/lib/networks";
import { deepLink, isMobile, isUserRejection } from "@/lib/wallet";
import { installedWallets, WALLET_LABEL, WALLET_IDS, type WalletId } from "@/lib/wagmi";
import { useNetwork } from "./network-provider";
import { Button, Note } from "./ui";

function NetworkSwitch() {
  const { network, setNetwork } = useNetwork();
  const keys: NetworkKey[] = ["testnet", "mainnet"];
  return (
    <div className="flex rounded-full bg-white/20 p-0.5" role="group" aria-label="Network">
      {keys.map((key) => {
        const active = key === network;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setNetwork(key)}
            aria-pressed={active}
            className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide transition ${
              active ? "bg-white text-ink" : "text-white/90"
            }`}
          >
            {NETWORKS[key].shortLabel}
          </button>
        );
      })}
    </div>
  );
}

function ConnectControl() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, error, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<WalletId[]>([]);
  const [mobile, setMobile] = useState(false);

  // window is not available while rendering on the server, so detection has to
  // happen after mount or the markup would differ between the two.
  useEffect(() => {
    setInstalled(installedWallets());
    setMobile(isMobile());
  }, []);

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white">
          {shortAddress(address)}
        </span>
        <button
          type="button"
          onClick={() => disconnect()}
          className="text-xs font-semibold text-white/80 underline underline-offset-2"
        >
          Disconnect
        </button>
      </div>
    );
  }

  const available = WALLET_IDS.filter((id) => installed.includes(id));
  const notInstalled = WALLET_IDS.filter((id) => !installed.includes(id));
  const currentUrl = typeof window === "undefined" ? "" : window.location.href;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="rounded-full bg-white px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-ink"
      >
        {isPending ? "Connecting…" : "Connect"}
      </button>

      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-72 rounded-[16px] bg-white p-3 shadow-[0_20px_50px_-20px_rgba(16,24,40,0.6)]">
          {available.length > 0 ? (
            <>
              <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">In this browser</p>
              <div className="flex flex-col gap-2">
                {available.map((id) => {
                  const target = connectors.find((c) => c.id === id);
                  if (!target) return null;
                  return (
                    <Button
                      key={id}
                      variant="ghost"
                      full
                      disabled={isPending}
                      onClick={() => {
                        connect({ connector: target });
                        setOpen(false);
                      }}
                    >
                      {WALLET_LABEL[id]}
                    </Button>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="px-1 pb-2 text-sm text-muted">
              No wallet in this browser.
              {mobile ? " Open this page inside a wallet app:" : " Install one, or open this page on your phone:"}
            </p>
          )}

          {/* A phone browser is not a wallet. These wrappers hand the page to the
              app, which is the only thing that actually works from Chrome. */}
          <p className="px-1 pb-2 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Open in</p>
          <div className="flex flex-col gap-2">
            {notInstalled.map((id) => (
              <a
                key={id}
                href={deepLink(id, currentUrl)}
                className="rounded-xl border border-line bg-white px-4 py-3 text-center text-sm font-semibold text-ink"
              >
                {WALLET_LABEL[id]}
              </a>
            ))}
          </div>

          {error && !isUserRejection(error) ? (
            <div className="pt-2">
              <Note tone="bad">{error.message.split("\n")[0]}</Note>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AppHeader({ back }: { back?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <header className="mb-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {back ? (
          <Link href={back} className="text-sm font-semibold text-white/90">
            ‹ Back
          </Link>
        ) : null}
        <Link href="/" className="text-lg font-black tracking-tight text-white">
          CrewPay
        </Link>
      </div>
      <div className="flex items-center gap-2">
        <NetworkSwitch />
        {/* Wallet detection reads `window`, so it only renders after mount —
            otherwise the server and client markup would disagree. */}
        {mounted ? <ConnectControl /> : null}
      </div>
    </header>
  );
}
