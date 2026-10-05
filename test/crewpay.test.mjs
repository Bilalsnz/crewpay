/**
 * CrewPay contract tests — run against the real Tempo Moderato testnet.
 *
 * These are not mocks. Every case deploys a fresh CrewPay, funds real test
 * accounts from the faucet, and asserts on chain state. That is slower than a
 * local EVM, and it is the point: the things most likely to be wrong here are
 * Tempo-specific (TIP-20 transfer semantics, permit, gas in pathUSD), and a
 * local chain would not catch any of them.
 *
 *   node test/crewpay.test.mjs
 *
 * Refuses to run against mainnet.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseUnits, formatUnits, keccak256, encodeAbiParameters, parseAbiParameters,
  decodeErrorResult, parseSignature, getAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { root, NETWORKS, pickNetwork, publicClientFor, walletFor, jsonRpc, EXPLORER_TX } from "../scripts/lib.mjs";

const network = pickNetwork(["--network=testnet"]);
if (!network.isTestnet) {
  console.error("These tests deploy contracts and spend gas. Testnet only.");
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(resolve(root, "artifacts/CrewPay.json"), "utf8"));
const pub = publicClientFor(network);
const D = network.pathUsdDecimals;
const fmt = (v) => formatUnits(v, D);

/* ───────────────────────────── tiny test harness ───────────────────────── */

let passed = 0;
const failures = [];
const ok = (name) => { passed += 1; console.log(`  \u001b[32mok\u001b[0m   ${name}`); };
const bad = (name, detail) => { failures.push({ name, detail }); console.log(`  \u001b[31mFAIL\u001b[0m ${name}\n       ${detail}`); };
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) { if (actual !== expected) throw new Error(`${msg}\n       expected ${expected}\n       actual   ${actual}`); }

/** Pulls the custom error name out of a viem revert, whichever shape it arrives in. */
function revertName(error) {
  // Walk the whole cause chain first — viem puts different pieces at different
  // depths depending on whether the revert was simulated or mined.
  const parts = [];
  let cur = error;
  for (let depth = 0; cur && depth < 8; depth += 1) {
    if (cur.data?.errorName) return cur.data.errorName;
    if (cur.errorName) return cur.errorName;
    if (typeof cur.data === "string" && cur.data.startsWith("0x") && cur.data.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: artifact.abi, data: cur.data });
        if (decoded?.errorName) return decoded.errorName;
      } catch { /* not a CrewPay error — likely the token's */ }
    }
    for (const key of ["shortMessage", "message", "details"]) {
      if (typeof cur[key] === "string") parts.push(cur[key]);
    }
    cur = cur.cause;
  }
  const full = parts.join(" ");

  const own = full.match(/reverted with (?:custom error )?['"]?([A-Za-z0-9_]+)/);
  if (own && own[1] !== "the") return own[1];

  // Reverts raised inside the TIP-20 token never decode against our ABI, but
  // they name themselves: "TIP20 token error: InsufficientAllowance(...)".
  const token = full.match(/token error:\s*([A-Za-z0-9_]+)/);
  if (token) return token[1];

  const sig = full.match(/signature:\s*(0x[0-9a-fA-F]{8})/);
  if (sig) return sig[1];

  return full.slice(0, 80) || "reverted";
}

/** Asserts a call reverts, and that it reverts for the stated reason. */
async function expectRevert(name, fn, expected) {
  try {
    await fn();
  } catch (error) {
    const got = revertName(error);
    if (expected && got !== expected) throw new Error(`expected revert ${expected}, got ${got}`);
    return;
  }
  throw new Error(`expected revert ${expected ?? ""} but the call succeeded`);
}

const addressOf = (i) => getAddress("0x" + (i + 1).toString(16).padStart(40, "0"));

/* ──────────────────────────────── setup ────────────────────────────────── */

console.log(`\nCrewPay tests on ${network.label} (chainId ${network.chainId})`);
console.log(`pathUSD ${network.pathUsd}\n`);

const ABI = artifact.abi;
const read = (address, functionName, args = []) => pub.readContract({ address, abi: ABI, functionName, args });
const write = (w, address, functionName, args = []) => w.client.writeContract({ address, abi: ABI, functionName, args });

async function funded() {
  const pk = generatePrivateKey();
  const { account, client } = walletFor(network, pk);
  const res = await jsonRpc(network, network.faucetMethod, [account.address]);
  if (res.error) throw new Error(`faucet: ${res.error.message}`);
  return { account, client, address: account.address, pk };
}

async function waitForFunds(addresses) {
  for (let i = 0; i < 40; i += 1) {
    const balances = await Promise.all(addresses.map((a) => pub.readContract({
      address: network.pathUsd,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf", args: [a],
    })));
    if (balances.every((b) => b > 0n)) return balances;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("faucet did not deliver within 40s");
}

console.log("funding accounts from the faucet…");
const ACCOUNTS = [];
for (let i = 0; i < 5; i += 1) ACCOUNTS.push(await funded());
await waitForFunds(ACCOUNTS.map((a) => a.address));
console.log(`  ${ACCOUNTS.length} accounts funded\n`);

const [CLIENT, C1, C2, C3, C4] = ACCOUNTS;
const CREW = [C1.address, C2.address, C3.address, C4.address];
const SHARES = [4000, 3000, 2000, 1000]; // 40 / 30 / 20 / 10
const KEY = generatePrivateKey();
const deployer = walletFor(network, KEY);
await jsonRpc(network, network.faucetMethod, [deployer.account.address]);
await waitForFunds([deployer.account.address]);

const PATHUSD_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "x", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];

const balanceOf = (a) => pub.readContract({ address: network.pathUsd, abi: PATHUSD_ABI, functionName: "balanceOf", args: [a] });
const allowanceOf = (owner) => pub.readContract({ address: network.pathUsd, abi: PATHUSD_ABI, functionName: "allowance", args: [owner, CP] });

/**
 * `pay()` pulls with transferFrom, so the client has to authorise it first —
 * same as any ERC-20 pull. The app's default path skips this entirely with a
 * permit (see payWithPermit at the bottom); this is the fallback that works
 * with any wallet, and it is what these tests exercise for the plain pay(). */
async function approve(who, amount) {
  const hash = await who.client.writeContract({ address: network.pathUsd, abi: PATHUSD_ABI, functionName: "approve", args: [CP, amount] });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  eq(rc.status, "success", "approve tx status");
}

console.log("deploying a fresh CrewPay for this run…");
const deployHash = await deployer.client.deployContract({ abi: ABI, bytecode: artifact.bytecode, args: [network.pathUsd] });
const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 });
const CP = deployReceipt.contractAddress;
console.log(`  ${CP}\n  ${EXPLORER_TX(network, deployHash)}\n`);

const NOW = () => BigInt(Math.floor(Date.now() / 1000));
const soon = () => NOW() + 3600n;

/* ─────────────────────────── create: rejections ────────────────────────── */

console.log("createJob — rejects bad input");

await test("no crew at all", () =>
  expectRevert("NoCrew", () => write(CLIENT, CP, "createJob", [[], [], parseUnits("2", D), soon()]), "NoCrew"));

await test("five crew (over the limit of four)", () =>
  expectRevert("TooManyCrew", () => write(CLIENT, CP, "createJob", [
    [C1.address, C2.address, C3.address, C4.address, addressOf(9)],
    [2000, 2000, 2000, 2000, 2000],
    parseUnits("2", D), soon(),
  ]), "TooManyCrew"));

await test("crew and shares lengths differ", () =>
  expectRevert("CrewLengthMismatch", () => write(CLIENT, CP, "createJob", [
    [C1.address, C2.address], [5000], parseUnits("2", D), soon(),
  ]), "CrewLengthMismatch"));

await test("a crew address is the zero address", () =>
  expectRevert("ZeroAddress", () => write(CLIENT, CP, "createJob", [
    [C1.address, "0x0000000000000000000000000000000000000000"], [5000, 5000], parseUnits("2", D), soon(),
  ]), "ZeroAddress"));

await test("percentages do not sum to 100%", () =>
  expectRevert("BadShares", () => write(CLIENT, CP, "createJob", [
    [C1.address, C2.address], [5000, 4000], parseUnits("2", D), soon(),
  ]), "BadShares"));

await test("percentages exceed 100%", () =>
  expectRevert("BadShares", () => write(CLIENT, CP, "createJob", [
    [C1.address, C2.address], [6000, 6000], parseUnits("2", D), soon(),
  ]), "BadShares"));

await test("deadline already in the past", () =>
  expectRevert("DeadlineInPast", () => write(CLIENT, CP, "createJob", [
    [C1.address], [10000], parseUnits("2", D), NOW() - 60n,
  ]), "DeadlineInPast"));

await test("deadline in the year 3000", () =>
  expectRevert("DeadlineTooFar", () => write(CLIENT, CP, "createJob", [
    [C1.address], [10000], parseUnits("2", D), 32_503_680_000n,
  ]), "DeadlineTooFar"));

await test("zero amount", () =>
  expectRevert("ZeroAmount", () => write(CLIENT, CP, "createJob", [
    [C1.address], [10000], 0n, soon(),
  ]), "ZeroAmount"));

/* ──────────────────────────── create: happy path ───────────────────────── */

console.log("\ncreateJob — the record");

const TOTAL = parseUnits("2", D);
let JOB;

await test("creates a job and freezes the crew, shares and deadline", async () => {
  const hash = await write(CLIENT, CP, "createJob", [CREW, SHARES, TOTAL, soon()]);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  eq(rc.status, "success", "createJob tx status");
  JOB = await read(CP, "jobCount");
  const j = await read(CP, "getJob", [JOB]);
  eq(j[0].toLowerCase(), CLIENT.address.toLowerCase(), "client");
  eq(j[3], TOTAL, "total");
  eq(j[4], 4, "crewCount");
  eq(j[5], false, "paid flag");
  eq(j[8].slice(0, 4).map((a) => a.toLowerCase()).join(), CREW.map((a) => a.toLowerCase()).join(), "crew set");
  eq(j[9].slice(0, 4).join(), SHARES.join(), "shares frozen");
});

await test("a second client cannot pay someone else's job", async () => {
  await expectRevert("NotClient", async () => {
    await write(C2, CP, "pay", [JOB]);
  }, "NotClient");
});

await test("statusOf says unpaid", async () => eq(await read(CP, "statusOf", [JOB]), "unpaid", "status"));

await test("the 10% is not yet returnable", async () => eq(await read(CP, "isReturnable", [JOB]), false, "isReturnable"));

/* ────────────────────────────── accept guards ──────────────────────────── */

console.log("\nsettlement guards before payment");

await test("cannot accept an unpaid job", () =>
  expectRevert("NotPaid", () => write(CLIENT, CP, "accept", [JOB]), "NotPaid"));

await test("cannot reclaim an unpaid job", () =>
  expectRevert("NotPaid", () => write(CLIENT, CP, "reclaim", [JOB]), "NotPaid"));

/* ──────────────────────────────── paying ───────────────────────────────── */

console.log("\npay — the 90% moves in the payment transaction itself");

const before = {
  client: await balanceOf(CLIENT.address),
  crew: await Promise.all(CREW.map(balanceOf)),
};

let payReceipt;

await test("pay() cannot pull funds the client never authorised", async () => {
  eq(await allowanceOf(CLIENT.address), 0n, "allowance before any approval");
  let got = null;
  try { await write(CLIENT, CP, "pay", [JOB]); } catch (error) { got = revertName(error); }
  assert(got !== null, "pay must not succeed with no allowance");
  assert(/InsufficientAllowance/i.test(got), `expected an allowance failure, got: ${got}`);
});

await test("pay() splits 90% across the crew by their percentages", async () => {
  await approve(CLIENT, TOTAL);
  const hash = await write(CLIENT, CP, "pay", [JOB]);
  payReceipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  eq(payReceipt.status, "success", "pay tx status");

  const crewTotal = (TOTAL * 9000n) / 10000n; // 1.80
  const expected = [720000n, 540000n, 360000n, 180000n]; // 40/30/20/10 of 1.80
  const after = await Promise.all(CREW.map(balanceOf));
  for (let i = 0; i < 4; i += 1) {
    eq(after[i] - before.crew[i], expected[i], `crew ${i + 1} received`);
  }
  eq(expected.reduce((a, b) => a + b, 0n), crewTotal, "crew amounts sum to the 90%");
});

await test("the contract holds exactly the 10% and not a unit more", async () => {
  const held = await read(CP, "holdback", [JOB]);
  eq(held, TOTAL - (TOTAL * 9000n) / 10000n, "holdback");
  eq(held, 200000n, "holdback is 0.20 of 2.00");
  eq(await balanceOf(CP), held, "the contract's whole balance is just the holdback");
});

await test("statusOf says paid", async () => eq(await read(CP, "statusOf", [JOB]), "paid", "status"));

await test("rejects a duplicate payment", () =>
  expectRevert("AlreadyPaid", () => write(CLIENT, CP, "pay", [JOB]), "AlreadyPaid"));

await test("rejects a duplicate payment by permit too", () =>
  expectRevert("AlreadyPaid", () => write(CLIENT, CP, "payWithPermit", [JOB, soon(), 0, "0x" + "0".repeat(64), "0x" + "0".repeat(64)]), "AlreadyPaid"));

await test("cannot reclaim before the deadline", () =>
  expectRevert("DeadlineNotPassed", () => write(CLIENT, CP, "reclaim", [JOB]), "DeadlineNotPassed"));

await test("a stranger cannot accept on the client's behalf", () =>
  expectRevert("NotClient", () => write(C1, CP, "accept", [JOB]), "NotClient"));

/* ─────────────────────────────── acceptance ────────────────────────────── */

console.log("\naccept — the 10% follows the same percentages");

const beforeAccept = await Promise.all(CREW.map(balanceOf));

await test("accept() releases the holdback to the crew", async () => {
  const hash = await write(CLIENT, CP, "accept", [JOB]);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  eq(rc.status, "success", "accept tx status");

  const expected = [80000n, 60000n, 40000n, 20000n]; // 40/30/20/10 of 0.20
  const after = await Promise.all(CREW.map(balanceOf));
  for (let i = 0; i < 4; i += 1) eq(after[i] - beforeAccept[i], expected[i], `crew ${i + 1} release`);
});

await test("the contract is left holding nothing", async () => {
  eq(await read(CP, "holdback", [JOB]), 0n, "holdback cleared");
  eq(await balanceOf(CP), 0n, "contract balance");
});

await test("statusOf says accepted", async () => eq(await read(CP, "statusOf", [JOB]), "accepted", "status"));

await test("cannot accept twice", () =>
  expectRevert("AlreadyAccepted", () => write(CLIENT, CP, "accept", [JOB]), "AlreadyAccepted"));

await test("cannot reclaim after accepting", () =>
  expectRevert("AlreadyAccepted", () => write(CLIENT, CP, "reclaim", [JOB]), "AlreadyAccepted"));

/* ──────────────────────── deadline return path ─────────────────────────── */

console.log("\nreclaim — deadline passes without acceptance");

const SHORT = 20n; // seconds
let JOB2;

await test("creates a job with a deadline 20 seconds out", async () => {
  const hash = await write(CLIENT, CP, "createJob", [CREW, SHARES, TOTAL, NOW() + SHORT]);
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  JOB2 = await read(CP, "jobCount");
  const j = await read(CP, "getJob", [JOB2]);
  eq(j[3], TOTAL, "total");
});

await test("accept() is refused once the deadline has passed", async () => {
  await approve(CLIENT, TOTAL);
  const hash = await write(CLIENT, CP, "pay", [JOB2]);
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  eq(await read(CP, "statusOf", [JOB2]), "paid", "status after paying");

  console.log(`       waiting ${SHORT}s for the deadline to pass…`);
  for (let i = 0; i < 40; i += 1) {
    if (await read(CP, "isReturnable", [JOB2])) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  eq(await read(CP, "isReturnable", [JOB2]), true, "isReturnable after the deadline");
  await expectRevert("DeadlinePassed", () => write(CLIENT, CP, "accept", [JOB2]), "DeadlinePassed");
});

await test("reclaim() returns the 10% to the client, and only to the client", async () => {
  const clientBefore = await balanceOf(CLIENT.address);
  const crewBefore = await Promise.all(CREW.map(balanceOf));

  // a stranger can push the button; the money still only goes to the client
  const hash = await write(C4, CP, "reclaim", [JOB2]);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  eq(rc.status, "success", "reclaim tx status");

  const held = TOTAL - (TOTAL * 9000n) / 10000n;
  eq(await balanceOf(CLIENT.address) - clientBefore, held, "client got the holdback back");

  // Crew 1-3 did not send this transaction, so their balances must be untouched
  // to the unit — that is what "only to the client" means.
  const crewAfter = await Promise.all(CREW.map(balanceOf));
  for (let i = 0; i < 3; i += 1) eq(crewAfter[i], crewBefore[i], `crew ${i + 1} untouched by the return`);

  // C4 pushed the button. Gas on Tempo is paid in pathUSD — the very token the
  // job settles in — so a caller's balance does move here, but only downward by
  // the gas. Receiving any part of the holdback would show up as a gain.
  const callerDelta = crewAfter[3] - crewBefore[3];
  assert(callerDelta < 0n, "the caller paid gas, so its balance must fall");
  assert(
    callerDelta > -parseUnits("0.01", D),
    `the caller lost only gas, not a slice of the holdback (lost ${fmt(-callerDelta)} pathUSD)`,
  );
});

await test("statusOf says returned", async () => eq(await read(CP, "statusOf", [JOB2]), "returned", "status"));

await test("cannot reclaim twice", () =>
  expectRevert("AlreadyReturned", () => write(CLIENT, CP, "reclaim", [JOB2]), "AlreadyReturned"));

await test("cannot accept after the money went back", () =>
  expectRevert("AlreadyReturned", () => write(CLIENT, CP, "accept", [JOB2]), "AlreadyReturned"));

/* ───────────────────────── permit: the one-tap path ────────────────────── */

console.log("\npayWithPermit — one transaction, no prior approve");

/** Derives the EIP-712 domain by matching the token's own DOMAIN_SEPARATOR. */
async function resolvePermitDomain() {
  const target = (await pub.call({ to: network.pathUsd, data: "0x3644e515" })).data;
  const h = (s) => keccak256(new TextEncoder().encode(s));
  const TH = keccak256(new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  for (const name of [...new Set([network.pathUsdName, network.pathUsdSymbol, "pathUSD", "PathUSD"])]) {
    for (const version of [network.permitDomainVersion, "1", "2", ""]) {
      const ds = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes32,uint256,address"),
        [TH, h(name), h(version), BigInt(network.chainId), getAddress(network.pathUsd)]));
      if (ds === target) return { name, version, chainId: network.chainId, verifyingContract: getAddress(network.pathUsd) };
    }
  }
  throw new Error("could not derive the EIP-712 permit domain from DOMAIN_SEPARATOR");
}

let JOB3;
const domain = await resolvePermitDomain();
console.log(`  permit domain: name="${domain.name}" version="${domain.version}"`);

await test("the derived domain matches the token's own separator", () =>
  assert(domain.name && domain.version !== undefined, "domain derived"));

await test("pays in a single transaction with a permit and no prior approve", async () => {
  const hash = await write(CLIENT, CP, "createJob", [CREW, SHARES, TOTAL, soon()]);
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  JOB3 = await read(CP, "jobCount");

  const allowanceBefore = await pub.readContract({
    address: network.pathUsd,
    abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "allowance", args: [CLIENT.address, CP],
  });
  eq(allowanceBefore, 0n, "no allowance exists beforehand");

  const nonce = await pub.readContract({
    address: network.pathUsd,
    abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "nonces", args: [CLIENT.address],
  });
  const permitDeadline = NOW() + 3600n;
  const signature = await CLIENT.account.signTypedData({
    domain,
    types: { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" },
      { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ] },
    primaryType: "Permit",
    message: { owner: CLIENT.address, spender: CP, value: TOTAL, nonce, deadline: permitDeadline },
  });
  const { v, r, s } = parseSignature(signature);

  const crewBefore = await Promise.all(CREW.map(balanceOf));
  const payHash = await write(CLIENT, CP, "payWithPermit", [JOB3, permitDeadline, v, r, s]);
  const rc = await pub.waitForTransactionReceipt({ hash: payHash, timeout: 60_000 });
  eq(rc.status, "success", "payWithPermit status");
  eq(await read(CP, "statusOf", [JOB3]), "paid", "status");

  const crewAfter = await Promise.all(CREW.map(balanceOf));
  eq(crewAfter[0] - crewBefore[0], 720000n, "crew 1 got their 90% share");
  eq(await read(CP, "holdback", [JOB3]), 200000n, "holdback held");
  console.log(`       ${EXPLORER_TX(network, payHash)}`);
});

/* ─────────────────────────── rounding exactness ────────────────────────── */

console.log("\nrounding — odd percentages must not strand dust");

await test("three crew at 33.33/33.33/33.34 distribute the 90% exactly", async () => {
  const amount = parseUnits("1", D); // 1.00 -> crew 0.90, which does not divide by 3
  const hash = await write(CLIENT, CP, "createJob", [
    [C1.address, C2.address, C3.address], [3333, 3333, 3334], amount, soon(),
  ]);
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  const job = await read(CP, "jobCount");

  const amounts = await read(CP, "crewAmounts", [job]);
  const crewTotal = (amount * 9000n) / 10000n;
  eq(amounts[0] + amounts[1] + amounts[2], crewTotal, "the three shares sum to exactly the 90%");

  const before = await Promise.all([C1, C2, C3].map((a) => balanceOf(a.address)));
  const contractBefore = await balanceOf(CP);
  await approve(CLIENT, amount);
  const payHash = await write(CLIENT, CP, "pay", [job]);
  await pub.waitForTransactionReceipt({ hash: payHash, timeout: 60_000 });
  const after = await Promise.all([C1, C2, C3].map((a) => balanceOf(a.address)));
  eq(after[0] - before[0], amounts[0], "crew 1 received its computed amount");
  eq(after[1] - before[1], amounts[1], "crew 2 received its computed amount");
  eq(after[2] - before[2], amounts[2], "crew 3 received its computed amount");
  // The contract holds every job's outstanding holdback at once, so assert the
  // delta from this payment rather than the whole balance.
  eq(await balanceOf(CP) - contractBefore, amount - crewTotal, "this job added exactly its 10% to the contract");
});

/* ──────────────────────────── conservation ─────────────────────────────── */

console.log("\nconservation — no path creates or loses a unit");

await test("across every paid job, crew + holdback + refunds equal what clients paid", async () => {
  const count = await read(CP, "jobCount");
  let paidTotal = 0n, heldNow = 0n;
  for (let id = 1n; id <= count; id += 1n) {
    const j = await read(CP, "getJob", [id]);
    if (j[5]) { paidTotal += j[3]; heldNow += await read(CP, "holdback", [id]); }
  }
  const contractBalance = await balanceOf(CP);
  eq(contractBalance, heldNow, "the contract holds exactly the sum of outstanding holdbacks");
  assert(heldNow <= paidTotal, "holdbacks cannot exceed what was paid in");
});

/* ──────────────────────────────── results ──────────────────────────────── */

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`\u001b[32m${passed} tests passed\u001b[0m on ${network.label}`);
  console.log(`contract under test: ${CP}`);
  process.exit(0);
} else {
  console.log(`\u001b[31m${failures.length} failed\u001b[0m, ${passed} passed`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail.split("\n")[0]}`);
  process.exit(1);
}
