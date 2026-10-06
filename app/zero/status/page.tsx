import { ZeroStatus } from "@/components/zero-status";
import { BRAND } from "@/lib/brand";

/**
 * There is no payment to look up in this design — nothing is written down, so a
 * status page cannot report on one. What it can do is read a transaction off
 * the chain and show what that transaction actually paid, which is the only
 * record this design produces. `?tx=` drives that; the rest is explanation.
 *
 * There is no longer a `?network=` here: Pay settles on Moderato and only there
 * can a FlowPay settlement exist, so the reader has one chain to look at.
 */
export const metadata = { title: `Check a settlement | ${BRAND}` };

export default async function StatusRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const tx = typeof raw.tx === "string" ? raw.tx.trim() : "";

  return <ZeroStatus initialTx={tx} />;
}
