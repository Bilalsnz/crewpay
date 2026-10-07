"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { TempoGuard } from "@/components/chain-guard";
import { Shell } from "@/components/shell";
import { Button, Card, Label, Note, Row } from "@/components/ui";
import { FOOTER_PAY_CREATE } from "@/lib/brand";
import { NETWORKS, PAY_NETWORK } from "@/lib/networks";
import { MAX_CREW, PAY_PRESETS, encodeTerms, formatUsdFixed, parseUsd, payNowAmount, percentLabel, percentToBps, splitCrew } from "@/lib/zerocon.mjs";

/**
 * The Pay create screen. There is no contract to call and nothing to deploy, so
 * making a payment is just writing the terms down — and the link IS the record.
 * That is the whole trade of this design: nothing is stored anywhere, so
 * nothing can be edited behind anyone's back, and nothing can be enforced either.
 *
 * The network is a constant here, not a piece of state. It used to come from
 * `useNetwork()`, which meant a value in localStorage could decide which chain
 * a payment link pointed at. Pay settles on Tempo Moderato and nowhere else, so
 * the link says so and nothing can change it.
 */

interface Row {
  address: string;
  percent: string;
}

const EMPTY: Row = { address: "", percent: "" };

/** Either the terms are payable, or here is the reason they are not. */
type Draft =
  | { ok: false; error: string }
  | {
      ok: true;
      total: bigint;
      payBps: number;
      payNow: bigint;
      crew: { address: string; bps: number }[];
      split: { crewTotal: bigint; retained: bigint; amounts: bigint[] };
    };

export function ZeroCreate() {
  const router = useRouter();
  const network = PAY_NETWORK;
  const config = NETWORKS[network];

  const [amount, setAmount] = useState("2.00");
  const [payPercent, setPayPercent] = useState("100");
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY }, { ...EMPTY }]);

  // Read once, so the preset buttons and the preview agree on what was typed.
  const chosenPercent = useMemo(() => percentToBps(payPercent), [payPercent]);

  // Everything below is the same code the payment page and the tests run. The
  // preview cannot disagree with what gets signed, because it is one function.
  const draft = useMemo<Draft>(() => {
    const total = parseUsd(amount);
    if (total === null) return { ok: false, error: "Enter an amount greater than zero." };

    // How much of the invoice the client is asked for. Any percentage from 1 to
    // 100; a link with no percentage on it means the whole invoice.
    const chosen = percentToBps(payPercent);
    if (!chosen.ok) return { ok: false, error: chosen.error };
    const payNow = payNowAmount(total, chosen.bps);
    if (payNow <= 0n) {
      return { ok: false, error: `That share of $${formatUsdFixed(total)} is smaller than the smallest amount ${config.pathUsdSymbol} can move.` };
    }

    const filled = rows.filter((r) => r.address.trim() !== "" || r.percent.trim() !== "");
    if (filled.length === 0) return { ok: false, error: "Add at least one crew wallet." };

    const crew = [];
    let sum = 0;
    for (const row of filled) {
      const percent = Number(row.percent);
      if (!Number.isFinite(percent) || percent <= 0) return { ok: false, error: `"${row.percent || "blank"}" is not a percentage.` };
      if (!/^0x[0-9a-fA-F]{40}$/.test(row.address.trim())) return { ok: false, error: `"${row.address.trim() || "blank"}" is not a wallet address.` };
      const bps = Math.round(percent * 100);
      crew.push({ address: row.address.trim(), bps });
      sum += bps;
    }
    if (sum !== 10000) return { ok: false, error: `The percentages add up to ${(sum / 100).toFixed(2)}%, not 100%.` };

    // The crew split divides what the client pays now, not the invoice total.
    return { ok: true, total, payBps: chosen.bps, payNow, crew, split: splitCrew(payNow, crew.map((c) => c.bps)) };
  }, [amount, payPercent, rows, config.pathUsdSymbol]);

  const query = draft.ok ? encodeTerms({ total: draft.total, crew: draft.crew, payBps: draft.payBps }) : null;
  const href = query ? `/zero/${network}?${query}` : null;

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Shell footer={FOOTER_PAY_CREATE}>
      <TempoGuard />

      <Card edge="none" className="bg-white/95">
        <Label>Pay</Label>
        <h1 className="pt-1 text-lg font-bold text-ink">Split one payment between your crew</h1>
        <p className="pt-2 text-sm text-muted">
          Split one {config.pathUsdSymbol} payment between up to {MAX_CREW} crew wallets. Crew percentages are fixed in
          the payment link.
        </p>
        <p className="pt-2 text-sm text-muted">No FlowPay contract is deployed. Settlement uses Tempo&apos;s existing Multicall3.</p>
        <p className="pt-2 text-xs text-muted">
          Pay settles on {config.label}. Your wallet will be prompted to switch automatically if needed.
        </p>
      </Card>

      <Card edge="crew">
        <Label>Job</Label>
        <div className="pt-2">
          <label className="block text-sm text-muted" htmlFor="amount">
            Amount to pay
          </label>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-lg font-bold text-ink">$</span>
            <input
              id="amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-full rounded-xl border border-line px-3 py-2 text-lg font-semibold text-ink outline-none focus:border-crew"
            />
          </div>
        </div>
      </Card>

      {/* The only percentage on this page that is about time rather than
          people: it decides how much of the invoice the client is asked for,
          and the crew boxes below divide whatever that turns out to be. */}
      <Card edge="crew">
        <Label>Client pays now</Label>
        <p className="pt-1 text-xs text-muted">
          How much of the invoice the client is asked to pay when they open the link. The crew split below divides this
          amount, not the invoice total.
        </p>

        <div className="flex flex-wrap gap-2 pt-3">
          {PAY_PRESETS.map((preset) => {
            const active = chosenPercent.ok && chosenPercent.bps === preset * 100;
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
          <label className="text-sm text-muted" htmlFor="create-pay-percent">
            Custom
          </label>
          <input
            id="create-pay-percent"
            inputMode="decimal"
            value={payPercent}
            onChange={(event) => setPayPercent(event.target.value)}
            className="w-24 rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink outline-none focus:border-crew"
          />
          <span className="text-sm text-muted">% of the invoice</span>
        </div>

        {draft.ok ? (
          <div className="pt-3">
            <Row label="Invoice total">${formatUsdFixed(draft.total)}</Row>
            <Row label="Client pays now">{percentLabel(draft.payBps)}</Row>
            <Row label="Amount">${formatUsdFixed(draft.payNow)}</Row>
            <Row label="Not paid now">${formatUsdFixed(draft.total - draft.payNow)}</Row>
          </div>
        ) : null}
      </Card>

      <Card edge="crew">
        <Label>Crew</Label>
        <p className="pt-1 text-xs text-muted">Percentages split what the client pays now.</p>
        <div className="flex flex-col gap-3 pt-3">
          {rows.map((row, index) => (
            <div key={index} className="flex flex-col gap-2">
              <input
                aria-label={`Crew ${index + 1} wallet address`}
                placeholder="0x… crew wallet"
                value={row.address}
                onChange={(event) => setRow(index, { address: event.target.value })}
                className="w-full rounded-xl border border-line px-3 py-2 text-sm text-ink outline-none focus:border-crew"
              />
              <div className="flex items-center gap-2">
                <input
                  aria-label={`Crew ${index + 1} percentage`}
                  inputMode="decimal"
                  placeholder="%"
                  value={row.percent}
                  onChange={(event) => setRow(index, { percent: event.target.value })}
                  className="w-24 rounded-xl border border-line px-3 py-2 text-sm text-ink outline-none focus:border-crew"
                />
                <span className="text-sm text-muted">% of the amount</span>
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    className="ml-auto text-xs font-semibold text-danger"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {rows.length < MAX_CREW ? (
          <div className="pt-3">
            <Button variant="ghost" onClick={() => setRows((current) => [...current, { ...EMPTY }])}>
              Add a crew member
            </Button>
          </div>
        ) : (
          <p className="pt-3 text-xs text-muted">{MAX_CREW} crew is the most one transaction will take here.</p>
        )}
      </Card>

      {draft.ok ? (
        <Card edge="crew">
          <Label>What each wallet receives</Label>
          <div className="divide-y divide-line pt-1">
            {draft.crew.map((member, index) => (
              <div key={member.address} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{member.address}</p>
                  <p className="text-xs text-muted">{(member.bps / 100).toFixed(2)}%</p>
                </div>
                <span className="tabular shrink-0 font-semibold text-crew">${formatUsdFixed(draft.split.amounts[index])}</span>
              </div>
            ))}
          </div>
          <div className="pt-2">
            <Row label="To the crew, now">${formatUsdFixed(draft.split.crewTotal)}</Row>
            <Row label="Held back">$0.00</Row>
          </div>
          <p className="pt-2 text-xs text-muted">
            This is the crew&apos;s share of the ${formatUsdFixed(draft.payNow)} the client pays now. Nothing is held
            back and nothing is kept — every wallet receives exactly its percentage of what is paid. The rest of the
            invoice is simply not part of this payment.
          </p>
        </Card>
      ) : (
        <Note tone="warn">{draft.error}</Note>
      )}

      {href ? (
        <Card edge="mint">
          <Label>The payment link</Label>
          <p className="pt-2 break-all text-xs text-muted">{href}</p>
          <div className="flex flex-col gap-2 pt-3">
            <Button variant="pay" full onClick={() => router.push(href)}>
              Open the payment page
            </Button>
            <Button
              variant="ghost"
              full
              onClick={() => {
                void navigator.clipboard?.writeText(new URL(href, window.location.origin).toString());
              }}
            >
              Copy the link
            </Button>
          </div>
          <p className="pt-3 text-xs text-muted">
            Whoever holds this link pays with their own wallet — the client is whoever signs, not whoever created the
            link. Send it to the client.
          </p>
        </Card>
      ) : null}
    </Shell>
  );
}
