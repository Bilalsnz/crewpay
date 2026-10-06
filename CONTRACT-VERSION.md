# The contract version (preserved, not the product)

This documents **CrewPay**, the original contract-based version. It is `main`'s
product. On the `zero-contract` branch it is kept intact and unlinked: its
screens still live at `/create` and `/job/*`, its tests still run, and its
contract source is unchanged. It is **not** what FlowPay's navigation reaches —
those routes need `NEXT_PUBLIC_CREWPAY_ADDRESS_TESTNET` and, on this branch, no
contract is deployed for them to talk to.

For the product this branch actually ships, see [README.md](README.md).

---

One client pays one job in **pathUSD on Tempo**. In that single transaction, 90%
goes to up to four crew wallets at percentages that were frozen when the payment
link was created. The last 10% is held by the contract until the client accepts
the work — or, if the deadline passes first, until it is returned to the client.

Every one of those rules is enforced by [`contracts/CrewPay.sol`](contracts/CrewPay.sol).
The web app reads state and sends transactions; it decides nothing. Replace the
frontend tomorrow and the money still moves the same way.

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

`statusOf(jobId)` returns `"unpaid" | "paid" | "accepted" | "returned"` straight
from contract state. The Status page renders that string and nothing else, so the
label cannot drift from what the contract holds.

### One thing a contract cannot do

The brief asked for the 10% to "automatically become returnable" once the
deadline passes. No contract can run itself, so there is no timer that fires on
its own. What is implemented instead is the strongest thing the chain allows:
after the deadline, `reclaim(jobId)` may be called **by anyone**, and the money
can only ever go to the client. The client does not need to still hold the link,
still hold the keys, or even be online — any passer-by can push the button on
their behalf, and cannot divert a unit of it. The switch from "held" to
"returnable" is on-chain state (`isReturnable`), not a frontend decision.

## Running it

```bash
npm run compile                # contracts/CrewPay.sol -> artifacts/ + lib/abi.ts
npm run deploy                 # testnet: generates a key, uses the faucet, deploys
node test/crewpay.test.mjs     # the settlement suite, against the live testnet
```

`npm run deploy` writes the address and deploy block into `.env.local`. Copy the
`NEXT_PUBLIC_*` values onto Vercel as environment variables.

The deploy script will not generate a key for mainnet, and refuses to deploy
there without `--confirm-mainnet`, because a mainnet deploy spends real money
from a wallet you must already control.

## Tests

`node test/crewpay.test.mjs` deploys a fresh CrewPay and runs **38 cases against
the live Tempo Moderato testnet** — real accounts funded from the real faucet,
real transactions, assertions on real chain state.

Covered: every rejection rule listed above; the exact 90/10 split to the unit;
that the contract holds precisely the holdback and not a unit more; the accept
path; the deadline-return path; refusing to accept after the deadline; refusing
to reclaim before it; rounding with percentages that do not divide evenly; a full
conservation check that the contract holds exactly the sum of outstanding
holdbacks.

Two findings worth keeping:

- **`pay()` needs an approval.** The contract pulls with `transferFrom`, so the
  plain path is `approve` then `pay`. `payWithPermit` exists so the app can do it
  in **one** transaction, and the app uses that by default, falling back to
  approve-then-pay for wallets that will not sign typed data.
- **The permit domain is discovered, not typed in.** `lib/permit.ts` hashes
  candidate domains and compares against the token's own `DOMAIN_SEPARATOR()`.
  Writing `name: "PathUSD", version: "1"` into the source would be a guess that
  fails inside the user's wallet, on their phone, at the worst moment.
