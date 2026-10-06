import { ZeroStatus } from "@/components/zero-status";
import { DEFAULT_NETWORK, isNetworkKey } from "@/lib/networks";

/**
 * There is no job to look up in this version — nothing is written down, so a
 * status page cannot report on a job. What it can do is read a transaction off
 * the chain and show what that transaction actually paid, which is the only
 * record this design produces. `?tx=` drives that; the rest is explanation.
 */
export const metadata = { title: "CrewPay Zero — check a settlement" };

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
