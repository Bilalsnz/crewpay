"use client";

import { useCallback, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { getWalletClient } from "wagmi/actions";

import { TempoGuard } from "@/components/chain-guard";
import { Shell, useFollowLinkNetwork } from "@/components/shell";
import { Button, Card, ExternalLink, Label, Note, Row, Spinner } from "@/components/ui";
import { FOOTER_PAY_JOB } from "@/lib/brand";
import { NETWORKS, explorerTx, type NetworkKey } from "@/lib/networks";
import { wagmiConfig } from "@/lib/wagmi";
import { PERMIT_TYPES, resolvePermitDomain } from "@/lib/permit";
import { ensureChain, isUserRejection, providerForConnector, errorMessage, SWITCH_HELP } from "@/lib/wallet";
import { PAY_PRESETS, formatUsdFixed, parseUsd, payNowAmount, percentLabel, percentToBps, splitCrew, canonicalTerms } from "@/lib/zerocon.mjs";
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

  // The job total comes off the link and does not change: it is what the job is
  // worth, not what is being paid right now.
  const jobTotal = useMemo(() => parseUsd(amount) ?? 0n, [amount]);

  // How much of the job is paid now. 100% by default, so a link opened and paid
  // without touching this control behaves exactly as it did before the control
  // existed — same permit value, same calldata, same one transaction.
  const [payPercent, setPayPercent] = useState("100");
  const chosen = useMemo(() => percentToBps(payPercent), [payPercent]);

  const payNow = useMemo(
    () => (chosen.ok ? payNowAmount(jobTotal, chosen.bps) : 0n),
    [chosen, jobTotal],
  );

  /**
   * A percentage that rounds down to nothing once it is in token units.
   * pathUSD's smallest unit is $0.000001, so 1% of a job under a cent is zero —
   * and a zero-value permit is a signature the chain accepts that moves nothing.
   * Refusing here is the only honest option; the alternative is a "payment" that
   * silently did not happen.
   */
  const amountError = useMemo(() => {
    if (!chosen.ok) return chosen.error;
    if (payNow <= 0n) {
      return `1% of $${formatUsdFixed(jobTotal)} is smaller than the smallest amount ${config.pathUsdSymbol} can move. Pay a larger share of the job.`;
    }
    return null;
  }, [chosen, payNow, jobTotal, config.pathUsdSymbol]);

  // Same function the tests run against Moderato, applied to the amount being
  // paid now instead of the job total. The crew percentages, the 90/10 split and
  // the remainder-to-the-last-member rule are untouched — only the number going
  // in has changed, so 100% still produces the exact numbers it always did.
  const split = useMemo(() => splitCrew(payNow, crew.map((m) => m.bps)), [payNow, crew]);

  const memo = useMemo(() => memoFor(canonicalTerms(query)), [query]);
  const crewTotal = split.crewTotal;
  const remaining = jobTotal - payNow;

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
    // The button is disabled on this too. A chosen percentage that cannot be
    // paid must never reach the wallet as a prompt: the client would be asked to
    // sign an amount the page already knows is wrong.
    if (amountError) {
      setError(amountError);
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

      // The permit authorises exactly the sum of the transfers that follow it.
      // Nothing beyond that is approved, so this transaction can never move more
      // than the amount the client chose to pay.
      const settlement = buildSettlement({
        client: account, crew, amounts: split.amounts, memo, permitDeadline, signature,
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
      const check = reconcile(entries, crew, split.amounts);
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
  }, [account, amountError, client, config, connector, crew, crewTotal, memo, signerHelp, split.amounts]);

  return (
    <Shell back="/zero" footer={FOOTER_PAY_JOB}>
      {/* Asks the wallet to move to Moderato the moment it connects, so the
          client normally never sees the switch happen. `pay` asks for it again
          itself, because a wallet can be connected on the wrong chain — the
          guard is a convenience, not the only thing standing between the
          client and a signed transaction. */}
      <TempoGuard />

      <Card edge="none" className="bg-white/95">
        <Label>Job</Label>
        <h1 className="pt-1 text-2xl font-bold text-ink">${formatUsdFixed(jobTotal)}</h1>
        <p className="pt-1 text-sm text-muted">
          {crew.length} crew {crew.length === 1 ? "wallet" : "wallets"} · {config.label} · paid in {config.pathUsdSymbol}
        </p>
      </Card>

      {/* The job total above is what the job is worth; this is what is actually
          being paid now. It sits directly above the crew card because that card
          is a split of this number, not of the job total. */}
      <Card edge="crew">
        <Label>Payment amount</Label>
        <p className="pt-1 text-xs text-muted">
          How much of the job to pay now. The crew split below applies to this amount, not to the job total.
        </p>

        <div className="flex flex-wrap gap-2 pt-3">
          {PAY_PRESETS.map((preset) => {
            const active = chosen.ok && chosen.bps === preset * 100;
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={active}
                onClick={() => setPayPercent(String(preset))}
                className={`min-h-[40px] rounded-full px-4 text-sm font-bold transition ${
                  active ? "bg-crew text-white" : "bg-crew-soft text-crew"
                }`}
              >
                {preset}%
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 pt-3">
          <label className="text-sm text-muted" htmlFor="pay-percent">
            Custom
          </label>
          <input
            id="pay-percent"
            inputMode="decimal"
            value={payPercent}
            onChange={(event) => setPayPercent(event.target.value)}
            className="w-24 rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink outline-none focus:border-crew"
          />
          <span className="text-sm text-muted">% of the job</span>
        </div>

        <div className="pt-3">
          <Row label="Job total">${formatUsdFixed(jobTotal)}</Row>
          <Row label="Pay now">{chosen.ok ? percentLabel(chosen.bps) : "—"}</Row>
          <Row label="You pay">${formatUsdFixed(payNow)}</Row>
          <Row label="Remaining on this job">${formatUsdFixed(remaining)}</Row>
        </div>

        {amountError ? (
          <div className="pt-2">
            <Note tone="warn">{amountError}</Note>
          </div>
        ) : null}
      </Card>

      <Card edge="crew">
        <Label>Crew allocations</Label>
        <p className="pt-1 text-xs text-muted">
          The whole of what you pay now is split by these percentages, in the same transaction that takes your{" "}
          {config.pathUsdSymbol}.
        </p>
        <div className="divide-y divide-line pt-2">
          {crew.map((member, index) => (
            <div key={`${member.address}-${index}`} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{member.address}</p>
                <p className="text-xs text-muted">{(member.bps / 100).toFixed(2)}%</p>
              </div>
              <span className="tabular shrink-0 font-semibold text-crew">${formatUsdFixed(split.amounts[index])}</span>
            </div>
          ))}
        </div>
        <div className="pt-2">
          <Row label="To the crew, now">${formatUsdFixed(split.crewTotal)}</Row>
          <Row label="Held back">$0.00</Row>
        </div>
      </Card>

      <Note tone="warn">
        Paid immediately. The whole amount you pay goes to the crew inside the same transaction that takes your{" "}
        {config.pathUsdSymbol} — nothing is held back and FlowPay keeps no part of it.
        {remaining > 0n
          ? ` The other $${formatUsdFixed(remaining)} of this job is not part of this transaction. This link still says $${formatUsdFixed(jobTotal)}, so it can be paid again for the rest — nothing records how much has already been paid against it, so keep count if you pay in more than one go.`
          : ""}{" "}
        FlowPay holds nothing after this transaction confirms, so there is nothing left for anyone to release, accept
        or send back.
      </Note>

      {receipt ? (
        <Card edge={receipt.ok ? "mint" : "holdback"}>
          <Label>Receipt</Label>
          <p className="pt-1 text-sm text-ink">
            {receipt.ok
              ? "Every crew wallet received exactly its share of the amount you paid."
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
              <Button variant="pay" full disabled={Boolean(busy) || Boolean(amountError)} onClick={pay}>
                {busy === "pay" ? "Paying…" : `Pay $${formatUsdFixed(payNow)}`}
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
