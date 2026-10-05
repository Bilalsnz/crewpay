import { getAddress, isAddress, type Address } from "viem";

import { CREWPAY_ABI } from "./abi";
import { NETWORKS, type NetworkKey } from "./networks";

export { CREWPAY_ABI };

export const MAX_CREW = 4;
export const HOLDBACK_BPS = 1000;
export const BPS_DENOMINATOR = 10000;
export const HOLDBACK_PERCENT = 10;

/**
 * The contract address is configuration, not code. It is read from the
 * environment per network so the same build can point at a fresh deployment
 * without a rebuild, and so no address is ever hardcoded into a component.
 *
 * Deliberately NOT a NEXT_PUBLIC_ secret — this is a public address, and it is
 * published in every link.
 */
export function contractAddress(network: NetworkKey): Address | null {
  const raw =
    network === "testnet"
      ? process.env.NEXT_PUBLIC_CREWPAY_ADDRESS_TESTNET
      : process.env.NEXT_PUBLIC_CREWPAY_ADDRESS_MAINNET;
  if (!raw || !isAddress(raw)) return null;
  return getAddress(raw);
}

export function isDeployed(network: NetworkKey): boolean {
  return contractAddress(network) !== null;
}

/**
 * The block CrewPay was deployed in. Log queries start here rather than at
 * genesis, so reading a receipt's transaction hashes stays a small query
 * instead of a scan of the whole chain — and works on RPCs that cap ranges.
 */
export function contractDeployBlock(network: NetworkKey): bigint {
  const raw =
    network === "testnet"
      ? process.env.NEXT_PUBLIC_CREWPAY_BLOCK_TESTNET
      : process.env.NEXT_PUBLIC_CREWPAY_BLOCK_MAINNET;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? BigInt(Math.floor(parsed)) : 0n;
}

/** True when this build has an address for the network the user is looking at. */
export function deploymentGap(network: NetworkKey): string | null {
  if (isDeployed(network)) return null;
  const variable =
    network === "testnet" ? "NEXT_PUBLIC_CREWPAY_ADDRESS_TESTNET" : "NEXT_PUBLIC_CREWPAY_ADDRESS_MAINNET";
  return `CrewPay is not deployed to ${NETWORKS[network].label} in this build. Set ${variable} and redeploy.`;
}

/** The pieces of pathUSD this app touches. */
export const PATHUSD_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** The contract's own error names, turned into something a person can act on. */
const ERROR_COPY: Record<string, string> = {
  NoCrew: "Add at least one crew wallet.",
  TooManyCrew: `A job can pay at most ${MAX_CREW} crew wallets.`,
  CrewLengthMismatch: "Every crew wallet needs exactly one percentage.",
  ZeroAddress: "One of the crew addresses is empty. Fill it in or remove the row.",
  BadShares: "The crew percentages have to add up to exactly 100%.",
  DeadlineInPast: "Pick a deadline in the future.",
  DeadlineTooFar: "That deadline is more than ten years away.",
  ZeroAmount: "Enter an amount above zero.",
  NoSuchJob: "No job with that number exists on this network. Check the link.",
  NotClient: "Only the wallet that created this job can do that.",
  AlreadyPaid: "This job has already been paid.",
  NotPaid: "This job has not been paid yet.",
  DeadlinePassed: "The deadline has passed, so the work can no longer be accepted. The holdback is returnable to the client.",
  DeadlineNotPassed: "The deadline has not passed yet, so the holdback cannot be returned.",
  AlreadyAccepted: "This job has already been accepted.",
  AlreadyReturned: "The holdback has already been returned to the client.",
  TransferFailed: "pathUSD transfer failed.",
};

/** Pulls a CrewPay error name out of whatever shape viem hands back. */
export function contractErrorName(error: unknown): string | null {
  let current = error as { data?: unknown; errorName?: string; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current.errorName === "string") return current.errorName;
    const data = current.data as { errorName?: string } | string | undefined;
    if (data && typeof data === "object" && typeof data.errorName === "string") return data.errorName;
    current = current.cause as typeof current;
  }
  return null;
}

/** A sentence for the user, falling back to the wallet's own message. */
export function explain(error: unknown): string {
  const name = contractErrorName(error);
  if (name && ERROR_COPY[name]) return ERROR_COPY[name];
  const e = error as { shortMessage?: string; message?: string; cause?: { shortMessage?: string } } | undefined;
  const text = e?.shortMessage ?? e?.cause?.shortMessage ?? e?.message ?? "";
  if (/InsufficientAllowance|insufficient allowance/i.test(text)) {
    return "pathUSD is not approved for this payment yet. Try again and approve it when your wallet asks.";
  }
  if (/insufficient|exceeds balance/i.test(text)) {
    return "Not enough pathUSD in that wallet to cover this job plus gas.";
  }
  if (name) return `${name} — the contract refused this transaction.`;
  return text || "Something went wrong.";
}
