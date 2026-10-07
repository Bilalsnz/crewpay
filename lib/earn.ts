/**
 * The Earn registry.
 *
 * This file is the whole backend. There is no database, no auth, no paid API
 * and no server: an opportunity is a row here, and adding a real one later
 * means adding a row with real values in it — not building a pipeline.
 *
 * The rule that shapes every field is that `null` means "we do not know", and
 * the UI is required to say so rather than substitute a plausible number. A
 * yield page that invents an APY is worse than a yield page that admits it has
 * none, because the first one gets someone to move money on a number that was
 * never real.
 *
 * Nothing here is `verified`. That is not an oversight — FlowPay has no
 * deployed yield integration on any network, so the honest registry is a set of
 * discovery entries, and every one of them renders as "Coming soon". The
 * `status` field and the `verified` code path exist so that the first real
 * integration is a one-line change here instead of a redesign.
 */

export type ChainKey = "tempo" | "base" | "arbitrum" | "ethereum";
export type AssetKey = "USDC" | "USDT" | "pathUSD";
export type RiskLevel = "Low" | "Medium" | "High";

/**
 * `verified` — FlowPay has a real, checked integration: the protocol and the
 * contract address are known and the UI may offer a deposit.
 * `coming-soon` — discovery only. No contract is deployed, no deposit exists,
 * and the APY/TVL/risk fields must stay null.
 */
export type OpportunityStatus = "verified" | "coming-soon";

export interface Chain {
  key: ChainKey;
  label: string;
  /** `settlement` — FlowPay moves money here today. `discovery` — not yet. */
  role: "settlement" | "discovery";
  note: string;
}

export interface Opportunity {
  id: string;
  name: string;
  chain: ChainKey;
  asset: AssetKey;
  /** The protocol, when one has actually been verified. Otherwise null. */
  protocol: string | null;
  /** Percent, or null. Never a placeholder number. */
  apy: number | null;
  /** Whole dollars, or null. Never a placeholder number. */
  tvlUsd: number | null;
  risk: RiskLevel | null;
  /** Why that risk label applies. Required whenever `risk` is set. */
  riskBasis: string | null;
  /** What the strategy actually does, in plain words. */
  strategy: string;
  status: OpportunityStatus;
  /** Where to read about the protocol — only once one is verified. */
  url: string | null;
  /** The contract a deposit would go to — only once one is verified. */
  contractAddress: `0x${string}` | null;
}

export const CHAINS: Chain[] = [
  {
    key: "tempo",
    label: "Tempo",
    // `discovery`, not `settlement`: this entry is about Tempo MAINNET, where
    // FlowPay has no integration and moves no money. Pay settles on Moderato
    // testnet (42431), which is a different network — so a badge reading
    // "settlement network" over a mainnet entry would be the exact blur this
    // page is written to avoid.
    role: "discovery",
    note: "Tempo mainnet, chain 4217. FlowPay Pay settles on Tempo Moderato testnet, chain 42431 — a different network with a different pathUSD balance.",
  },
  {
    key: "base",
    label: "Base",
    role: "discovery",
    note: "Discovery only. FlowPay has no yield integration deployed on Base.",
  },
  {
    key: "arbitrum",
    label: "Arbitrum",
    role: "discovery",
    note: "Discovery only. FlowPay has no yield integration deployed on Arbitrum.",
  },
  {
    key: "ethereum",
    label: "Ethereum",
    role: "discovery",
    note: "Discovery only. FlowPay has no yield integration deployed on Ethereum.",
  },
];

export const ASSETS: { key: AssetKey; label: string; note: string }[] = [
  { key: "USDC", label: "USDC", note: "A dollar stablecoin issued by Circle." },
  { key: "USDT", label: "USDT", note: "A dollar stablecoin issued by Tether." },
  { key: "pathUSD", label: "pathUSD", note: "The stablecoin FlowPay settles payments in on Tempo." },
];

/**
 * Every strategy sentence below describes a *category of mechanism*, not a
 * product. That distinction is the difference between explaining yield and
 * advertising it, and it is why none of these names a protocol.
 */
export const OPPORTUNITIES: Opportunity[] = [
  {
    id: "tempo-pathusd",
    name: "Idle pathUSD on Tempo",
    chain: "tempo",
    asset: "pathUSD",
    protocol: null,
    apy: null,
    tvlUsd: null,
    risk: null,
    riskBasis: null,
    strategy:
      "pathUSD is what FlowPay settles in, so it is the balance most likely to be sitting still between payments. Putting it to work means finding a venue on Tempo that pays for supplied stablecoins — and verifying that venue on chain before FlowPay would route anything into it. That has not happened yet.",
    status: "coming-soon",
    url: null,
    contractAddress: null,
  },
  {
    id: "base-usdc-lending",
    name: "Stablecoin lending — Base",
    chain: "base",
    asset: "USDC",
    protocol: null,
    apy: null,
    tvlUsd: null,
    risk: null,
    riskBasis: null,
    strategy:
      "Lending markets pay suppliers out of the interest borrowers pay. The rate is set by how much of the pool is borrowed, so it moves continuously and is never fixed in advance. The risks that matter are whether the market can be liquidated safely and whether the price feed it trusts can be manipulated.",
    status: "coming-soon",
    url: null,
    contractAddress: null,
  },
  {
    id: "arbitrum-usdc-lending",
    name: "Stablecoin lending — Arbitrum",
    chain: "arbitrum",
    asset: "USDC",
    protocol: null,
    apy: null,
    tvlUsd: null,
    risk: null,
    riskBasis: null,
    strategy:
      "The same lending mechanism as on Base, on a different chain with different liquidity, different bridge risk and different gas costs. A higher rate on one chain is often the market paying for a risk the other chain does not carry.",
    status: "coming-soon",
    url: null,
    contractAddress: null,
  },
  {
    id: "arbitrum-usdt-liquidity",
    name: "Stablecoin liquidity — Arbitrum",
    chain: "arbitrum",
    asset: "USDT",
    protocol: null,
    apy: null,
    tvlUsd: null,
    risk: null,
    riskBasis: null,
    strategy:
      "Providing liquidity to a stablecoin pair earns the fees traders pay to swap, rather than interest from borrowers. The return depends on trading volume, and the position can lose money if the two stablecoins stop trading at par with each other.",
    status: "coming-soon",
    url: null,
    contractAddress: null,
  },
  {
    id: "ethereum-usdc-lending",
    name: "Stablecoin lending — Ethereum",
    chain: "ethereum",
    asset: "USDC",
    protocol: null,
    apy: null,
    tvlUsd: null,
    risk: null,
    riskBasis: null,
    strategy:
      "Ethereum has the deepest lending markets and the highest gas costs. For a small balance the fee to enter and exit can cost more than the interest earned, which is why a position size floor belongs in any real integration.",
    status: "coming-soon",
    url: null,
    contractAddress: null,
  },
  {
    id: "ethereum-usdt-lending",
    name: "Stablecoin lending — Ethereum",
    chain: "ethereum",
    asset: "USDT",
    protocol: null,
    apy: null,
    tvlUsd: null,
    risk: null,
    riskBasis: null,
    strategy:
      "The same mechanism as the USDC market, priced separately because the two stablecoins have separate pools and separate demand to borrow them. Rates on the two diverge more often than people expect.",
    status: "coming-soon",
    url: null,
    contractAddress: null,
  },
];

export function chainByKey(key: ChainKey): Chain {
  return CHAINS.find((chain) => chain.key === key) ?? CHAINS[0];
}

export function opportunityById(id: string): Opportunity | undefined {
  return OPPORTUNITIES.find((item) => item.id === id);
}

export const VERIFIED_COUNT = OPPORTUNITIES.filter((item) => item.status === "verified").length;

/** `5.2` → `"5.20%"`. Null stays null so the caller has to decide what to say. */
export function formatApy(apy: number | null): string | null {
  return apy === null ? null : `${apy.toFixed(2)}%`;
}

/** `1240000` → `"$1.24M"`. Null stays null. */
export function formatTvl(tvlUsd: number | null): string | null {
  if (tvlUsd === null) return null;
  if (tvlUsd >= 1_000_000) return `$${(tvlUsd / 1_000_000).toFixed(2)}M`;
  if (tvlUsd >= 1_000) return `$${(tvlUsd / 1_000).toFixed(1)}K`;
  return `$${tvlUsd}`;
}

/**
 * Said on every screen that shows a risk label, because the label is FlowPay's
 * own reading and not a rating, an audit or a promise.
 */
export const RISK_NOTE =
  "Risk labels are FlowPay's own informational classification, not a guarantee, a rating or an audit. They describe what FlowPay checked and what it found — nothing about them is advice.";

export const NO_RISK_NOTE =
  "FlowPay assigns a risk label only after it has verified the specific protocol and the specific contract behind an opportunity. Nothing here is verified yet, so risk is unknown rather than low.";
