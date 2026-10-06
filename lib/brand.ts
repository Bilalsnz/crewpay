/**
 * What FlowPay calls itself, in one place.
 *
 * The rename from CrewPay happened across a lot of screens, and a name spelled
 * out in a dozen files drifts. Everything a person reads is here; every
 * technical identifier — the `zerocon` link codec, the `pathUsd` field, the
 * `crew` query parameter, the contract source — keeps its old name on purpose.
 * Renaming those would touch the payment path for no user-visible gain, and the
 * payment path is the one thing this branch must not break.
 *
 * The historical name is still true: the product is called FlowPay and the
 * people getting paid are still a crew.
 */

export const BRAND = "FlowPay";

/** The hero. Two sentences, because the second one is the point. */
export const TAGLINE = "Move money. Make it work.";
export const SUPPORTING = "Pay people in one transaction, then put idle stablecoins to work.";

/** The one-line description of what FlowPay is. */
export const POSITIONING = "Move money. Split payments. Put idle stablecoins to work.";

export const META_TITLE = `${BRAND} | Pay and Earn`;
export const META_DESCRIPTION =
  "Split stablecoin payments in one transaction and explore yield opportunities across supported networks.";

/**
 * The footers say what the page in front of you actually did. The Pay footer
 * claims no contract because this branch deploys none — Multicall3 is Tempo's,
 * and it was there before FlowPay was.
 */
export const FOOTER_HOME = `${BRAND} · Pay on Tempo Moderato · Earn across four networks`;
export const FOOTER_PAY_CREATE = `${BRAND} · one payment, split by Tempo's Multicall3 · no ${BRAND} contract`;
export const FOOTER_PAY_JOB = `${BRAND} · settled by Multicall3 on Tempo · no ${BRAND} contract`;
export const FOOTER_EARN = `${BRAND} Earn · an opportunity explorer · no yield integration is live yet`;
