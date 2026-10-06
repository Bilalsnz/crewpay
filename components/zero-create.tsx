"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { useNetwork } from "@/components/network-provider";
import { Shell } from "@/components/shell";
import { Button, Card, Label, Note, Row } from "@/components/ui";
import { NETWORKS } from "@/lib/networks";
import { HOLDBACK_BPS, MAX_CREW, encodeTerms, formatUsdFixed, parseUsd, splitCrew } from "@/lib/zerocon.mjs";

/**
 * The create screen. There is no contract to call and nothing to deploy, so
 * "creating a job" is just writing the terms down — and the link IS the record.
 * That is the whole trade of this version: nothing is stored anywhere, so
 * nothing can be edited behind anyone's back, and nothing can be enforced either.
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
      crew: { address: string; bps: number }[];
      split: { crewTotal: bigint; retained: bigint; amounts: bigint[] };
    };

export function ZeroCreate() {
  const router = useRouter();
  const { network } = useNetwork();
  const config = NETWORKS[network];

  const [amount, setAmount] = useState("2.00");
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY }, { ...EMPTY }]);

  // Everything below is the same code the payment page and the tests run. The
  // preview cannot disagree with what gets signed, because it is one function.
  const draft = useMemo<Draft>(() => {
    const total = parseUsd(amount);
    if (total === null) return { ok: false, error: "Enter an amount greater than zero." };

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

    return { ok: true, total, crew, split: splitCrew(total, crew.map((c) => c.bps)) };
  }, [amount, rows]);

  const query = draft.ok ? encodeTerms({ total: draft.total, crew: draft.crew }) : null;
  const href = query ? `/zero/${network}?${query}` : null;

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Shell footer="CrewPay Zero · settled by Multicall3 on Tempo · no CrewPay contract">
      <Card edge="none" className="bg-white/95">
        <Label>Zero-contract version</Label>
        <h1 className="pt-1 text-lg font-bold text-ink">Split a payment in one transaction</h1>
        <p className="pt-2 text-sm text-muted">
          One payment in {config.pathUsdSymbol}, split across up to {MAX_CREW} crew wallets at percentages fixed in
          the link. No contract is deployed — the whole split is one transaction to the Multicall3 deployment Tempo
          already has.
        </p>
      </Card>

      <Card edge="crew">
        <Label>Job</Label>
        <div className="pt-2">
          <label className="block text-sm text-muted" htmlFor="amount">
            Amount the client pays
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

      <Card edge="crew">
        <Label>Crew</Label>
        <p className="pt-1 text-xs text-muted">
          Percentages split 90% of the amount. They are written into the link, so a crew member can read the link and
          check their own cut without trusting this page.
        </p>
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
                <span className="text-sm text-muted">% of the crew portion</span>
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
            <Row label="To the crew, in the payment transaction">${formatUsdFixed(draft.split.crewTotal)}</Row>
            <Row label="Stays with the client">${formatUsdFixed(draft.split.retained)}</Row>
          </div>
          <p className="pt-2 text-xs text-muted">
            The client keeps the remaining {Number(HOLDBACK_BPS) / 100}% and sends only the crew portion. Nothing
            holds it — there is no contract in this version to hold it.
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
