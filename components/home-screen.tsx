"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { contractAddress, deploymentGap } from "@/lib/contract";
import { formatUsdFixed, relativeTime, shortAddress } from "@/lib/format";
import { useNetwork } from "@/components/network-provider";
import { Shell, useFollowLinkNetwork } from "@/components/shell";
import { Button, Card, Label, LinkButton, Note, Row } from "@/components/ui";
import { parseJobId } from "@/components/job-screen";
import type { NetworkKey } from "@/lib/networks";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { readJob } from "@/lib/job";

/** Links this browser has opened, kept here only — never sent anywhere. */
const LINKS_KEY = "crewpay.links";

export interface SavedLink {
  network: NetworkKey;
  id: string;
  note: string;
  at: number;
}

export function readSavedLinks(): SavedLink[] {
  try {
    const raw = window.localStorage.getItem(LINKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedLink[];
    return Array.isArray(parsed) ? parsed.filter((l) => l && (l.network === "testnet" || l.network === "mainnet")) : [];
  } catch {
    return [];
  }
}

export function saveLink(link: SavedLink): void {
  try {
    const existing = readSavedLinks().filter((l) => !(l.network === link.network && l.id === link.id));
    window.localStorage.setItem(LINKS_KEY, JSON.stringify([link, ...existing].slice(0, 25)));
  } catch {
    /* not fatal — the link is still the record */
  }
}

function RecentLinks() {
  const [links, setLinks] = useState<SavedLink[]>([]);
  const { network, config } = useNetwork();
  const client = usePublicClient({ chainId: config.chainId });
  const address = contractAddress(network);

  useEffect(() => setLinks(readSavedLinks()), []);

  const forThisNetwork = links.filter((l) => l.network === network);

  const { data: states } = useQuery({
    queryKey: ["recent-status", network, forThisNetwork.map((l) => l.id).join(",")],
    enabled: Boolean(client && address) && forThisNetwork.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        forThisNetwork.slice(0, 8).map(async (link) => {
          const id = parseJobId(link.id);
          if (id === null) return null;
          try {
            const job = await readJob(client!, address!, id);
            return { key: `${link.network}:${link.id}`, status: job.status, total: job.total, deadline: job.deadline };
          } catch {
            return null;
          }
        }),
      );
      return entries;
    },
  });

  if (forThisNetwork.length === 0) return null;

  return (
    <Card>
      <Label>Jobs you opened on this device</Label>
      <p className="pt-1 text-xs text-muted">
        Held in this browser only. The links themselves are the record — the status beside each one is read live from
        the contract.
      </p>
      <div className="divide-y divide-line pt-2">
        {forThisNetwork.slice(0, 8).map((link) => {
          const state = states?.find((s) => s && s.key === `${link.network}:${link.id}`);
          return (
            <Link
              key={`${link.network}:${link.id}`}
              href={`/job/${link.network}/${link.id}/status`}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">
                  Job #{link.id}
                  {link.note ? ` · ${link.note}` : ""}
                </span>
                <span className="block text-xs text-muted">
                  {state ? `${state.status} · ${relativeTime(state.deadline)}` : "reading…"}
                </span>
              </span>
              <span className="tabular text-sm font-semibold text-ink">
                {state ? `$${formatUsdFixed(state.total)}` : ""}
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

function OpenALink() {
  const { network } = useNetwork();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const go = () => {
    setProblem(null);
    const trimmed = value.trim();
    // Accept a full link or a bare job number. A full link's own network wins —
    // we never quietly re-point a mainnet link at testnet.
    const match = trimmed.match(/\/job\/(testnet|mainnet)\/(\d+)/);
    if (match) {
      window.location.href = `/job/${match[1]}/${match[2]}`;
      return;
    }
    const id = parseJobId(trimmed.replace(/^#/, ""));
    if (id === null) {
      setProblem("Paste a CrewPay link, or a job number like 3.");
      return;
    }
    saveLink({ network, id: id.toString(), note: "", at: Date.now() });
    window.location.href = `/job/${network}/${id.toString()}`;
  };

  return (
    <Card edge="crew">
      <Label>Open a job</Label>
      <p className="pt-1 text-xs text-muted">Paste the link a client sent you, or just the job number.</p>
      <div className="flex gap-2 pt-3">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") go();
          }}
          placeholder="https://…/job/testnet/3"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-line px-3 py-3 text-sm text-ink placeholder:text-muted"
        />
        <Button variant="plain" onClick={go}>
          Open
        </Button>
      </div>
      {problem ? (
        <div className="pt-2">
          <Note tone="warn">{problem}</Note>
        </div>
      ) : null}
    </Card>
  );
}

export function HomeScreen() {
  const { network, config } = useNetwork();
  const { address } = useAccount();
  const gap = deploymentGap(network);
  const deployed = contractAddress(network);

  return (
    <Shell>
      <Card edge="crew">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Tempo · {config.label}</p>
        <h1 className="pt-1 text-2xl font-black leading-tight tracking-tight">
          Pay a crew in one transaction.
        </h1>
        <p className="pt-2 text-sm text-muted">
          The client pays once in {config.pathUsdSymbol}. 90% reaches up to four crew wallets in that same
          transaction, at percentages frozen when the link was made. The last 10% waits until the client accepts the
          work — or goes back if the deadline passes first.
        </p>
        <div className="pt-4">
          <LinkButton href="/create" variant="plain">
            Create a job
          </LinkButton>
        </div>
      </Card>

      {gap ? <Note tone="warn">{gap}</Note> : null}

      <OpenALink />
      <RecentLinks />

      <Card>
        <Label>How the money moves</Label>
        <div className="pt-1">
          <Row label="Paid to the crew at once">90%</Row>
          <Row label="Held by the contract">10%</Row>
          <Row label="Crew wallets per job">up to 4</Row>
          <Row label="Token">{config.pathUsdSymbol}</Row>
          <Row label="Gas paid in">{config.gasToken}</Row>
        </div>
        <p className="pt-2 text-xs text-muted">
          Every rule above is enforced by the contract at {deployed ? shortAddress(deployed, 10, 8) : "—"} on{" "}
          {config.label}. The pages only read it.
        </p>
      </Card>

      {!address ? (
        <Card>
          <Label>Wallet</Label>
          <p className="pt-1 text-sm text-muted">
            No account, no sign-up. Connect a wallet when you are ready to create or pay — on a phone, open this page
            in your wallet's own browser.
          </p>
        </Card>
      ) : null}
    </Shell>
  );
}
