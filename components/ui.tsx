"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { JobStatus } from "@/lib/job";

/** A white card with a coloured left edge. The edge colour is the meaning. */
export function Card({
  children,
  edge,
  className = "",
}: {
  children: ReactNode;
  edge?: "crew" | "holdback" | "mint" | "none";
  className?: string;
}) {
  const edges: Record<string, string> = {
    crew: "border-l-4 border-l-crew",
    holdback: "border-l-4 border-l-holdback",
    mint: "border-l-4 border-l-mint",
    none: "",
  };
  return (
    <section className={`rounded-[16px] bg-white p-4 shadow-[0_10px_30px_-18px_rgba(16,24,40,0.45)] ${edges[edge ?? "none"]} ${className}`}>
      {children}
    </section>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="block text-xs font-semibold uppercase tracking-wide text-muted">{children}</span>;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-sm text-muted">{label}</span>
      <span className="tabular text-right text-sm font-semibold text-ink">{children}</span>
    </div>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  variant?: "pay" | "plain" | "ghost" | "danger";
  full?: boolean;
  className?: string;
};

export function Button({
  children,
  onClick,
  disabled,
  type = "button",
  variant = "plain",
  full,
  className = "",
}: ButtonProps) {
  const base = "inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed";
  const variants: Record<string, string> = {
    pay: "pay-button",
    plain: "bg-ink text-white disabled:bg-[#c8cddd]",
    ghost: "border border-line bg-white text-ink disabled:text-muted",
    danger: "bg-danger-soft text-danger disabled:opacity-60",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${full ? "w-full" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

const STATUS_STYLE: Record<JobStatus, string> = {
  unpaid: "bg-holdback-soft text-holdback",
  paid: "bg-crew-soft text-crew",
  accepted: "bg-mint-soft text-mint",
  returned: "bg-mint-soft text-mint",
};

const STATUS_LABEL: Record<JobStatus, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  accepted: "Accepted",
  returned: "Returned",
};

export function StatusPill({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Note({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "warn" | "bad" | "good" }) {
  const tones: Record<string, string> = {
    plain: "bg-white/15 text-white",
    warn: "bg-holdback-soft text-holdback",
    bad: "bg-danger-soft text-danger",
    good: "bg-mint-soft text-mint",
  };
  return <p className={`rounded-xl px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}

export function LinkButton({ href, children, variant = "ghost" }: { href: string; children: ReactNode; variant?: "ghost" | "plain" }) {
  const styles = variant === "plain" ? "bg-ink text-white" : "border border-line bg-white text-ink";
  return (
    <Link href={href} className={`inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold ${styles}`}>
      {children}
    </Link>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-crew" aria-hidden />
      {label}
    </span>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="break-all text-crew underline decoration-crew/40 underline-offset-2">
      {children}
    </a>
  );
}

/** `$2.00` in the colour that says what the money is for. */
export function Money({ value, tone = "ink" }: { value: string; tone?: "crew" | "holdback" | "mint" | "ink" }) {
  const tones: Record<string, string> = {
    crew: "text-crew",
    holdback: "text-holdback",
    mint: "text-mint",
    ink: "text-ink",
  };
  return <span className={`tabular font-semibold ${tones[tone]}`}>${value}</span>;
}
