"use client";

import { JobNotFound, JobScreen, parseJobId, type JobMode } from "./job-screen";
import { Shell, useFollowLinkNetwork } from "./shell";
import type { NetworkKey } from "@/lib/networks";

export function JobPage({ networkKey, rawId, mode }: { networkKey: NetworkKey; rawId: string; mode: JobMode }) {
  useFollowLinkNetwork(networkKey);
  const jobId = parseJobId(rawId);

  return (
    <Shell back="/">
      {jobId === null ? <JobNotFound networkKey={networkKey} /> : <JobScreen networkKey={networkKey} jobId={jobId} mode={mode} />}
    </Shell>
  );
}
