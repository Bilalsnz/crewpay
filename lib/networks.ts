import { defineChain } from "viem";

import data from "@/networks.json";

/**
 * The networks come from networks.json — the same file the deploy script and
 * the test suite read. Nothing in this app spells a chain id, an RPC URL or a
 * token address a second time, so there is exactly one place for any of them to
 * be wrong, and it is the place that was checked against the live chains.
 */
export interface NetworkConfig {
  key: "testnet" | "mainnet";
  label: string;
  shortLabel: string;
  chainId: number;
  chainIdHex: string;
  rpcUrl: string;
  explorerUrl: string;
  pathUsd: `0x${string}`;
  pathUsdName: string;
  pathUsdSymbol: string;
  pathUsdDecimals: number;
  permitDomainVersion: string;
  hasFaucet: boolean;
  faucetMethod: string | null;
  faucetAmount: string | null;
  gasToken: string;
  isTestnet: boolean;
}

export type NetworkKey = NetworkConfig["key"];

const raw = data.networks as unknown as Record<NetworkKey, NetworkConfig>;

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  testnet: raw.testnet,
  mainnet: raw.mainnet,
};

export const NETWORK_KEYS: NetworkKey[] = ["testnet", "mainnet"];

export function isNetworkKey(value: unknown): value is NetworkKey {
  return value === "testnet" || value === "mainnet";
}

/**
 * Tempo first, and testnet by default. A build can flip the default with
 * NEXT_PUBLIC_DEFAULT_NETWORK, but nothing else about the choice is implicit —
 * every link carries its own network, so a testnet payment link can never be
 * opened against mainnet by accident.
 */
export const DEFAULT_NETWORK: NetworkKey =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK === "mainnet" ? "mainnet" : "testnet";

export function viemChainFor(network: NetworkConfig) {
  return defineChain({
    id: network.chainId,
    name: network.label,
    // Gas on Tempo is paid in a TIP-20 stablecoin, not ETH. This is only what
    // wallets want to see in the add-chain prompt; no code path reads a native
    // balance or sets msg.value.
    nativeCurrency: { name: network.pathUsdName, symbol: network.pathUsdSymbol, decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: { default: { name: "Tempo Explorer", url: network.explorerUrl } },
    testnet: network.isTestnet,
  });
}

/** Exact payload for `wallet_addEthereumChain`, used on wallet error 4902. */
export function addChainParams(network: NetworkConfig) {
  return {
    chainId: network.chainIdHex,
    chainName: network.label,
    rpcUrls: [network.rpcUrl],
    nativeCurrency: { name: network.pathUsdName, symbol: network.pathUsdSymbol, decimals: 18 },
    blockExplorerUrls: [network.explorerUrl],
  };
}

export const explorerTx = (network: NetworkConfig, hash: string) => `${network.explorerUrl}/tx/${hash}`;
export const explorerAddress = (network: NetworkConfig, address: string) => `${network.explorerUrl}/address/${address}`;
