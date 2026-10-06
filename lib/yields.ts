/**
 * Live yield data for Earn.
 *
 * The registry in `lib/earn.ts` is hand-written and every entry in it is
 * `coming-soon`, because FlowPay has no deposit integration anywhere. This file
 * is the other half: real numbers, read from a real source, about pools that
 * actually exist on Tempo mainnet.
 *
 * The source is DeFiLlama's public Yields API — no key, no account, no paid
 * tier, one GET. `https://yields.llama.fi/pools` returns every pool it tracks,
 * and the Tempo ones are what Earn shows. Nothing here is transcribed by hand:
 * if the source does not publish a value, the field is `null` and the UI is
 * required to say "unavailable". That rule is the whole reason this file is
 * separate from the registry — every number below came off the wire.
 *
 * Two things this file deliberately does NOT do:
 *
 *   - It does not claim a protocol is safe, audited or endorsed. `project` is
 *     the source's own slug, passed through verbatim and labelled as such.
 *   - It does not treat a Tempo pool as a FlowPay integration. There is no
 *     deposit contract, no route, and nothing on Earn moves money.
 *
 * Tempo's chain id is 4217 — the same value `api.llama.fi/chains` publishes for
 * its "Tempo" entry and the value `https://rpc.tempo.xyz` answers for
 * `eth_chainId` (`0x1079`), checked against each other rather than assumed.
 * That is Tempo MAINNET. FlowPay Pay settles on Moderato Testnet, chain 42431,
 * which is a different network and is why the two are labelled differently
 * everywhere they appear.
 */

export const LIVE_SOURCE = {
  name: "DeFiLlama Yields API",
  /** The endpoint that was read. Linked in the UI rather than a page URL. */
  endpoint: "https://yields.llama.fi/pools",
} as const;

/** The source's own name for the chain. Matched case-sensitively, as published. */
export const LIVE_CHAIN_NAME = "Tempo";

/** Verified in two independent places — see the note above. Tempo mainnet. */
export const LIVE_CHAIN_ID = 4217;

export interface LiveOpportunity {
  /** Stable across refetches: `llama-` plus the source's pool uuid. */
  id: string;
  poolId: string;
  /** The source's symbol, verbatim. Never reformatted into a nicer name. */
  symbol: string;
  /** The source's own `poolMeta`, when it publishes one. */
  poolMeta: string | null;
  chain: string;
  chainId: number;
  /** The source's own protocol slug, verbatim. Not a FlowPay endorsement. */
  project: string;
  /** Percent per year, or null. Null means the source did not publish it. */
  apy: number | null;
  /** The interest part of `apy`, or null. */
  apyBase: number | null;
  /** The token-incentive part of `apy`, or null. */
  apyReward: number | null;
  /** The source's own 30-day mean, or null. */
  apyMean30d: number | null;
  /** Whole dollars, or null. */
  tvlUsd: number | null;
  /** The source's impermanent-loss flag, verbatim — "no", "yes", or null. */
  ilRisk: string | null;
  /** The source's exposure description, verbatim, or null. */
  exposure: string | null;
  /** Token addresses the source lists as backing this pool. */
  underlyingTokens: string[];
  /** Token addresses the source lists as paying the reward part of the APY. */
  rewardTokens: string[];
  /** True when the source itself marks this a stablecoin pool. */
  stablecoin: boolean;
  fetchedAt: string;
}

export interface LiveOk {
  ok: true;
  fetchedAt: string;
  opportunities: LiveOpportunity[];
  /** Tempo pools the source returned that are not stablecoin pools. */
  excludedCount: number;
}

export interface LiveFailed {
  ok: false;
  error: string;
}

export type LiveResult = LiveOk | LiveFailed;

/** Anything that is not a finite number is "the source did not say". */
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Only address-shaped strings survive; a malformed one is worse than none. */
function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && /^0x[0-9a-fA-F]{40}$/.test(entry));
}

export function normalizePool(raw: unknown, fetchedAt: string): LiveOpportunity | null {
  if (!raw || typeof raw !== "object") return null;
  const pool = raw as Record<string, unknown>;
  const poolId = str(pool.pool);
  const symbol = str(pool.symbol);
  const chain = str(pool.chain);
  const project = str(pool.project);
  // A pool missing its id, symbol, chain or protocol cannot be described
  // honestly, so it is dropped rather than rendered with blanks.
  if (!poolId || !symbol || !chain || !project) return null;

  return {
    id: `llama-${poolId}`,
    poolId,
    symbol,
    poolMeta: str(pool.poolMeta),
    chain,
    chainId: LIVE_CHAIN_ID,
    project,
    apy: num(pool.apy),
    apyBase: num(pool.apyBase),
    apyReward: num(pool.apyReward),
    apyMean30d: num(pool.apyMean30d),
    tvlUsd: num(pool.tvlUsd),
    ilRisk: str(pool.ilRisk),
    exposure: str(pool.exposure),
    underlyingTokens: addresses(pool.underlyingTokens),
    rewardTokens: addresses(pool.rewardTokens),
    stablecoin: pool.stablecoin === true,
    fetchedAt,
  };
}

/**
 * Every stablecoin pool the source tracks on Tempo mainnet.
 *
 * The filter is stated in the UI rather than applied silently, and the count of
 * what it dropped comes back with the result so the page can say so out loud.
 * A hidden filter on a page about money is a small dishonesty that compounds.
 */
export async function fetchLiveOpportunities(): Promise<LiveResult> {
  const fetchedAt = new Date().toISOString();

  let payload: unknown;
  try {
    // No `next.revalidate` here on purpose. The endpoint returns every pool it
    // tracks — about 15 MB — and Next refuses to put a response that large in
    // its data cache, logging "items over 2MB can not be cached" on every
    // build. Asking for a cache that cannot exist only produces a warning that
    // looks like a bug, so the fetch is left uncached and the *page* is the
    // cache: its ISR window is what decides how often this runs.
    const response = await fetch(LIVE_SOURCE.endpoint, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, error: `${LIVE_SOURCE.name} answered ${response.status}. No yield data was read.` };
    }
    payload = await response.json();
  } catch {
    return { ok: false, error: `${LIVE_SOURCE.name} could not be reached. No yield data was read.` };
  }

  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return { ok: false, error: `${LIVE_SOURCE.name} returned a shape FlowPay does not recognise. No yield data was read.` };
  }

  const tempo = data.filter((entry) => (entry as { chain?: unknown })?.chain === LIVE_CHAIN_NAME);
  const pools = tempo.map((entry) => normalizePool(entry, fetchedAt)).filter((pool): pool is LiveOpportunity => pool !== null);
  const stable = pools.filter((pool) => pool.stablecoin);

  // Largest first — a pool with more in it is the one a person is more likely
  // to have heard of. Pools with no published TVL sort last rather than as zero.
  stable.sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.symbol.localeCompare(b.symbol));

  return {
    ok: true,
    fetchedAt,
    opportunities: stable,
    excludedCount: pools.length - stable.length,
  };
}

/** `3.49698` → `"3.50%"`. Null stays null so the caller must decide what to say. */
export function formatLiveApy(apy: number | null): string | null {
  return apy === null ? null : `${apy.toFixed(2)}%`;
}

/** `39054746` → `"$39.05M"`. Null stays null. */
export function formatLiveTvl(tvlUsd: number | null): string | null {
  if (tvlUsd === null) return null;
  if (tvlUsd >= 1_000_000) return `$${(tvlUsd / 1_000_000).toFixed(2)}M`;
  if (tvlUsd >= 1_000) return `$${(tvlUsd / 1_000).toFixed(1)}K`;
  return `$${tvlUsd.toFixed(2)}`;
}

/** An ISO timestamp as "12:34 UTC on 6 Oct 2026", or null when unparseable. */
export function formatFetchedAt(iso: string | null): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const time = `${String(when.getUTCHours()).padStart(2, "0")}:${String(when.getUTCMinutes()).padStart(2, "0")}`;
  const date = when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${time} UTC on ${date}`;
}

/** Shared by the Earn page and the analysis route so both say the same thing. */
export const LIVE_DATA_NOTE =
  "Live data means these numbers were read from the source when this page was built. It does not mean FlowPay has verified a deposit route: there is no FlowPay contract on Tempo mainnet, nothing to deposit into, and no position to open. The source's figures are its own — FlowPay repeats them and does not audit them.";

export const LIVE_SOURCE_ATTRIBUTION =
  "Protocol names, pool symbols and token addresses below are the source's own strings, reproduced exactly as published. FlowPay has not independently verified them and does not endorse them.";
