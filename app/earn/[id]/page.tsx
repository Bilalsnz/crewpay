import { notFound } from "next/navigation";

import { Shell } from "@/components/shell";
import { Card, ExternalLink, Label, Note, Row } from "@/components/ui";
import { BRAND, FOOTER_EARN } from "@/lib/brand";
import {
  NO_RISK_NOTE,
  OPPORTUNITIES,
  RISK_NOTE,
  chainByKey,
  formatApy,
  formatTvl,
  opportunityById,
} from "@/lib/earn";
import { NETWORKS, explorerAddress } from "@/lib/networks";

/**
 * One opportunity, in full.
 *
 * Every row that FlowPay cannot fill says so in words rather than showing a
 * blank or a zero: `TVL unavailable` and `Not available yet` are the honest
 * answers, and a page full of them is the correct page to ship when nothing is
 * verified. The deposit button is disabled for the same reason — there is no
 * contract for it to call, and a button that opens a wallet to do nothing is
 * worse than a button that explains why it cannot.
 */

export function generateStaticParams() {
  return OPPORTUNITIES.map((item) => ({ id: item.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = opportunityById(id);
  if (!item) return { title: `Opportunity not found | ${BRAND}` };
  return {
    title: `${item.name} — ${chainByKey(item.chain).label} ${item.asset} | ${BRAND}`,
    description: item.strategy,
  };
}

export default async function OpportunityRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = opportunityById(id);
  if (!item) notFound();

  const chain = chainByKey(item.chain);
  const verified = item.status === "verified";
  const apy = formatApy(item.apy);
  const tvl = formatTvl(item.tvlUsd);

  // An explorer link exists only where the app already knows the explorer —
  // Tempo, from networks.json. Inventing URLs for the other chains would be
  // another unverified claim on a page whose whole point is not making them.
  //
  // Mainnet, not testnet: a Tempo entry in the Earn registry is about Tempo
  // mainnet (4217). Pay settles on Moderato testnet, which is a different
  // network, and an address that exists on one does not exist on the other.
  const explorer =
    item.contractAddress && item.chain === "tempo"
      ? explorerAddress(NETWORKS.mainnet, item.contractAddress)
      : null;

  return (
    <Shell back="/earn" footer={FOOTER_EARN}>
      <Card edge={verified ? "mint" : "crew"}>
        <div className="flex items-start justify-between gap-3">
          <Label>{verified ? "Verified live" : "Coming soon"}</Label>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
              verified ? "bg-mint-soft text-mint" : "bg-holdback-soft text-holdback"
            }`}
          >
            {chain.role === "discovery" ? "Discovery only" : "Settlement network"}
          </span>
        </div>
        <h1 className="pt-1 text-xl font-bold leading-snug text-ink">{item.name}</h1>
        <p className="pt-1 text-sm text-muted">
          {chain.label} · {item.asset}
        </p>
        <p className="pt-2 text-sm text-muted">{chain.note}</p>
      </Card>

      <Card edge="none">
        <Label>Terms</Label>
        <div className="pt-1">
          <Row label="Asset">{item.asset}</Row>
          <Row label="Network">{chain.label}</Row>
          <Row label="Protocol">{item.protocol ?? "Not available yet"}</Row>
          <Row label="APY">{apy ?? "APY unavailable"}</Row>
          <Row label="TVL">{tvl ?? "TVL unavailable"}</Row>
          <Row label="Status">{verified ? "Verified live" : "Coming soon"}</Row>
        </div>
        {!verified ? (
          <p className="pt-2 text-xs text-muted">
            No protocol, APY or TVL is listed because none has been verified. These stay blank until they can be read
            from a real source — a placeholder number here would be a claim FlowPay cannot support.
          </p>
        ) : null}
      </Card>

      <Card edge="crew">
        <Label>Strategy</Label>
        <p className="pt-2 text-sm leading-relaxed text-ink">{item.strategy}</p>
      </Card>

      <Card edge="holdback">
        <Label>Risk</Label>
        <p className="pt-1 text-lg font-bold text-ink">{item.risk ?? "Risk information unavailable"}</p>
        <p className="pt-2 text-sm leading-relaxed text-ink">
          {item.risk && item.riskBasis ? item.riskBasis : NO_RISK_NOTE}
        </p>
        <p className="pt-2 text-xs text-muted">{RISK_NOTE}</p>
      </Card>

      <Card edge="none">
        <Label>Contract</Label>
        <div className="pt-1">
          <Row label="Deposit contract">{item.contractAddress ? "Listed below" : "Not available yet"}</Row>
        </div>
        {item.contractAddress ? (
          <p className="pt-2 break-all text-xs">
            {explorer ? (
              <ExternalLink href={explorer}>{item.contractAddress}</ExternalLink>
            ) : (
              <span className="font-mono">{item.contractAddress}</span>
            )}
          </p>
        ) : (
          <p className="pt-2 text-xs text-muted">
            There is no FlowPay deposit contract for this opportunity on {chain.label}. Nothing has been deployed, so
            there is no address to show.
          </p>
        )}
        {item.url ? (
          <p className="pt-2 break-all text-xs">
            <ExternalLink href={item.url}>{item.url}</ExternalLink>
          </p>
        ) : null}
      </Card>

      <Card edge={verified ? "mint" : "holdback"}>
        <Label>Deposit</Label>
        {verified ? (
          <p className="pt-2 text-sm text-ink">
            This integration is verified. Deposit is available from the opportunity list.
          </p>
        ) : (
          <>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="mt-2 w-full cursor-not-allowed rounded-xl bg-[#c8cddd] px-4 py-3 text-sm font-semibold text-white"
            >
              Coming soon
            </button>
            <p className="pt-2 text-xs text-muted">
              Deposit is disabled because there is nothing behind it. FlowPay does not build deposit screens for
              integrations it has not verified — a wallet prompt that moves nothing would still be a lie about what
              the button does.
            </p>
          </>
        )}
      </Card>

      <Note tone="plain">
        FlowPay Earn is an opportunity explorer. It compares networks, assets and strategies; it does not custody
        anything, route anything, or hold a position on your behalf.
      </Note>
    </Shell>
  );
}
