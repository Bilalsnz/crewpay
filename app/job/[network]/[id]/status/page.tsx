import { notFound } from "next/navigation";

import { JobPage } from "@/components/job-page";
import { isNetworkKey } from "@/lib/networks";

export default async function StatusJobRoute({ params }: { params: Promise<{ network: string; id: string }> }) {
  const { network, id } = await params;
  if (!isNetworkKey(network)) notFound();
  return <JobPage networkKey={network} rawId={id} mode="status" />;
}
