import { ZeroCreate } from "@/components/zero-create";

/**
 * The front door of THIS BRANCH is the zero-contract flow.
 *
 * It used to be the contract version's home screen, whose "Create a job" button
 * pointed at `/create` — the contract create screen. That screen needs
 * `NEXT_PUBLIC_CREWPAY_ADDRESS_TESTNET` and has no contract to talk to on this
 * branch, so the natural path through the deployed app walked out of the
 * zero-contract flow and into "CrewPay is not deployed in this build". Nothing
 * was wrong with `/zero/create`; the route into it was.
 *
 * The contract version is untouched. Its screens are exactly as they were and
 * still live at `/create` and `/job/*` — `components/home-screen.tsx` is left
 * in place, unreferenced, so reverting this one file restores the old landing
 * and nothing else has to change.
 */
export const metadata = {
  title: "CrewPay Zero — split a payment without a contract",
  description:
    "One payment in pathUSD splits across up to four crew wallets in a single transaction to Tempo's already-deployed Multicall3. No CrewPay contract is deployed, and none is needed.",
};

export default function Page() {
  return <ZeroCreate />;
}
