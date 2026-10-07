"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { AiAnalysis } from "@/components/ai-analysis";
import { Shell } from "@/components/shell";
import { Card, ExternalLink, Label, LinkButton, Note, Row } from "@/components/ui";
import { FOOTER_EARN } from "@/lib/brand";
import {
  ASSETS,
  CHAINS,
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
import { NETWORKS, PAY_NETWORK } from "@/lib/networks";
import { formatUsdFixed } from "@/lib/zerocon.mjs";
import {
  LIVE_SOURCE,
  formatFetchedAt,
  formatLiveApy,
  formatLiveTvl,
  type LiveOpportunity,
  type LiveResult,
} from "@/lib/yields";

/**
 * Earn.
 *
 * Two different things are on this page and they are kept visibly apart.
 *
 *   - The balance card reads pathUSD on Tempo Moderato TESTNET, because that is
 *     the network FlowPay Pay settles on and therefore where this wallet's
 *     pathUSD actually is.
 *   - The live section reads real pools on Tempo MAINNET, from a public source,
 *     because that is where the yield is. Different network, different money,
 *     labelled differently in every row.
 *
 * The one thing that is not here is an invented number. Every figure on this
 * page is either read from a chain, read from the source, or printed as
 * unavailable — and the registry at the bottom, which has neither, says so.
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

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <section className="pt-1">
      <h2 className="text-lg font-bold tracking-tight text-white">{title}</h2>
      <p className="pt-1 text-xs leading-relaxed text-white/85">{note}</p>
    </section>
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

/**
 * One live pool.
 *
 * Every row either shows a number the source published or says the value is
 * unavailable. The base/reward split is broken out on purpose: on these pools
 * almost all of the headline APY is token incentives rather than interest paid
 * by borrowers, and those are not the same kind of yield. Rolling them into one
 * number would be technically accurate and practically misleading.
 */
function LiveCard({ item }: { item: LiveOpportunity }) {
  const readAt = formatFetchedAt(item.fetchedAt);
  return (
    <Card edge="mint">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-bold leading-snug text-ink">{item.symbol}</h3>
        <span className="shrink-0 rounded-full bg-mint-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-mint">
          Live data
        </span>
      </div>
      <p className="pt-1 text-xs text-muted">
        {item.chain} mainnet · chain {item.chainId} · {item.stablecoin ? "stablecoin pool" : "not a stablecoin pool"}
      </p>
      {item.poolMeta ? <p className="pt-0.5 text-xs text-muted">{item.poolMeta}</p> : null}

      <div className="pt-2">
        <Row label="APY">{formatLiveApy(item.apy) ?? "APY unavailable"}</Row>
        <Row label="↳ base interest">{formatLiveApy(item.apyBase) ?? "Unavailable"}</Row>
        <Row label="↳ token rewards">{formatLiveApy(item.apyReward) ?? "Unavailable"}</Row>
        <Row label="30-day mean APY">{formatLiveApy(item.apyMean30d) ?? "Unavailable"}</Row>
        <Row label="TVL">{formatLiveTvl(item.tvlUsd) ?? "TVL unavailable"}</Row>
        <Row label="Protocol, as the source labels it">{item.project}</Row>
        <Row label="Source's IL risk flag">{item.ilRisk ?? "Not published"}</Row>
        <Row label="Source's exposure">{item.exposure ?? "Not published"}</Row>
      </div>

      {item.underlyingTokens.length > 0 ? (
        <p className="pt-2 break-all text-xs text-muted">
          Underlying tokens: <span className="font-mono">{item.underlyingTokens.join(", ")}</span>
        </p>
      ) : null}
      {item.rewardTokens.length > 0 ? (
        <p className="pt-1 break-all text-xs text-muted">
          Reward tokens: <span className="font-mono">{item.rewardTokens.join(", ")}</span>
        </p>
      ) : null}

      <p className="pt-2 text-xs text-muted">
        Read from {LIVE_SOURCE.name}
        {readAt ? ` at ${readAt}` : ""}. Pool id <span className="font-mono">{item.poolId}</span>.
      </p>
    </Card>
  );
}

export function EarnExplorer({ live }: { live: LiveResult }) {
  // The Pay network, not a chosen one. Pay settles on Moderato Testnet, so this
  // is the network this wallet's pathUSD is actually on — and it is labelled as
  // testnet in the card rather than left for the reader to guess.
  const config = NETWORKS[PAY_NETWORK];

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

  const livePoolIds = useMemo(
    () => (live.ok ? live.opportunities.map((item) => item.id) : []),
    [live],
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
          Explore live stablecoin yield opportunities on Tempo Mainnet. Data is sourced from DeFiLlama.
        </p>
      </section>

      <Note tone="plain">
        Pay uses Tempo Moderato Testnet. Earn&apos;s live opportunities are on Tempo Mainnet. For research only — FlowPay
        does not currently provide deposits into these pools.
      </Note>

      {/* Portfolio. Connecting is optional; browsing is not gated on it. */}
      <Card edge="crew">
        <Label>Your pathUSD on the Pay network</Label>
        <p className="pt-1 text-2xl font-bold text-ink">{balanceText}</p>

        <div className="pt-2">
          <Row label={`pathUSD · ${config.label}`}>
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

      </Card>

      <SectionHeading title="Live on Tempo mainnet" note="Stablecoin pools currently reported on Tempo mainnet." />

      {live.ok ? (
        live.opportunities.length > 0 ? (
          <>
            <p className="px-1 text-xs text-white/85">
              {live.opportunities.length} stablecoin {live.opportunities.length === 1 ? "pool" : "pools"} on Tempo
              mainnet
              {live.excludedCount > 0
                ? ` · ${live.excludedCount} more Tempo ${live.excludedCount === 1 ? "pool is" : "pools are"} not a stablecoin pool and ${live.excludedCount === 1 ? "is" : "are"} not listed`
                : ""}
            </p>
            {live.opportunities.map((item) => (
              <LiveCard key={item.id} item={item} />
            ))}
            <AiAnalysis poolIds={livePoolIds} />
          </>
        ) : (
          <Card edge="holdback">
            <Label>No stablecoin pools right now</Label>
            <p className="pt-2 text-sm text-ink">
              The source answered, and it currently reports no stablecoin pool on Tempo mainnet. That is an empty
              result from a working source, not a failure — nothing is shown rather than a placeholder.
            </p>
          </Card>
        )
      ) : (
        <Card edge="holdback">
          <Label>The source could not be read</Label>
          <p className="pt-2 text-sm text-ink">{live.error}</p>
          <p className="pt-2 text-xs text-muted">
            FlowPay will not fill this gap with remembered numbers. When the source is reachable again the pools
            reappear here; until then the honest page is this one. The registry below is unaffected — it never claimed
            to be live.
          </p>
          <p className="pt-2 break-all text-xs">
            <ExternalLink href={LIVE_SOURCE.endpoint}>{LIVE_SOURCE.endpoint}</ExternalLink>
          </p>
        </Card>
      )}

      <SectionHeading
        title="Discovery registry"
        note="Discovery only. These opportunities are not currently integrated with FlowPay."
      />

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
        {shown.length} of {OPPORTUNITIES.length} registry entries · {VERIFIED_COUNT} verified live
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
    </Shell>
  );
}
