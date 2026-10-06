/**
 * Zero-contract CrewPay — the one-transaction settlement, in viem.
 *
 * There is no CrewPay contract in this version. The whole payment is one
 * ordinary transaction to Tempo's existing Multicall3 deployment, which runs
 * these calls in order and reverts the lot if any one of them fails:
 *
 *   calls[0]   pathUSD.permit(client, Multicall3, crewTotal, deadline, v, r, s)
 *   calls[1..] pathUSD.transferFromWithMemo(client, crewN, amountN, memo)   ×1–4
 *
 * The permit has to come first because the transferFroms below are executed by
 * Multicall3, so Multicall3 is the spender. Signing the permit costs no gas;
 * the client confirms exactly one transaction. Nothing is approved afterwards —
 * the transfers consume the allowance inside the same call, so it ends at zero.
 *
 * What this version cannot do is hold anything. There is no escrow, so there is
 * no accept step and nothing to return at a deadline.
 */

import { encodeFunctionData, encodeAbiParameters, keccak256, toHex, parseSignature, decodeAbiParameters, formatUnits } from "viem";

/** pathUSD is the same address on Moderato and mainnet. 6 decimals. */
export const PATHUSD = /** @type {`0x${string}`} */ ("0x20c0000000000000000000000000000000000000");

/** Tempo's existing deployment. 3,808 bytes, live on both networks. */
export const MULTICALL3 = /** @type {`0x${string}`} */ ("0xcA11bde05977b3631167028862bE2a173976CA11");

export const PATHUSD_DECIMALS = 6;

/**
 * pathUSD is a codeless native TIP-20: it has no bytecode, so `version()`
 * reverts and the domain cannot be read off the chain. These two strings are
 * the domain as the precompile actually implements it — `name()` and
 * `DOMAIN_SEPARATOR()` both answer, and a signature built from anything else is
 * rejected by the permit call itself, which is the real check.
 */
export const PATHUSD_DOMAIN_NAME = "PathUSD";
export const PATHUSD_DOMAIN_VERSION = "1";

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "blockNumber", type: "uint256" },
      { name: "returnData", type: "bytes[]" },
    ],
  },
];

export const PATHUSD_ABI = [
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transferFromWithMemo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "memo", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

/**
 * `transferFromWithMemo` emits BOTH a plain `Transfer` and a `TransferWithMemo`
 * carrying the same value. Summing the logs that share a recipient therefore
 * doubles the receipt — the exact bug the PayStub build shipped once. Only the
 * memo-bearing event is read, and the gas transfer to the fee collector never
 * carries a memo, so the two can never be confused.
 */
export const TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";

const TRANSFER_ABI = [
  {
    type: "event",
    name: "TransferWithMemo",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "memo", type: "bytes32", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
];

export function permitDomain(chainId) {
  return {
    name: PATHUSD_DOMAIN_NAME,
    version: PATHUSD_DOMAIN_VERSION,
    chainId,
    verifyingContract: PATHUSD,
  };
}

/** The memo is a hash of the link, so the receipt is tied to the exact terms paid. */
export function memoFor(canonical) {
  return keccak256(toHex(canonical));
}

/** Nonces are per-owner on pathUSD and must be read immediately before signing. */
export async function readPermitNonce(publicClient, owner) {
  return publicClient.readContract({
    address: PATHUSD,
    abi: PATHUSD_ABI,
    functionName: "nonces",
    args: [owner],
  });
}

export async function readBalance(publicClient, account) {
  return publicClient.readContract({
    address: PATHUSD,
    abi: PATHUSD_ABI,
    functionName: "balanceOf",
    args: [account],
  });
}

/**
 * Builds the exact Multicall3 calldata. `crewTotal` is what the permit
 * authorises — 90% of the job — not the full amount, because the remaining 10%
 * never leaves the client's wallet. The allowance the permit creates is spent
 * entirely by the transfers that follow it, in the same call, so nothing
 * survives the transaction.
 */
export function buildSettlement({ client, crew, amounts, memo, permitDeadline, signature }) {
  const { v, r, s } = typeof signature === "string" ? parseSignature(signature) : signature;
  const crewTotal = amounts.reduce((sum, a) => sum + a, 0n);

  const permitData = encodeFunctionData({
    abi: PATHUSD_ABI,
    functionName: "permit",
    args: [client, MULTICALL3, crewTotal, BigInt(permitDeadline), Number(v), r, s],
  });

  const calls = [{ target: PATHUSD, callData: permitData }];
  for (let i = 0; i < crew.length; i += 1) {
    calls.push({
      target: PATHUSD,
      callData: encodeFunctionData({
        abi: PATHUSD_ABI,
        functionName: "transferFromWithMemo",
        args: [client, crew[i].address, amounts[i], memo],
      }),
    });
  }

  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "aggregate", args: [calls] });
  return { to: MULTICALL3, data, calls, crewTotal };
}

/**
 * Gas, measured from mined transactions on live Moderato — not guessed.
 *
 * Tempo's token is not cheap to call: the permit alone costs about 810,000 gas
 * because it is a native precompile, and each `transferFromWithMemo` adds about
 * 264,000. An earlier version of this file carried estimates three times too
 * low, and the failure mode was nasty: `eth_call` reported success while every
 * real settlement ran out of gas and reverted. So `estimateSettlementGas` below
 * is preferred whenever a node is reachable, and this is only the floor for
 * when one is not.
 */
export function gasLimitFor(crewCount) {
  const measured = 809815n + 263711n * BigInt(crewCount);
  return (measured * 125n) / 100n;
}

/** Asks the node what this exact settlement costs, then leaves a quarter spare. */
export async function estimateSettlementGas(publicClient, settlement, account) {
  const estimate = await publicClient.estimateGas({ account, to: settlement.to, data: settlement.data });
  return (estimate * 125n) / 100n;
}

/**
 * Runs the whole settlement through `eth_call` first. It costs nothing and it
 * is a real execution on the node — a malformed permit, a short balance or a
 * rejected crew address reverts here exactly as it would for real, before the
 * client is asked to confirm anything.
 *
 * It is not, however, a gas check: `eth_call` is given a generous limit here on
 * purpose, because a limit that is too low would fail the simulation for a
 * reason that has nothing to do with the payment. Use `estimateSettlementGas`
 * to find out what the transaction will actually cost.
 */
export async function simulateSettlement(publicClient, settlement, account) {
  return publicClient.call({
    to: settlement.to,
    data: settlement.data,
    account,
    gas: gasLimitFor(settlement.calls.length - 1),
  });
}

/**
 * Reads the receipt. `TransferWithMemo` only, filtered to this job's memo and
 * to the client as sender, so the fee transfer and the duplicate plain
 * `Transfer` are both structurally excluded rather than filtered by hope.
 */
export function decodeSettlementLogs(logs, { client, memo }) {
  const entries = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_WITH_MEMO_TOPIC) continue;
    if (log.address.toLowerCase() !== PATHUSD.toLowerCase()) continue;
    let decoded;
    try {
      decoded = decodeAbiParameters(TRANSFER_ABI[0].inputs, log.data);
    } catch {
      decoded = null;
    }
    const from = `0x${log.topics[1].slice(26)}`.toLowerCase();
    const to = `0x${log.topics[2].slice(26)}`.toLowerCase();
    const logMemo = log.topics[3].toLowerCase();
    if (from !== client.toLowerCase()) continue;
    if (logMemo !== memo.toLowerCase()) continue;
    entries.push({ to, value: decoded ? decoded[0] : BigInt(log.data) });
  }
  return entries;
}

/** Sums what the receipt proves left the client, and reconciles against the terms. */
export function reconcile(entries, crew, amounts) {
  const expected = new Map();
  for (let i = 0; i < crew.length; i += 1) {
    const key = crew[i].address.toLowerCase();
    expected.set(key, (expected.get(key) ?? 0n) + amounts[i]);
  }
  const seen = new Map();
  for (const entry of entries) seen.set(entry.to, (seen.get(entry.to) ?? 0n) + entry.value);

  const lines = crew.map((c) => {
    const key = c.address.toLowerCase();
    const want = expected.get(key) ?? 0n;
    const got = seen.get(key) ?? 0n;
    return { address: c.address, expected: want, received: got, ok: want === got };
  });
  return { lines, ok: lines.every((l) => l.ok) && entries.length === crew.length };
}

export function usd(value) {
  return formatUnits(value, PATHUSD_DECIMALS);
}

/**
 * Turns a wallet or node error into something a person can act on. Tempo
 * precompiles reject with their own selectors, so an unrecognised revert is
 * reported as-is rather than translated into a guess.
 */
export function explainError(error) {
  const text = [error?.shortMessage, error?.details, error?.message].filter(Boolean).join(" ");
  if (/user rejected|denied transaction|User denied/i.test(text)) return "You cancelled the request in your wallet.";
  if (/insufficient funds|exceeds the balance|InsufficientBalance/i.test(text)) return "Not enough pathUSD in this wallet to cover the payment and the network fee.";
  if (/nonce/i.test(text)) return "The permit nonce moved — someone else used this wallet since the link was opened. Reload and sign again.";
  if (/expired|deadline/i.test(text)) return "The signing window closed before the transaction was sent. Press pay again to sign a fresh one.";
  if (/Multicall3: call failed/i.test(text)) return "The split was rejected on chain — the whole transaction was rolled back, so nothing moved.";
  return text || "The transaction failed.";
}
