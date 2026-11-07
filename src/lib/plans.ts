import { isBillingCycle, isPlanKey, type BillingCycle } from "./billing";

/**
 * The plans Calvras sells, and where a buyer pays for them.
 *
 * Payment runs on calvras.com through RevenueCat Web Billing, so the app only ever needs a URL: no
 * SDK key and no card details travel to the desktop. The package ids live in the site's own code
 * (see ./billing), and every paid plan on the page has a checkout rather than one that cannot bill.
 */
export const CHECKOUT_ORIGIN = "https://calvras.com";

export type PaidPlan = { name: "Pro" | "Ultra"; key: "pro" | "ultra" };

export const paidPlans: PaidPlan[] = [
  { name: "Pro", key: "pro" },
  { name: "Ultra", key: "ultra" },
];

/** The checkout page for a plan, carrying the signed-in email so the webhook can find the account. */
export function checkoutFor(name: string, billing: BillingCycle = "month", email = ""): string {
  const plan = paidPlans.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!plan || !isPlanKey(plan.key) || !isBillingCycle(billing)) return "";
  const query = `plan=${plan.key}&billing=${billing}${email ? `&email=${encodeURIComponent(email)}` : ""}`;
  return `${CHECKOUT_ORIGIN}/checkout?${query}`;
}
