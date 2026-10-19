import { verifyGoogleIdentity } from "./runtime/google-identity";
import { accountEvents, deleteAccount, grantPlan, listAccounts, recentEvents, recordSignIn, summarize, type D1Database } from "./runtime/ledger";

/**
 * The public site's own API: who has signed in, what plan they hold, and what the owner can do about
 * it. It lives on the hosted Worker, so unlike /api/agent it is meant to answer calvras.com — and it
 * holds nothing that belongs to the computer it is running on.
 */

export type SiteEnv = {
  CALVRAS_DB?: D1Database;
  CALVRAS_ADMIN_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  CALVRAS_PAYMENTS_KEY?: string;
  CALVRAS_PAYMENTS_MERCHANT?: string;
};

const PAYMENTS_BASE = "https://mor.payments.ai/api";

/** The desktop app calls this from a different origin, and nothing here is cookie-based, so a bare
 *  wildcard is what lets it read its own plan back. Admin calls still carry the owner token. */
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...cors } });
}

/** Same length, same work, whatever differs — so a wrong token cannot be read out one byte at a time. */
function sameToken(provided: string, expected: string): boolean {
  if (!expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < provided.length; index += 1) diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return diff === 0;
}

function isAdmin(request: Request, env: SiteEnv): boolean {
  const header = request.headers.get("authorization") || "";
  return sameToken(header.replace(/^Bearer\s+/i, "").trim(), String(env.CALVRAS_ADMIN_TOKEN || "").trim());
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Cloudflare tags every request it proxies with where the visitor roughly is: a country code always,
 * a city when the plan exposes it. The owner console reads this to spot a sign-in from somewhere
 * unexpected. The IP address itself is never stored. */
function signInLocation(request: Request): { city: string; country: string } {
  const cf = (request as Request & { cf?: { city?: unknown; country?: unknown } }).cf;
  const decode = (value: unknown) => {
    try { return decodeURIComponent(String(value ?? "").trim()); } catch { return ""; }
  };
  const city = decode(request.headers.get("cf-ipcity")) || decode(cf?.city);
  const country = decode(request.headers.get("cf-ipcountry")) || String(cf?.country ?? "");
  return { city: city.slice(0, 60), country: country.toUpperCase().slice(0, 2) };
}

/**
 * Sales are read from Payments AI, never copied into this database. Their transaction payload is
 * theirs, so each field is taken from whichever name the response actually uses and left blank when
 * it does not — a missing figure reads as missing, not as zero.
 */
async function fetchSales(env: SiteEnv): Promise<Record<string, unknown>> {
  const key = String(env.CALVRAS_PAYMENTS_KEY || "").trim();
  const merchant = String(env.CALVRAS_PAYMENTS_MERCHANT || "").trim();
  if (!key || !merchant) return { configured: false, sales: [], note: "The site has no Payments AI credential, so nothing can be read from the store." };
  const response = await fetch(`${PAYMENTS_BASE}/v1/public-api/merchants/${encodeURIComponent(merchant)}/transactions?page=1&perPage=100`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } }).catch((error) => null);
  if (!response) return { configured: true, sales: [], error: "Payments AI could not be reached from the site." };
  if (!response.ok) return { configured: true, sales: [], error: `Payments AI answered ${response.status}.` };
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.["data"]) ? payload["data"] : Array.isArray(payload?.["items"]) ? payload["items"] : Array.isArray(payload?.["transactions"]) ? payload["transactions"] : [];
  const pick = (row: Record<string, unknown>, keys: string[]) => { for (const key of keys) { const value = row[key]; if (value !== undefined && value !== null && value !== "") return value; } return ""; };
  const sales = (rows as Record<string, unknown>[]).slice(0, 100).map((row) => ({
    reference: String(pick(row, ["id", "transactionId", "transaction_id"]) || ""),
    email: String(pick(row, ["customerEmail", "customer_email", "email", "customer", "payer"]) || "").toLowerCase(),
    amount: pick(row, ["amount", "value", "total"]) as string | number,
    currency: String(pick(row, ["currency", "currencyCode", "currency_code"]) || ""),
    status: String(pick(row, ["status", "state", "paymentStatus"]) || ""),
    plan: String(pick(row, ["plan", "planId", "plan_id", "product", "productName", "description"]) || ""),
    at: String(pick(row, ["createdAt", "created_at", "date", "timestamp", "paidAt"]) || ""),
  }));
  return { configured: true, sales, total: payload?.["total"] ?? sales.length, unrecognized: sales.filter((entry) => !entry.email && !entry.amount).length };
}

export async function handleSiteApi(request: Request, env: SiteEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/site/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const db = env.CALVRAS_DB;
  if (!db) return json({ ok: false, error: "The account ledger is not attached to this deployment." }, 503);

  if (url.pathname === "/api/site/session" && request.method === "POST") {
    const payload = await body(request);
    const idToken = String(payload["idToken"] || "");
    if (!idToken) return json({ ok: false, error: "A Google sign-in token is required." }, 400);
    if (!env.GOOGLE_CLIENT_ID) return json({ ok: false, error: "The site cannot check Google sign-ins yet: no client id is configured." }, 503);
    try {
      const identity = await verifyGoogleIdentity(idToken, env.GOOGLE_CLIENT_ID);
      const account = await recordSignIn(db, {
        email: identity.email, subject: identity.subject, name: identity.name, picture: identity.picture,
        platform: String(payload["platform"] || "").slice(0, 40), version: String(payload["version"] || "").slice(0, 40),
        ...signInLocation(request), at: Date.now(),
      });
      return json({ ok: true, email: account.email, plan: account.plan, firstSeen: account.first_seen, lastSeen: account.last_seen, signins: account.signins });
    } catch (error) {
      // The reason is about this token, not the ledger, so it is safe to say out loud.
      return json({ ok: false, error: error instanceof Error ? error.message : "That sign-in could not be verified." }, 401);
    }
  }

  if (!url.pathname.startsWith("/api/site/admin/")) return json({ ok: false, error: "Not found" }, 404);
  // Say so before comparing anything: a console that answers 401 forever would look like a typo in
  // the token, when the real problem is that the deployment has no owner token at all.
  if (!env.CALVRAS_ADMIN_TOKEN) return json({ ok: false, error: "No owner token is set on the site, so the console is closed. Set CALVRAS_ADMIN_TOKEN with wrangler secret put." }, 503);
  if (!isAdmin(request, env)) return json({ ok: false, error: "This console needs the owner token." }, 401);

  try {
    if (url.pathname === "/api/site/admin/summary") {
      const [accounts, events, sales] = await Promise.all([listAccounts(db, url.searchParams.get("q") || ""), recentEvents(db), fetchSales(env)]);
      return json({ ok: true, at: Date.now(), summary: await summarize(db, Date.now()), accounts, events, sales });
    }
    if (url.pathname === "/api/site/admin/grant" && request.method === "POST") {
      const payload = await body(request);
      const account = await grantPlan(db, String(payload["email"] || ""), String(payload["plan"] || ""), "owner", Date.now());
      return json({ ok: true, account });
    }
    if (url.pathname === "/api/site/admin/remove" && request.method === "POST") {
      const payload = await body(request);
      await deleteAccount(db, String(payload["email"] || ""));
      return json({ ok: true });
    }
    if (url.pathname === "/api/site/admin/history") {
      const email = url.searchParams.get("email") || "";
      return json({ ok: true, events: await accountEvents(db, email) });
    }
    return json({ ok: false, error: "Not found" }, 404);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "The ledger refused that." }, 400);
  }
}
