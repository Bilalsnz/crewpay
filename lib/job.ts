import { parseAbiItem, type Address, type PublicClient } from "viem";

import { CREWPAY_ABI, HOLDBACK_BPS, BPS_DENOMINATOR } from "./contract";

export type JobStatus = "unpaid" | "paid" | "accepted" | "returned";

export interface Job {
  id: bigint;
  client: Address;
  deadline: bigint;
  createdAt: bigint;
  total: bigint;
  crewCount: number;
  crew: Address[];
  shares: number[];
  paid: boolean;
  accepted: boolean;
  returned: boolean;
  /** Read straight off the contract — never recomputed in the browser. */
  status: JobStatus;
  /** What each crew member receives from the 90%, as the contract computes it. */
  crewAmounts: bigint[];
  /** What is held back right now. Zero once accepted or returned. */
  holdback: bigint;
  /** True once the deadline has passed and the holdback can go back. */
  returnable: boolean;
}

type RawJob = readonly [
  Address, bigint, bigint, bigint, number, boolean, boolean, boolean,
  readonly Address[], readonly number[],
];

/**
 * Everything on this page comes from the contract. There is no database, no
 * account and no cached status — so a job cannot read as paid here and unpaid
 * to the person who actually holds the money.
 */
export async function readJob(client: PublicClient, address: Address, id: bigint): Promise<Job> {
  const [raw, status, crewAmounts, holdback, returnable] = await Promise.all([
    client.readContract({ address, abi: CREWPAY_ABI, functionName: "getJob", args: [id] }),
    client.readContract({ address, abi: CREWPAY_ABI, functionName: "statusOf", args: [id] }),
    client.readContract({ address, abi: CREWPAY_ABI, functionName: "crewAmounts", args: [id] }),
    client.readContract({ address, abi: CREWPAY_ABI, functionName: "holdback", args: [id] }),
    client.readContract({ address, abi: CREWPAY_ABI, functionName: "isReturnable", args: [id] }),
  ]);

  const job = raw as unknown as RawJob;
  const crewCount = Number(job[4]);

  return {
    id,
    client: job[0],
    deadline: job[1],
    createdAt: job[2],
    total: job[3],
    crewCount,
    crew: job[8].slice(0, crewCount),
    shares: job[9].slice(0, crewCount).map(Number),
    paid: job[5],
    accepted: job[6],
    returned: job[7],
    status: status as JobStatus,
    crewAmounts: (crewAmounts as readonly bigint[]).slice(0, crewCount),
    holdback,
    returnable,
  };
}

/**
 * The same split the contract performs, for display before a payment exists.
 * The contract stays the source of truth — this is only what the Create screen
 * previews so the client can see the numbers before signing anything.
 *
 * The last crew member absorbs the rounding remainder, exactly as the contract
 * does, so a preview can never disagree with the transfer that follows.
 */
export function previewSplit(total: bigint, shares: number[]): { crew: bigint[]; holdback: bigint } {
  const crewTotal = (total * BigInt(BPS_DENOMINATOR - HOLDBACK_BPS)) / BigInt(BPS_DENOMINATOR);
  const crew: bigint[] = [];
  let distributed = 0n;
  for (let i = 0; i < shares.length; i += 1) {
    const amount =
      i === shares.length - 1
        ? crewTotal - distributed
        : (crewTotal * BigInt(shares[i])) / BigInt(BPS_DENOMINATOR);
    distributed += amount;
    crew.push(amount);
  }
  return { crew, holdback: total - crewTotal };
}

export const JOB_STATUS_COPY: Record<JobStatus, { label: string; blurb: string }> = {
  unpaid: { label: "Unpaid", blurb: "The client has not paid yet. Nothing has moved." },
  paid: {
    label: "Paid",
    blurb: "90% went to the crew in the payment transaction. 10% is held until the client accepts the work.",
  },
  accepted: { label: "Accepted", blurb: "The client accepted the work. The holdback went to the crew at the same percentages." },
  returned: {
    label: "Returned",
    blurb: "The deadline passed without acceptance, so the holdback went back to the client.",
  },
};

const JOB_CREATED = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed client, uint128 total, uint64 deadline, uint8 crewCount)",
);
const JOB_PAID = parseAbiItem("event JobPaid(uint256 indexed jobId, address indexed client, uint128 crewTotal, uint128 held)");
const JOB_ACCEPTED = parseAbiItem("event JobAccepted(uint256 indexed jobId, uint128 released)");
const JOB_RETURNED = parseAbiItem("event JobReturned(uint256 indexed jobId, uint128 refunded)");

export interface JobEvent {
  txHash: `0x${string}`;
  blockNumber: bigint;
}

export interface JobHistory {
  created?: JobEvent;
  paid?: JobEvent;
  accepted?: JobEvent;
  returned?: JobEvent;
}

/**
 * The transaction hashes for a job, read back from the chain rather than
 * remembered by this browser.
 *
 * That matters: a receipt built from local state would be empty for anyone who
 * opened the link on a different device, which is exactly the person most
 * likely to be checking whether they were paid.
 */
export async function readJobHistory(
  client: PublicClient,
  address: Address,
  jobId: bigint,
  fromBlock: bigint,
): Promise<JobHistory> {
  const find = async (event: typeof JOB_PAID): Promise<JobEvent | undefined> => {
    const logs = await client.getLogs({ address, event, args: { jobId }, fromBlock, toBlock: "latest" });
    const last = logs[logs.length - 1];
    if (!last || !last.transactionHash) return undefined;
    return { txHash: last.transactionHash, blockNumber: last.blockNumber ?? 0n };
  };

  const [created, paid, accepted, returned] = await Promise.all([
    find(JOB_CREATED as unknown as typeof JOB_PAID),
    find(JOB_PAID),
    find(JOB_ACCEPTED as unknown as typeof JOB_PAID),
    find(JOB_RETURNED as unknown as typeof JOB_PAID),
  ]);

  return { created, paid, accepted, returned };
}
