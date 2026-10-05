import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
// Override with NM=… to install into another project; defaults to this one.
const NM = process.env.NM || "/public/crewpay/node_modules";
const reg = async (n) => {
  const res = await fetch("https://registry.npmjs.org/" + n.replace("/", "%2f"));
  if (res.status === 404) return null; // unpublished or private — the caller decides
  if (!res.ok) throw new Error(`registry ${n}: HTTP ${res.status}`);
  return res.json();
};

/**
 * Wallet-SDK trees the app never imports. `injected` comes from `wagmi` itself
 * (= @wagmi/core); `wagmi/connectors` is the barrel that drags in Base Account,
 * Coinbase and the rest, and pulling it in breaks this build. Skipping them here
 * keeps a hand-rolled install from chasing a dependency graph we do not use —
 * and `cbw-sdk`, one of Coinbase's, is not even published any more (404).
 */
const SKIP = new Set([
  "@wagmi/connectors",
  "@base-org/account",
  "@coinbase/wallet-sdk",
  "@coinbase/cdp-sdk",
  "@metamask/connect-evm",
  "cbw-sdk",
  "porto",
  "porto/internal",
]);

/** glibc or musl — the native binaries are named for the difference. */
const LIBC = (() => {
  try {
    return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return "glibc";
  }
})();

/** Does this package declare itself buildable for the machine we are on? */
function buildsHere(meta) {
  const osOk = !meta.os || meta.os.includes(process.platform);
  const cpuOk = !meta.cpu || meta.cpu.includes(process.arch);
  const libcOk = !meta.libc || meta.libc.includes(LIBC);
  return osOk && cpuOk && libcOk;
}

/** Numeric compare of two version strings, ignoring prerelease tags. */
function cmp(a, b) {
  const pa = String(a).split("-")[0].split(".").map(Number);
  const pb = String(b).split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function one(v, range) {
  const m = String(range).trim().match(/^(\^|~|>=|<=|>|<|=)?\s*v?(.+)$/);
  if (!m) return false;
  const [, op = "", want] = m;
  const w = want.split("-")[0];
  switch (op) {
    case "^": {
      // >=want, same major (or same minor when major is 0)
      const [maj, min] = w.split(".").map(Number);
      if (cmp(v, w) < 0) return false;
      const [vmaj, vmin] = String(v).split("-")[0].split(".").map(Number);
      return maj === 0 ? vmaj === 0 && vmin === min : vmaj === maj;
    }
    case "~": {
      const [maj, min] = w.split(".").map(Number);
      if (cmp(v, w) < 0) return false;
      const [vmaj, vmin] = String(v).split("-")[0].split(".").map(Number);
      return vmaj === maj && vmin === min;
    }
    case ">=": return cmp(v, w) >= 0;
    case "<=": return cmp(v, w) <= 0;
    case ">": return cmp(v, w) > 0;
    case "<": return cmp(v, w) < 0;
    default: return cmp(v, w) === 0;
  }
}

/** Highest published version satisfying a range — `latest` when there is none. */
function pick(meta, range) {
  if (!range || range === "*" || range === "" || range === "latest") return meta["dist-tags"].latest;
  // npm: aliases, file: and workspace: specs are not installable by name here.
  if (/^(npm:|file:|link:|workspace:|git|https?:)/.test(range)) return null;
  const candidates = Object.keys(meta.versions)
    .filter((v) => !v.includes("-") || range.includes("-"))
    .filter((v) => String(range).split("||").some((r) => r.trim().split(/\s+/).every((p) => one(v, p))))
    .sort(cmp);
  // A range with no match is a spec this installer cannot honour; failing loudly
  // beats silently installing a version the caller never asked for.
  if (!candidates.length) throw new Error(`no version of ${meta.name} satisfies "${range}"`);
  return candidates[candidates.length - 1];
}

export async function install(name, want, seen = new Set(), quiet = false) {
  if (seen.has(name)) return;
  seen.add(name);
  if (SKIP.has(name)) {
    if (!quiet) console.log(`  ${name} — skipped (wallet-SDK tree this app does not import)`);
    return;
  }
  const meta = await reg(name);
  if (!meta) {
    // A transitive dep that no longer exists. Say so loudly: if the build then
    // fails on this name, the cause is right here rather than a mystery.
    console.warn(`  ${name} — NOT FOUND on the registry, skipped`);
    return;
  }
  const ver = want && meta.versions[want] ? want : pick(meta, want);
  if (!ver) return;
  const dir = `${NM}/${name}`;
  const already = (() => {
    try {
      return JSON.parse(execSync(`cat "${dir}/package.json"`, { shell: "/bin/bash" }).toString()).version === ver;
    } catch {
      return false;
    }
  })();
  if (already) {
    if (!quiet) console.log(`  ${name}@${ver} (cached)`);
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execSync(`curl -sL -o /tmp/p.tgz "${meta.versions[ver].dist.tarball}" && tar xzf /tmp/p.tgz -C "${dir}" --strip-components=1`, { shell: "/bin/bash" });
    if (!quiet) console.log(`  ${name}@${ver}`);
  }
  const deps = { ...(meta.versions[ver].dependencies || {}) };
  // Optional peers are what break a hand-rolled install; they are genuinely optional.
  for (const [d, r] of Object.entries(deps)) {
    if (d.startsWith("@types/")) continue;
    await install(d, r, seen, quiet);
  }
  // optionalDependencies is where the platform-specific native binaries live —
  // @next/swc-*, @tailwindcss/oxide-*, lightningcss-*. Take the ones built for
  // this machine and leave the other twenty alone; without them the build gets
  // as far as globals.css and dies.
  for (const [d, r] of Object.entries(meta.versions[ver].optionalDependencies || {})) {
    if (seen.has(d) || d.startsWith("@types/")) continue;
    const om = await reg(d);
    if (!om) continue;
    const platform = om.versions[om["dist-tags"].latest] || {};
    if (!buildsHere(platform)) {
      if (!quiet) console.log(`  ${d} — skipped (not built for ${process.platform}/${process.arch}/${LIBC})`);
      seen.add(d);
      continue;
    }
    await install(d, r, seen, quiet);
  }
}
if (process.argv[1].endsWith("install.mjs")) {
  console.log("installing:");
  for (const spec of process.argv.slice(2)) {
    // A leading "@" is the scope, not a version separator — "@scope/name" has
    // to survive intact. Only an "@" after the first character starts a version.
    const at = spec.indexOf("@", 1);
    if (at === -1) await install(spec, null);
    else await install(spec.slice(0, at), spec.slice(at + 1));
  }
  console.log("done");
}
