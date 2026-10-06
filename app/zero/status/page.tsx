import { ZeroStatus } from "@/components/zero-status";
import { BRAND } from "@/lib/brand";
import { DEFAULT_NETWORK, isNetworkKey } from "@/lib/networks";

/**
 * There is no payment to look up in this design — nothing is written down, so a
 * status page cannot report on one. What it can do is read a transaction off
 * the chain and show what that transaction actually paid, which is the only
 * record this design produces. `?tx=` drives that; the rest is explanation.
 */
export const metadata = { title: `Check a settlement | ${BRAND}` };

export default async function StatusRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const tx = typeof raw.tx === "string" ? raw.tx.trim() : "";
  const requested = typeof raw.network === "string" ? raw.network : "";

  return (
    <ZeroStatus
      initialTx={tx}
      initialNetwork={isNetworkKey(requested) ? requested : DEFAULT_NETWORK}
    />
  );
}
