/**
 * RevenueCat Web Billing: what Calvras sells, which package each plan is bought as, and how the site
 * proves a webhook came from RevenueCat.
 *
 * The public SDK key and the product ids are public — they ride in the checkout page every buyer can
 * read — so they live in code. The webhook secret is a Worker secret and never reaches a browser.
 *
 * Setup that has to exist in the RevenueCat dashboard for these ids to resolve:
 *   entitlement "pro"   → calvras_pro_month, calvras_pro_year
 *   entitlement "ultra" → calvras_ultra_month, calvras_ultra_year
 *   offering "calvras"  → packages pro_month, pro_year, ultra_month, ultra_year
 */

export type PlanKey = "pro" | "ultra";
export type BillingCycle = "month" | "year";

export const PLAN_LABELS: Record<PlanKey, string> = { pro: "Pro", ultra: "Ultra" };

export const BILLING_OFFERING = "calvras";

export const PACKAGE_IDS: Record<PlanKey, Record<BillingCycle, string>> = {
  pro: { month: "pro_month", year: "pro_year" },
  ultra: { month: "ultra_month", year: "ultra_year" },
};

/** The product identifiers the dashboard's web catalog has to carry, in the same shape. */
export const PRODUCT_IDS: Record<PlanKey, Record<BillingCycle, string>> = {
  pro: { month: "calvras_pro_month", year: "calvras_pro_year" },
  ultra: { month: "calvras_ultra_month", year: "calvras_ultra_year" },
};

/** What the pricing page prints. RevenueCat charges what the dashboard says, so this is the same
 *  list price the product was created with — not a figure read back from a receipt. */
export const LIST_PRICES: Record<PlanKey, Record<BillingCycle, string>> = {
  pro: { month: "9.00", year: "79.00" },
  ultra: { month: "20.00", year: "179.00" },
};

export const isPlanKey = (value: unknown): value is PlanKey => value === "pro" || value === "ultra";
export const isBillingCycle = (value: unknown): value is BillingCycle => value === "month" || value === "year";

export function packageKey(plan: unknown, billing: unknown): string {
  if (!isPlanKey(plan)) return "";
  return PACKAGE_IDS[plan][isBillingCycle(billing) ? billing : "month"];
}

export function listPrice(plan: PlanKey, billing: BillingCycle): string {
  return LIST_PRICES[plan][billing];
}

/** RevenueCat names the product, not the plan. The catalog above is the only place that knows how
 *  a product id becomes a plan, and an id it does not recognize is left alone rather than guessed. */
export function planForProduct(productId: unknown): { plan: PlanKey; billing: BillingCycle } | null {
  const wanted = String(productId ?? "").trim().toLowerCase();
  if (!wanted) return null;
  for (const plan of Object.keys(PRODUCT_IDS) as PlanKey[]) {
    for (const billing of ["month", "year"] as BillingCycle[]) {
      if (PRODUCT_IDS[plan][billing].toLowerCase() === wanted) return { plan, billing };
    }
  }
  return null;
}

/** Entitlements are the durable thing RevenueCat tracks. A person can hold both if they upgraded
 *  before the old plan lapsed, and the higher plan is what they are paying for. */
export function planForEntitlements(ids: unknown): PlanKey | null {
  const list = Array.isArray(ids) ? ids.map((id) => String(id).toLowerCase()) : [];
  if (list.includes("ultra")) return "ultra";
  if (list.includes("pro")) return "pro";
  return null;
}

/** Every package the checkout page needs to find, in the shape it reads. */
export function packageCatalog(): { plan: PlanKey; label: string; billing: BillingCycle; packageId: string; productId: string; price: string }[] {
  const rows: { plan: PlanKey; label: string; billing: BillingCycle; packageId: string; productId: string; price: string }[] = [];
  for (const plan of Object.keys(PACKAGE_IDS) as PlanKey[]) {
    for (const billing of ["month", "year"] as BillingCycle[]) {
      rows.push({ plan, label: PLAN_LABELS[plan], billing, packageId: PACKAGE_IDS[plan][billing], productId: PRODUCT_IDS[plan][billing], price: LIST_PRICES[plan][billing] });
    }
  }
  return rows;
}

/** The account a purchase belongs to. Checkout configures the SDK with the signed-in email as the
 *  app user id, so that is the field every event carries. */
export function buyerEmail(event: Record<string, unknown>): string {
  const identity = (event["identity"] || {}) as Record<string, unknown>;
  const raw = event["app_user_id"] ?? identity["app_user_id"] ?? event["original_app_user_id"];
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * RevenueCat signs each delivery as `t=<seconds>,v1=<hex hmac>` over `<t>.<raw body>` with SHA-256.
 * The signature is opt-in in the dashboard; the plain Authorization header it also sends is checked
 * separately. The timestamp is bounded so a captured request cannot be replayed forever — but the
 * bound is a day, not minutes, because RevenueCat retries a delivery after a deploy and a replay only
 * rewrites the same ledger row.
 */
export async function verifyRevenueCatSignature(header: string | null, rawBody: string, secret: string, nowMs: number, toleranceMs = 24 * 60 * 60 * 1000): Promise<boolean> {
  const raw = String(header ?? "").trim();
  if (!raw || !secret) return false;
  const parts = raw.split(",").map((piece) => piece.trim()).filter(Boolean);
  const ts = Number(parts.find((piece) => piece.startsWith("t="))?.slice(2));
  const signatures = parts.filter((piece) => piece.startsWith("v1=")).map((piece) => piece.slice(3)).filter(Boolean);
  if (!Number.isFinite(ts) || !signatures.length) return false;
  if (Math.abs(nowMs - ts * 1000) > toleranceMs) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const message = encoder.encode(`${ts}.${rawBody}`);
  for (const signature of signatures) {
    const bytes = hexBytes(signature);
    if (bytes && await crypto.subtle.verify("HMAC", key, bytes.buffer as ArrayBuffer, message)) return true;
  }
  return false;
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
