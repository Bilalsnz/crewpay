import Link from "next/link";
import { notFound } from "next/navigation";

import { ZeroJob } from "@/components/zero-job";
import { isNetworkKey } from "@/lib/networks";
import { canonicalTerms, decodeTerms } from "@/lib/zerocon.mjs";

/**
 * The job page. The terms live in the query string, so this route decodes the
 * link and either renders the payment or explains exactly what is wrong with
 * it. Nothing is fetched and nothing is looked up — there is nowhere to look.
 *
 * Decoding is done here, on the server, with the same module the payment uses,
 * so a link that renders is a link that can be paid.
 */
export default async function ZeroJobRoute({
  params,
  searchParams,
}: {
  params: Promise<{ network: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { network } = await params;
  if (!isNetworkKey(network)) notFound();

  const raw = await searchParams;
  const flat = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat.set(key, value);
  }

  const decoded = decodeTerms(flat);
  if (!decoded.ok) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-4 px-4 pb-10 pt-5">
        <section className="rounded-[16px] border-l-4 border-l-holdback bg-white p-4 shadow-[0_10px_30px_-18px_rgba(16,24,40,0.45)]">
          <span className="block text-xs font-semibold uppercase tracking-wide text-muted">This link cannot be paid</span>
          <p className="pt-2 text-sm text-ink">{decoded.error}</p>
          <p className="pt-3 text-sm text-muted">
            Nothing was sent and nothing is wrong with your wallet — the link itself is incomplete or inconsistent.
          </p>
        </section>
        <Link href="/zero" className="text-sm font-semibold text-white underline underline-offset-2">
          Start a new job
        </Link>
      </main>
    );
  }

  return (
    <ZeroJob
      networkKey={network}
      // The canonical string, not the raw one. Parameter order and percent-
      // encoding must not change the job's memo, or the same link would hash
      // differently depending on how the browser spelled it.
      query={canonicalTerms(flat)}
      amount={flat.get("amount") ?? ""}
      crew={decoded.terms.crew}
    />
  );
}
