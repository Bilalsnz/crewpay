# FlowPay Pay — the same split, no contract

This documents the Pay product on the `zero-contract` branch. `main` is
untouched: the contract version, its tests and its deployment are exactly as
they were. See [CONTRACT-VERSION.md](CONTRACT-VERSION.md).

The idea is to answer one question honestly: **can the split work on Tempo using
only what is already deployed there, with no FlowPay contract at all?**

It can — for most of it. Here is precisely what survives and what does not.

## What it does

One client payment in pathUSD, split across up to four recipient wallets at
percentages fixed in the link, settled in **one transaction** that the client
signs once.

There is no FlowPay contract. The transaction goes to Multicall3 —
`0xcA11bde05977b3631167028862bE2a173976CA11`, already deployed on Tempo — which
runs these calls in order and reverts the whole thing if any one fails:

```
calls[0]   pathUSD.permit(client, Multicall3, crewTotal, deadline, v, r, s)
calls[1..] pathUSD.transferFromWithMemo(client, crewN, amountN, memo)   ×1–4
```

The permit has to come first because Multicall3 is what executes the
`transferFrom` calls, so Multicall3 is the spender. The client signs once
off-chain (free) and confirms once on-chain. Nothing is left approved
afterwards: the transfers consume the allowance inside the same call, so it ends
at zero — asserted in the tests.

## What was removed, and why

**The 10% holdback, the accept step, and the deadline return are gone.** Not
simplified — removed, because there is nothing that can hold the money. A link
holder could send the 10% to a "hold" address, but a plain address cannot
release on acceptance or return on a deadline; it would need the client's key to
move at all, and that is just the client keeping it with extra steps. Tempo has
no escrow, splitting or streaming primitive deployed (0xSplits, Sablier,
Superfluid and Disperse are all absent on both networks), and Safe is not an
escrow — a client-owned Safe means the money never left the client's control.

So the client pays 90% and keeps 10%. The UI says exactly that, in those words,
rather than showing a holdback that holds nothing.

**Nothing is stored on chain.** The terms live in the link:

```
/zero/testnet?amount=2.00&crew=0xabc…:4000,0xdef…:6000
```

Readable on purpose, so a crew member can check their own address and cut
without trusting this app. The cost is real: **whoever holds the link can change
the crew addresses before the client signs.** The permit's EIP-712 type is
`{owner, spender, value, nonce, deadline}` — it does not cover the recipients, so
the signature authorises an amount to Multicall3, not a split to specific
people. The memo is `keccak256` of the terms, which makes the receipt evidence
of *which* terms were paid, but evidence is not enforcement. In the contract
version the split was frozen at `createJob`; here it is frozen nowhere.

**No `reclaim()`.** With no holdback there is nothing to return, so the
deadline has no meaning and is not shown. A deadline field that did nothing
would be a fake affordance.

## What it costs

Measured on live Moderato from mined transactions, not estimated — an earlier
pass of this work had gas estimates three times too low, and the failure mode
was ugly: `eth_call` reported success while every real settlement ran out of
gas.

| crew | calldata | gas |
|---|---|---|
| 1 | 740 B | ~1,073,000 |
| 2 | 1,028 B | ~1,332,000 |
| 3 | 1,316 B | ~1,598,000 |
| 4 | 1,604 B | ~1,865,000 |

The permit is the expensive part (about 810,000 gas on its own, because
pathUSD is a native precompile). `estimateSettlementGas` asks the node for each
real transaction; `gasLimitFor` is the fallback when it cannot.

## Proving it

```
node test/zero-contract.test.mjs --network=testnet
```

39 checks against live Tempo Moderato, importing the same `lib/zerocon.mjs` and
`lib/multicall.mjs` the page imports — so the split the test proves is the split
the UI shows, and the calldata the test signs is the calldata the wallet sends.
It funds a real client from the faucet, signs a real permit, sends a real
transaction, and reads the result back off the chain: every crew balance moves
by exactly its link amount, the allowance ends at zero, and replaying the same
permit is rejected.

The decoder reads **only** `TransferWithMemo` logs. Every
`transferFromWithMemo` also emits a plain `Transfer` with the same value, so
summing both would report double what moved, and Tempo's gas fee is a third
pathUSD transfer that carries no memo at all.

## Running it

```
node test/zero-contract.test.mjs --network=testnet   # prove the split on-chain
node node_modules/next/dist/bin/next build           # local tooling note, see below
```

Create a payment at `/zero/create`; the payment page is `/zero/testnet?…`.

Both routes refuse to do anything on mainnet from this branch — nothing here
has been run against Tempo Mainnet, and no mainnet transaction has been produced.
