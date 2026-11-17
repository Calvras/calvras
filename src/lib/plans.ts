import { CHECKOUT_URLS, type PlanKey } from "./billing";

/**
 * The plans Calvras sells, and where a buyer pays for them.
 *
 * Payment runs on Payments AI's hosted checkout, so the app only ever needs a URL: no SDK key and no
 * card details travel to the desktop. The plan ids live in the site's own code (see ./billing), and
 * every paid plan on the page has a checkout rather than one that cannot bill.
 */

export type PaidPlan = { name: "Lite" | "Pro"; key: PlanKey };

export const paidPlans: PaidPlan[] = [
  { name: "Lite", key: "lite" },
  { name: "Pro", key: "pro" },
];

/** The hosted checkout for a plan. The buyer enters the email they sign in to Calvras with there,
 *  and the store's customer.created webhook is what ties the payment back to that account. */
export function checkoutFor(name: string): string {
  const plan = paidPlans.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return plan ? CHECKOUT_URLS[plan.key] : "";
}