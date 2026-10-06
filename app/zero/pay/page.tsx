import { redirect } from "next/navigation";

import { Shell } from "@/components/shell";
import { Card, Label, LinkButton, Note } from "@/components/ui";
import { BRAND, FOOTER_PAY_CREATE } from "@/lib/brand";
import { DEFAULT_NETWORK, isNetworkKey } from "@/lib/networks";

/**
 * `/zero/pay` on its own has nothing to pay.
 *
 * In this design the terms — amount, crew, percentages — travel in the link,
 * and there is no store to look a payment up in. So a link that carries its
 * terms is forwarded to the network page that can render it, and a bare
 * `/zero/pay` says plainly that a payment needs a link instead of showing a
 * form with nothing behind it.
 */
export const metadata = { title: `Pay | ${BRAND}` };

export default async function PayRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const amount = typeof raw.amount === "string" ? raw.amount : "";
  const crew = typeof raw.crew === "string" ? raw.crew : "";

  // Someone landed on the alias with a real link's query still attached. The
  // network is part of the link, so honour it when it is there and fall back to
  // the build's default network when it is not.
  if (amount && crew) {
    const requested = typeof raw.network === "string" ? raw.network : "";
    const network = isNetworkKey(requested) ? requested : DEFAULT_NETWORK;
    const params = new URLSearchParams({ amount, crew });
    redirect(`/zero/${network}?${params.toString()}`);
  }

  return (
    <Shell back="/zero" footer={FOOTER_PAY_CREATE}>
      <Card edge="holdback">
        <Label>Nothing to pay here yet</Label>
        <p className="pt-2 text-sm text-ink">
          A payment needs its terms. Here the crew addresses and their percentages <em>are</em> the link — nothing is
          stored, so there is nothing to look up and nothing to open without one.
        </p>
      </Card>

      <Card edge="none">
        <Label>What to do</Label>
        <p className="pt-2 text-sm text-ink">
          Open the payment link you were sent. If you are the one paying the crew, create a payment and send that link
          to the client.
        </p>
        <div className="pt-3">
          <LinkButton href="/zero/create" variant="plain">
            Create a payment
          </LinkButton>
        </div>
      </Card>

      <Note tone="plain">
        A link that still carries its terms forwards from here to the right network page automatically.
      </Note>
    </Shell>
  );
}
