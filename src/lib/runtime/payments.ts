import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** The merchant's own credentials. They live beside the model keys, in the per-user app folder,
 * and are only ever read by this server process — the renderer sees a masked status, never a key. */
type PaymentsConfig = { apiKey?: string; merchantId?: string };

const LIVE_API = "https://mor.payments.ai/api";
const file = () => path.join(process.env["LOCALAPPDATA"] || path.join(os.homedir(), ".local", "share"), "Calvras", "payments.json");

function stored(): PaymentsConfig {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; }
}

export function paymentsStatus() {
  const config = stored();
  const key = config.apiKey || "";
  return {
    hasKey: key.startsWith("pai_live_") || key.startsWith("pai_test_"),
    live: key.startsWith("pai_live_"),
    keyHint: key ? `…${key.slice(-4)}` : "",
    merchantId: config.merchantId || "",
  };
}

const isKey = (value: string) => /^pai_(live|test)_[0-9a-f]{32,}$/i.test(value);
const isMerchantId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function setPaymentsConfig(patch: { apiKey?: unknown; merchantId?: unknown }) {
  const next = stored();
  if (patch.apiKey !== undefined) {
    const apiKey = String(patch.apiKey).trim();
    if (apiKey && !isKey(apiKey)) throw new Error("That is not a Payments AI key. They start with pai_live_ or pai_test_.");
    if (apiKey) next.apiKey = apiKey; else delete next.apiKey;
  }
  if (patch.merchantId !== undefined) {
    const merchantId = String(patch.merchantId).trim();
    if (merchantId && !isMerchantId(merchantId)) throw new Error("The merchant id is the 36-character id shown in the Payments AI dashboard.");
    if (merchantId) next.merchantId = merchantId.toLowerCase(); else delete next.merchantId;
  }
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + ".tmp", JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
  return paymentsStatus();
}

async function api(pathname: string, init?: { method?: string; key?: string; body?: string }) {
  const response = await fetch(`${LIVE_API}${pathname}`, {
    method: init?.method || "GET",
    headers: { accept: "application/json", ...(init?.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init?.body ? { "content-type": "application/json" } : {}) },
    ...(init?.body ? { body: init.body } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

/** A provider error body is the honest reason; keep it short and never echo the request headers. */
function reason(payload: unknown, status: number) {
  const record = (payload || {}) as { message?: unknown; error?: unknown };
  const text = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : "";
  return text ? `HTTP ${status}: ${text.slice(0, 180)}` : `HTTP ${status}`;
}

export type PaidPlan = { planId: string; planName: string; productName: string; amount: number; currency: string; interval: string; checkoutUrl: string };

const list = (payload: unknown): Record<string, unknown>[] => Array.isArray(payload) ? payload as Record<string, unknown>[]
  : Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: Record<string, unknown>[] }).data
    : Array.isArray((payload as { items?: unknown })?.items) ? (payload as { items: Record<string, unknown>[] }).items : [];

const numberAt = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) { const value = row[key]; if (typeof value === "number" && Number.isFinite(value)) return value; }
  return 0;
};
const textAt = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) { const value = row[key]; if (typeof value === "string" && value) return value; }
  return "";
};

function toPlan(productName: string, row: Record<string, unknown>, checkoutUrl: string): PaidPlan {
  return {
    planId: textAt(row, ["id", "planId"]),
    planName: textAt(row, ["name", "planName"]) || productName,
    productName,
    amount: numberAt(row, ["amount", "price", "unitAmount"]),
    currency: (textAt(row, ["currency"]) || "usd").toLowerCase(),
    interval: (textAt(row, ["interval", "billingInterval", "period"]) || "one-time").toLowerCase(),
    checkoutUrl: checkoutUrl || `https://mor.payments.ai/payment/${textAt(row, ["id", "planId"])}`,
  };
}

/** Read the merchant's live catalogue. Products and plans are separate routes, and only the
 * buyer-facing checkout route is guaranteed to carry a usable checkout url. */
export async function paymentsCatalog(): Promise<{ ok: boolean; plans: PaidPlan[]; error: string }> {
  const config = stored();
  if (!config.apiKey || !config.merchantId) return { ok: false, plans: [], error: "Calvras has no Payments AI merchant id saved yet." };
  const products = await api(`/v1/public-api/merchants/${config.merchantId}/products`, { key: config.apiKey });
  if (!products.ok) return { ok: false, plans: [], error: reason(products.payload, products.status) };
  const plans: PaidPlan[] = [];
  for (const product of list(products.payload)) {
    const productName = textAt(product, ["name", "title"]) || "Product";
    const nested = list(product["plans"]);
    if (nested.length) {
      for (const row of nested) plans.push(toPlan(productName, row, textAt(row, ["checkoutUrl", "purchaseUrl"])));
      continue;
    }
    const productId = textAt(product, ["id", "productId"]);
    if (!productId) continue;
    const fetched = await api(`/v1/public-api/merchants/${config.merchantId}/products/${productId}/plans`, { key: config.apiKey });
    if (!fetched.ok) return { ok: false, plans: [], error: reason(fetched.payload, fetched.status) };
    for (const row of list(fetched.payload)) plans.push(toPlan(productName, row, textAt(row, ["checkoutUrl", "purchaseUrl"])));
  }
  return { ok: true, plans: plans.filter((plan) => plan.planId), error: "" };
}
