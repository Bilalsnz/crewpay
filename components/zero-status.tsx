"use client";

import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http } from "viem";

import { Shell } from "@/components/shell";
import { Button, Card, ExternalLink, Label, Note, Row, Spinner } from "@/components/ui";
import { NETWORKS, explorerTx, type NetworkKey } from "@/lib/networks";
import { decodeMemoTransfers } from "@/lib/multicall.mjs";
import { formatUsdFixed } from "@/lib/zerocon.mjs";

/**
 * The status page, which is really a receipt reader.
 *
 * The contract version could show a job's status because the job was on chain.
 * This version writes nothing down, so there is no job state to report and a
 * page that pretended otherwise would be inventing it. What is real is the
 * transaction: it can be read straight from the chain, by anyone, with no help
 * from this app. So that is what this page does.
 *
 * It reports what moved. It cannot report what was agreed — the memo is a hash,
 * so it ties a receipt to a link without containing one. Saying that plainly is
 * the point of the note at the bottom.
 */

type Line = { to: string; value: bigint };
type Group = { memo: string; from: string; total: bigint; lines: Line[] };

type Outcome =
  | { ok: false; error: string }
  | { ok: true; hash: `0x${string}`; blockNumber: bigint; reverted: boolean; groups: Group[] };

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function explainRead(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/not be found|not found/i.test(text)) {
    return "No transaction with that hash is on this network. Check the hash, and check the network it was sent on — a testnet transaction does not exist on mainnet.";
  }
  return text;
}

export function ZeroStatus({ initialTx, initialNetwork }: { initialTx: string; initialNetwork: NetworkKey }) {
  const [network, setNetwork] = useState<NetworkKey>(initialNetwork);
  const [input, setInput] = useState(initialTx);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const config = NETWORKS[network];

  const look = useCallback(async (rawHash: string, net: NetworkKey) => {
    const hash = rawHash.trim();
    if (!HASH_RE.test(hash)) {
      setOutcome({ ok: false, error: "A transaction hash is 0x followed by 64 hex characters." });
      return;
    }

    setBusy(true);
    setOutcome(null);
    try {
      const client = createPublicClient({ transport: http(NETWORKS[net].rpcUrl) });
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      const entries = decodeMemoTransfers(receipt.logs);

      // One group per memo. A settlement carries exactly one, but reading the
      // receipt rather than assuming keeps this honest for a transaction that
      // happens to contain more than one.
      const byMemo = new Map<string, { memo: string; from: string; total: bigint; lines: Map<string, bigint> }>();
      for (const entry of entries) {
        const group =
          byMemo.get(entry.memo) ?? { memo: entry.memo, from: entry.from, total: 0n, lines: new Map<string, bigint>() };
        group.total += entry.value;
        group.lines.set(entry.to, (group.lines.get(entry.to) ?? 0n) + entry.value);
        byMemo.set(entry.memo, group);
      }

      setOutcome({
        ok: true,
        hash: hash as `0x${string}`,
        blockNumber: receipt.blockNumber,
        reverted: receipt.status === "reverted",
        groups: [...byMemo.values()].map((group) => ({
          memo: group.memo,
          from: group.from,
          total: group.total,
          lines: [...group.lines.entries()].map(([to, value]) => ({ to, value })),
        })),
      });
    } catch (error) {
      setOutcome({ ok: false, error: explainRead(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  // A link into this page can carry the hash, which is what a client would send
  // on: "here is the transaction". Read it without making them paste it again.
  useEffect(() => {
    if (initialTx) void look(initialTx, initialNetwork);
  }, [initialTx, initialNetwork, look]);

  return (
    <Shell back="/zero" footer="CrewPay Zero · settled by Multicall3 on Tempo · no CrewPay contract">
      <Card edge="holdback">
        <Label>This version keeps no record</Label>
        <p className="pt-2 text-sm text-ink">
          There is no job status here, because there is no job anywhere to have one. Nothing is stored — not on chain,
          not on a server. The transaction is the only record this design produces, so that is what this page reads.
        </p>
      </Card>

      <Card edge="crew">
        <Label>Read a settlement off the chain</Label>
        <p className="pt-1 text-xs text-muted">
          Paste the transaction hash the client was given when they paid. This reads it from {config.label} and shows
          what it actually moved.
        </p>

        <div className="flex flex-col gap-2 pt-3">
          <input
            aria-label="Transaction hash"
            placeholder="0x… transaction hash"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="w-full rounded-xl border border-line px-3 py-2 text-sm text-ink outline-none focus:border-crew"
          />

          <div className="flex items-center gap-2">
            {(["testnet", "mainnet"] as NetworkKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setNetwork(key)}
                className={`rounded-xl px-3 py-2 text-xs font-semibold ${
                  key === network ? "bg-ink text-white" : "border border-line bg-white text-muted"
                }`}
              >
                {NETWORKS[key].shortLabel}
              </button>
            ))}
            <span className="text-xs text-muted">a hash only exists on the network it was sent to</span>
          </div>

          <Button variant="plain" full disabled={busy} onClick={() => void look(input, network)}>
            {busy ? "Reading the chain…" : "Read the transaction"}
          </Button>
        </div>
      </Card>

      {busy ? <Spinner label="Reading the receipt" /> : null}
      {outcome && !outcome.ok ? <Note tone="bad">{outcome.error}</Note> : null}

      {outcome?.ok && outcome.groups.length === 0 ? (
        <Card edge="holdback">
          <Label>No memo transfers in this transaction</Label>
          <p className="pt-2 text-sm text-ink">
            {outcome.reverted
              ? "This transaction reverted, so nothing moved."
              : "This transaction went through, but it carries no memo-bearing pathUSD transfer — so it is not a CrewPay Zero settlement."}
          </p>
          <p className="pt-2 text-xs text-muted">
            Only <code>transferFromWithMemo</code> logs are counted. A plain transfer carries no memo, and Tempo&apos;s
            gas fee is a pathUSD transfer with no memo either, so both are excluded by construction rather than by a
            filter that might miss one.
          </p>
          <div className="pt-2">
            <Row label="Block">{outcome.blockNumber.toString()}</Row>
          </div>
        </Card>
      ) : null}

      {outcome?.ok
        ? outcome.groups.map((group, index) => (
            <Card key={group.memo} edge={index === 0 ? "mint" : "crew"}>
              <Label>
                {outcome.groups.length > 1 ? `Split ${index + 1} of ${outcome.groups.length}` : "What this transaction paid"}
              </Label>
              <div className="divide-y divide-line pt-1">
                {group.lines.map((line) => (
                  <div key={line.to} className="flex items-center justify-between gap-3 py-2.5">
                    <p className="min-w-0 truncate text-sm font-semibold text-ink">{line.to}</p>
                    <span className="tabular shrink-0 font-semibold text-crew">${formatUsdFixed(line.value)}</span>
                  </div>
                ))}
              </div>
              <div className="pt-2">
                <Row label="Total that left the client">${formatUsdFixed(group.total)}</Row>
                <Row label="Paid from">{group.from}</Row>
                <Row label="Block">{outcome.blockNumber.toString()}</Row>
              </div>
              <p className="pt-2 text-xs text-muted">
                Terms memo <span className="break-all font-mono">{group.memo}</span> — the keccak256 of the link that
                was paid. It ties this receipt to those terms without revealing them.
              </p>
              <p className="pt-2 break-all text-xs">
                <ExternalLink href={explorerTx(config, outcome.hash)}>{outcome.hash}</ExternalLink>
              </p>
            </Card>
          ))
        : null}

      <Note tone="plain">
        What this proves: these amounts left that wallet in this transaction. What it cannot prove: that the split was
        the agreed one. The permit&apos;s signature covers an amount and a spender, not a list of recipients, so a link
        holder could change the crew before the client signed. The memo makes the receipt evidence of which terms were
        paid — evidence is not enforcement.
      </Note>
    </Shell>
  );
}
