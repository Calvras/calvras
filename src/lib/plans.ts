/**
 * The plans Calvras sells, and where a buyer pays for them.
 *
 * Payments AI's hosted checkout takes only a plan id in the URL, so this file is all a visitor needs:
 * no store key and no merchant id ever travels to the browser. A plan with an empty planId has not
 * been created in the store yet, and the pages say so instead of offering a payment they cannot take.
 */
export const CHECKOUT_BASE = "https://mor.payments.ai/payment";

export type PaidPlan = { name: "Pro" | "Ultra"; planId: string };

export const paidPlans: PaidPlan[] = [
  { name: "Pro", planId: "" },
  { name: "Ultra", planId: "" },
];

/** The page a buyer lands on to pay, or "" while the plan is not in the store. */
export function checkoutFor(name: string): string {
  const plan = paidPlans.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return plan?.planId ? `${CHECKOUT_BASE}/${plan.planId}` : "";
}
