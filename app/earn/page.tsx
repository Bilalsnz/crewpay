import { EarnExplorer } from "@/components/earn-explorer";
import { BRAND } from "@/lib/brand";
import { fetchLiveOpportunities } from "@/lib/yields";
export const metadata = {
  title: `Earn — stablecoin yield opportunities | ${BRAND}`,
  description:
    "Live stablecoin pools on Tempo mainnet alongside a discovery registry of opportunities across supported networks. FlowPay shows an opportunity as verified only when a real integration exists.",
};

/**
 * How often the page re-reads the source.
 *
 * This page IS the cache. The source answers with every pool it tracks — about
 * 15 MB — and Next will not put a response that size in its data cache, so the
 * fetch is deliberately uncached and this window is the only thing limiting how
 * often it runs. Thirty minutes keeps the figures useful while not pulling 15 MB
 * out of a free public API forty-eight times a day.
 *
 * The number must be a literal: Next reads route config statically and fails
 * the build with "Unknown identifier" if it is imported or computed.
 */
export const revalidate = 1800;

/**
 * The live yield data is fetched here, on the server, and passed down.
 *
 * It could have been a client-side fetch to an API route, but then the numbers
 * would arrive after the page and the page would have a loading state where it
 * should have figures. More importantly, the fetched data never has to travel
 * through the browser as something the browser could be asked to alter.
 *
 * A failure is passed down as a failure. The page renders the reason rather
 * than an empty list, because an empty list on a yield page reads like "there
 * is nothing", which is a different claim from "we could not read it".
 */
export default async function Page() {
  const live = await fetchLiveOpportunities();
  return <EarnExplorer live={live} />;
}
