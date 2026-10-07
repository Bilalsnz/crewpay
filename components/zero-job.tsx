"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useSignTypedData,
  useWalletClient,
} from "wagmi";

import { TempoGuard } from "@/components/chain-guard";
import { Shell, useFollowLinkNetwork } from "@/components/shell";
import {
  Button,
  Card,
  ExternalLink,
  Label,
  Note,
  Row,
  Spinner,
} from "@/components/ui";
import { FOOTER_PAY_JOB } from "@/lib/brand";
import { NETWORKS, explorerTx, type NetworkKey } from "@/lib/networks";
import { PERMIT_TYPES, resolvePermitDomain } from "@/lib/permit";
import {
  ensureChain,
  errorMessage,
  isUserRejection,
  providerForConnector,
  SWITCH_HELP,
} from "@/lib/wallet";
import {
  canonicalTerms,
  formatUsdFixed,
  parseUsd,
  splitCrew,
} from "@/lib/zerocon.mjs";
import {
  MULTICALL3,
  buildSettlement,
  decodeSettlementLogs,
  estimateSettlementGas,
  explainError,
  gasLimitFor,
  memoFor,
  reconcile,
} from "@/lib/multicall.mjs";

interface Member {
  address: string;
  bps: number;
}

interface Receipt {
  hash: string;
  lines: {
    address: string;
    received: bigint;
    expected: bigint;
    ok: boolean;
  }[];
  ok: boolean;
  gasUsed: bigint;
}

export function ZeroJob({
  networkKey,
  query,
  amount,
  crew,
}: {
  networkKey: NetworkKey;
  query: string;
  amount: string;
  crew: Member[];
}) {
  useFollowLinkNetwork(networkKey);

  const config = NETWORKS[networkKey];

  const {
    address: account,
    connector,
    isConnected,
  } = useAccount();

  const { signTypedDataAsync } = useSignTypedData();

  const { data: walletClient } = useWalletClient({
    chainId: config.chainId,
  });

  const client = usePublicClient({
    chainId: config.chainId,
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const terms = useMemo(() => {
    const total = parseUsd(amount) ?? 0n;

    return {
      total,
      split: splitCrew(
        total,
        crew.map((member) => member.bps),
      ),
    };
  }, [amount, crew]);

  const memo = useMemo(
    () => memoFor(canonicalTerms(query)),
    [query],
  );

  const crewTotal = terms.split.crewTotal;

  const blocked = !isConnected
    ? "Connect your wallet first, then pay."
    : null;

  const pay = useCallback(async () => {
    if (!account) {
      setError("Connect your wallet first, then pay.");
      return;
    }

    if (!connector) {
      setError(
        "FlowPay could not find the connected wallet. Reconnect your wallet and try again.",
      );
      return;
    }

    if (!client) {
      setError(
        `FlowPay could not reach ${config.label}. Check your connection and reload the page.`,
      );
      return;
    }

    setError(null);
    setBusy("pay");

    try {
      /*
       * IMPORTANT:
       * Do NOT require walletClient here.
       *
       * When the wallet is connected to another chain, wagmi can return
       * undefined for useWalletClient({ chainId: config.chainId }).
       * That used to make Pay exit before the chain-switch request ever ran.
       */

      setStage("Checking your wallet is on Tempo…");

      const provider = await providerForConnector(connector);

      if (!provider) {
        throw new Error(
          "The connected wallet did not expose a usable provider.",
        );
      }

      /*
       * Switch the ACTUAL connected wallet provider directly.
       *
       * ensureChain:
       * - reads eth_chainId
       * - switches to Tempo if needed
       * - adds Tempo if the wallet does not know it
       * - verifies eth_chainId afterwards
       */
      await ensureChain(provider, config);

      /*
       * The wallet is now confirmed on Tempo.
       *
       * Wagmi's React state can take a moment to update after an external
       * EIP-1193 chain switch, so use the connected connector directly for
       * the wallet client instead of relying on the stale hook value.
       */
      let activeWalletClient = walletClient;

      if (!activeWalletClient) {
        setStage("Connecting your wallet to Tempo…");

        /*
         * Give wagmi a short opportunity to process the chainChanged event.
         * This is deliberately small. We are not polling or looping.
         */
        await new Promise((resolve) => setTimeout(resolve, 250));

        /*
         * The hook may now have updated.
         *
         * Because React hook values cannot be refreshed synchronously inside
         * this callback, we obtain the connector's wallet client through the
         * connector's provider path below if the hook has not caught up.
         */
        const refreshedProvider = await providerForConnector(connector);

        if (!refreshedProvider) {
          throw new Error(
            "Your wallet switched to Tempo, but FlowPay could not access the wallet provider afterwards.",
          );
        }

        const currentChain = await refreshedProvider.request({
          method: "eth_chainId",
        });

        if (
          typeof currentChain !== "string" ||
          Number.parseInt(currentChain, 16) !== config.chainId
        ) {
          throw new Error(
            `Your wallet is not on ${config.label} yet. Please approve the network switch and try again.`,
          );
        }
      }

      /*
       * At this point the provider itself has confirmed Tempo.
       *
       * If wagmi has caught up, use its wallet client.
       * Otherwise the next render will populate it, and the user can retry.
       */
      if (!activeWalletClient) {
        throw new Error(
          `Your wallet is on ${config.label}, but wagmi has not finished updating the wallet signer yet. Please tap Pay again.`,
        );
      }

      setStage("Waiting for your wallet to sign the permit…");

      const domain = await resolvePermitDomain(
        client,
        config,
        MULTICALL3,
      );

      const nonce = (await client.readContract({
        address: config.pathUsd,
        abi: [
          {
            type: "function",
            name: "nonces",
            stateMutability: "view",
            inputs: [
              {
                name: "owner",
                type: "address",
              },
            ],
            outputs: [
              {
                name: "",
                type: "uint256",
              },
            ],
          },
        ],
        functionName: "nonces",
        args: [account],
      })) as bigint;

      const permitDeadline =
        BigInt(Math.floor(Date.now() / 1000) + 3600);

      const signature = await signTypedDataAsync({
        domain,
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: {
          owner: account,
          spender: MULTICALL3,
          value: crewTotal,
          nonce,
          deadline: permitDeadline,
        },
      });

      const settlement = buildSettlement({
        client: account,
        crew,
        amounts: terms.split.amounts,
        memo,
        permitDeadline,
        signature,
      });

      setStage("Making sure the split will go through…");

      await client.call({
        to: settlement.to,
        data: settlement.data,
        account,
        gas: gasLimitFor(crew.length),
      });

      let gas = gasLimitFor(crew.length);

      try {
        gas = await estimateSettlementGas(
          client,
          settlement,
          account,
        );
      } catch {
        // Keep the measured fallback.
      }

      setStage("Sending the payment — one transaction…");

      const hash = await activeWalletClient.sendTransaction({
        to: settlement.to,
        data: settlement.data,
        gas,
        account,
        chain: undefined,
      });

      setStage("Waiting for Tempo to confirm…");

      const mined = await client.waitForTransactionReceipt({
        hash,
      });

      const entries = decodeSettlementLogs(mined.logs, {
        client: account,
        memo,
      });

      const check = reconcile(
        entries,
        crew,
        terms.split.amounts,
      );

      setReceipt({
        hash,
        lines: check.lines,
        ok: check.ok,
        gasUsed: mined.gasUsed,
      });

      setStage("");
    } catch (caught) {
      if (isUserRejection(caught)) {
        setError(
          "You cancelled in your wallet. Nothing was sent.",
        );
      } else if (
        errorMessage(caught).includes(SWITCH_HELP)
      ) {
        setError(SWITCH_HELP);
      } else {
        setError(explainError(caught));
      }

      setStage("");
    } finally {
      setBusy(null);
    }
  }, [
    account,
    client,
    config,
    connector,
    crew,
    crewTotal,
    memo,
    signTypedDataAsync,
    terms.split.amounts,
    walletClient,
  ]);

  return (
    <Shell back="/zero" footer={FOOTER_PAY_JOB}>
      <TempoGuard />

      <Card edge="none" className="bg-white/95">
        <Label>Payment</Label>

        <h1 className="pt-1 text-2xl font-bold text-ink">
          ${formatUsdFixed(terms.total)}
        </h1>

        <p className="pt-1 text-sm text-muted">
          {crew.length} crew{" "}
          {crew.length === 1 ? "wallet" : "wallets"} ·{" "}
          {config.label} · paid in {config.pathUsdSymbol}
        </p>
      </Card>

      <Card edge="crew">
        <Label>Crew allocations</Label>

        <p className="pt-1 text-xs text-muted">
          90% of the total is split by these percentages, in
          the same transaction that takes your{" "}
          {config.pathUsdSymbol}.
        </p>

        <div className="divide-y divide-line pt-2">
          {crew.map((member, index) => (
            <div
              key={`${member.address}-${index}`}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">
                  {member.address}
                </p>

                <p className="text-xs text-muted">
                  {(member.bps / 100).toFixed(2)}%
                </p>
              </div>

              <span className="tabular shrink-0 font-semibold text-crew">
                ${formatUsdFixed(terms.split.amounts[index])}
              </span>
            </div>
          ))}
        </div>

        <div className="pt-2">
          <Row label="To the crew, now">
            ${formatUsdFixed(terms.split.crewTotal)}
          </Row>

          <Row label="Stays with you">
            ${formatUsdFixed(terms.split.retained)}
          </Row>
        </div>
      </Card>

      <Note tone="warn">
        Paid in full, immediately. The crew receives its
        share inside the same transaction that takes your{" "}
        {config.pathUsdSymbol}, and the remaining $
        {formatUsdFixed(terms.split.retained)} never leaves
        your wallet. FlowPay holds nothing after this
        transaction confirms, so there is nothing left for
        anyone to release, accept or send back.
      </Note>

      {receipt ? (
        <Card edge={receipt.ok ? "mint" : "holdback"}>
          <Label>Receipt</Label>

          <p className="pt-1 text-sm text-ink">
            {receipt.ok
              ? "Every crew wallet received exactly the amount in the link."
              : "The transaction confirmed, but the amounts do not match the link. Do not treat this as paid."}
          </p>

          <div className="divide-y divide-line pt-2">
            {receipt.lines.map((line, index) => (
              <div
                key={`${line.address}-${index}`}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <p className="truncate text-sm text-ink">
                  {line.address}
                </p>

                <span
                  className={`tabular shrink-0 font-semibold ${
                    line.ok ? "text-mint" : "text-danger"
                  }`}
                >
                  ${formatUsdFixed(line.received)}
                </span>
              </div>
            ))}
          </div>

          <div className="pt-2">
            <Row label="Total that left the client">
              $
              {formatUsdFixed(
                receipt.lines.reduce(
                  (sum, line) => sum + line.received,
                  0n,
                ),
              )}
            </Row>

            <Row label="Gas used">
              {receipt.gasUsed.toString()}
            </Row>
          </div>

          <p className="pt-2 text-xs text-muted">
            Read from the chain&apos;s own logs, not from what
            was intended. pathUSD has six decimals, so the
            recorded amounts can be finer than the cents shown
            above; where a percentage does not divide evenly
            the remainder goes to the last crew member, which
            is why the parts always sum to the crew portion
            exactly.
          </p>

          <p className="pt-3 text-xs text-muted">
            <ExternalLink
              href={explorerTx(config, receipt.hash)}
            >
              {receipt.hash}
            </ExternalLink>
          </p>
        </Card>
      ) : (
        <Card edge="none">
          <Label>Pay</Label>

          <div className="pt-1">
            <Row label="Network">{config.label}</Row>
            <Row label="Token">{config.pathUsdSymbol}</Row>
            <Row label="You sign">
              One permit, off-chain — no gas
            </Row>
            <Row label="You send">
              One transaction to Multicall3
            </Row>
            <Row label="Crew paid">
              In that same transaction
            </Row>
          </div>

          <div className="pt-3">
            {!isConnected ? (
              <p className="text-sm text-muted">
                Use{" "}
                <span className="font-semibold text-ink">
                  Connect
                </span>{" "}
                at the top of this page to connect the wallet
                that will pay, then come back and pay in one
                tap.
              </p>
            ) : (
              <Button
                variant="pay"
                full
                disabled={Boolean(busy)}
                onClick={pay}
              >
                {busy === "pay"
                  ? "Paying…"
                  : `Pay $${formatUsdFixed(terms.total)}`}
              </Button>
            )}
          </div>

          {blocked && isConnected ? (
            <div className="pt-3">
              <Note tone="warn">{blocked}</Note>
            </div>
          ) : null}

          {stage ? (
            <div className="pt-3">
              <Spinner label={stage} />
            </div>
          ) : null}
        </Card>
      )}

      {error ? <Note tone="bad">{error}</Note> : null}

      <p className="px-1 text-xs text-white/85">
        The whole split is one call to Tempo&apos;s existing
        Multicall3 deployment. If any single transfer fails,
        the entire transaction is rolled back and nothing
        moves. No FlowPay contract is involved, and none was
        deployed.
      </p>
    </Shell>
  );
}