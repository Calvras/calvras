/**
 * Payments AI, the merchant of record: what Calvras sells and how the site proves a webhook came
 * from the store. The checkout URLs are public — every buyer can read them — so they live in code.
 * The webhook signing secret is a Worker secret and never reaches a browser.
 *
 * Setup that has to exist in the Payments AI dashboard for these ids to resolve:
 *   product "calvras" → plan Lite $12/month and plan Pro $30/month, recurring, billed every 1 month.
 */

export type PlanKey = "lite" | "pro";

export const PLAN_LABELS: Record<PlanKey, string> = { lite: "Lite", pro: "Pro" };

/** The hosted checkout for each plan, exactly as the dashboard created it. */
export const CHECKOUT_URLS: Record<PlanKey, string> = {
  lite: "https://mor.payments.ai/payment/01a1e81a-f39f-792d-b320-8a32c2c49905",
  pro: "https://mor.payments.ai/payment/01a1e81d-0489-740f-89e4-4c477f0d58cc",
};

/** What the pricing page prints: the amount each dashboard plan was created with, in USD. */
export const LIST_PRICES: Record<PlanKey, number> = { lite: 12, pro: 30 };

export const isPlanKey = (value: unknown): value is PlanKey => value === "lite" || value === "pro";

export function listPrice(plan: PlanKey): string {
  return LIST_PRICES[plan].toFixed(2);
}

/** Payments AI deliveries carry no plan id, only what was charged, so the amount is the catalog key.
 *  An amount the store does not sell is left alone rather than guessed at. */
export function planForAmount(amount: unknown): PlanKey | null {
  const value = Number(amount);
  if (value === LIST_PRICES.lite) return "lite";
  if (value === LIST_PRICES.pro) return "pro";
  return null;
}

/** Every plan on sale, in the shape the pricing page and the console read. */
export function packageCatalog(): { plan: PlanKey; label: string; price: string; checkout: string }[] {
  return (Object.keys(CHECKOUT_URLS) as PlanKey[]).map((plan) => ({ plan, label: PLAN_LABELS[plan], price: listPrice(plan), checkout: CHECKOUT_URLS[plan] }));
}

/** The account a purchase belongs to. Payments AI sends the buyer's email on customer.created; the
 *  payment and subscription events carry the customer id that points at it. */
export function buyerEmail(event: Record<string, unknown>): string {
  return String(event["email"] ?? "").trim().toLowerCase();
}

/**
 * Payments AI signs each delivery as `sha256=<hex hmac>` over `<timestamp>.<raw body>` with SHA-256,
 * the timestamp arriving in X-Webhook-Timestamp as whole seconds. The body is verified before it is
 * parsed, because re-serializing JSON changes the bytes the signature covers. The timestamp bound is
 * a day, not minutes: the store retries a delivery up to 15 minutes later and a replay of a signed
 * event only rewrites the same ledger row, which the eventId dedupe already drops.
 */
export async function verifyPaymentsAiSignature(signatureHeader: string | null, timestampHeader: string | null, rawBody: string, secret: string, nowMs: number, toleranceMs = 24 * 60 * 60 * 1000): Promise<boolean> {
  const signature = String(signatureHeader ?? "").trim();
  const timestamp = String(timestampHeader ?? "").trim();
  const ts = Number(timestamp);
  if (!signature.startsWith("sha256=") || !secret || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(ts)) return false;
  if (Math.abs(nowMs - ts * 1000) > toleranceMs) return false;
  const digest = signature.slice(7);
  const bytes = hexBytes(digest);
  if (!bytes || bytes.length !== 32) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, bytes.buffer as ArrayBuffer, encoder.encode(`${ts}.${rawBody}`));
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}