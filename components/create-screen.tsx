"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { decodeEventLog, getAddress, isAddress, zeroAddress } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";

import { contractAddress, contractDeployBlock, CREWPAY_ABI, explain, HOLDBACK_BPS, MAX_CREW } from "@/lib/contract";
import { formatUsd, formatUsdFixed, formatPercent, parseUsd, toDateTimeLocal, formatDeadline } from "@/lib/format";
import { previewSplit } from "@/lib/job";
import { explorerTx, NETWORKS } from "@/lib/networks";
import { ensureChain, errorMessage, isUserRejection, providerForConnector, SWITCH_HELP } from "@/lib/wallet";
import { Button, Card, ExternalLink, Label, Money, Note, Row, Spinner } from "./ui";
import { useNetwork } from "./network-provider";
import { Shell } from "./shell";
import { saveLink } from "./home-screen";

const MAX_HORIZON_YEARS = 10;

interface CrewRow {
  address: string;
  percent: string;
}

const DEFAULT_ROWS: CrewRow[] = [
  { address: "", percent: "50" },
  { address: "", percent: "50" },
];

function defaultDeadline(): string {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return toDateTimeLocal(date);
}

export function CreateScreen() {
  const { network, config } = useNetwork();
  const address = contractAddress(network);
  const { address: account, connector, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: config.chainId });
  const { switchChainAsync } = useSwitchChain();
  const client = usePublicClient({ chainId: config.chainId });
  const queryClient = useQueryClient();

  const [amount, setAmount] = useState("2");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [rows, setRows] = useState<CrewRow[]>(DEFAULT_ROWS);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; hash: string } | null>(null);

  useEffect(() => setDeadline(defaultDeadline()), []);

  const total = useMemo(() => parseUsd(amount, config.pathUsdDecimals), [amount, config.pathUsdDecimals]);

  const percentTotal = useMemo(
    () => rows.reduce((sum, row) => sum + (Number.isFinite(Number(row.percent)) ? Number(row.percent) : 0), 0),
    [rows],
  );

  const deadlineSeconds = useMemo(() => {
    const ms = new Date(deadline).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }, [deadline]);

  const preview = useMemo(() => {
    if (!total) return null;
    const shares = rows.map((row) => Math.round(Number(row.percent) * 100));
    if (shares.some((s) => !Number.isFinite(s) || s <= 0)) return null;
    if (shares.reduce((a, b) => a + b, 0) !== 10000) return null;
    return previewSplit(total, shares);
  }, [rows, total]);

  /* Client-side checks mirror the contract's, so the client sees the problem
     before paying for a transaction that would revert. The contract still
     enforces every one of them. */
  const problems = useMemo(() => {
    const list: string[] = [];
    if (!isConnected || !account) list.push("Connect the wallet that will pay this job.");
    if (!total) list.push("Enter an amount above zero.");
    if (rows.length === 0) list.push("Add at least one crew wallet.");
    if (rows.length > MAX_CREW) list.push(`At most ${MAX_CREW} crew wallets.`);
    for (const [index, row] of rows.entries()) {
      const trimmed = row.address.trim();
      if (!trimmed) list.push(`Crew ${index + 1}: enter a wallet address.`);
      else if (!isAddress(trimmed)) list.push(`Crew ${index + 1}: that is not a wallet address.`);
      else if (getAddress(trimmed) === zeroAddress) list.push(`Crew ${index + 1}: the zero address cannot be paid.`);
      const percent = Number(row.percent);
      if (!Number.isFinite(percent) || percent <= 0) list.push(`Crew ${index + 1}: enter a percentage above zero.`);
    }
    if (Math.round(percentTotal * 100) !== 10000) {
      list.push(`The percentages add up to ${percentTotal}%, and they have to be exactly 100%.`);
    }
    if (deadlineSeconds === null) list.push("Pick a deadline.");
    else if (deadlineSeconds <= Math.floor(Date.now() / 1000)) list.push("Pick a deadline in the future.");
    else if (deadlineSeconds > Math.floor(Date.now() / 1000) + MAX_HORIZON_YEARS * 365 * 24 * 3600) {
      list.push(`Pick a deadline within ${MAX_HORIZON_YEARS} years.`);
    }
    return list;
  }, [account, deadlineSeconds, isConnected, percentTotal, rows, total]);

  const addRow = () => {
    if (rows.length >= MAX_CREW) return;
    setRows((prev) => [...prev, { address: "", percent: "0" }]);
  };

  const removeRow = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));

  const update = (index: number, patch: Partial<CrewRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const create = useCallback(async () => {
    if (!address || !walletClient || !client || !account || !total || problems.length > 0) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const provider = await providerForConnector(connector);
      await ensureChain(provider, config);
      try {
        await switchChainAsync({ chainId: config.chainId });
      } catch {
        /* ensureChain already proved the wallet is on this chain */
      }

      setStage("Waiting for your wallet to confirm…");
      const crew = rows.map((row) => getAddress(row.address.trim()));
      const shares = rows.map((row) => Math.round(Number(row.percent) * 100));

      const hash = await walletClient.writeContract({
        address,
        abi: CREWPAY_ABI,
        functionName: "createJob",
        args: [crew, shares, total, BigInt(deadlineSeconds!)],
        account,
        chain: undefined,
      });

      setStage("Confirming on Tempo…");
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("The transaction was mined but reverted.");

      // The job number comes out of the event the contract emitted, not from a
      // counter kept in the browser — so the link cannot be off by one.
      let jobId: string | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: CREWPAY_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "JobCreated") {
            jobId = (decoded.args as { jobId: bigint }).jobId.toString();
            break;
          }
        } catch {
          /* not one of ours */
        }
      }
      if (jobId === null) throw new Error("The job was created but its number could not be read from the receipt.");

      saveLink({ network, id: jobId, note: note.trim(), at: Date.now() });
      void queryClient.invalidateQueries();
      setCreated({ id: jobId, hash });
    } catch (caught) {
      if (isUserRejection(caught)) setError("You cancelled in your wallet. Nothing was created.");
      else if (errorMessage(caught).includes(SWITCH_HELP)) setError(SWITCH_HELP);
      else setError(explain(caught));
    } finally {
      setStage(null);
      setBusy(false);
    }
  }, [account, address, client, config, connector, deadlineSeconds, network, note, problems.length, queryClient, rows, switchChainAsync, total, walletClient]);

  if (created) {
    const link = typeof window === "undefined" ? "" : `${window.location.origin}/job/${network}/${created.id}`;
    return (
      <Shell back="/">
        <Card edge="crew">
          <Label>Job created</Label>
          <p className="pt-1 text-2xl font-black tracking-tight">Job #{created.id}</p>
          <p className="pt-1 text-xs text-muted">
            Confirmed on {config.label} ·{" "}
            <ExternalLink href={explorerTx(config, created.hash)}>view the transaction</ExternalLink>
          </p>
          <p className="pt-3 text-sm text-muted">
            The crew, the percentages and the deadline are now fixed on-chain. Send this link to whoever needs it —
            it is the whole record.
          </p>
        </Card>

        <Card edge="holdback">
          <Label>Payment link</Label>
          <p className="break-all pt-2 text-sm font-semibold text-crew">{link}</p>
          <div className="flex flex-wrap gap-2 pt-3">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(link);
              }}
            >
              Copy link
            </Button>
            <a
              href={`/job/${network}/${created.id}/pay`}
              className="pay-button inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold"
            >
              Pay it now
            </a>
          </div>
        </Card>

        <Card>
          <Label>What happens next</Label>
          <ol className="list-decimal space-y-1 pl-5 pt-1 text-sm text-muted">
            <li>The payment sends 90% to the crew in one transaction.</li>
            <li>10% stays in the contract.</li>
            <li>Accept the work and that 10% follows the same percentages.</li>
            <li>Or let the deadline pass and it goes back to you.</li>
          </ol>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell back="/">
      <Card edge="crew">
        <Label>New job</Label>
        <p className="pt-1 text-sm text-muted">
          Set the terms once. They are written to the contract and cannot be changed afterwards — not by you, not by
          the crew.
        </p>
      </Card>

      <Card>
        <Label>Total amount</Label>
        <div className="flex items-center gap-2 pt-2">
          <span className="text-2xl font-black text-muted">$</span>
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            className="tabular w-full min-w-0 rounded-xl border border-line px-3 py-3 text-2xl font-black text-ink"
            placeholder="2"
          />
          <span className="text-sm font-semibold text-muted">{config.pathUsdSymbol}</span>
        </div>
        <p className="pt-2 text-xs text-muted">
          Paid in {config.pathUsdSymbol} on {config.label}. Gas is paid in the same token, so this is the only balance
          the wallet needs.
        </p>
      </Card>

      <Card edge="holdback">
        <Label>Deadline</Label>
        <input
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
          className="mt-2 w-full rounded-xl border border-line px-3 py-3 text-sm text-ink"
        />
        <p className="pt-2 text-xs text-muted">
          {deadlineSeconds
            ? `Acceptance closes ${formatDeadline(BigInt(deadlineSeconds))}. After that the holdback can only go back to you.`
            : "Pick a date and time."}
        </p>
      </Card>

      <Card edge="crew">
        <div className="flex items-center justify-between">
          <Label>Crew</Label>
          <span className="text-xs font-semibold text-muted">
            {rows.length}/{MAX_CREW}
          </span>
        </div>

        <div className="flex flex-col gap-3 pt-3">
          {rows.map((row, index) => (
            <div key={index} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between pb-2">
                <span className="text-xs font-bold uppercase tracking-wide text-crew">Crew {index + 1}</span>
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    className="text-xs font-semibold text-danger underline underline-offset-2"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <input
                value={row.address}
                onChange={(event) => update(index, { address: event.target.value })}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                className="w-full rounded-lg border border-line px-3 py-2.5 font-mono text-xs text-ink"
              />
              <div className="flex items-center gap-2 pt-2">
                <input
                  value={row.percent}
                  onChange={(event) => update(index, { percent: event.target.value })}
                  inputMode="decimal"
                  autoComplete="off"
                  className="tabular w-24 rounded-lg border border-line px-3 py-2.5 text-sm font-semibold text-ink"
                />
                <span className="text-sm font-semibold text-muted">% of the crew share</span>
              </div>
              {preview ? (
                <p className="pt-2 text-xs text-muted">
                  gets <Money value={formatUsd(preview.crew[index] ?? 0n)} tone="crew" /> on payment
                </p>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-3">
          {rows.length < MAX_CREW ? (
            <Button variant="ghost" onClick={addRow}>
              Add crew wallet
            </Button>
          ) : (
            <span className="text-xs text-muted">Four is the maximum.</span>
          )}
          <span className={`tabular text-sm font-bold ${Math.round(percentTotal * 100) === 10000 ? "text-mint" : "text-holdback"}`}>
            {percentTotal}% / 100%
          </span>
        </div>
      </Card>

      <Card>
        <Label>Note (optional)</Label>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Kitchen fit-out, week 12"
          className="mt-2 w-full rounded-xl border border-line px-3 py-3 text-sm text-ink"
        />
        <p className="pt-2 text-xs text-muted">
          Kept in this browser alongside the link. The note is not written to the chain — the contract holds the money
          terms, and those are what settle.
        </p>
      </Card>

      {preview && total ? (
        <Card edge="holdback">
          <Label>The split</Label>
          <div className="pt-1">
            <Row label="Total">
              <Money value={formatUsdFixed(total)} />
            </Row>
            <Row label={`To the crew now (${100 - HOLDBACK_BPS / 100}%)`}>
              <Money value={formatUsdFixed(preview.crew.reduce((a, b) => a + b, 0n))} tone="crew" />
            </Row>
            <Row label={`Held back (${HOLDBACK_BPS / 100}%)`}>
              <Money value={formatUsdFixed(preview.holdback)} tone="holdback" />
            </Row>
            <Row label="Crew share">{formatPercent(10000 - HOLDBACK_BPS)}</Row>
          </div>
        </Card>
      ) : null}

      {error ? <Note tone="bad">{error}</Note> : null}
      {problems.length > 0 ? (
        <Card>
          <Label>Before this can go on-chain</Label>
          <ul className="list-disc space-y-1 pl-5 pt-1 text-sm text-holdback">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      {stage ? (
        <Card>
          <Spinner label={stage} />
        </Card>
      ) : null}

      <Button variant="pay" full disabled={busy || problems.length > 0} onClick={create}>
        {busy ? "Creating…" : total ? `Create job · $${formatUsdFixed(total)}` : "Create job"}
      </Button>

      <p className="text-center text-xs text-white/80">
        Creating this job is one transaction. Paying it is another.
      </p>
    </Shell>
  );
}
