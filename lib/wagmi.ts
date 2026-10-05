import type { EIP1193Provider } from "viem";
import { createConfig, http, injected } from "wagmi";

import { NETWORKS, viemChainFor } from "./networks";

export const tempoTestnet = viemChainFor(NETWORKS.testnet);
export const tempoMainnet = viemChainFor(NETWORKS.mainnet);

export type WalletId = "metamask" | "okx" | "coinbase" | "trust" | "rabby";

export const WALLET_LABEL: Record<WalletId, string> = {
  metamask: "MetaMask",
  okx: "OKX Wallet",
  coinbase: "Coinbase Wallet",
  trust: "Trust Wallet",
  rabby: "Rabby",
};

type InjectedEthereum = EIP1193Provider & {
  isMetaMask?: boolean;
  isRabby?: boolean;
  isOkxWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
};

type InjectedWindow = {
  okxwallet?: EIP1193Provider;
  coinbaseWalletExtension?: EIP1193Provider;
  trustwallet?: EIP1193Provider;
  ethereum?: InjectedEthereum;
};

function readWindow(): InjectedWindow {
  if (typeof window === "undefined") return {};
  return window as unknown as InjectedWindow;
}

/**
 * One connector per wallet, each bound to its own provider object rather than
 * to "whatever is at window.ethereum". When two wallets are installed they both
 * claim window.ethereum, and a single generic connector would silently open
 * whichever registered last — so tapping "MetaMask" could open OKX.
 */
function providerFor(id: WalletId): EIP1193Provider | undefined {
  const w = readWindow();
  const eth = w.ethereum;
  switch (id) {
    case "metamask":
      // Rabby advertises isMetaMask for dapp compatibility, so exclude it.
      return eth?.isMetaMask && !eth.isRabby ? eth : undefined;
    case "okx":
      return w.okxwallet ?? (eth?.isOkxWallet ? eth : undefined);
    case "coinbase":
      return w.coinbaseWalletExtension ?? (eth?.isCoinbaseWallet ? eth : undefined);
    case "trust":
      return w.trustwallet ?? (eth?.isTrust || eth?.isTrustWallet ? eth : undefined);
    case "rabby":
      return eth?.isRabby ? eth : undefined;
  }
}

export function walletInstalled(id: WalletId): boolean {
  return Boolean(providerFor(id));
}

export const WALLET_IDS: WalletId[] = ["metamask", "okx", "coinbase", "trust", "rabby"];

/** Which wallets this browser actually has, in the order we'd like to show them. */
export function installedWallets(): WalletId[] {
  return WALLET_IDS.filter(walletInstalled);
}

/** Whatever wallet is present, when no specific connector is in play. */
export function getInjectedProvider(): EIP1193Provider | undefined {
  const w = readWindow();
  return w.ethereum ?? w.okxwallet ?? w.coinbaseWalletExtension ?? w.trustwallet;
}

/**
 * `injected` comes from `wagmi` — that is, `@wagmi/core` — and deliberately not
 * from `wagmi/connectors`. That subpath re-exports every connector wagmi ships,
 * including Base Account, which pulls `@base-org/account` → `@coinbase/cdp-sdk`
 * → the optional peer `@x402/evm` that npm does not install, so importing the
 * barrel breaks the build on a module this app never calls.
 */
export const wagmiConfig = createConfig({
  chains: [tempoTestnet, tempoMainnet],
  connectors: WALLET_IDS.map((id) =>
    injected({
      shimDisconnect: true,
      target: { id, name: WALLET_LABEL[id], provider: () => providerFor(id) },
    }),
  ),
  transports: {
    [tempoTestnet.id]: http(tempoTestnet.rpcUrls.default.http[0]),
    [tempoMainnet.id]: http(tempoMainnet.rpcUrls.default.http[0]),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
