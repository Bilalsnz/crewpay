import { EarnExplorer } from "@/components/earn-explorer";
import { BRAND } from "@/lib/brand";

export const metadata = {
  title: `Earn — stablecoin yield opportunities | ${BRAND}`,
  description:
    "Explore stablecoin yield opportunities across supported networks and protocols. FlowPay shows an opportunity as verified only when a real integration exists.",
};

export default function Page() {
  return <EarnExplorer />;
}
