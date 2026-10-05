/**
 * Shared plumbing for the offline scripts (deploy, faucet, tests).
 *
 * Deliberately dependency-free apart from viem — no dotenv, no hardhat, no
 * framework. The `.env.local` reader below is a dozen lines and keeps the
 * secret-handling obvious: keys go in one gitignored file and nowhere else.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = resolve(root, ".env.local");

const networksFile = JSON.parse(readFileSync(resolve(root, "networks.json"), "utf8"));
export const NETWORKS = networksFile.networks;

/* ─────────────────────────────── .env.local ────────────────────────────── */

export function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Merges keys into .env.local without disturbing anything already there. */
export function saveEnv(updates) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(updates)) {
    const at = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (at === -1) lines.push(line);
    else lines[at] = line;
  }
  // Drop blank and comment-only leftovers so repeated runs do not grow the file.
  const kept = lines.filter((l) => l.trim() !== "");
  writeFileSync(ENV_PATH, `${kept.join("\n")}\n`);
}

/* ──────────────────────────────── networks ─────────────────────────────── */

export function pickNetwork(argv = process.argv.slice(2)) {
  const flag = argv.find((a) => a.startsWith("--network="));
  const key = flag ? flag.split("=")[1] : loadEnv().CREWPAY_NETWORK || "testnet";
  const network = NETWORKS[key];
  if (!network) throw new Error(`unknown network "${key}" — expected testnet or mainnet`);
  return network;
}

export function viemChain(network) {
  return defineChain({
    id: network.chainId,
    name: network.label,
    nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: { default: { name: "Tempo Explorer", url: network.explorerUrl } },
    testnet: network.isTestnet,
  });
}

export function publicClientFor(network) {
  return createPublicClient({ chain: viemChain(network), transport: http(network.rpcUrl, { timeout: 30_000 }) });
}

export function walletFor(network, privateKey) {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    client: createWalletClient({ account, chain: viemChain(network), transport: http(network.rpcUrl, { timeout: 60_000 }) }),
  };
}

export async function jsonRpc(network, method, params) {
  const res = await fetch(network.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  return res.json();
}

/** Testnet only. Refuses to run against mainnet — there is no faucet there. */
export async function fundFromFaucet(network, address) {
  if (!network.hasFaucet) throw new Error(`no faucet on ${network.label}`);
  const out = await jsonRpc(network, network.faucetMethod, [address]);
  if (out.error) throw new Error(out.error.message ?? "faucet refused");
  return out.result;
}

export const EXPLORER_TX = (network, hash) => `${network.explorerUrl}/tx/${hash}`;
export const EXPLORER_ADDRESS = (network, address) => `${network.explorerUrl}/address/${address}`;
