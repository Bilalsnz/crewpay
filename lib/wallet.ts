import type { EIP1193Provider } from "viem";

import { addChainParams, type NetworkConfig } from "./networks";
import { getInjectedProvider, type WalletId } from "./wagmi";

export function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

type RequestProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function asRequestProvider(value: unknown): RequestProvider | undefined {
  const candidate = value as { request?: unknown } | null | undefined;
  return candidate && typeof candidate.request === "function" ? (candidate as RequestProvider) : undefined;
}

/** The EIP-1193 provider behind a wagmi connector, if it can produce one. */
export async function providerForConnector(
  connector: { getProvider: (parameters?: { chainId?: number }) => Promise<unknown> } | undefined,
): Promise<unknown> {
  if (!connector) return undefined;
  try {
    return await connector.getProvider();
  } catch {
    return undefined;
  }
}

export function errorCode(error: unknown): number | undefined {
  const e = error as { code?: number; cause?: { code?: number } } | undefined;
  return e?.code ?? e?.cause?.code;
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  const e = error as { shortMessage?: string; message?: string; cause?: unknown };
  const cause = e.cause as { shortMessage?: string; message?: string } | undefined;
  return e.shortMessage ?? cause?.shortMessage ?? e.message ?? cause?.message ?? String(error);
}

export function isUserRejection(error: unknown): boolean {
  if (errorCode(error) === 4001) return true;
  return /user (rejected|denied|cancell?ed)|rejected the request/i.test(errorMessage(error));
}

export const SWITCH_HELP = "Your wallet would not switch to Tempo. Open this page in the wallet's own browser and try again.";

/**
 * Runs before every write. Connects nothing and signs nothing — it only makes
 * sure the wallet is looking at the right Tempo network, adding it if the
 * wallet has never seen it (error 4902).
 *
 * The chain id in hex, the RPC URL and the explorer all come from networks.json
 * via `addChainParams`, so there is no second place for a wrong chain to hide.
 */
export async function ensureChain(provider: unknown, network: NetworkConfig): Promise<void> {
  const active = asRequestProvider(provider) ?? asRequestProvider(getInjectedProvider());
  if (!active) throw new Error("No wallet in this browser. Connect one first.");

  const current = await active.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === network.chainIdHex.toLowerCase()) return;

  try {
    await active.request({ method: "wallet_switchEthereumChain", params: [{ chainId: network.chainIdHex }] });
  } catch (error) {
    if (errorCode(error) !== 4902) throw error;
    await active.request({ method: "wallet_addEthereumChain", params: [addChainParams(network)] });
    // Some wallets switch on add, some merely add. Ask once more, quietly.
    try {
      await active.request({ method: "wallet_switchEthereumChain", params: [{ chainId: network.chainIdHex }] });
    } catch {
      /* checked below */
    }
  }

  const after = await active.request({ method: "eth_chainId" });
  if (typeof after !== "string" || after.toLowerCase() !== network.chainIdHex.toLowerCase()) {
    throw new Error(SWITCH_HELP);
  }
}

/**
 * Deep links for a phone browser that is not a wallet.
 *
 * Chrome on Android has no injected provider, so tapping a wallet button there
 * has to leave the browser. Each wallet has its own wrapper URL that makes the
 * OS hand the link to the app; the bare `metamask://`-style schemes mostly do
 * nothing when opened from a page.
 */
export function deepLink(id: WalletId, url: string): string {
  const encoded = encodeURIComponent(url);
  switch (id) {
    case "metamask":
      return `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}`;
    case "okx":
      return `https://web3.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encoded}`)}`;
    case "coinbase":
      return `https://go.cb-w.com/dapp?cb_url=${encoded}`;
    case "trust":
      return `https://link.trustwallet.com/open_url?coin_id=60&url=${encoded}`;
    case "rabby":
      return `https://rabby.io/dapp?url=${encoded}`;
  }
}

/** The wallet's own browser, for a page opened in Chrome on a phone. */
export function openInWallet(id: WalletId, url: string): void {
  window.location.href = deepLink(id, url);
}
