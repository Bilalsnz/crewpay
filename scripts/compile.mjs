/**
 * Compiles contracts/CrewPay.sol to artifacts/CrewPay.json.
 *
 * The artifact is committed on purpose. Deploying and testing need solc, but
 * the web app only needs the ABI and the address — so a Vercel build never has
 * to run a compiler, and the bytecode that gets deployed can be checked into
 * git and diffed.
 *
 *   node scripts/compile.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "contracts/CrewPay.sol"), "utf8");

const input = {
  language: "Solidity",
  sources: { "CrewPay.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const diagnostics = output.errors ?? [];
for (const d of diagnostics) console.log(`${d.severity.toUpperCase()}: ${d.formattedMessage.trim()}`);

if (diagnostics.some((d) => d.severity === "error")) {
  console.error("\ncompile failed");
  process.exit(1);
}

const compiled = output.contracts["CrewPay.sol"].CrewPay;
const artifact = {
  contractName: "CrewPay",
  compiler: solc.version(),
  abi: compiled.abi,
  bytecode: "0x" + compiled.evm.bytecode.object,
  deployedBytecode: "0x" + compiled.evm.deployedBytecode.object,
};

mkdirSync(resolve(root, "artifacts"), { recursive: true });
const out = resolve(root, "artifacts/CrewPay.json");
writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");

console.log(`\nCrewPay compiled with ${solc.version()}`);
console.log(`  creation bytecode : ${(artifact.bytecode.length - 2) / 2} bytes`);
console.log(`  runtime bytecode  : ${(artifact.deployedBytecode.length - 2) / 2} bytes`);
console.log(`  abi entries       : ${artifact.abi.length}`);
console.log(`  written to        : artifacts/CrewPay.json`);
