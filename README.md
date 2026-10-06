# FlowPay

**Move money. Make it work.**

Pay people in one transaction, then put idle stablecoins to work.

Two products, one site:

| | What it does | Where |
| --- | --- | --- |
| **Pay** | Splits one stablecoin payment between up to four people, in one transaction, with no FlowPay contract deployed. Tempo Moderato testnet only | `/zero/create` |
| **Earn** | Live stablecoin pools on Tempo mainnet, read from a public source, plus a discovery registry for Base, Arbitrum and Ethereum | `/earn` |

This is the `zero-contract` branch. **`main` is untouched** and still carries the
original contract version of CrewPay — see [CONTRACT-VERSION.md](CONTRACT-VERSION.md).
Nothing on this branch deploys a contract, and nothing here has been run against
Tempo Mainnet.

- No login, no database, no custodial wallet, no simulated transaction.
- **Pay settles on Tempo Moderato testnet and nowhere else.** There is no
  Testnet/Mainnet switch, because a switch that offers a network the app cannot
  pay on is a promise the code cannot keep. A wallet connected elsewhere is
  asked to move, automatically.

---

## Pay

One client payment in pathUSD, split across up to four recipients at percentages
fixed in the link, settled in **one transaction** the client signs once.

There is no FlowPay contract. The transaction goes to **Multicall3** —
`0xcA11bde05977b3631167028862bE2a173976CA11`, already deployed on Tempo — which
runs these calls in order and reverts all of them if any one fails:

```
calls[0]    pathUSD.permit(client, Multicall3, crewTotal, deadline, v, r, s)
calls[1..]  pathUSD.transferFromWithMemo(client, recipientN, amountN, memo)   ×1–4
```

The permit comes first because Multicall3 is what executes the `transferFrom`
calls, so Multicall3 is the spender. The client signs once off-chain (free) and
confirms once on-chain. Nothing is left approved afterwards — the transfers
consume the allowance inside the same call, so it ends at zero, which the tests
assert on chain.

**Nothing is stored.** The terms live in the link, readable on purpose so a
recipient can check their own address and share without trusting this app:

```
/zero/testnet?amount=2.00&crew=0xabc…:4000,0xdef…:6000
```

### The trade this design makes

The client pays the crew portion and keeps the rest. There is no holdback, no
accept step and no deadline return, because there is nothing that could hold the
money — Tempo has no escrow, splitting or streaming primitive deployed.

The permit's EIP-712 type is `{owner, spender, value, nonce, deadline}`. It does
**not** cover the recipients, so whoever holds the link can change the addresses
before the client signs. The memo is `keccak256` of the terms, which makes the
receipt evidence of *which* terms were paid — evidence is not enforcement. The
contract version froze the split at `createJob`; here it is frozen nowhere.

### What it costs

Measured on live Moderato from mined transactions, not estimated. An earlier pass
of this work had estimates three times too low, and `eth_call` reported success
while every real settlement ran out of gas — so the numbers below are read off
receipts.

| recipients | calldata | gas |
| --- | --- | --- |
| 1 | 740 B | ~1,073,000 |
| 2 | 1,028 B | ~1,332,000 |
| 3 | 1,316 B | ~1,598,000 |
| 4 | 1,604 B | ~1,865,000 |

The permit is the expensive part — about 810,000 gas on its own, because pathUSD
is a native precompile.

---

## Earn

`/earn` and `/earn/[id]`. Earn is two things, kept visibly apart.

**Live pools on Tempo mainnet.** [`lib/yields.ts`](lib/yields.ts) reads
[DeFiLlama's public Yields API](https://yields.llama.fi/pools) — no key, no
account — and shows every pool it reports on Tempo mainnet (chain 4217). Those
numbers are real and come off the wire: APY broken out into base interest and
token rewards, TVL, the 30-day mean, the underlying and reward token addresses,
and the source's own protocol slug. Anything the source does not publish renders
as "unavailable" rather than as a plausible figure. The page re-reads the source
every 30 minutes and says when it last did.

**A discovery registry.** [`lib/earn.ts`](lib/earn.ts) is a plain typed array —
no database, no auth. Nothing in it is verified, and that is the honest state:
FlowPay has no deployed yield integration on any network, so every entry is
`status: "coming-soon"` with `protocol`, `apy`, `tvlUsd` and `risk` all `null`,
and the deposit button is disabled with the reason printed underneath it.

**They are on different networks and the page says so in every row.** Pay
settles on Tempo Moderato testnet, chain 42431. The live pools are on Tempo
mainnet, chain 4217. The balance card reads `pathUSD.balanceOf` on the Pay
network, because that is where this wallet's pathUSD actually is; the live
pools are labelled mainnet. The two are never merged into a single "Tempo".

**AI analysis.** The live pools can be sent to Groq for a plain-language read.
The browser sends only pool ids — the server re-reads the data from the source
itself before prompting, so the model cannot be handed invented numbers. The
prompt states that the supplied data is authoritative, forbids any figure,
protocol or safety claim that is not in it, and requires the answer to say
FlowPay has not audited anything. See [Secrets](#secrets) for the key.

The `verified` status and its badge exist so the first real integration is one
row here, not a redesign. Risk labels are FlowPay's own informational
classification, not a rating, an audit or a guarantee.

---

## Networks

Both networks were probed live, and the values live in
[`networks.json`](networks.json). Nothing in the app, the scripts or the tests
spells a chain id or a token address a second time.

| | Testnet | Mainnet |
| --- | --- | --- |
| Name | Tempo Moderato Testnet | Tempo |
| Chain id | 42431 (`0xa5bf`) | 4217 (`0x1079`) |
| RPC | `https://rpc.moderato.tempo.xyz` | `https://rpc.tempo.xyz` |
| Explorer | `https://explore.testnet.tempo.xyz` | `https://explore.tempo.xyz` |
| pathUSD | `0x20c0000000000000000000000000000000000000` | same address |
| Faucet | `tempo_fundAddress` | none |

Gas on Tempo is paid in pathUSD, not ETH — so nothing here sets `msg.value`, and
no path waits on a native balance.

**Testnet and mainnet are never mixed, and Pay never touches mainnet.** Every
payment link carries its network, so a link can never be paid on the wrong one —
and Pay accepts only Moderato. A link written for mainnet is refused in words
rather than quietly redirected, because rewriting a link's network would change
what "2.00" means and where it goes without anyone agreeing to it.

**A wallet connected to another EVM chain is moved automatically.** On connect,
and again whenever the chain changes, FlowPay asks the wallet to switch to
Moderato (adding the chain, with `networks.json` as the only source of its id,
RPC and explorer, if the wallet has never seen it), then re-reads `eth_chainId`
rather than assuming the request was honoured. There is no "switch it yourself
and reload" anywhere in the app: a rejected switch leaves an actionable message
and a retry button.

Tempo Mainnet is configured but **unproven**: no mainnet transaction has ever
been produced by this codebase, and no mainnet payment should be treated as
tested.

---

## Running it

```bash
npm install
node node_modules/next/dist/bin/next build     # npm is unreliable on this device
node test/zero-contract.test.mjs               # 39 checks, live Moderato
node test/crewpay.test.mjs                     # 38 checks, the contract version
```

`npm install` and `npm test` work on a normal machine. On the device this was
built on, npm is wedged and dependencies are installed from registry tarballs by
[`install.mjs`](install.mjs).

---

## Tests

**Pay, against the live chain.** `node test/zero-contract.test.mjs` runs **39
checks against Tempo Moderato**, importing the same `lib/zerocon.mjs` and
`lib/multicall.mjs` the page imports — so the split the test proves is the split
the UI shows, and the calldata the test signs is the calldata the wallet sends.
It funds a real client from the faucet, signs a real permit, sends a real
transaction and reads the result back off the chain: every recipient balance
moves by exactly its link amount, the allowance ends at zero, and replaying the
permit is rejected.

A local EVM would not catch what goes wrong here, because it is Tempo-specific:
TIP-20 transfer semantics, EIP-2612 permit, and gas paid in the settled token.

The decoder reads **only** `TransferWithMemo` logs. Every `transferFromWithMemo`
also emits a plain `Transfer` with the same value, so summing both would report
double what moved — and Tempo's gas fee is a third pathUSD transfer that carries
no memo at all.

**The contract version.** `node test/crewpay.test.mjs` runs its 38 checks
unchanged. Those screens are still on this branch at `/create` and `/job/*`, just
not linked from FlowPay's navigation.

---

## Wallets on a phone

The payment flow is built for an Android browser.

- **Inside a wallet's own browser** (MetaMask, OKX, Coinbase, Trust, Rabby) the
  injected provider is used directly, with one connector per wallet so two
  installed wallets never fight over `window.ethereum`.
- **In Chrome on a phone** there is no provider, so the connect sheet hands the
  page to the wallet app through its own deep-link wrapper. Bare `metamask://`
  style schemes do nothing when opened from a page.
- **The wallet is moved to the right Tempo network automatically** — on connect
  and on every chain change, not only at the moment of paying. The chain is added
  first if the wallet has never seen it (error 4902), and the wallet's own
  `eth_chainId` is re-read afterwards instead of trusting the request.
- **A hash is never treated as a payment.** Every button waits for the receipt,
  every wait is bounded so nothing spins forever, and every failure says which
  one it was: no wallet connected, provider unavailable, switch declined,
  cancelled, rejected. The pay button cannot silently do nothing.

WalletConnect is not wired up. It needs a Reown project id, and importing
`wagmi/connectors` for it pulls a barrel that reaches an optional peer this build
does not install. The deep-link flow above is the mobile path that ships.

---

## Layout

```
app/page.tsx               the home: Pay and Earn
app/earn/                  the Earn explorer and its detail pages
app/zero/                  Pay: /zero, /zero/create, /zero/pay, /zero/status, /zero/[network]
app/api/analyze/           the Groq route — reads GROQ_API_KEY, server only
lib/brand.ts               every user-visible FlowPay string
lib/earn.ts                the Earn discovery registry
lib/yields.ts              the live Tempo mainnet yield data, read from the source
lib/zerocon.mjs            link codec, split math — shared by the app and the tests
lib/multicall.mjs          permit typed-data, Multicall3 builder, log decoder
networks.json              the one place a chain id or token address is written down
test/zero-contract.test.mjs  the Pay suite, against live testnet
components/                the screens
app/create, app/job/       the contract version, preserved and unlinked
contracts/CrewPay.sol      the contract version's rules, untouched
```

## Secrets

`DEPLOYER_PRIVATE_KEY` lives only in `.env.local`, which is gitignored, and is
never exposed under a `NEXT_PUBLIC_` name. Nothing on this branch needs it to
run — there is no deploy step.

`GROQ_API_KEY` is what Earn's AI analysis uses. It is read in
`app/api/analyze/route.ts`, on the server, and is never prefixed `NEXT_PUBLIC_`
and never sent to the browser. Without it the app builds and runs normally and
the analysis panel reports that the service is not configured — it does not
substitute a canned analysis for a real one. `GROQ_MODEL` optionally overrides
the model id; it must be one Groq actually serves.
