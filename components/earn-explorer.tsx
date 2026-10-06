"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { useNetwork } from "@/components/network-provider";
import { Shell } from "@/components/shell";
import { Card, Label, LinkButton, Note, Row } from "@/components/ui";
import { FOOTER_EARN } from "@/lib/brand";
import {
  ASSETS,
  CHAINS,
  NO_INTEGRATION_NOTE,
  OPPORTUNITIES,
  VERIFIED_COUNT,
  chainByKey,
  formatApy,
  formatTvl,
  type AssetKey,
  type ChainKey,
  type Opportunity,
  type OpportunityStatus,
} from "@/lib/earn";
import { NETWORKS } from "@/lib/networks";
import { formatUsdFixed } from "@/lib/zerocon.mjs";

/**
 * Earn.
 *
 * The one thing on this page that reads from a chain is the portfolio balance,
 * and it reads pathUSD on Tempo — the asset FlowPay actually settles in, on the
 * network it actually settles on. Everything else is a registry lookup. That
 * division is deliberate: a page that shows a real balance next to invented
 * APYs teaches people to trust both equally.
 *
 * Browsing needs no wallet. Connecting adds one number.
 */

const BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** `1234567.80` → `1,234,567.80`. Six-decimal amounts get long fast. */
function group(value: string): string {
  const [whole, fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-full px-4 text-xs font-bold uppercase tracking-wide transition ${
        active ? "bg-white text-ink" : "bg-white/20 text-white/90"
      }`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: OpportunityStatus }) {
  const verified = status === "verified";
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
        verified ? "bg-mint-soft text-mint" : "bg-holdback-soft text-holdback"
      }`}
    >
      {verified ? "Verified live" : "Coming soon"}
    </span>
  );
}

function OpportunityCard({ item }: { item: Opportunity }) {
  const chain = chainByKey(item.chain);
  return (
    <Card edge={item.status === "verified" ? "mint" : "crew"}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-bold leading-snug text-ink">{item.name}</h3>
        <StatusBadge status={item.status} />
      </div>
      <p className="pt-1 text-xs text-muted">
        {chain.label} · {item.asset}
        {chain.role === "discovery" ? " · discovery only" : ""}
      </p>

      <div className="pt-2">
        <Row label="APY">{formatApy(item.apy) ?? "APY unavailable"}</Row>
        <Row label="TVL">{formatTvl(item.tvlUsd) ?? "TVL unavailable"}</Row>
        <Row label="Protocol">{item.protocol ?? "Coming soon"}</Row>
        <Row label="Risk">{item.risk ?? "Risk information unavailable"}</Row>
      </div>

      <div className="pt-3">
        <LinkButton href={`/earn/${item.id}`} variant="ghost" full>
          View opportunity
        </LinkButton>
      </div>
    </Card>
  );
}

export function EarnExplorer() {
  const { network } = useNetwork();
  const config = NETWORKS[network];

  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });

  const [mounted, setMounted] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const [chain, setChain] = useState<"all" | ChainKey>("all");
  const [asset, setAsset] = useState<"all" | AssetKey>("all");

  // Wallet state is not known while rendering on the server, so nothing that
  // depends on it may render until after mount or the markup would mismatch.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!isConnected || !address || !client) {
      setBalance(null);
      setReadError(null);
      return;
    }
    let cancelled = false;
    setReading(true);
    setReadError(null);
    client
      .readContract({
        address: config.pathUsd,
        abi: BALANCE_ABI,
        functionName: "balanceOf",
        args: [address],
      })
      .then((value) => {
        if (!cancelled) setBalance(value as bigint);
      })
      .catch(() => {
        if (!cancelled) {
          setBalance(null);
          setReadError("Could not read your balance from the network. The page still works — only this number is missing.");
        }
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, client, config.pathUsd, isConnected]);

  const shown = useMemo(
    () =>
      OPPORTUNITIES.filter(
        (item) => (chain === "all" || item.chain === chain) && (asset === "all" || item.asset === asset),
      ),
    [asset, chain],
  );

  const balanceText = !mounted
    ? "$0.00"
    : isConnected && balance !== null
      ? `$${group(formatUsdFixed(balance))}`
      : "$0.00";

  return (
    <Shell footer={FOOTER_EARN}>
      <section className="pt-2">
        <h1 className="text-[2rem] font-black leading-tight tracking-tight text-white">Earn</h1>
        <p className="pt-1 text-lg font-bold leading-snug text-white">Put idle stablecoins to work.</p>
        <p className="pt-2 text-sm leading-relaxed text-white/90">
          Explore stablecoin yield opportunities across supported networks and protocols.
        </p>
      </section>

      <Note tone="plain">
        Every opportunity below is a discovery entry. FlowPay has no live yield integration on any network yet —
        there is nothing to deposit into, and an APY you cannot earn is shown as unavailable rather than guessed at.
      </Note>

      {/* Portfolio. Connecting is optional; browsing is not gated on it. */}
      <Card edge="crew">
        <Label>Your balance</Label>
        <p className="pt-1 text-2xl font-bold text-ink">{balanceText}</p>

        <div className="pt-2">
          <Row label={`pathUSD · ${config.shortLabel}`}>
            {!mounted ? "—" : !isConnected ? "—" : reading ? "Reading…" : balance !== null ? `$${group(formatUsdFixed(balance))}` : "—"}
          </Row>
          <Row label="USDC">Not available</Row>
          <Row label="USDT">Not available</Row>
        </div>

        {mounted && !isConnected ? (
          <p className="pt-2 text-xs text-muted">
            Connect wallet to see your positions — use <span className="font-semibold text-ink">Connect</span> at the
            top of this page. You do not need to connect to browse opportunities.
          </p>
        ) : null}

        {readError ? (
          <div className="pt-2">
            <Note tone="bad">{readError}</Note>
          </div>
        ) : null}

        <p className="pt-2 text-xs text-muted">
          FlowPay reads pathUSD on {config.label} because that is the asset it settles payments in. USDC and USDT
          balances appear once there is a verified integration on the network that holds them.
        </p>
      </Card>

      {/* Network first, then asset — the two axes people actually shop by. */}
      <div className="flex flex-col gap-2">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 no-scrollbar">
          <Chip active={chain === "all"} onClick={() => setChain("all")}>
            All networks
          </Chip>
          {CHAINS.map((item) => (
            <Chip key={item.key} active={chain === item.key} onClick={() => setChain(item.key)}>
              {item.label}
            </Chip>
          ))}
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 no-scrollbar">
          <Chip active={asset === "all"} onClick={() => setAsset("all")}>
            All assets
          </Chip>
          {ASSETS.map((item) => (
            <Chip key={item.key} active={asset === item.key} onClick={() => setAsset(item.key)}>
              {item.label}
            </Chip>
          ))}
        </div>
      </div>

      <p className="px-1 text-xs text-white/85">
        {shown.length} of {OPPORTUNITIES.length} opportunities · {VERIFIED_COUNT} verified live
      </p>

      {shown.length === 0 ? (
        <Card edge="holdback">
          <Label>Nothing matches those filters</Label>
          <p className="pt-2 text-sm text-ink">
            No opportunity in the registry is on that network with that asset yet. The registry is short on purpose —
            it only holds entries FlowPay can describe honestly.
          </p>
          <div className="pt-3">
            <button
              type="button"
              onClick={() => {
                setChain("all");
                setAsset("all");
              }}
              className="w-full rounded-xl border border-line bg-white px-4 py-3 text-sm font-semibold text-ink"
            >
              Clear filters
            </button>
          </div>
        </Card>
      ) : (
        shown.map((item) => <OpportunityCard key={item.id} item={item} />)
      )}

      <Note tone="plain">{NO_INTEGRATION_NOTE}</Note>
    </Shell>
  );
}
