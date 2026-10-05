/**
 * Deploys CrewPay and records the address in .env.local.
 *
 *   node scripts/deploy.mjs                       # testnet (default)
 *   node scripts/deploy.mjs --network=mainnet --confirm-mainnet
 *
 * On testnet this is self-serve: if no key is configured it generates one,
 * asks the faucet for gas, and deploys. On mainnet it will not generate a key —
 * a mainnet deploy spends real money from a wallet you control, so the key has
 * to already be there, and the run has to be confirmed explicitly.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  root, loadEnv, saveEnv, pickNetwork, publicClientFor, walletFor,
  fundFromFaucet, EXPLORER_ADDRESS, EXPLORER_TX,
} from "./lib.mjs";

const KEY_NAME = "DEPLOYER_PRIVATE_KEY";
const argv = process.argv.slice(2);
const network = pickNetwork(argv);
const env = loadEnv();

const artifact = JSON.parse(readFileSync(resolve(root, "artifacts/CrewPay.json"), "utf8"));
const pub = publicClientFor(network);

const abi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const balanceOf = (address) =>
  pub.readContract({ address: network.pathUsd, abi, functionName: "balanceOf", args: [address] });

/* ── the deployer key ─────────────────────────────────────────────────────── */

let privateKey = env[KEY_NAME];
if (!privateKey) {
  if (!network.isTestnet) {
    console.error(
      `No ${KEY_NAME} in .env.local.\n\n` +
      `CrewPay will not generate a mainnet key for you: deploying to ${network.label} spends real\n` +
      `pathUSD, and a freshly generated address would have no way to be funded by this script.\n` +
      `Put a funded key in .env.local as ${KEY_NAME}=0x… and run this again.`,
    );
    process.exit(1);
  }
  privateKey = generatePrivateKey();
  saveEnv({ [KEY_NAME]: privateKey, CREWPAY_NETWORK: network.key });
  console.log(`generated a throwaway testnet key and saved it to .env.local (gitignored)`);
}

const { account, client } = walletFor(network, privateKey);
console.log(`network  : ${network.label} (chainId ${network.chainId})`);
console.log(`deployer : ${account.address}`);
console.log(`  ${EXPLORER_ADDRESS(network, account.address)}`);

/* ── gas: on Tempo it is paid in pathUSD, not ETH ─────────────────────────── */

let balance = await balanceOf(account.address);
console.log(`balance  : ${formatUnits(balance, network.pathUsdDecimals)} pathUSD`);

if (balance === 0n) {
  if (!network.hasFaucet) {
    console.error(
      `\nThis address holds no pathUSD and ${network.label} has no faucet.\n` +
      `Fund ${account.address} with pathUSD, then run this again.`,
    );
    process.exit(1);
  }
  console.log(`asking the ${network.label} faucet…`);
  const hashes = await fundFromFaucet(network, account.address);
  console.log(`  faucet sent ${Array.isArray(hashes) ? hashes.length : 0} transfer(s)`);
  for (let i = 0; i < 30 && balance === 0n; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    balance = await balanceOf(account.address);
  }
  console.log(`balance  : ${formatUnits(balance, network.pathUsdDecimals)} pathUSD`);
  if (balance === 0n) {
    console.error("faucet did not deliver in 30s — try again");
    process.exit(1);
  }
}

/* ── mainnet costs real money, so make it a deliberate choice ─────────────── */

if (!network.isTestnet && !argv.includes("--confirm-mainnet")) {
  console.error(
    `\nRefusing to deploy to ${network.label} without --confirm-mainnet.\n` +
    `This spends real pathUSD from ${account.address}. Re-run with:\n` +
    `  node scripts/deploy.mjs --network=mainnet --confirm-mainnet`,
  );
  process.exit(1);
}

/* ── deploy ───────────────────────────────────────────────────────────────── */

console.log(`\ndeploying CrewPay (${(artifact.bytecode.length - 2) / 2} bytes)…`);
const hash = await client.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [network.pathUsd] });
console.log(`  tx ${hash}`);
console.log(`  ${EXPLORER_TX(network, hash)}`);

const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
if (receipt.status !== "success") {
  console.error(`\ndeploy reverted`);
  process.exit(1);
}

const address = receipt.contractAddress;
const key = network.isTestnet ? "CREWPAY_ADDRESS_TESTNET" : "CREWPAY_ADDRESS_MAINNET";
const blockKey = network.isTestnet ? "CREWPAY_BLOCK_TESTNET" : "CREWPAY_BLOCK_MAINNET";
// The app reads receipt transaction hashes with getLogs, and starting that scan
// at the deploy block keeps it cheap and inside RPC range limits.
saveEnv({ [key]: address, [blockKey]: String(receipt.blockNumber), CREWPAY_NETWORK: network.key });

const code = await pub.getCode({ address });
console.log(`\nCrewPay deployed`);
console.log(`  address : ${address}`);
console.log(`  block   : ${receipt.blockNumber}`);
console.log(`  code    : ${(code.length - 2) / 2} bytes`);
console.log(`  gasUsed : ${receipt.gasUsed}`);
console.log(`  ${EXPLORER_ADDRESS(network, address)}`);
console.log(`\nsaved ${key} and ${blockKey} to .env.local`);
console.log(`add both to Vercel as environment variables too, as NEXT_PUBLIC_${key} / NEXT_PUBLIC_${blockKey}.`);
