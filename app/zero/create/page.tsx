import { ZeroCreate } from "@/components/zero-create";
import { BRAND } from "@/lib/brand";

/**
 * `/zero/create` is the Pay screen, and so is `/zero`, and so is the Pay link
 * in the navigation.
 *
 * The alias exists because `/zero/create` is the URL people reach for, and a
 * 404 there reads as a broken app rather than as a different scheme. All of
 * them render the same component, so they cannot drift apart.
 */
export const metadata = {
  title: `Pay — create a payment | ${BRAND}`,
  description: "Set an amount and up to four crew wallets, then send the payment link.",
};

export default function Page() {
  return <ZeroCreate />;
}
