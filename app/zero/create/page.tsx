import { ZeroCreate } from "@/components/zero-create";

/**
 * `/zero/create` is the create screen, and so is `/zero`.
 *
 * The alias exists because `/zero/create` is the URL people reach for, and a
 * 404 there reads as a broken app rather than as a different scheme. Both
 * routes render the same component, so they cannot drift apart.
 */
export const metadata = { title: "CrewPay Zero — create a job" };

export default function Page() {
  return <ZeroCreate />;
}
