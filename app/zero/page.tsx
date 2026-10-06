import { ZeroCreate } from "@/components/zero-create";
import { BRAND } from "@/lib/brand";

export const metadata = {
  title: `Pay — split one payment between your crew | ${BRAND}`,
  description:
    "One payment in pathUSD splits across up to four crew wallets in a single transaction to Tempo's already-deployed Multicall3. No FlowPay contract is deployed, and none is needed.",
};

export default function Page() {
  return <ZeroCreate />;
}
