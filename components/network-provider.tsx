"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { DEFAULT_NETWORK, isNetworkKey, NETWORKS, type NetworkConfig, type NetworkKey } from "@/lib/networks";

interface NetworkContextValue {
  network: NetworkKey;
  config: NetworkConfig;
  setNetwork: (next: NetworkKey) => void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);
const STORAGE_KEY = "crewpay.network";

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [network, setNetworkState] = useState<NetworkKey>(DEFAULT_NETWORK);

  // Remember the choice so a reload does not silently move someone from
  // mainnet back to testnet.
  //
  // A link, however, names its own network and that always wins. Child effects
  // run before this one, so without the guard below a `/job/mainnet/3` link
  // would set mainnet and then be quietly overwritten by a stored "testnet" —
  // which is precisely how the two networks get mixed.
  useEffect(() => {
    try {
      if (/^\/job\/(testnet|mainnet)(\/|$)/.test(window.location.pathname)) return;
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isNetworkKey(stored)) setNetworkState(stored);
    } catch {
      /* private mode, blocked storage — the default stands */
    }
  }, []);

  const setNetwork = useCallback((next: NetworkKey) => {
    setNetworkState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* not fatal */
    }
  }, []);

  const value = useMemo(
    () => ({ network, config: NETWORKS[network], setNetwork }),
    [network, setNetwork],
  );

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const context = useContext(NetworkContext);
  if (!context) throw new Error("useNetwork must be used inside NetworkProvider");
  return context;
}
