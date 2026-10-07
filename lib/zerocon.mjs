/**
 * FlowPay Pay — the parts that have no viem in them.
 *
 * No custom contract exists in this design, so the payment terms are not stored
 * anywhere on chain: they live in the link. This module is the whole format —
 * what goes in the link, how it is validated, and how the crew split is
 * computed. `lib/multicall.mjs` turns that into calls; the tests import both,
 * so the numbers the tests prove are the numbers the page shows.
 *
 * Everything here is deliberately dependency-free so both the Next app and a
 * plain `node` test can use the identical code.
 */

/** The client keeps 10% — but in this version nothing holds it. See `retained`. */
export const HOLDBACK_BPS = 1000n;
export const BPS = 10000n;
export const MAX_CREW = 4;
export const USD_DECIMALS = 6;

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

/** Parses a dollar string into 6-decimal units. null when it is not a number. */
export function parseUsd(input) {
  const cleaned = String(input ?? "").trim().replace(/[$,\s]/g, "");
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned) || cleaned === ".") return null;
  const [whole, fraction = ""] = cleaned.split(".");
  if (fraction.length > USD_DECIMALS) return null;
  try {
    const value = BigInt(whole || "0") * 10n ** BigInt(USD_DECIMALS) + BigInt((fraction + "0".repeat(USD_DECIMALS)).slice(0, USD_DECIMALS) || "0");
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

export function formatUsd(value) {
  const s = value.toString().padStart(USD_DECIMALS + 1, "0");
  const whole = s.slice(0, -USD_DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = s.slice(-USD_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Money as a person reads it: two decimals, rounded half-up.
 *
 * `lib/format.ts` has a function of the same name that truncates instead, and
 * for the contract app that is fine — it shows a job total, which is a round
 * number. Here it is the parts that get shown, and truncating a three-way split
 * of 1.80 prints 0.59 / 0.60 / 0.60: three amounts that visibly do not add up,
 * on a page whose entire job is to show that they do. So this rounds.
 *
 * Rounding each part independently can still land a cent away from the total in
 * pathological cases; the receipt states the amounts to six decimals, and the
 * chain is the authority either way.
 */
export function formatUsdFixed(value) {
  // 10,000 units is one cent, so adding half of that before dividing rounds
  // half-up on integer arithmetic — no floats anywhere near the money.
  const cents = (value + 5000n) / 10000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * The crew split, integer-exact.
 *
 * 90% of the total is the crew portion; each member's percentage applies to
 * that portion. The last member absorbs the rounding remainder, so the parts
 * always sum to the crew total exactly and nothing is stranded as dust — the
 * same arithmetic the contract used.
 *
 * `retained` is what the client does NOT send. It is not held by anything: with
 * no contract there is nowhere to hold it, so the client simply keeps it.
 */
export function splitCrew(total, shares) {
  const crewTotal = (total * (BPS - HOLDBACK_BPS)) / BPS;
  const amounts = [];
  let distributed = 0n;
  for (let i = 0; i < shares.length; i += 1) {
    const amount = i === shares.length - 1 ? crewTotal - distributed : (crewTotal * BigInt(shares[i])) / BPS;
    distributed += amount;
    amounts.push(amount);
  }
  return { crewTotal, retained: total - crewTotal, amounts };
}

/* ───────────────────────── paying part of the job ───────────────────────── */

/** The preset shares. 100% is on the list because that is what the page did before. */
export const PAY_PRESETS = [25, 50, 75, 100];

/**
 * A typed percentage as basis points, or the reason it cannot be used.
 *
 * A percentage is converted once, here, and every amount after this point is
 * integer arithmetic — no float ever gets near a balance. The bounds are the
 * ones the page states: more than 0%, never more than 100%.
 *
 * @param {string} input
 * @returns {{ ok: true, bps: number } | { ok: false, error: string }}
 */
export function percentToBps(input) {
  const text = String(input ?? "").trim().replace(/%$/, "");
  if (text === "") return fail("Enter how much of the job to pay now.");
  if (!/^\d*\.?\d*$/.test(text) || text === ".") return fail(`"${input}" is not a percentage.`);
  const percent = Number(text);
  if (!Number.isFinite(percent)) return fail(`"${input}" is not a percentage.`);
  if (percent <= 0) return fail("A payment cannot be 0% of the job.");
  if (percent > 100) return fail("A payment cannot be more than 100% of the job.");
  const bps = Math.round(percent * 100);
  // A sliver of a percent that rounds away to nothing would ask the wallet to
  // sign a zero-value permit. That is not a small payment, it is no payment.
  if (bps <= 0) return fail("That is too small a share of the job to pay.");
  if (bps > Number(BPS)) return fail("A payment cannot be more than 100% of the job.");
  return { ok: true, bps };
}

/** `5000` → `50%`, `3333` → `33.33%`. The rate actually charged, not what was typed. */
export function percentLabel(bps) {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/**
 * How much of the job is paid now, from the job total and a share in bps.
 *
 * Floor division, so the result can only ever round *down*: a payment can never
 * exceed the job total, whatever is typed into the control. At 100% the
 * multiply and the divide cancel exactly and this returns the total unchanged —
 * which is what keeps a full payment byte-identical to what it was before there
 * was a control at all.
 *
 * @param {bigint} total
 * @param {number} bps
 * @returns {bigint}
 */
export function payNowAmount(total, bps) {
  return (total * BigInt(bps)) / BPS;
}

/* ─────────────────────────────── the link ─────────────────────────────── */

/**
 * Terms are carried as ordinary query parameters, not an opaque blob, so a
 * crew member can read the link and see their own address and percentage
 * without trusting this app. That readability is the only thing standing in
 * for the on-chain record the contract used to provide.
 *
 *   /zero/testnet?amount=2.00&crew=0xabc…:4000,0xdef…:6000
 */
export function encodeTerms(terms) {
  const crew = terms.crew.map((c) => `${c.address}:${c.bps}`).join(",");
  const params = new URLSearchParams();
  params.set("amount", formatUsd(terms.total));
  params.set("crew", crew);
  return params.toString();
}

/**
 * @typedef {{ address: string, bps: number }} CrewMember
 * @typedef {{ total: bigint, crew: CrewMember[] }} Terms
 * @typedef {{ ok: true, terms: Terms }} Decoded
 * @typedef {{ ok: false, error: string }} Failed
 */

/** @type {(error: string) => Failed} */
const fail = (error) => ({ ok: false, error });

/**
 * Reads a link. Returns either the terms or the reason it cannot be paid — the
 * page renders that reason rather than a form that would fail later.
 *
 * @param {string | URLSearchParams} input
 * @returns {Decoded | Failed}
 */
export function decodeTerms(input) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input);
  const rawAmount = params.get("amount");
  const rawCrew = params.get("crew");
  if (!rawAmount || !rawCrew) return fail("This link is missing its amount or crew list.");

  const total = parseUsd(rawAmount);
  if (total === null) return fail(`"${rawAmount}" is not a valid dollar amount.`);

  const parts = rawCrew.split(",").filter((p) => p.trim() !== "");
  if (parts.length === 0) return fail("This link has no crew wallet on it.");
  if (parts.length > MAX_CREW) return fail(`This link names ${parts.length} crew wallets; the most the split supports is ${MAX_CREW}.`);

  const crew = [];
  let sum = 0;
  for (const part of parts) {
    const at = part.lastIndexOf(":");
    if (at === -1) return fail(`"${part}" is not an address and a percentage.`);
    const address = part.slice(0, at).trim();
    const bps = Number(part.slice(at + 1).trim());
    if (!isAddress(address)) return fail(`"${address}" is not a valid wallet address.`);
    if (address.toLowerCase() === ZERO) return fail("A zero address cannot receive a payment.");
    if (!Number.isInteger(bps) || bps <= 0) return fail(`"${part.slice(at + 1)}" is not a valid percentage.`);
    crew.push({ address, bps });
    sum += bps;
  }
  if (sum !== Number(BPS)) return fail(`The crew percentages add up to ${sum / 100}%, not 100%.`);

  return { ok: true, terms: { total, crew } };
}

/**
 * The memo written into every transfer is `keccak256` of the encoded terms, so
 * it is bound to the exact link that was paid. Edit one digit of the link and
 * the memo no longer matches the receipt — the only tamper-evidence this
 * version has. The hash itself lives in `lib/multicall.mjs`, because keccak is
 * viem's and this file stays dependency-free. It is evidence, never enforcement.
 */
export function canonicalTerms(input) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input);
  const amount = params.get("amount") ?? "";
  const crew = params.get("crew") ?? "";
  return `amount=${amount}&crew=${crew}`;
}

/** A link is only ever as trustworthy as the page serving it — say so plainly. */
export const NO_ESCROW_NOTE =
  "This version has no escrow. The crew is paid immediately and the remaining 10% stays in the client's wallet. There is no accept step and no deadline return, because nothing is holding it.";
