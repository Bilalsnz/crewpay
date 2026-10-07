"use client";

import { useCallback, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { getWalletClient } from "wagmi/actions";

import { useNetwork } from "@/components/network-provider";
import { TempoGuard } from "@/components/chain-guard";
import { Shell, useFollowLinkNetwork } from "@/components/shell";
import { Button, Card, ExternalLink, Label, Note, Row, Spinner } from "@/components/ui";
import { FOOTER_PAY_JOB } from "@/lib/brand";
import { NETWORKS, explorerTx, type NetworkKey } from "@/lib/networks";
import { wagmiConfig } from "@/lib/wagmi";
import { PERMIT_TYPES, resolvePermitDomain } from "@/lib/permit";
import { ensureChain, isUserRejection, providerForConnector, errorMessage, SWITCH_HELP } from "@/lib/wallet";
import { formatUsdFixed, parseUsd, splitCrew, canonicalTerms } from "@/lib/zerocon.mjs";
import {
  MULTICALL3, buildSettlement, decodeSettlementLogs, estimateSettlementGas, explainError,
  gasLimitFor, memoFor, reconcile,
} from "@/lib/multicall.mjs";

/**
 * The payment page — the one screen that spends anything.
 *
 * The client signs an EIP-2612 permit off-chain and then sends exactly one
 * transaction. That transaction goes to Multicall3, which runs the permit and
 * then one transferFromWithMemo per crew member, and reverts the entire thing
 * if any part of it fails. There is no approval step to leave behind, because
 * the permit is consumed inside the same call.
 */

interface Member {
  address: string;
  bps: number;
}

interface Receipt {
  hash: string;
  lines: { address: string; received: bigint; expected: bigint; ok: boolean }[];
  ok: boolean;
  gasUsed: bigint;
}

export function ZeroJob({ networkKey, query, amount, crew }: {
  networkKey: NetworkKey;
  query: string;
  amount: string;
  crew: Member[];
}) {
  useFollowLinkNetwork(networkKey);

  const config = NETWORKS[networkKey];
  const { address: account, connector, isConnected } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });

  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  // Same function the tests run against Moderato. The amounts on this page are
  // the amounts in the calldata, not a second implementation of them.
  const terms = useMemo(() => {
    const total = parseUsd(amount) ?? 0n;
    return { total, split: splitCrew(total, crew.map((m) => m.bps)) };
  }, [amount, crew]);

  const memo = useMemo(() => memoFor(canonicalTerms(query)), [query]);
  const crewTotal = terms.split.crewTotal;

  /**
   * The wallet is connected but would not give the page a signer for this
   * network. This is a real failure, not the network switch merely being a
   * moment behind React — that case is handled below by taking the signer from
   * the connector rather than from a hook, so it never reaches this message.
   */
  const signerHelp = `Your wallet is connected but did not provide a signer for ${config.label}. If it is showing a network prompt, approve it — otherwise reconnect from the button at the top of this page.`;

  const pay = useCallback(async () => {
    // Belt and braces: the button below says this too, and pressing it anyway
    // must never be a no-op. A silent return from a payment button is the worst
    // failure mode this app has: the client taps, nothing happens, and they
    // cannot tell whether they paid.
    if (!account) {
      setError("Connect your wallet first, then pay.");
      return;
    }
    if (!client) {
      setError(`FlowPay could not reach ${config.label}. Check your connection and reload the page.`);
      return;
    }
    setError(null);
    setBusy("pay");
    try {
      setStage("Checking your wallet is on Tempo…");
      const provider = await providerForConnector(connector);
      await ensureChain(provider, config);

      // The signer is taken here, from the connector, and not from
      // `useWalletClient`.
      //
      // That hook reads React state, and React state trails the wallet by a
      // render: immediately after a network switch is approved it can still
      // hold the pre-switch value, which is `undefined` — because the wallet
      // was not on this chain before. So a switch that worked perfectly looked
      // like a wallet that would not sign, and the page asked the client to
      // start over. `getWalletClient` asks the connector instead, and the
      // connector asks the provider for its chain id live, so this is correct
      // the moment `ensureChain` has returned rather than a render later.
      const wallet = await getWalletClient(wagmiConfig, { chainId: config.chainId }).catch(() => {
        throw new Error(signerHelp);
      });

      setStage("Waiting for your wallet to sign the permit…");
      // The domain is proved against pathUSD's own DOMAIN_SEPARATOR rather than
      // written down here, because a wrong name or version produces a signature
      // the token rejects — and it would be rejected on the client's phone.
      const domain = await resolvePermitDomain(client, config, MULTICALL3);
      const nonce = (await client.readContract({
        address: config.pathUsd,
        abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
        functionName: "nonces",
        args: [account],
      })) as bigint;
      const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const signature = await wallet.signTypedData({
        domain,
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: { owner: account, spender: MULTICALL3, value: crewTotal, nonce, deadline: permitDeadline },
        account,
      });

      // The permit authorises exactly the crew portion. The remaining 10% is
      // never approved and so can never be moved by this transaction.
      const settlement = buildSettlement({
        client: account, crew, amounts: terms.split.amounts, memo, permitDeadline, signature,
      });

      setStage("Making sure the split will go through…");
      // A real execution on the node. If the permit is malformed or a balance
      // is short, this reverts here rather than in the client's wallet.
      await client.call({ to: settlement.to, data: settlement.data, account, gas: gasLimitFor(crew.length) });

      let gas = gasLimitFor(crew.length);
      try {
        gas = await estimateSettlementGas(client, settlement, account);
      } catch {
        /* fall back to the measured formula */
      }

      setStage("Sending the payment — one transaction…");
      const hash = await wallet.sendTransaction({
        to: settlement.to, data: settlement.data, gas, account,
      });

      setStage("Waiting for Tempo to confirm…");
      const mined = await client.waitForTransactionReceipt({ hash });

      // Read the receipt, not the intent. Only the memo-bearing transfer logs
      // count: every transferFromWithMemo also emits a plain Transfer with the
      // same value, so adding both would report double what actually moved.
      const entries = decodeSettlementLogs(mined.logs, { client: account, memo });
      const check = reconcile(entries, crew, terms.split.amounts);
      setReceipt({ hash, lines: check.lines, ok: check.ok, gasUsed: mined.gasUsed });
      setStage("");
    } catch (caught) {
      if (isUserRejection(caught)) setError("You cancelled in your wallet. Nothing was sent.");
      else if (errorMessage(caught) === signerHelp) setError(signerHelp);
      else if (errorMessage(caught).includes(SWITCH_HELP)) setError(SWITCH_HELP);
      else setError(explainError(caught));
      setStage("");
    } finally {
      setBusy(null);
    }
  }, [account, client, config, connector, crew, crewTotal, memo, signerHelp, terms.split.amounts]);

  return (
    <Shell back="/zero" footer={FOOTER_PAY_JOB}>
      {/* Asks the wallet to move to Moderato the moment it connects, so the
          client normally never sees the switch happen. `pay` asks for it again
          itself, because a wallet can be connected on the wrong chain — the
          guard is a convenience, not the only thing standing between the
          client and a signed transaction. */}
      <TempoGuard />

      <Card edge="none" className="bg-white/95">
        <Label>Payment</Label>
        <h1 className="pt-1 text-2xl font-bold text-ink">${formatUsdFixed(terms.total)}</h1>
        <p className="pt-1 text-sm text-muted">
          {crew.length} crew {crew.length === 1 ? "wallet" : "wallets"} · {config.label} · paid in {config.pathUsdSymbol}
        </p>
      </Card>

      <Card edge="crew">
        <Label>Crew allocations</Label>
        <p className="pt-1 text-xs text-muted">
          90% of the total is split by these percentages, in the same transaction that takes your {config.pathUsdSymbol}.
        </p>
        <div className="divide-y divide-line pt-2">
          {crew.map((member, index) => (
            <div key={`${member.address}-${index}`} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{member.address}</p>
                <p className="text-xs text-muted">{(member.bps / 100).toFixed(2)}%</p>
              </div>
              <span className="tabular shrink-0 font-semibold text-crew">${formatUsdFixed(terms.split.amounts[index])}</span>
            </div>
          ))}
        </div>
        <div className="pt-2">
          <Row label="To the crew, now">${formatUsdFixed(terms.split.crewTotal)}</Row>
          <Row label="Stays with you">${formatUsdFixed(terms.split.retained)}</Row>
        </div>
      </Card>

      <Note tone="warn">
        Paid in full, immediately. The crew receives its share inside the same transaction that takes your{" "}
        {config.pathUsdSymbol}, and the remaining ${formatUsdFixed(terms.split.retained)} never leaves your wallet.
        FlowPay holds nothing after this transaction confirms, so there is nothing left for anyone to release, accept
        or send back.
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
              <div key={`${line.address}-${index}`} className="flex items-center justify-between gap-3 py-2.5">
                <p className="truncate text-sm text-ink">{line.address}</p>
                <span className={`tabular shrink-0 font-semibold ${line.ok ? "text-mint" : "text-danger"}`}>
                  ${formatUsdFixed(line.received)}
                </span>
              </div>
            ))}
          </div>
          <div className="pt-2">
            <Row label="Total that left the client">${formatUsdFixed(receipt.lines.reduce((sum, l) => sum + l.received, 0n))}</Row>
            <Row label="Gas used">{receipt.gasUsed.toString()}</Row>
          </div>
          <p className="pt-2 text-xs text-muted">
            Read from the chain&apos;s own logs, not from what was intended. pathUSD has six decimals, so the recorded
            amounts can be finer than the cents shown above; where a percentage does not divide evenly the remainder
            goes to the last crew member, which is why the parts always sum to the crew portion exactly.
          </p>
          <p className="pt-3 text-xs text-muted">
            <ExternalLink href={explorerTx(config, receipt.hash)}>{receipt.hash}</ExternalLink>
          </p>
        </Card>
      ) : (
        <Card edge="none">
          <Label>Pay</Label>
          <div className="pt-1">
            <Row label="Network">{config.label}</Row>
            <Row label="Token">{config.pathUsdSymbol}</Row>
            <Row label="You sign">One permit, off-chain — no gas</Row>
            <Row label="You send">One transaction to Multicall3</Row>
            <Row label="Crew paid">In that same transaction</Row>
          </div>
          <div className="pt-3">
            {!isConnected ? (
              <p className="text-sm text-muted">
                Use <span className="font-semibold text-ink">Connect</span> at the top of this page to connect the
                wallet that will pay, then come back and pay in one tap.
              </p>
            ) : (
              <Button variant="pay" full disabled={Boolean(busy)} onClick={pay}>
                {busy === "pay" ? "Paying…" : `Pay $${formatUsdFixed(terms.total)}`}
              </Button>
            )}
          </div>
          {stage ? <div className="pt-3"><Spinner label={stage} /></div> : null}
        </Card>
      )}

      {error ? <Note tone="bad">{error}</Note> : null}

      <p className="px-1 text-xs text-white/85">
        The whole split is one call to Tempo&apos;s existing Multicall3 deployment. If any single transfer fails, the
        entire transaction is rolled back and nothing moves. No FlowPay contract is involved, and none was deployed.
      </p>
    </Shell>
  );
}
