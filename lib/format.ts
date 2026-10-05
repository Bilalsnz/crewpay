import { formatUnits, parseUnits } from "viem";

/**
 * pathUSD has 6 decimals on both Tempo networks. The app deals in real dollar
 * amounts and never converts between assets — there is no rate anywhere in this
 * codebase, because inventing one is the one thing that would make a receipt
 * lie.
 */
export const USD_DECIMALS = 6;

export function formatUsd(value: bigint, decimals = USD_DECIMALS): string {
  const asString = formatUnits(value, decimals);
  const [whole, fraction = ""] = asString.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** Always two decimals, for money shown on a card or a button. */
export function formatUsdFixed(value: bigint, decimals = USD_DECIMALS): string {
  const asString = formatUnits(value, decimals);
  const [whole, fraction = ""] = asString.split(".");
  const two = (fraction + "00").slice(0, 2);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${two}`;
}

/** Parses a dollar string the user typed. Returns null when it is not a number. */
export function parseUsd(input: string, decimals = USD_DECIMALS): bigint | null {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned) || cleaned === ".") return null;
  try {
    const parsed = parseUnits(cleaned, decimals);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function formatPercent(bps: number): string {
  const percent = bps / 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`;
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (!address || address.length < lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** "12 Nov 2026, 14:03" — local time, because the deadline is a wall clock. */
export function formatDeadline(unixSeconds: bigint | number): string {
  const ms = Number(unixSeconds) * 1000;
  return new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 3 days" / "4 hours ago" — the useful half of a deadline. */
export function relativeTime(unixSeconds: bigint | number, now = Date.now()): string {
  const deltaMs = Number(unixSeconds) * 1000 - now;
  const past = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const count = Math.round(abs / size);
      const plural = count === 1 ? "" : "s";
      return past ? `${count} ${name}${plural} ago` : `in ${count} ${name}${plural}`;
    }
  }
  return past ? "just now" : "in under a minute";
}

/** Value for a datetime-local input, in the user's own timezone. */
export function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
