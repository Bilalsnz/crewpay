import type { EIP1193Provider } from "viem";

import { addChainParams, type NetworkConfig } from "./networks";
import { type WalletId } from "./wagmi";

export function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

type RequestProvider = {
  request: (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;
};

function asRequestProvider(
  value: unknown,
): RequestProvider | undefined {
  const candidate = value as
    | { request?: unknown }
    | null
    | undefined;

  return candidate && typeof candidate.request === "function"
    ? (candidate as RequestProvider)
    : undefined;
}

/**
 * Returns the EIP-1193 provider belonging to the wallet connector
 * that is actually connected.
 *
 * We deliberately do not fall back to window.ethereum here.
 * If the connected connector cannot provide its own provider, failing
 * is safer than accidentally switching a different installed wallet.
 */
export async function providerForConnector(
  connector:
    | {
        getProvider: (
          parameters?: { chainId?: number },
        ) => Promise<unknown>;
      }
    | undefined,
): Promise<EIP1193Provider | undefined> {
  if (!connector) return undefined;

  try {
    const provider = await connector.getProvider();
    return asRequestProvider(provider) as EIP1193Provider | undefined;
  } catch {
    return undefined;
  }
}

export function errorCode(error: unknown): number | undefined {
  const e = error as
    | {
        code?: number;
        cause?: { code?: number };
      }
    | undefined;

  return e?.code ?? e?.cause?.code;
}

export function errorMessage(error: unknown): string {
  if (!error) return "";

  const e = error as {
    shortMessage?: string;
    message?: string;
    cause?: unknown;
  };

  const cause = e.cause as
    | {
        shortMessage?: string;
        message?: string;
      }
    | undefined;

  return (
    e.shortMessage ??
    cause?.shortMessage ??
    e.message ??
    cause?.message ??
    String(error)
  );
}

export function isUserRejection(error: unknown): boolean {
  if (errorCode(error) === 4001) return true;

  return /user (rejected|denied|cancell?ed)|rejected the request/i.test(
    errorMessage(error),
  );
}

export const SWITCH_HELP =
  "Your wallet would not switch to Tempo. Open this page in the wallet's own browser and try again.";

/**
 * Ensures that the supplied wallet provider is on the requested network.
 *
 * Flow:
 * 1. Read the wallet's current eth_chainId.
 * 2. If already correct, stop.
 * 3. Ask the wallet to switch.
 * 4. If the wallet returns 4902, add Tempo.
 * 5. Ask the wallet to switch again after adding.
 * 6. Read eth_chainId again.
 * 7. Fail unless the wallet itself confirms the requested chain.
 *
 * This function never signs, sends a transaction, or changes wallets.
 */
export async function ensureChain(
  provider: unknown,
  network: NetworkConfig,
): Promise<void> {
  const active = asRequestProvider(provider);

  if (!active) {
    throw new Error(
      "The connected wallet did not expose a usable provider.",
    );
  }

  const current = await active.request({
    method: "eth_chainId",
  });

  if (
    typeof current === "string" &&
    current.toLowerCase() === network.chainIdHex.toLowerCase()
  ) {
    return;
  }

  try {
    await active.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: network.chainIdHex }],
    });
  } catch (error) {
    // 4001 means the user explicitly rejected the switch.
    // Let the caller handle that normally.
    if (errorCode(error) === 4001) {
      throw error;
    }

    // 4902 means this wallet does not know the requested chain yet.
    if (errorCode(error) !== 4902) {
      throw error;
    }

    await active.request({
      method: "wallet_addEthereumChain",
      params: [addChainParams(network)],
    });

    // Some wallets switch automatically when adding a chain.
    // Others only add it, so explicitly request the switch afterwards.
    await active.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: network.chainIdHex }],
    });
  }

  // Never assume the request worked.
  // The wallet itself must confirm the resulting chain.
  const after = await active.request({
    method: "eth_chainId",
  });

  if (
    typeof after !== "string" ||
    after.toLowerCase() !== network.chainIdHex.toLowerCase()
  ) {
    throw new Error(SWITCH_HELP);
  }
}

/**
 * Deep links for a phone browser that is not itself a wallet browser.
 */
export function deepLink(
  id: WalletId,
  url: string,
): string {
  const encoded = encodeURIComponent(url);

  switch (id) {
    case "metamask":
      return `https://metamask.app.link/dapp/${url.replace(
        /^https?:\/\//,
        "",
      )}`;

    case "okx":
      return `https://web3.okx.com/download?deeplink=${encodeURIComponent(
        `okx://wallet/dapp/url?dappUrl=${encoded}`,
      )}`;

    case "coinbase":
      return `https://go.cb-w.com/dapp?cb_url=${encoded}`;

    case "trust":
      return `https://link.trustwallet.com/open_url?coin_id=60&url=${encoded}`;

    case "rabby":
      return `https://rabby.io/dapp?url=${encoded}`;
  }
}

/** Opens the supplied URL in the selected wallet's browser. */
export function openInWallet(
  id: WalletId,
  url: string,
): void {
  window.location.href = deepLink(id, url);
}