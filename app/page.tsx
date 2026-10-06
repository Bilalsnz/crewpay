import { Shell } from "@/components/shell";
import { Card, Label, LinkButton } from "@/components/ui";
import { FOOTER_HOME, META_DESCRIPTION, META_TITLE, POSITIONING, SUPPORTING } from "@/lib/brand";

/**
 * The front door. Two products, two doors, and nothing else to click.
 *
 * The trap this page has fallen into before is worth restating, because the
 * symptom is always the same: a button here that leads to the contract
 * version's screens. This branch deploys no contract, so `/create` and `/job/*`
 * cannot run — they guard on `NEXT_PUBLIC_CREWPAY_ADDRESS_TESTNET` and refuse.
 * Both Pay links below go to `/zero/create`, which needs no address, no
 * contract and no configuration.
 */
export const metadata = {
  title: META_TITLE,
  description: META_DESCRIPTION,
};

export default function Page() {
  return (
    <Shell footer={FOOTER_HOME}>
      <section className="pt-2">
        <h1 className="text-[2rem] font-black leading-[1.1] tracking-tight text-white sm:text-4xl">
          Move money.
          <br />
          Make it work.
        </h1>
        <p className="pt-3 text-base leading-relaxed text-white/90">{SUPPORTING}</p>
      </section>

      <div className="grid grid-cols-2 gap-2">
        <LinkButton href="/zero/create" variant="pay" full>
          Pay
        </LinkButton>
        <LinkButton href="/earn" variant="ghost" full>
          Earn
        </LinkButton>
      </div>

      <Card edge="crew">
        <Label>Pay</Label>
        <h2 className="pt-1 text-xl font-bold leading-snug text-ink">Split one payment between your crew.</h2>
        <p className="pt-2 text-sm text-muted">One transaction. Up to 4 recipients. Tempo pathUSD.</p>
        <div className="pt-3">
          <LinkButton href="/zero/create" variant="pay" full>
            Pay →
          </LinkButton>
        </div>
      </Card>

      <Card edge="mint">
        <Label>Earn</Label>
        <h2 className="pt-1 text-xl font-bold leading-snug text-ink">Explore stablecoin yield opportunities.</h2>
        <p className="pt-2 text-sm text-muted">Compare networks, assets and strategies.</p>
        <div className="pt-3">
          <LinkButton href="/earn" variant="plain" full>
            Explore yield →
          </LinkButton>
        </div>
      </Card>

      <p className="px-1 text-xs leading-relaxed text-white/85">{POSITIONING}</p>
    </Shell>
  );
}
