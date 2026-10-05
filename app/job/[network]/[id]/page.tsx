import { notFound, redirect } from "next/navigation";

import { isNetworkKey } from "@/lib/networks";

/**
 * The bare link — `/job/testnet/3` — is the one that gets shared, so it has to
 * land somewhere. Status is the right default: it is the page that answers
 * "where is this job?" without being able to move any money.
 */
export default async function JobIndexRoute({ params }: { params: Promise<{ network: string; id: string }> }) {
  const { network, id } = await params;
  if (!isNetworkKey(network)) notFound();
  redirect(`/job/${network}/${id}/status`);
}
