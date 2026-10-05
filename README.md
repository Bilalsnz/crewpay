# CrewPay

One client pays one job in **pathUSD on Tempo**. In that single transaction, 90% goes to up to four crew wallets at percentages that were frozen when the payment link was created. The last 10% is held by the contract until the client accepts the work — or, if the deadline passes first, until it is returned to the client.

Every one of those rules is enforced by [`contracts/CrewPay.sol`](contracts/CrewPay.sol). The web app reads state and sends transactions; it decides nothing. Replace the frontend tomorrow and the money still moves the same way.

- No login, no database, no custodial wallet, no simulated transaction.
- The payment link is the record. It carries the network and the job number; everything else is read back from the contract.
- Tempo is the primary and default chain, with a clearly labelled Testnet/Mainnet switch.

---

## The settlement rules, and where they live

| Rule | Enforced by |
| --- | --- |
| 1–4 crew wallets, no more | `createJob` → `NoCrew` / `TooManyCrew` |
| No zero addresses anywhere | `createJob` → `ZeroAddress` (also in the constructor) |
| Percentages must total exactly 100% | `createJob` → `BadShares` |
| Deadline must be in the future, and within 10 years | `createJob` → `DeadlineInPast` / `DeadlineTooFar` |
| Amount must be above zero | `createJob` → `ZeroAmount` |
| Crew, percentages and deadline are immutable after creation | There is no setter. `createJob` is the only write to those fields |
| Only the client may pay | `_requirePayable` → `NotClient` |
| A job can be paid exactly once | `_requirePayable` → `AlreadyPaid` |
| 90% reaches the crew **in the payment transaction** | `_settlePayment` transfers inside `pay` / `payWithPermit` |
| The crew split sums to the 90% exactly | The last crew member absorbs the rounding remainder, so nothing is stranded as dust |
| Only the client may accept | `accept` → `NotClient` |
| Acceptance closes at the deadline | `accept` → `DeadlinePassed` |
| The holdback can only ever reach the client | `reclaim` transfers to `j.client` and to nothing else |
| The holdback returns only after the deadline | `reclaim` → `DeadlineNotPassed` |
| No double settlement | `AlreadyAccepted` / `AlreadyReturned` on both paths |

`statusOf(jobId)` returns `"unpaid" | "paid" | "accepted" | "returned"` straight from contract state. The Status page renders that string and nothing else, so the label cannot drift from what the contract holds.

### One thing a contract cannot do

The brief asked for the 10% to "automatically become returnable" once the deadline passes. No contract can run itself, so there is no timer that fires on its own. What is implemented instead is the strongest thing the chain allows: after the deadline, `reclaim(jobId)` may be called **by anyone**, and the money can only ever go to the client. The client does not need to still hold the link, still hold the keys, or even be online — any passer-by can push the button on their behalf, and cannot divert a unit of it. The switch from "held" to "returnable" is on-chain state (`isReturnable`), not a frontend decision.

---

## Networks

Both networks were probed live, and the values live in [`networks.json`](networks.json). Nothing in the app, the scripts or the tests spells a chain id or a token address a second time.

| | Testnet | Mainnet |
| --- | --- | --- |
| Name | Tempo Moderato Testnet | Tempo |
| Chain id | 42431 (`0xa5bf`) | 4217 (`0x1079`) |
| RPC | `https://rpc.moderato.tempo.xyz` | `https://rpc.tempo.xyz` |
| Explorer | `https://explore.testnet.tempo.xyz` | `https://explore.tempo.xyz` |
| pathUSD | `0x20c0000000000000000000000000000000000000` | same address |
| Faucet | `tempo_fundAddress` | none |

Gas on Tempo is paid in pathUSD, not ETH — so nothing in this codebase sets `msg.value`, and no path waits on a native balance.

**Testnet and mainnet are never mixed.** Every link carries its network (`/job/testnet/3`), opening a link moves the whole app to that network, and the contract address is resolved per network from the environment. A mainnet job is never readable while the app is pointed at testnet.

---

## Running it

```bash
npm install
cp .env.example .env.local     # then fill in what you need
npm run compile                # contracts/CrewPay.sol -> artifacts/ + lib/abi.ts
npm run deploy                 # testnet: generates a key, uses the faucet, deploys
npm test                       # the settlement suite, against the live testnet
npm run build
```

`npm run deploy` writes the address and deploy block into `.env.local`. Copy the `NEXT_PUBLIC_*` values onto Vercel as environment variables.

The deploy script will not generate a key for mainnet, and refuses to deploy there without `--confirm-mainnet`, because a mainnet deploy spends real money from a wallet you must already control.

---

## Tests

`npm test` deploys a fresh CrewPay and runs **38 cases against the live Tempo Moderato testnet** — real accounts funded from the real faucet, real transactions, assertions on real chain state. A local EVM would not catch the things most likely to be wrong here, because they are Tempo-specific: TIP-20 transfer semantics, EIP-2612 permit, and gas paid in the settled token.

```bash
npm test
# 38 tests passed on Tempo Moderato Testnet
```

Covered: every rejection rule listed above; the exact 90/10 split to the unit; that the contract holds precisely the holdback and not a unit more; the accept path; the deadline-return path; refusing to accept after the deadline; refusing to reclaim before it; rounding with percentages that do not divide evenly; a full conservation check that the contract holds exactly the sum of outstanding holdbacks.

Two findings worth keeping:

- **`pay()` needs an approval.** The contract pulls with `transferFrom`, so the plain path is `approve` then `pay`. `payWithPermit` exists so the app can do it in **one** transaction, and the app uses that by default, falling back to approve-then-pay for wallets that will not sign typed data.
- **The permit domain is discovered, not typed in.** `lib/permit.ts` hashes candidate domains and compares against the token's own `DOMAIN_SEPARATOR()`. Writing `name: "PathUSD", version: "1"` into the source would be a guess that fails inside the user's wallet, on their phone, at the worst moment.

---

## Wallets on a phone

The payment flow is built for an Android browser.

- **Inside a wallet's own browser** (MetaMask, OKX, Coinbase, Trust, Rabby) the injected provider is used directly, with one connector per wallet so two installed wallets never fight over `window.ethereum`.
- **In Chrome on a phone** there is no provider at all, so the connect sheet hands the page to the wallet app through its own deep-link wrapper (`metamask.app.link/dapp/…`, OKX's redirect page, and so on). Bare `metamask://`-style schemes do nothing when opened from a page.
- **The wallet is put on the right Tempo network before every write**, adding the chain if the wallet has never seen it (error 4902).
- **A hash is never treated as a payment.** Every button waits for the receipt, every wait is bounded so nothing spins forever, and a cancel in the wallet says so in plain words rather than failing silently.

WalletConnect is not wired up. It needs a Reown project id, and importing `wagmi/connectors` for it pulls a barrel that reaches an optional peer this build does not install. The deep-link flow above is the mobile path that ships.

---

## Layout

```
contracts/CrewPay.sol      the whole product, in one file
artifacts/CrewPay.json     compiled abi + bytecode, committed so Vercel never needs solc
networks.json              the one place a chain id or token address is written down
scripts/compile.mjs        solc -> artifacts + lib/abi.ts
scripts/deploy.mjs         key, faucet, deploy, record address and block
scripts/lib.mjs            shared plumbing: env reader, viem clients, explorer links
test/crewpay.test.mjs      the settlement suite, against live testnet
lib/                       chains, contract access, permit discovery, formatting
components/                the screens
app/                       routes: / and /create, /job/[network]/[id]/{pay,receipt,status}
```

## Secrets

`DEPLOYER_PRIVATE_KEY` lives only in `.env.local`, which is gitignored, and is never exposed under a `NEXT_PUBLIC_` name. The contract address and deploy block are public and are the only values that reach the browser.
