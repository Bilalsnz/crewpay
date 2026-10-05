import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, toBytes, type Address, type PublicClient } from "viem";

import type { NetworkConfig } from "./networks";

export interface PermitDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const DOMAIN_SEPARATOR_SELECTOR = "0x3644e515"; // DOMAIN_SEPARATOR()
const DOMAIN_TYPE_HASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

const cache = new Map<number, PermitDomain>();

/**
 * Works out the EIP-712 domain pathUSD actually signs under, by hashing the
 * candidates and comparing against the token's own DOMAIN_SEPARATOR.
 *
 * The alternative — writing `name: "PathUSD", version: "1"` into the source —
 * is a guess that fails silently at signing time, in the user's wallet, on a
 * phone, at the worst moment. The token is asked instead, and on Tempo both
 * networks share one pathUSD address, so a wrong chain id here produces a
 * signature the token rejects rather than a confusing revert.
 */
export async function resolvePermitDomain(
  client: PublicClient,
  network: NetworkConfig,
  spender: Address,
): Promise<PermitDomain> {
  void spender;
  const cached = cache.get(network.chainId);
  if (cached) return cached;

  const target = await client.call({ to: network.pathUsd, data: DOMAIN_SEPARATOR_SELECTOR });
  if (!target?.data) throw new Error("pathUSD did not answer DOMAIN_SEPARATOR()");

  const hash = (value: string) => keccak256(toBytes(value));
  const candidates = {
    names: Array.from(new Set([network.pathUsdName, network.pathUsdSymbol, "PathUSD", "pathUSD"])),
    versions: Array.from(new Set([network.permitDomainVersion, "1", "2", ""])),
  };

  for (const name of candidates.names) {
    for (const version of candidates.versions) {
      const separator = keccak256(
        encodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes32,uint256,address"), [
          DOMAIN_TYPE_HASH,
          hash(name),
          hash(version),
          BigInt(network.chainId),
          getAddress(network.pathUsd),
        ]),
      );
      if (separator.toLowerCase() === target.data.toLowerCase()) {
        const domain: PermitDomain = { name, version, chainId: network.chainId, verifyingContract: getAddress(network.pathUsd) };
        cache.set(network.chainId, domain);
        return domain;
      }
    }
  }

  throw new Error(
    `Could not work out the permit domain for pathUSD on ${network.label}. The payment would need an approve() first.`,
  );
}
