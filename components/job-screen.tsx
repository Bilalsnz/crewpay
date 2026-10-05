"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseSignature } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWalletClient } from "wagmi";

import {
  BPS_DENOMINATOR, contractAddress, contractDeployBlock, CREWPAY_ABI, explain, HOLDBACK_BPS, PATHUSD_ABI,
} from "@/lib/contract";
import { formatUsd, formatUsdFixed, formatPercent, formatDeadline, relativeTime, shortAddress } from "@/lib/format";
import { JOB_STATUS_COPY, readJob, readJobHistory, type Job } from "@/lib/job";
import { explorerAddress, explorerTx, NETWORKS, type NetworkKey } from "@/lib/networks";
import { PERMIT_TYPES, resolvePermitDomain } from "@/lib/permit";
import { ensureChain, errorMessage, isUserRejection, providerForConnector, SWITCH_HELP } from "@/lib/wallet";
import { Card, ExternalLink, Label, Money, Note, Row, Spinner, StatusPill, Button, LinkButton } from "./ui";

export type JobMode = "pay" | "receipt" | "status";

const RECEIPT_WAIT_MS = 180_000;

/** Nothing in this app is allowed to await forever and leave a button spinning. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export function JobScreen({
  networkKey,
  jobId,
  mode,
}: {
  networkKey: NetworkKey;
  jobId: bigint;
  mode: JobMode;
}) {
  const config = NETWORKS[networkKey];
  const address = contractAddress(networkKey);
  const client = usePublicClient({ chainId: config.chainId });
  const { address: account, connector, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: config.chainId });
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();

  const [busy, setBusy] = useState<null | "pay" | "accept" | "reclaim">(null);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const jobQuery = useQuery({
    queryKey: ["job", networkKey, address, jobId.toString()],
    enabled: Boolean(client && address),
    refetchInterval: 15_000,
    queryFn: () => readJob(client!, address!, jobId),
  });

  const job = jobQuery.data;

  const historyQuery = useQuery({
    queryKey: ["job-history", networkKey, address, jobId.toString()],
    enabled: Boolean(client && address) && mode === "receipt",
    queryFn: () => readJobHistory(client!, address!, jobId, contractDeployBlock(networkKey)),
  });

  const isClient = Boolean(account && job && account.toLowerCase() === job.client.toLowerCase());
  const base = `/job/${networkKey}/${jobId.toString()}`;

  /** Puts the wallet on the chain the link names, then lets wagmi agree. */
  const ensureRightChain = useCallback(async () => {
    const provider = await providerForConnector(connector);
    await ensureChain(provider, config);
    try {
      await switchChainAsync({ chainId: config.chainId });
    } catch {
      /* ensureChain already proved the wallet is on this chain */
    }
  }, [connector, config, switchChainAsync]);

  const run = useCallback(
    async (kind: "pay" | "accept" | "reclaim", body: () => Promise<`0x${string}`>) => {
      setBusy(kind);
      setError(null);
      setDone(null);
      try {
        await ensureRightChain();
        const hash = await body();
        // A hash is not a payment. Say so, then wait for the chain to agree.
        setStage("Confirming on Tempo…");
        await withTimeout(
          client!.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS }),
          RECEIPT_WAIT_MS + 5_000,
          "Tempo is taking longer than usual to confirm. The transaction is in flight — check the explorer before trying again.",
        );
        setStage(null);
        // The read that backs the receipt can land on a node a beat behind the
        // one that mined the transaction. Retry rather than show a job the user
        // just paid as still unpaid.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000));
          const fresh = await jobQuery.refetch();
          if (fresh.data) break;
        }
        await historyQuery.refetch();
        setDone(hash);
      } catch (caught) {
        setStage(null);
        if (isUserRejection(caught)) setError("You cancelled in your wallet. Nothing was sent.");
        else if (errorMessage(caught).includes(SWITCH_HELP)) setError(SWITCH_HELP);
        else setError(explain(caught));
      } finally {
        setBusy(null);
      }
    },
    [client, ensureRightChain, historyQuery, jobQuery],
  );

  const pay = useCallback(async () => {
    if (!job || !walletClient || !client || !account || !address) return;
    await run("pay", async () => {
      // One signature and one transaction, with no approve step — pathUSD
      // supports EIP-2612, so the permit is folded into the payment itself.
      try {
        setStage("Waiting for your wallet to sign the payment…");
        const domain = await resolvePermitDomain(client, config, address);
        const nonce = await client.readContract({
          address: config.pathUsd, abi: PATHUSD_ABI, functionName: "nonces", args: [account],
        });
        const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const signature = await signTypedDataAsync({
          domain,
          types: PERMIT_TYPES,
          primaryType: "Permit",
          message: {
            owner: account,
            spender: address,
            value: job.total,
            nonce: nonce as bigint,
            deadline: permitDeadline,
          },
        });
        // viem hands back yParity; the contract wants the classic v byte.
        const { r, s, yParity } = parseSignature(signature);
        const v = yParity + 27;
        setStage("Sending the payment…");
        return await walletClient.writeContract({
          address, abi: CREWPAY_ABI, functionName: "payWithPermit",
          args: [job.id, permitDeadline, v, r, s], account, chain: undefined,
        });
      } catch (permitFailure) {
        // The permit can fail for reasons that have nothing to do with the
        // payment — a wallet that will not sign typed data, a token without
        // EIP-2612. Fall back to the ordinary two-step pull so the job still
        // gets paid, and let the contract enforce exactly the same rules.
        if (isUserRejection(permitFailure)) throw permitFailure;
        setStage("Approving pathUSD…");
        const approveHash = await walletClient.writeContract({
          address: config.pathUsd, abi: PATHUSD_ABI, functionName: "approve",
          args: [address, job.total], account, chain: undefined,
        });
        await withTimeout(client.waitForTransactionReceipt({ hash: approveHash }), RECEIPT_WAIT_MS, "The approval is taking too long to confirm.");
        setStage("Sending the payment…");
        return await walletClient.writeContract({
          address, abi: CREWPAY_ABI, functionName: "pay", args: [job.id], account, chain: undefined,
        });
      }
    });
  }, [account, address, client, config, job, run, signTypedDataAsync, walletClient]);

  const accept = useCallback(async () => {
    if (!job || !walletClient || !account || !address) return;
    await run("accept", () =>
      walletClient.writeContract({ address, abi: CREWPAY_ABI, functionName: "accept", args: [job.id], account, chain: undefined }),
    );
  }, [account, address, job, run, walletClient]);

  const reclaim = useCallback(async () => {
    if (!job || !walletClient || !account || !address) return;
    await run("reclaim", () =>
      walletClient.writeContract({ address, abi: CREWPAY_ABI, functionName: "reclaim", args: [job.id], account, chain: undefined }),
    );
  }, [account, address, job, run, walletClient]);

  if (!address) {
    return (
      <Card>
        <p className="text-sm text-ink">CrewPay is not deployed to {config.label} in this build.</p>
      </Card>
    );
  }

  if (jobQuery.isLoading) {
    return (
      <Card>
        <Spinner label={`Reading job #${jobId} from ${config.label}…`} />
      </Card>
    );
  }

  if (jobQuery.error || !job) {
    return (
      <Card edge="holdback">
        <Label>Not found</Label>
        <p className="pt-2 text-sm text-ink">
          No job #{jobId.toString()} on {config.label}. The link may belong to the other network — this page never
          falls back to another chain.
        </p>
        <p className="pt-2 text-xs text-muted">{client ? explain(jobQuery.error) : ""}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card edge={job.status === "returned" || job.status === "accepted" ? "mint" : job.status === "paid" ? "crew" : "holdback"}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label>Job #{job.id.toString()}</Label>
            <p className="pt-1 text-3xl font-black tracking-tight">
              <Money value={formatUsdFixed(job.total)} />
            </p>
            <p className="pt-1 text-xs text-muted">
              {config.label} · created {formatDeadline(job.createdAt)}
            </p>
          </div>
          <StatusPill status={job.status} />
        </div>
        <p className="pt-3 text-sm text-muted">{JOB_STATUS_COPY[job.status].blurb}</p>
        <div className="flex flex-wrap gap-2 pt-3">
          <LinkButton href={`${base}/pay`} variant={mode === "pay" ? "plain" : "ghost"}>
            Pay
          </LinkButton>
          <LinkButton href={`${base}/receipt`} variant={mode === "receipt" ? "plain" : "ghost"}>
            Receipt
          </LinkButton>
          <LinkButton href={`${base}/status`} variant={mode === "status" ? "plain" : "ghost"}>
            Status
          </LinkButton>
        </div>
      </Card>

      {error ? <Note tone="bad">{error}</Note> : null}
      {done ? (
        <Note tone="good">
          Confirmed on Tempo. <ExternalLink href={explorerTx(config, done)}>View the transaction</ExternalLink>
        </Note>
      ) : null}
      {stage ? (
        <Card>
          <Spinner label={stage} />
        </Card>
      ) : null}

      {mode === "pay" ? (
        <PayPanel
          job={job}
          networkKey={networkKey}
          account={account}
          isConnected={isConnected}
          isClient={isClient}
          busy={busy}
          onPay={pay}
        />
      ) : null}

      <AllocationCard job={job} />

      {mode === "receipt" ? (
        <ReceiptCard
          job={job}
          networkKey={networkKey}
          address={address}
          history={historyQuery.data}
          loading={historyQuery.isLoading}
        />
      ) : null}

      {mode === "status" ? (
        <ActionCard
          job={job}
          networkKey={networkKey}
          account={account}
          isConnected={isConnected}
          isClient={isClient}
          busy={busy}
          onAccept={accept}
          onReclaim={reclaim}
        />
      ) : null}
    </div>
  );
}

/* ───────────────────────────────── pay ──────────────────────────────────── */

function PayPanel({
  job, networkKey, account, isConnected, isClient, busy, onPay,
}: {
  job: Job;
  networkKey: NetworkKey;
  account?: string;
  isConnected: boolean;
  isClient: boolean;
  busy: string | null;
  onPay: () => void;
}) {
  const config = NETWORKS[networkKey];

  if (job.status !== "unpaid") {
    return (
      <Card edge="mint">
        <Label>Already settled</Label>
        <p className="pt-2 text-sm text-ink">
          This job is <strong>{job.status}</strong>. The contract will refuse a second payment, so there is nothing
          to send here.
        </p>
      </Card>
    );
  }

  return (
    <Card edge="crew">
      <Label>Payment</Label>
      <div className="pt-1">
        <Row label="Network">{config.label}</Row>
        <Row label="Token">{config.pathUsdSymbol}</Row>
        <Row label="You pay">
          <Money value={formatUsdFixed(job.total)} />
        </Row>
        <Row label="To the crew now">
          <Money value={formatUsdFixed(job.crewAmounts.reduce((a, b) => a + b, 0n))} tone="crew" />
        </Row>
        <Row label={`Held back (${HOLDBACK_BPS / 100}%)`}>
          <Money value={formatUsdFixed(job.total - job.crewAmounts.reduce((a, b) => a + b, 0n))} tone="holdback" />
        </Row>
      </div>

      <div className="pt-3">
        {!isConnected ? (
          <p className="text-sm text-muted">Connect the wallet that created this job to pay it.</p>
        ) : !isClient ? (
          <Note tone="warn">
            This job was created by {shortAddress(job.client)}. Only that wallet can pay it — the contract refuses
            anyone else.
          </Note>
        ) : (
          <Button variant="pay" full disabled={Boolean(busy)} onClick={onPay}>
            {busy === "pay" ? "Paying…" : `Pay $${formatUsdFixed(job.total)}`}
          </Button>
        )}
      </div>

      <p className="pt-3 text-xs text-muted">
        One tap: the permit is signed and the payment carries it, so 90% reaches the crew in the same transaction
        that takes your pathUSD. {account ? "" : ""}
      </p>
    </Card>
  );
}

/* ─────────────────────────────── allocations ────────────────────────────── */

function AllocationCard({ job }: { job: Job }) {
  const released = job.accepted;
  const returned = job.returned;

  return (
    <Card edge={returned ? "mint" : "crew"}>
      <Label>Crew allocations</Label>
      <p className="pt-1 text-xs text-muted">
        {formatPercent(BPS_DENOMINATOR - HOLDBACK_BPS)} of the total is split by these percentages. They were fixed
        when the job was created and cannot be changed.
      </p>
      <div className="divide-y divide-line pt-2">
        {job.crew.map((member, index) => (
          <div key={member} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{shortAddress(member, 8, 6)}</p>
              <p className="text-xs text-muted">{formatPercent(job.shares[index])} of the crew share</p>
            </div>
            <div className="text-right">
              <Money value={formatUsd(job.crewAmounts[index] ?? 0n)} tone="crew" />
              {released ? <p className="text-xs text-crew">+ holdback share</p> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
        <div>
          <p className="text-sm font-semibold text-holdback">
            {returned ? "Holdback returned to client" : "Holdback"}
          </p>
          <p className="text-xs text-muted">
            {returned
              ? `Went back to ${shortAddress(job.client)}`
              : job.accepted
                ? "Released to the crew on acceptance"
                : `${HOLDBACK_BPS / 100}% held until the client accepts, or until ${formatDeadline(job.deadline)}`}
          </p>
        </div>
        <Money value={formatUsdFixed(job.total - job.crewAmounts.reduce((a, b) => a + b, 0n))} tone={returned ? "mint" : "holdback"} />
      </div>
    </Card>
  );
}

/* ──────────────────────────────── receipt ───────────────────────────────── */

function ReceiptCard({
  job, networkKey, address, history, loading,
}: {
  job: Job;
  networkKey: NetworkKey;
  address: `0x${string}`;
  history?: { created?: { txHash: `0x${string}` }; paid?: { txHash: `0x${string}` }; accepted?: { txHash: `0x${string}` }; returned?: { txHash: `0x${string}` } };
  loading: boolean;
}) {
  const config = NETWORKS[networkKey];
  const holdback = job.total - job.crewAmounts.reduce((a, b) => a + b, 0n);

  // The full link is only knowable in the browser, so it is filled in after
  // mount rather than during render — otherwise the server and client markup
  // would disagree on first paint.
  const [link, setLink] = useState(`/job/${networkKey}/${job.id}`);
  useEffect(() => {
    setLink(window.location.href.replace(/\/(receipt|status|pay)$/, ""));
  }, []);

  return (
    <Card edge={job.status === "returned" ? "mint" : job.status === "accepted" ? "mint" : "holdback"}>
      <Label>Receipt</Label>

      <div className="pt-1">
        <Row label="Job">{`#${job.id}`}</Row>
        <Row label="Network">{`${config.label} (chain ${config.chainId})`}</Row>
        <Row label="Token">{`${config.pathUsdSymbol} · ${config.pathUsd}`}</Row>
        <Row label="Contract">{address}</Row>
        <Row label="Client">{job.client}</Row>
        <Row label="Total paid">
          <Money value={formatUsdFixed(job.total)} />
        </Row>
        <Row label="To the crew">
          <Money value={formatUsdFixed(job.crewAmounts.reduce((a, b) => a + b, 0n))} tone="crew" />
        </Row>
        <Row label={`Holdback (${HOLDBACK_BPS / 100}%)`}>
          <Money value={formatUsdFixed(holdback)} tone={job.returned ? "mint" : "holdback"} />
        </Row>
        <Row label="Deadline">{`${formatDeadline(job.deadline)} (${relativeTime(job.deadline)})`}</Row>
        <Row label="Status">{job.status}</Row>
      </div>

      <div className="border-t border-line pt-3">
        <Label>Transactions</Label>
        {loading ? (
          <div className="pt-2">
            <Spinner label="Reading the job's transactions from Tempo…" />
          </div>
        ) : (
          <div className="pt-1">
            <TxRow label="Created" hash={history?.created?.txHash} network={networkKey} />
            <TxRow label="Paid" hash={history?.paid?.txHash} network={networkKey} />
            <TxRow label="Accepted" hash={history?.accepted?.txHash} network={networkKey} />
            <TxRow label="Returned" hash={history?.returned?.txHash} network={networkKey} />
          </div>
        )}
      </div>

      <div className="border-t border-line pt-3">
        <Label>Payment link</Label>
        <p className="break-all pt-1 text-xs text-crew">{link}</p>
        <p className="pt-1 text-xs text-muted">
          The link is the record. It carries the network and the job number, and everything on this page is read back
          from the contract — there is no account and nothing stored on a server.
        </p>
      </div>

      <div className="pt-3">
        <ExternalLink href={explorerAddress(config, address)}>Open the contract on the Tempo explorer</ExternalLink>
      </div>
    </Card>
  );
}

function TxRow({ label, hash, network }: { label: string; hash?: `0x${string}`; network: NetworkKey }) {
  const config = NETWORKS[network];
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-sm text-muted">{label}</span>
      <span className="min-w-0 text-right text-sm font-semibold">
        {hash ? (
          <ExternalLink href={explorerTx(config, hash)}>{shortAddress(hash, 10, 8)}</ExternalLink>
        ) : (
          <span className="text-muted">—</span>
        )}
      </span>
    </div>
  );
}

/* ───────────────────────────────── status ───────────────────────────────── */

function ActionCard({
  job, networkKey, account, isConnected, isClient, busy, onAccept, onReclaim,
}: {
  job: Job;
  networkKey: NetworkKey;
  account?: string;
  isConnected: boolean;
  isClient: boolean;
  busy: string | null;
  onAccept: () => void;
  onReclaim: () => void;
}) {
  const config = NETWORKS[networkKey];
  const holdback = job.total - job.crewAmounts.reduce((a, b) => a + b, 0n);

  const body = useMemo(() => {
    if (job.status === "unpaid") {
      return "Nothing has been paid yet, so there is nothing to accept and nothing to return. The link can sit unpaid until the deadline.";
    }
    if (job.status === "accepted") {
      return `Accepted. The ${formatPercent(HOLDBACK_BPS)} holdback of $${formatUsdFixed(holdback)} went to the crew at the same percentages. This job is finished.`;
    }
    if (job.status === "returned") {
      return `The deadline passed on ${formatDeadline(job.deadline)} without acceptance, so $${formatUsdFixed(holdback)} went back to ${shortAddress(job.client)}. This job is finished.`;
    }
    return job.returnable
      ? `The deadline passed on ${formatDeadline(job.deadline)}, so the $${formatUsdFixed(holdback)} holdback can now be returned to the client.`
      : `The $${formatUsdFixed(holdback)} holdback is held by the contract until ${formatDeadline(job.deadline)} (${relativeTime(job.deadline)}).`;
  }, [holdback, job]);

  return (
    <Card edge={job.status === "accepted" || job.status === "returned" ? "mint" : job.status === "paid" ? "holdback" : "none"}>
      <Label>Status — read from {config.label}</Label>
      <p className="pt-2 text-sm text-ink">{body}</p>

      <div className="pt-3">
        {job.status === "paid" && !job.returnable ? (
          !isConnected ? (
            <p className="text-sm text-muted">Connect {shortAddress(job.client)} to accept the work.</p>
          ) : isClient ? (
            <Button variant="pay" full disabled={Boolean(busy)} onClick={onAccept}>
              {busy === "accept" ? "Accepting…" : `Accept the work — release $${formatUsdFixed(holdback)}`}
            </Button>
          ) : (
            <Note tone="warn">Only {shortAddress(job.client)} can accept. You can still return the holdback once the deadline passes.</Note>
          )
        ) : null}

        {job.status === "paid" && job.returnable ? (
          <>
            <Note tone="warn">
              The deadline has passed, so acceptance is closed. The holdback can go back to the client — anyone can
              push that button, and the contract sends the money only to {shortAddress(job.client)}.
            </Note>
            <div className="pt-3">
              {isConnected ? (
                <Button variant="ghost" full disabled={Boolean(busy)} onClick={onReclaim}>
                  {busy === "reclaim" ? "Returning…" : `Return $${formatUsdFixed(holdback)} to the client`}
                </Button>
              ) : (
                <p className="text-sm text-muted">Connect any wallet to send the holdback back.</p>
              )}
            </div>
          </>
        ) : null}

        {job.status === "unpaid" ? (
          <div className="pt-1">
            <LinkButton href={`/job/${networkKey}/${job.id}/pay`} variant="ghost">
              Go to payment
            </LinkButton>
          </div>
        ) : null}
      </div>

      <p className="pt-3 text-xs text-muted">
        Nothing on this page is remembered by the browser. Each status is a fresh read of the contract, so it cannot
        disagree with the money.
      </p>
    </Card>
  );
}

/* ─────────────────────────────── shared bits ────────────────────────────── */

export function JobNotFound({ networkKey }: { networkKey: NetworkKey }) {
  return (
    <Card edge="holdback">
      <Label>Bad link</Label>
      <p className="pt-2 text-sm text-ink">
        That job number is not a number. Links look like <code>/job/testnet/1</code>.
      </p>
      <div className="pt-3">
        <LinkButton href="/">Back to CrewPay</LinkButton>
      </div>
      <p className="pt-2 text-xs text-muted">Network in this link: {NETWORKS[networkKey].label}</p>
    </Card>
  );
}

export function parseJobId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    const value = BigInt(raw);
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? value : null;
  } catch {
    return null;
  }
}
