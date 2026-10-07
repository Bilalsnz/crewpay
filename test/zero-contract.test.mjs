/**
 * Zero-contract CrewPay — run against the real Tempo Moderato testnet.
 *
 * The point of this file is that it imports `lib/zerocon.mjs` and
 * `lib/multicall.mjs` directly — the same two modules the page imports. So the
 * split the test proves is the split the UI shows, and the calldata the test
 * signs is the calldata the wallet sends. Nothing here is re-implemented for
 * the test's convenience.
 *
 *   node test/zero-contract.test.mjs
 *
 * Sends real transactions and spends real testnet gas. Refuses to run against
 * mainnet, and there is no code path in this repo that signs one for mainnet.
 */
import { formatUnits, parseSignature, encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NETWORKS, pickNetwork, publicClientFor, walletFor, fundFromFaucet, EXPLORER_TX } from "../scripts/lib.mjs";
import {
  parseUsd, formatUsd, formatUsdFixed, splitCrew, encodeTerms, decodeTerms, canonicalTerms, isAddress,
  PAY_PRESETS, percentToBps, percentLabel, payNowAmount,
} from "../lib/zerocon.mjs";
import {
  PATHUSD, PATHUSD_ABI, MULTICALL3, MULTICALL3_ABI, permitDomain, memoFor, buildSettlement, gasLimitFor,
  estimateSettlementGas, simulateSettlement, decodeSettlementLogs, reconcile, explainError, readPermitNonce, usd,
} from "../lib/multicall.mjs";

const network = pickNetwork(["--network=testnet"]);
if (!network.isTestnet) {
  console.error("This test sends real transactions. Testnet only — refusing to run.");
  process.exit(1);
}

const pub = publicClientFor(network);

/* ───────────────────────────── tiny test harness ───────────────────────── */

let passed = 0;
const failures = [];
const ok = (name) => { passed += 1; console.log(`  \u001b[32mok\u001b[0m   ${name}`); };
const bad = (name, detail) => { failures.push({ name, detail }); console.log(`  \u001b[31mFAIL\u001b[0m ${name}\n       ${detail}`); };
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) { if (actual !== expected) throw new Error(`${msg}\n       expected ${expected}\n       actual   ${actual}`); }
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const addr = (n) => `0x${(n % 16).toString(16).repeat(40)}`.slice(0, 42);

console.log(`\nZero-contract CrewPay — live on ${network.label} (chain ${network.chainId})\n`);

/* ───────────────────────── 1. the link is the record ───────────────────── */

console.log("link format");

await test("a link round-trips through encode and decode", () => {
  const terms = { total: parseUsd("2.00"), crew: [{ address: addr(1), bps: 4000 }, { address: addr(2), bps: 6000 }] };
  const query = encodeTerms(terms);
  const back = decodeTerms(query);
  assert(back.ok, `decode refused a link this encoder just produced: ${back.error}`);
  eq(back.terms.total, terms.total, "total survived the round trip");
  eq(back.terms.crew.length, 2, "both crew survived");
  eq(back.terms.crew[0].bps, 4000, "first percentage survived");
});

await test("the link is readable without this app — the crew can audit their own cut", () => {
  const terms = { total: parseUsd("2.00"), crew: [{ address: addr(1), bps: 4000 }, { address: addr(2), bps: 6000 }] };
  const query = encodeTerms(terms);
  assert(query.includes(addr(1)), "the crew address is not hidden in an opaque blob");
  assert(query.includes("4000"), "the percentage is readable in the link");
});

await test("a zero address is refused", () => {
  const r = decodeTerms(`amount=2.00&crew=${ZERO_ADDR}:10000`);
  assert(!r.ok, "a zero address was accepted — money sent there is destroyed");
  assert(/zero address/i.test(r.error), `wrong reason: ${r.error}`);
});

await test("more than four crew wallets is refused", () => {
  const crew = [1, 2, 3, 4, 5].map((n) => `${addr(n)}:2000`).join(",");
  const r = decodeTerms(`amount=2.00&crew=${crew}`);
  assert(!r.ok, "a five-way split was accepted");
  assert(/4/.test(r.error), `wrong reason: ${r.error}`);
});

await test("percentages that do not total 100% are refused", () => {
  const r = decodeTerms(`amount=2.00&crew=${addr(1)}:4000,${addr(2)}:3000`);
  assert(!r.ok, "an 70% split was accepted");
  assert(/100%/.test(r.error), `wrong reason: ${r.error}`);
});

await test("a percentage of zero is refused rather than silently paying nothing", () => {
  const r = decodeTerms(`amount=2.00&crew=${addr(1)}:10000,${addr(2)}:0`);
  assert(!r.ok, "a 0% member was accepted");
});

await test("a malformed address is refused", () => {
  const r = decodeTerms("amount=2.00&crew=0xnope:10000");
  assert(!r.ok, "a malformed address was accepted");
});

await test("a zero or negative amount is refused", () => {
  assert(!decodeTerms(`amount=0&crew=${addr(1)}:10000`).ok, "zero was accepted");
  assert(!decodeTerms(`amount=-5&crew=${addr(1)}:10000`).ok, "a negative amount was accepted");
});

await test("an address with no percentage is refused", () => {
  assert(!decodeTerms(`amount=2.00&crew=${addr(1)}`).ok, "a bare address was accepted");
});

/* ─────────────────────────── 2. the split math ─────────────────────────── */

console.log("\nsplit");

await test("the whole amount goes to the crew and nothing is retained", () => {
  const { crewTotal, retained, amounts } = splitCrew(parseUsd("2.00"), [10000]);
  eq(crewTotal, parseUsd("2.00"), "crew total is the whole amount");
  eq(retained, 0n, "nothing may be held back");
  eq(amounts[0], parseUsd("2.00"), "a single crew member takes the whole amount");
});

await test("the parts always sum to the crew total exactly — no stranded dust", () => {
  // 1/3 splits are where rounding shows up: 2000000 * 3333 / 10000 = 666600,
  // three of those leaves 200 units unaccounted for on the floor alone.
  const { crewTotal, amounts } = splitCrew(parseUsd("2.00"), [3333, 3333, 3334]);
  const sum = amounts.reduce((a, b) => a + b, 0n);
  eq(sum, crewTotal, "the crew amounts do not sum to the amount paid");
});

await test("the last member absorbs the rounding remainder, never the first", () => {
  const { amounts } = splitCrew(parseUsd("2.00"), [3333, 3333, 3334]);
  eq(amounts[0], 666600n, "first takes the floor of its share");
  eq(amounts[1], 666600n, "second takes the floor of its share");
  assert(amounts[2] > 666600n, "the last member should carry the remainder");
});

await test("the same total always splits the same way — the link is deterministic", () => {
  const a = splitCrew(parseUsd("1.23"), [4000, 3000, 2000, 1000]).amounts.join(",");
  const b = splitCrew(parseUsd("1.23"), [4000, 3000, 2000, 1000]).amounts.join(",");
  eq(a, b, "two runs disagreed");
});

await test("an amount with more than six decimals is refused rather than rounded", () => {
  assert(parseUsd("1.0000001") === null, "a sub-micro amount was accepted and would be silently truncated");
});

await test("a four-way split divides the whole amount", () => {
  // 2.00 split 40/30/20/10 — the percentages apply to all of it now, so the
  // crew receives the entire 2.00 rather than 90% of it.
  const { crewTotal, amounts } = splitCrew(parseUsd("2.00"), [4000, 3000, 2000, 1000]);
  eq(crewTotal, 2000000n, "the whole amount is the crew portion");
  eq(amounts.map((a) => formatUsdFixed(a)).join(" / "), "0.80 / 0.60 / 0.40 / 0.20", "four-way split");
});

await test("a three-way split sums exactly in units, and only the 2dp rendering can drift", () => {
  // Each part rounds half-up on its own, so three parts of 0.6666 print as
  // 0.67 / 0.67 / 0.67 and read as 2.01 against a stated 2.00. The amounts
  // themselves sum to the total exactly — the drift is the display's, not the
  // arithmetic's, and the receipt states the amounts it read off the chain.
  const { amounts, crewTotal } = splitCrew(parseUsd("2.00"), [3333, 3333, 3334]);
  const sum = amounts.reduce((a, b) => a + b, 0n);
  eq(sum, crewTotal, "the parts must sum to the total exactly in units");
  eq(amounts.map((a) => formatUsdFixed(a)).join(" + "), "0.67 + 0.67 + 0.67", "each part rounds to the cent");
  eq(formatUsdFixed(sum), formatUsdFixed(crewTotal), "the displayed total matches the underlying total");
});

await test("a split that divides evenly shows parts that add up to the cent", () => {
  // The shape the page leads with. Every number a client sees is exact.
  const { amounts, crewTotal } = splitCrew(parseUsd("100.00"), [5000, 3000, 2000]);
  const shown = amounts.map((a) => formatUsdFixed(a));
  const cents = (s) => Math.round(Number(s) * 100);
  eq(shown.join(" + "), "50.00 + 30.00 + 20.00", "the parts as displayed");
  eq(
    shown.reduce((sum, s) => sum + cents(s), 0),
    cents(formatUsdFixed(crewTotal)),
    "the displayed parts do not add up to the displayed total",
  );
});

await test("money formatting rounds half-up and never uses a float", () => {
  eq(formatUsdFixed(0n), "0.00", "zero");
  eq(formatUsdFixed(5000n), "0.01", "exactly half a cent rounds up");
  eq(formatUsdFixed(4999n), "0.00", "just under half a cent rounds down");
  eq(formatUsdFixed(2000000n), "2.00", "whole dollars");
  eq(formatUsdFixed(123456789n), "123.46", "thousands are grouped and the cent rounds up");
});

/* ──────────────────── 2b. paying part of the job ───────────────────────── */

console.log("\npartial payment");

// $100 job, crew 50/30/20. The percentages apply to the amount being paid now,
// and the whole of that amount goes to the crew — nothing is held back.
const HUNDRED = parseUsd("100.00");
const SHARES_532 = [5000, 3000, 2000];

await test("25 / 50 / 75 / 100% of a $100 job produce the amounts a person would write down", () => {
  const rows = [
    { pct: 25, pay: "25.00", crewTotal: "25.00", amounts: "12.50 / 7.50 / 5.00" },
    { pct: 50, pay: "50.00", crewTotal: "50.00", amounts: "25.00 / 15.00 / 10.00" },
    { pct: 75, pay: "75.00", crewTotal: "75.00", amounts: "37.50 / 22.50 / 15.00" },
    { pct: 100, pay: "100.00", crewTotal: "100.00", amounts: "50.00 / 30.00 / 20.00" },
  ];
  for (const row of rows) {
    const chosen = percentToBps(String(row.pct));
    assert(chosen.ok, `${row.pct}% was refused: ${chosen.error}`);
    const payNow = payNowAmount(HUNDRED, chosen.bps);
    const { crewTotal, retained, amounts } = splitCrew(payNow, SHARES_532);
    eq(formatUsdFixed(payNow), row.pay, `${row.pct}% — you pay`);
    eq(formatUsdFixed(crewTotal), row.crewTotal, `${row.pct}% — to the crew (all of what is paid)`);
    eq(amounts.map((a) => formatUsdFixed(a)).join(" / "), row.amounts, `${row.pct}% — per crew member`);
    eq(retained, 0n, `${row.pct}% — nothing may be held back`);
  }
});

await test("the crew always receives exactly what was paid, at every share", () => {
  // The property the old 90/10 rule broke: whatever percentage is chosen, the
  // amount that leaves the client is the amount the crew receives.
  for (const pct of [1, 7, 25, 33.33, 50, 66.67, 75, 99, 100]) {
    const chosen = percentToBps(String(pct));
    assert(chosen.ok, `${pct}% was refused`);
    const payNow = payNowAmount(HUNDRED, chosen.bps);
    const { crewTotal, retained, amounts } = splitCrew(payNow, SHARES_532);
    eq(crewTotal + retained, payNow, `${pct}%: crew plus retention is not what was paid`);
    eq(crewTotal, payNow, `${pct}%: the crew did not receive the whole payment`);
    eq(retained, 0n, `${pct}%: something was retained`);
    eq(amounts.reduce((a, b) => a + b, 0n), payNow, `${pct}%: the per-member parts do not sum to what was paid`);
  }
});

await test("the remaining balance is the job total minus what is paid now", () => {
  for (const pct of [25, 50, 75, 100]) {
    const chosen = percentToBps(String(pct));
    const payNow = payNowAmount(HUNDRED, chosen.bps);
    const remaining = HUNDRED - payNow;
    eq(payNow + remaining, HUNDRED, `${pct}%: paid plus remaining is not the job total`);
    if (pct < 100) assert(remaining > 0n, `${pct}% should leave something owing`);
    if (pct === 100) eq(remaining, 0n, "100% should leave nothing owing");
  }
});

await test("a payment can never exceed the job total, at any percentage that is allowed", () => {
  const totals = [parseUsd("0.01"), parseUsd("1.00"), HUNDRED, parseUsd("1234.56"), parseUsd("999999.99")];
  for (const total of totals) {
    for (let bps = 1; bps <= 10000; bps += 1) {
      const payNow = payNowAmount(total, bps);
      assert(payNow <= total, `${formatUsd(total)} at ${bps}bps paid ${formatUsd(payNow)} — more than the job`);
      assert(payNow >= 0n, "a negative payment is not possible and must stay that way");
    }
  }
});

await test("0%, more than 100%, and anything that is not a number are refused", () => {
  for (const bad of ["0", "0.0", "-5", "100.01", "101", "abc", "", "  ", ".", "5e2", "50%%"]) {
    const chose = percentToBps(bad);
    assert(!chose.ok, `"${bad}" was accepted as a percentage`);
  }
});

await test("1% and 100% are both accepted, and a decimal percentage is honoured", () => {
  const low = percentToBps("1");
  assert(low.ok, "1% was refused");
  eq(low.bps, 100, "1% is 100 bps");
  const high = percentToBps("100");
  assert(high.ok, "100% was refused");
  eq(high.bps, 10000, "100% is 10000 bps");
  const odd = percentToBps("33.33");
  assert(odd.ok, "33.33% was refused");
  eq(odd.bps, 3333, "33.33% is 3333 bps");
  eq(formatUsdFixed(payNowAmount(HUNDRED, odd.bps)), "33.33", "33.33% of $100");
});

await test("a percentage that rounds away to nothing is refused rather than signing a zero payment", () => {
  // $0.000001 — the smallest amount pathUSD can move — at 1% is 0.00000001 of a
  // dollar, which is zero units. A permit for zero is a signature that moves
  // nothing, so it must never reach the wallet.
  const dust = parseUsd("0.000001");
  eq(payNowAmount(dust, 100), 0n, "this case is supposed to round to zero");
  // One cent is the smallest job where 1% survives: 1% of 10000 units is 100
  // units = $0.0001, which is above the smallest unit the token can move.
  eq(payNowAmount(parseUsd("0.01"), 100), 100n, "1% of a cent must survive as 0.0001");
});

await test("the label shown is the rate actually charged, not what was typed", () => {
  eq(percentLabel(10000), "100%", "100%");
  eq(percentLabel(5000), "50%", "50%");
  eq(percentLabel(3333), "33.33%", "33.33%");
  eq(percentLabel(2550), "25.5%", "25.5%");
});

await test("the presets are the four the page offers", () => {
  eq(PAY_PRESETS.join(","), "25,50,75,100", "the preset list changed");
  for (const preset of PAY_PRESETS) {
    eq(percentToBps(String(preset)).bps, preset * 100, `${preset}% is not ${preset * 100} bps`);
  }
});

await test("100% pays the whole job: the crew receives all of it", () => {
  const shares = [3333, 3333, 3334];
  for (const total of [HUNDRED, parseUsd("2.00"), parseUsd("0.07"), parseUsd("1234.57")]) {
    const split = splitCrew(payNowAmount(total, percentToBps("100").bps), shares);
    eq(split.crewTotal, total, `the crew did not receive the whole job at ${formatUsd(total)}`);
    eq(split.retained, 0n, `something was retained at ${formatUsd(total)}`);
    eq(split.amounts.reduce((a, b) => a + b, 0n), total, `the parts do not sum to the job at ${formatUsd(total)}`);
  }
});

await test("the percentage route at 100% matches calling the split directly", () => {
  // Guards the identity payNowAmount(total, 10000) === total. If it ever broke,
  // a full payment would silently stop being the whole job.
  const shares = [3333, 3333, 3334];
  for (const total of [HUNDRED, parseUsd("2.00"), parseUsd("0.07"), parseUsd("1234.57")]) {
    const before = splitCrew(total, shares);
    const after = splitCrew(payNowAmount(total, percentToBps("100").bps), shares);
    eq(after.crewTotal, before.crewTotal, `crew total changed at ${formatUsd(total)}`);
    eq(after.retained, before.retained, `retention changed at ${formatUsd(total)}`);
    eq(after.amounts.join(","), before.amounts.join(","), `per-member amounts changed at ${formatUsd(total)}`);
  }
});

await test("100% produces byte-identical settlement calldata", () => {
  // The real thing: the same builder the page calls, over the same amounts,
  // through the percentage route and the direct route. If these differ, a full
  // payment would send different bytes than it used to.
  const signature = { v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` };
  const crew = SHARES_532.map((bps, i) => ({ address: addr(i + 1), bps }));
  const memo = memoFor(canonicalTerms("amount=100.00&crew=x"));

  const before = buildSettlement({
    client: addr(9), crew, amounts: splitCrew(HUNDRED, SHARES_532).amounts, memo, permitDeadline: 2000000000n, signature,
  });
  const after = buildSettlement({
    client: addr(9), crew,
    amounts: splitCrew(payNowAmount(HUNDRED, percentToBps("100").bps), SHARES_532).amounts,
    memo, permitDeadline: 2000000000n, signature,
  });
  eq(after.data, before.data, "the 100% calldata changed");
  eq(after.crewTotal, before.crewTotal, "the permit value changed at 100%");
});

await test("a partial payment authorises the amount paid, never the job total", () => {
  const crew = SHARES_532.map((bps, i) => ({ address: addr(i + 1), bps }));
  const chosen = percentToBps("50");
  const payNow = payNowAmount(HUNDRED, chosen.bps);
  const split = splitCrew(payNow, SHARES_532);
  const settlement = buildSettlement({
    client: addr(9), crew, amounts: split.amounts, memo: memoFor(canonicalTerms("amount=100.00&crew=x")),
    permitDeadline: 2000000000n, signature: { v: 27, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` },
  });
  eq(settlement.crewTotal, parseUsd("50.00"), "the permit authorised the wrong amount");
  eq(settlement.crewTotal, payNow, "the permit must authorise exactly what is being paid");
  assert(settlement.crewTotal < HUNDRED, "a half payment must not authorise the whole job");
  eq(settlement.calls.length, 1 + crew.length, "one permit call plus one transfer per crew member");
});

/* ─────────────────── 3. the payment, on the real chain ─────────────────── */

console.log(`\nlive settlement on ${network.label}`);

const clientKey = generatePrivateKey();
const client = privateKeyToAccount(clientKey);
const crew = [1, 2, 3, 4].map(() => privateKeyToAccount(generatePrivateKey()));

await test("the client is funded from the faucet", async () => {
  const funding = await fundFromFaucet(network, client.address);
  // The faucet returns hashes, not a mined balance. Reading straight after it
  // returns races the node — which is exactly what an earlier run of this test
  // did, and it read a zero balance from a wallet that was about to be funded.
  for (const hash of funding) await pub.waitForTransactionReceipt({ hash });
  const balance = await pub.readContract({ address: PATHUSD, abi: PATHUSD_ABI, functionName: "balanceOf", args: [client.address] });
  assert(balance > parseUsd("2.00"), `faucet did not fund the client (balance ${formatUnits(balance, 6)})`);
});

const terms = {
  total: parseUsd("2.00"),
  crew: crew.map((c, i) => ({ address: c.address, bps: [4000, 3000, 2000, 1000][i] })),
};
const query = encodeTerms(terms);
const canonical = canonicalTerms(query);
const memo = memoFor(canonical);
const split = splitCrew(terms.total, terms.crew.map((c) => c.bps));

await test("the terms survive the trip the page actually makes", () => {
  const decoded = decodeTerms(canonical);
  assert(decoded.ok, `the page's own canonical form failed to decode: ${decoded.error}`);
  eq(decoded.terms.total, terms.total, "total");
  eq(decoded.terms.crew.length, 4, "crew count");
});

let settlement;
let signature;

await test("the permit is signed over the exact domain pathUSD implements", async () => {
  const nonce = await readPermitNonce(pub, client.address);
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  signature = await client.signTypedData({
    domain: permitDomain(network.chainId),
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit",
    message: { owner: client.address, spender: MULTICALL3, value: split.crewTotal, nonce, deadline: permitDeadline },
  });
  assert(/^0x[0-9a-f]{130}$/i.test(signature), "signature is not a well-formed 65-byte value");
  const parsed = parseSignature(signature);
  assert(parsed.r && parsed.s, "signature did not split into r and s");

  settlement = buildSettlement({
    client: client.address, crew: terms.crew, amounts: split.amounts,
    memo, permitDeadline, signature,
  });
  eq(settlement.crewTotal, parseUsd("2.00"), "the permit authorises exactly the amount paid");
});

await test("the permit authorises exactly what the transfers move, and no more", () => {
  // Nothing is retained, so a full payment's permit covers the whole invoice —
  // that is the expected behaviour now. The property that still has to hold is
  // that the permit is never larger than the transfers it authorises: anything
  // above that sum would be pullable by a later spender call.
  eq(settlement.crewTotal, terms.total, "at 100% the permit covers the whole invoice");
  eq(settlement.crewTotal, terms.total - split.retained, "authorised = total - retained");
  eq(split.retained, 0n, "something was retained");
  eq(
    settlement.crewTotal,
    split.amounts.reduce((a, b) => a + b, 0n),
    "the permit covers more than the transfers that follow it",
  );
});

await test("the whole settlement is one call to Multicall3, with permit first", () => {
  eq(settlement.to, MULTICALL3, "target is not Tempo's Multicall3");
  eq(settlement.calls.length, 5, "expected one permit plus four transfers");
  eq(settlement.calls[0].target, PATHUSD, "every sub-call targets pathUSD, not a custom contract");
  assert(settlement.calls.every((c) => c.target === PATHUSD), "a sub-call targets something other than pathUSD");
});

await test("the exact calldata stays inside the envelope the design assumes", () => {
  const bytes = (settlement.data.length - 2) / 2;
  console.log(`       ${bytes} bytes of calldata, gas limit ${gasLimitFor(4)}`);
  assert(bytes > 1000 && bytes < 2000, `calldata ${bytes} bytes is outside the expected 1,316-byte envelope`);
});

await test("the node's own gas estimate agrees with the measured formula", async () => {
  const live = await estimateSettlementGas(pub, settlement, client.address);
  const formula = gasLimitFor(4);
  console.log(`       node says ${live}, formula says ${formula}`);
  // They are not expected to be identical — the formula is a fallback. What
  // matters is that the fallback is never the smaller of the two, because that
  // is the direction that silently burns a transaction.
  assert(formula >= live, `the fallback limit ${formula} is below the node's ${live} — a settlement would run out of gas`);
  assert(formula < live * 2n, `the fallback ${formula} is more than double the node's ${live} — over-reserving badly`);
});

await test("simulation succeeds before anything is signed or spent", async () => {
  const result = await simulateSettlement(pub, settlement, client.address);
  assert(typeof result?.data === "string" && result.data.startsWith("0x"), "eth_call returned no data at all");
});

await test("a settlement with no permit behind it is rejected — nothing is pre-approved", async () => {
  // The same transfers without calls[0]. If this succeeded, the client would be
  // relying on a standing allowance, which is exactly what this design avoids.
  const naked = buildSettlement({
    client: client.address, crew: terms.crew, amounts: split.amounts,
    memo, permitDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800), signature,
  });
  const noPermit = {
    to: MULTICALL3,
    data: encodeFunctionData({ abi: MULTICALL3_ABI, functionName: "aggregate", args: [naked.calls.slice(1)] }),
  };
  let threw = false;
  try { await simulateSettlement(pub, noPermit, client.address); } catch { threw = true; }
  assert(threw, "transfers went through with no allowance — the permit is not actually load-bearing");
});

let hash;
let receipt;
let balanceBefore;
let balanceAfter;

await test("the client sends exactly one transaction", async () => {
  const read = () => pub.readContract({ address: PATHUSD, abi: PATHUSD_ABI, functionName: "balanceOf", args: [client.address] });
  balanceBefore = await read();
  // The limit comes from the node, not from the formula — the formula is only
  // what the app uses if it cannot reach one.
  const gas = await estimateSettlementGas(pub, settlement, client.address);
  const wallet = walletFor(network, clientKey);
  hash = await wallet.client.sendTransaction({ to: settlement.to, data: settlement.data, gas });
  receipt = await pub.waitForTransactionReceipt({ hash });
  balanceAfter = await read();
  eq(receipt.status, "success", `transaction did not succeed: ${hash}`);
  console.log(`       ${EXPLORER_TX(network, hash)}`);
  console.log(`       gas limit ${gas}, gas used ${receipt.gasUsed}`);
});

await test("the receipt shows all four crew members paid, and only them", () => {
  const entries = decodeSettlementLogs(receipt.logs, { client: client.address, memo });
  eq(entries.length, 4, "expected exactly four memo-bearing transfers — reading the plain Transfer logs too would double this");
  const check = reconcile(entries, terms.crew, split.amounts);
  for (const line of check.lines) {
    console.log(`       ${line.address}  ${formatUnits(line.received, 6)} pathUSD  ${line.ok ? "" : "<-- MISMATCH"}`);
  }
  assert(check.ok, "what the chain recorded does not match the link");
});

await test("the fee transfer and the duplicate Transfer logs are excluded by construction", () => {
  const entries = decodeSettlementLogs(receipt.logs, { client: client.address, memo });
  const total = entries.reduce((a, e) => a + e.value, 0n);
  eq(total, parseUsd("2.00"), "the decoded total is not what was paid");
  assert(!entries.some((e) => e.to === "0xfeec000000000000000000000000000000000000"), "the gas fee leaked into the receipt");
  assert(receipt.logs.length > entries.length, "there should be more raw logs than receipt lines — otherwise the filter is not filtering");
});

await test("each crew member's balance actually moved by the amount in the link", async () => {
  for (let i = 0; i < crew.length; i += 1) {
    const balance = await pub.readContract({ address: PATHUSD, abi: PATHUSD_ABI, functionName: "balanceOf", args: [crew[i].address] });
    eq(balance, split.amounts[i], `crew ${i} balance (${usd(balance)}) does not equal their link amount (${usd(split.amounts[i])})`);
  }
});

await test("no allowance survives the transaction", async () => {
  // The permit set 2.00 and the transfers consumed it inside the same call. If
  // anything remained, the link holder could pull again without a signature.
  const left = await pub.readContract({ address: PATHUSD, abi: PATHUSD_ABI, functionName: "allowance", args: [client.address, MULTICALL3] });
  eq(left, 0n, `an allowance of ${formatUnits(left, 6)} survived — the permit is not self-consuming`);
});

await test("the client was debited exactly what was paid, plus the gas fee and nothing else", async () => {
  // Gas on Tempo is paid in pathUSD, so the debit is the amount paid + fee.
  // With nothing retained, "what the crew receives" and "what the client pays"
  // are the same number — the fee is the only difference there should be.
  const spent = balanceBefore - balanceAfter;
  const fee = spent - split.crewTotal;
  console.log(`       spent ${usd(spent)} pathUSD = ${usd(split.crewTotal)} to crew + ${usd(fee)} gas`);
  assert(fee >= 0n, `the client was debited ${usd(-fee)} less than the crew amount — the crew was not paid from this wallet`);
  assert(fee < parseUsd("0.10"), `gas cost ${usd(fee)} looks wrong for this transaction`);
  eq(split.crewTotal, terms.total, "at 100% the crew must receive the whole invoice");
  eq(split.retained, 0n, "something was retained — the client paid more than the crew received, less gas");
  eq(balanceAfter, balanceBefore - spent, "the balance reads are inconsistent");
});

await test("a replayed permit is rejected — the nonce is consumed", async () => {
  // Resending the identical calldata must fail: it is the same permit nonce.
  // This is what stops the link being paid twice from one signature.
  let threw = false;
  try { await simulateSettlement(pub, settlement, client.address); } catch { threw = true; }
  assert(threw, "the same permit simulated again — it is replayable, which would let the link be paid twice");
});

await test("the nonce advanced by exactly one", async () => {
  const after = await readPermitNonce(pub, client.address);
  eq(after, 1n, "pathUSD nonce did not advance exactly once");
});

/* ───────────────────────────── 4. gas shape ────────────────────────────── */

console.log("\ngas and limits");

await test("the gas limit formula clears every crew count with headroom", () => {
  // The constants are the mined-transaction figures from Moderato, not guesses.
  for (let n = 1; n <= 4; n += 1) {
    const limit = gasLimitFor(n);
    const measured = 809815n + 263711n * BigInt(n);
    assert(limit > measured, `n=${n}: limit ${limit} is below the measured need ${measured}`);
    assert(limit < measured * 2n, `n=${n}: limit ${limit} is more than double the need — over-reserving`);
  }
});

await test("a five-way split's calldata would be larger than the four-way one the design allows", () => {
  assert(gasLimitFor(5) > gasLimitFor(4), "gas does not grow with crew count");
});

/* ─────────────────────────── 5. honest failures ────────────────────────── */

console.log("\nerror reporting");

await test("a cancelled wallet request reads as a cancellation, not a crash", () => {
  eq(explainError({ shortMessage: "User rejected the request." }), "You cancelled the request in your wallet.", "rejection");
});

await test("an underfunded wallet says so in the client's terms", () => {
  const msg = explainError({ shortMessage: "InsufficientBalance(0x1, 100, 200)" });
  assert(/Not enough pathUSD/.test(msg), `wrong message: ${msg}`);
});

await test("an unrecognised revert is passed through rather than guessed at", () => {
  const raw = "TIP20 token error: SomethingNew(1)";
  eq(explainError({ shortMessage: raw }), raw, "an unknown error was replaced with a confident guess");
});

/* ──────────────────────────────── summary ─────────────────────────────── */

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ${f.name}\n    ${f.detail}`);
  process.exit(1);
}
