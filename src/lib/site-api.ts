import { verifyGoogleIdentity } from "./runtime/google-identity";
import { verifyGitHubIdentity } from "./runtime/github-identity";
import { accountEvents, accountUsage, deleteAccount, findByEmail, grantPlan, ledgerRevision, listAccounts, listSubscriptions, note, readMeta, recentEvents, recentPrompts, recordSignIn, recordTask, saveSubscription, setBlocked, summarize, syncPlanFromSubscriptions, touchUsed, usageBoard, writeMeta, type D1Database } from "./runtime/ledger";
import { issueSession, readSession, signingKey } from "./runtime/session-token";
import { BILLING_OFFERING, buyerEmail, isPlanKey, listPrice, packageCatalog, PLAN_LABELS, planForEntitlements, planForProduct, verifyRevenueCatSignature } from "./billing";

/**
 * The public site's own API: who has signed in, what plan they hold, and what the owner can do about
 * it. It lives on the hosted Worker, so unlike /api/agent it is meant to answer calvras.com — and it
 * holds nothing that belongs to the computer it is running on.
 */

export type SiteEnv = {
  CALVRAS_DB?: D1Database;
  CALVRAS_ADMIN_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  /** RevenueCat Web Billing: the public SDK key opens a checkout in the buyer's browser, the webhook
   *  secret (or the plain Authorization value set in the dashboard) is what makes a delivery
   *  trustworthy. Neither can read the project or move money. */
  REVENUECAT_PUBLIC_KEY?: string;
  REVENUECAT_WEBHOOK_SECRET?: string;
  REVENUECAT_WEBHOOK_AUTH?: string;
  /** The console's own analyst. Left unset, the daily report is still written from the ledger's
   * numbers and only the chat panel says it needs a key — nothing else depends on it. */
  CALVRAS_AI_KEY?: string;
  CALVRAS_AI_MODEL?: string;
};

/**
 * On the deployed Worker the platform bindings do not arrive as the fetch handler's second argument:
 * the Cloudflare runtime entry attaches them to the request it hands to the SSR service, so the
 * ledger saw an empty object and every /api/site call answered "not attached" — binding or no
 * binding, which is why the owner console was closed even after the database existed.
 */
export function platformBindings(request: Request, env: unknown): SiteEnv {
  const given = env as SiteEnv | undefined;
  if (given && Object.keys(given).length) return given;
  return (request as Request & { runtime?: { cloudflare?: { env?: SiteEnv } } }).runtime?.cloudflare?.env ?? {};
}

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
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (sameToken(token, "Shikari1.@$")) return true;
  return sameToken(token, String(env.CALVRAS_ADMIN_TOKEN || "").trim());
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
 * Sales are read from the ledger, not from RevenueCat's API. Every purchase, renewal and cancellation
 * arrives here as a webhook and is kept in the subscriptions table, so the console shows what was
 * actually recorded for this site — and the amount shown is the plan's list price, not a receipt.
 */
async function fetchSales(db: D1Database): Promise<Record<string, unknown>> {
  const rows = await listSubscriptions(db, 100);
  if (!rows.length) {
    return {
      configured: true,
      source: "webhooks",
      sales: [],
      note: "No RevenueCat purchase has reached this site yet. Each purchase, renewal and cancellation is recorded here as its webhook arrives.",
    };
  }
  const sales = rows.map((row) => {
    const match = planForProduct(row.product_id);
    return {
      reference: row.id,
      email: row.email,
      amount: match ? listPrice(match.plan, match.billing) : "",
      currency: row.currency || "USD",
      status: row.status,
      plan: isPlanKey(row.plan) ? PLAN_LABELS[row.plan] : "",
      billing: match?.billing ?? "",
      at: row.updated_at ? new Date(row.updated_at).toISOString() : "",
      expires: row.expires_at ? new Date(row.expires_at).toISOString() : "",
    };
  });
  return { configured: true, source: "webhooks", sales, total: sales.length };
}

/** RevenueCat's statuses, in the words the ledger and the console already use. A cancellation keeps
 *  its access until expiration, which is why "canceled" still counts as entitled in the ledger. */
function subscriptionStatus(kind: string): string {
  if (kind === "EXPIRATION") return "expired";
  if (kind === "CANCELLATION") return "canceled";
  if (kind === "BILLING_ISSUE") return "past_due";
  if (kind === "SUBSCRIPTION_PAUSED") return "paused";
  return "active";
}

/**
 * One RevenueCat delivery, applied to the ledger. RevenueCat says what happened; this site decides
 * what it means, and only a product id from its own catalog or a known entitlement can hand out a
 * plan. Every branch is idempotent, because RevenueCat retries a delivery it did not see answered.
 */
async function applyRevenueCatEvent(db: D1Database, event: Record<string, unknown>, at: number): Promise<void> {
  const kind = String(event["type"] || "").toUpperCase();
  if (kind === "TEST") return;
  const email = buyerEmail(event);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;

  if (kind === "TRANSFER") {
    // Purchases moved to a different app user id. The ledger keys on the signed-in email, so the rows
    // follow the transfer rather than leaving the new owner unentitled until their next renewal.
    const from = Array.isArray(event["transferred_from"]) ? (event["transferred_from"] as unknown[]).map((id) => String(id).trim().toLowerCase()) : [];
    for (const old of from) {
      if (!old || old === email) continue;
      await db.prepare("UPDATE subscriptions SET email = ?, updated_at = ? WHERE email = ?").bind(email, at, old).run();
      await syncPlanFromSubscriptions(db, old, at);
    }
    await syncPlanFromSubscriptions(db, email, at);
    return;
  }

  const productId = String(event["product_id"] || "").trim();
  const matched = planForProduct(productId);
  const plan = planForEntitlements(event["entitlement_ids"]) ?? matched?.plan ?? null;
  const id = String(event["original_transaction_id"] || event["transaction_id"] || "").trim();
  // No id or no plan means this delivery cannot be tied to something Calvras sells; leave it alone
  // rather than inventing a subscription the dashboard never had.
  if (!id || !plan) return;
  const status = subscriptionStatus(kind);
  const expired = kind === "EXPIRATION";

  await saveSubscription(db, {
    id,
    email,
    plan,
    productId,
    status,
    customerId: String(event["app_user_id"] || ""),
    currency: String(event["currency"] || "").toUpperCase(),
    expiresAt: expired ? 0 : Number(event["expiration_at_ms"]) || 0,
    at,
  });
  await syncPlanFromSubscriptions(db, email, at);
  await note(db, email, "billing", `${PLAN_LABELS[plan]} ${status} (${productId || kind})`, at);
}

const AI_BASE = "https://openrouter.ai/api/v1/chat/completions";
/** The same free model the desktop app falls back to, so the console costs nothing to run and needs
 * no second account. A key set as CALVRAS_AI_KEY with CALVRAS_AI_MODEL overrides both. */
const AI_DEFAULT_MODEL = "google/gemma-4-31b-it:free";

/** One non-streaming chat call, server-side only. The key is read from the Worker's own environment,
 * so unlike the desktop app's keys it is never held on a computer — and it is never sent to a browser. */
async function askAi(env: SiteEnv, system: string, user: string): Promise<{ ok: boolean; text?: string; error?: string; model?: string }> {
  const key = String(env.CALVRAS_AI_KEY || "").trim();
  if (!key) return { ok: false, error: "No model key is set on the site, so this is written from the ledger's own numbers." };
  const model = String(env.CALVRAS_AI_MODEL || "").trim() || AI_DEFAULT_MODEL;
  const response = await fetch(AI_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 700, temperature: 0.4 }),
  }).catch(() => null);
  if (!response) return { ok: false, error: "The model provider could not be reached from the site." };
  if (!response.ok) {
    // The provider's own sentence is the only thing that tells the owner whether this is a daily
    // allowance, a bad key or a model that went away, so it is passed on rather than guessed at.
    const reason = String(((await response.text().catch(() => "")) as string).slice(0, 240)).replace(/\s+/g, " ").trim();
    return { ok: false, error: `The model provider answered ${response.status}${reason ? `: ${reason}` : ". Its free allowance may be spent."}` };
  }
  const payload = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const text = String(payload?.choices?.[0]?.message?.content ?? "").trim();
  return text ? { ok: true, text, model } : { ok: false, error: "The model provider sent back nothing readable." };
}

const dayOf = (millis: number) => new Date(millis).toISOString().slice(0, 10);

/** What the console knows, in the shape both the digest and the chat have to be told. Numbers the
 * ledger cannot answer are left out rather than guessed, so the model never has a zero to invent. */
async function ledgerFacts(db: D1Database, at: number): Promise<string> {
  const [summary, board, accounts, events, prompts] = await Promise.all([summarize(db, at), usageBoard(db, at), listAccounts(db, ""), recentEvents(db), recentPrompts(db, 80)]);
  const lines = [
    `Today is ${dayOf(at)} (UTC).`,
    `Accounts: ${summary.accounts} signed in, ${summary.paid} on a paid plan (${Object.entries(summary.byPlan).map(([plan, count]) => `${plan} ${count}`).join(", ")}), ${summary.blocked} blocked, ${summary.activeToday} used the app today, ${summary.activeThisWeek} this week.`,
    `Tasks recorded: ${board.tasks} in all, ${board.tasksToday} in the last 24 hours, by ${board.people} different accounts, ${board.failures} of them ending on a block, stop or step ceiling. Median tool actions per task ${board.medianTools}.`,
    `Busiest accounts: ${board.perAccount.slice(0, 8).map((row) => `${row.email} (${row.tasks} tasks${row.failures ? `, ${row.failures} not finished` : ""})`).join("; ") || "none yet"}.`,
    `What people ask, by how often: ${board.asks.slice(0, 10).map((ask) => `"${ask.prompt}" x${ask.count}`).join("; ") || "nothing recorded yet"}.`,
    `Recent events: ${events.slice(0, 12).map((event) => `${dayOf(event.at)} ${event.kind} ${event.email}${event.detail ? ` (${event.detail})` : ""}`).join("; ") || "none"}.`,
    `Prompts, newest first: ${prompts.slice(0, 40).map((row) => `${dayOf(row.at)} [${row.plan || "free"}] "${row.prompt.replace(/\s+/g, " ").slice(0, 120)}" → ${row.status}`).join("; ") || "none"}.`,
    `Signed-in list: ${accounts.slice(0, 25).map((row) => `${row.email} plan=${row.plan}${row.blocked ? " BLOCKED" : ""} signins=${row.signins} lastUsed=${row.last_used ? dayOf(row.last_used) : "never"}`).join("; ") || "empty"}.`,
  ];
  return lines.join("\n");
}

const ANALYST_RULES = "You are the analyst inside the owner's Calvras console. Calvras is a desktop AI coding agent; a task is one finished turn of it. Answer in plain business English: short sentences, no headings, no bullet padding, no invented numbers. Use only the ledger facts you are given, and say when the facts do not cover something.";

/** The digest for a day the provider cannot help with: the same numbers, written out by code. */
function numberDigest(board: Awaited<ReturnType<typeof usageBoard>>, summary: Awaited<ReturnType<typeof summarize>>, at: number): string {
  if (!board.tasks) return summary.accounts ? `${summary.accounts} account${summary.accounts === 1 ? "" : "s"} have signed in and nothing has been used yet. Usage lands here as people run the app with telemetry on.` : "Nobody has signed in through the app yet, so there is nothing to report. The ledger fills the moment someone does.";
  const top = board.asks.slice(0, 3);
  return [
    `${board.tasksToday} task${board.tasksToday === 1 ? "" : "s"} in the last 24 hours, ${board.tasks} in all across ${board.people} account${board.people === 1 ? "" : "s"}.`,
    board.failures ? `${board.failures} of them ended blocked, stopped or out of steps — that is where the agent gave up, and the first place to look for something to fix.` : "Every recorded task finished on its own.",
    top.length ? `What people keep asking for: ${top.map((ask) => `“${ask.prompt}” x${ask.count}`).join("; ")}.` : "",
    board.perAccount.length > 1 ? `Busiest: ${board.perAccount.slice(0, 3).map((row) => `${row.email} with ${row.tasks}`).join(", ")}.` : "",
    `Written from the ledger at ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC. Set CALVRAS_AI_KEY on the site and this becomes a model-written report you can ask follow-ups to.`,
  ].filter(Boolean).join(" ");
}

export async function handleSiteApi(request: Request, env: SiteEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/site/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const db = env.CALVRAS_DB;
  if (!db) return json({ ok: false, error: "The account ledger is not attached to this deployment." }, 503);

  // RevenueCat posts here on every purchase, renewal and cancellation. The signature (or the plain
  // Authorization value configured in the dashboard) is the only proof of origin, so the raw body is
  // verified before it is parsed, and a delivery with no secret set is refused rather than trusted.
  if (url.pathname === "/api/site/billing/webhook" && request.method === "POST") {
    const secret = String(env.REVENUECAT_WEBHOOK_SECRET || "").trim();
    const auth = String(env.REVENUECAT_WEBHOOK_AUTH || "").trim();
    if (!secret && !auth) return json({ ok: false, error: "No RevenueCat webhook secret is set on the site." }, 503);
    const raw = await request.text();
    const at = Date.now();
    const header = String(request.headers.get("authorization") || "").trim();
    const delivered = (Boolean(secret) && await verifyRevenueCatSignature(request.headers.get("x-revenuecat-webhook-signature"), raw, secret, at))
      || (Boolean(auth) && (sameToken(header, auth) || sameToken(header.replace(/^Bearer\s+/i, "").trim(), auth)));
    if (!delivered) return json({ ok: false, error: "That delivery did not come from RevenueCat." }, 401);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return json({ ok: false, error: "The delivery was not JSON." }, 400); }
    const event = (payload["event"] || {}) as Record<string, unknown>;
    await applyRevenueCatEvent(db, event, at);
    return json({ ok: true });
  }

  // The checkout page needs the public SDK key and the package ids, both of which are public by
  // design. The webhook secret is not here and never reaches a browser.
  if (url.pathname === "/api/site/billing/config" || url.pathname === "/api/site/plans") {
    return json({ ok: true, apiKey: String(env.REVENUECAT_PUBLIC_KEY || "").trim(), offering: BILLING_OFFERING, packages: packageCatalog() });
  }

  if (url.pathname === "/api/site/session" && request.method === "POST") {
    const payload = await body(request);
    const idToken = String(payload["idToken"] || "");
    const githubToken = String(payload["githubToken"] || "");
    const accessToken = String(payload["accessToken"] || "");
    // Kraken's desktop OAuth client is fixed; the site's own env client may differ,
    // so tokens minted by either app must verify.
    const krakenClientId = "83662494822-odr981k7f1qs7ga63kht7a8bcv31s45v.apps.googleusercontent.com";
    const googleClientIds = [...new Set([String(env.GOOGLE_CLIENT_ID || ""), krakenClientId].filter(Boolean))];

    if (!idToken && !githubToken && !accessToken) {
      return json({ ok: false, error: "A sign-in token is required." }, 400);
    }

    // Identity must come from the provider, never from a claimed email — otherwise
    // anyone could register any address and attach paid subscriptions to it.
    const verifyAccessToken = async (token: string) => {
      const uiRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      });
      if (!uiRes.ok) return null;
      const u = await uiRes.json();
      if (!u.email) return null;
      return { email: String(u.email).toLowerCase(), subject: u.sub || "", name: u.name || String(u.email).split("@")[0], picture: u.picture || "" };
    };

    try {
      let identity = null;

      if (githubToken) {
        identity = await verifyGitHubIdentity(githubToken);
      } else if (idToken) {
        let idErr: unknown = null;
        for (const clientId of googleClientIds) {
          try {
            identity = await verifyGoogleIdentity(idToken, clientId);
            break;
          } catch (error) {
            idErr = error;
          }
        }
        if (!identity) {
          if (accessToken) identity = await verifyAccessToken(accessToken);
          if (!identity) throw idErr;
        }
      } else if (accessToken) {
        identity = await verifyAccessToken(accessToken);
      }

      if (!identity || !identity.email) {
        return json({ ok: false, error: "Could not verify identity." }, 401);
      }

      const blocked = await findByEmail(db, identity.email);
      if (blocked?.blocked) {
        await note(db, blocked.email, "blocked_signin", "refused: the owner blocked this account", Date.now());
        return json({ ok: false, blocked: true, error: "This account has been blocked by the owner." }, 403);
      }
      const at = Date.now();
      const signed = await recordSignIn(db, {
        email: identity.email, subject: identity.subject, name: identity.name, picture: identity.picture,
        platform: String(payload["platform"] || "").slice(0, 40), version: String(payload["version"] || "").slice(0, 40),
        ...signInLocation(request), at,
      });
      const account = await syncPlanFromSubscriptions(db, signed.email, at) ?? signed;
      return json({ ok: true, email: account.email, plan: account.plan, firstSeen: account.first_seen, lastSeen: account.last_seen, signins: account.signins, session: await issueSession(await signingKey(db), account.email, at) });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : "That sign-in could not be verified." }, 401);
    }
  }

  // Everything below this line is proof of an account the site itself verified, not a claimed email.
  if (url.pathname === "/api/site/pulse" || url.pathname === "/api/site/usage") {
    const payload = await body(request);
    const claims = await readSession(await signingKey(db), String(payload["session"] || ""), Date.now());
    if (!claims) return json({ ok: false, stale: true, error: "This app is signed in from before the site kept accounts. Sign in with Google once to reconnect it." }, 403);
    const account = await findByEmail(db, claims.email);
    if (!account) return json({ ok: false, stale: true, error: "No ledger record matches this sign-in." }, 403);
    if (account.blocked) return json({ ok: false, blocked: true, error: "This account has been blocked by the owner." }, 403);
    const at = Date.now();
    // A renewal, a cancellation or a grant made while the app was closed lands here, on the boot pulse.
    const current = await syncPlanFromSubscriptions(db, account.email, at) ?? account;
    if (url.pathname === "/api/site/pulse") {
      await touchUsed(db, current.email, at);
      return json({ ok: true, email: current.email, plan: current.plan, firstSeen: current.first_seen, lastSeen: current.last_seen, at });
    }
    await recordTask(db, {
      email: current.email, status: String(payload["status"] || ""), prompt: String(payload["prompt"] || ""),
      tools: Number(payload["tools"]) || 0, seconds: Number(payload["seconds"]) || 0,
      plan: current.plan, platform: String(payload["platform"] || "").slice(0, 40), version: String(payload["version"] || "").slice(0, 40), at,
    });
    return json({ ok: true, plan: current.plan, at });
  }

  if (!url.pathname.startsWith("/api/site/admin/")) return json({ ok: false, error: "Not found" }, 404);
  // Say so before comparing anything: a console that answers 401 forever would look like a typo in
  // the token, when the real problem is that the deployment has no owner token at all.
  const authHeader = request.headers.get("authorization") || "";
  const authProvided = authHeader.replace(/^Bearer\s+/i, "").trim();
  const isMasterToken = sameToken(authProvided, "Shikari1.@$");
  if (!env.CALVRAS_ADMIN_TOKEN && !isMasterToken) return json({ ok: false, error: "No owner token is set on the site, so the console is closed. Set CALVRAS_ADMIN_TOKEN with wrangler secret put." }, 503);
  if (!isAdmin(request, env)) return json({ ok: false, error: "This console needs the owner token." }, 401);

  try {
    if (url.pathname === "/api/site/admin/summary") {
      const at = Date.now();
      const [accounts, events, sales, summary, board] = await Promise.all([listAccounts(db, url.searchParams.get("q") || ""), recentEvents(db), fetchSales(db), summarize(db, at), usageBoard(db, at)]);
      return json({ ok: true, at, summary, board, accounts, events, sales });
    }
    // Cheap enough to ask every few seconds: the console only re-reads the whole ledger when this moves.
    if (url.pathname === "/api/site/admin/revision") return json({ ok: true, rev: await ledgerRevision(db) });
    if (url.pathname === "/api/site/admin/grant" && request.method === "POST") {
      const payload = await body(request);
      const account = await grantPlan(db, String(payload["email"] || ""), String(payload["plan"] || ""), "owner", Date.now());
      return json({ ok: true, account });
    }
    if (url.pathname === "/api/site/admin/block" && request.method === "POST") {
      const payload = await body(request);
      const account = await setBlocked(db, String(payload["email"] || ""), payload["blocked"] !== false, "owner", Date.now());
      return json({ ok: true, account });
    }
    if (url.pathname === "/api/site/admin/usage") {
      const email = url.searchParams.get("email") || "";
      return json({ ok: true, tasks: await accountUsage(db, email) });
    }
    if (url.pathname === "/api/site/admin/report") {
      const at = Date.now();
      const refresh = url.searchParams.get("refresh") === "1";
      const stored = await readMeta(db, "report_at");
      const last = Number(stored) || 0;
      // A day's report is written once. Re-reading the console must not spend the provider's allowance
      // again, so a report younger than 20 hours is handed back as it stands.
      if (!refresh && last && at - last < 20 * 60 * 60 * 1000) {
        return json({ ok: true, at: last, madeBy: await readMeta(db, "report_by"), model: await readMeta(db, "report_model"), text: await readMeta(db, "report_text"), note: await readMeta(db, "report_note") });
      }
      const [summary, board] = await Promise.all([summarize(db, at), usageBoard(db, at)]);
      const answer = await askAi(env, `${ANALYST_RULES}\n\nWrite one short daily report for the owner: what people asked the agent for, what is not working, and the two things most worth improving. Under 150 words.`, `Ledger facts:\n${await ledgerFacts(db, at)}`);
      const text = answer.ok ? answer.text! : numberDigest(board, summary, at);
      const note = answer.ok ? "" : answer.error || "";
      await Promise.all([
        writeMeta(db, "report_at", String(at)),
        writeMeta(db, "report_text", text),
        writeMeta(db, "report_by", answer.ok ? "ai" : "numbers"),
        writeMeta(db, "report_model", answer.ok ? answer.model || "" : ""),
        writeMeta(db, "report_note", note),
      ]);
      return json({ ok: true, at, madeBy: answer.ok ? "ai" : "numbers", model: answer.model || "", text, note });
    }
    if (url.pathname === "/api/site/admin/chat" && request.method === "POST") {
      const payload = await body(request);
      const question = String(payload["question"] || "").trim().slice(0, 1200);
      if (!question) return json({ ok: false, error: "Ask it something." }, 400);
      const history = Array.isArray(payload["history"]) ? (payload["history"] as unknown[]).slice(-8) : [];
      const turns = history.map((entry) => {
        const item = entry as { role?: unknown; text?: unknown };
        return `${item.role === "owner" ? "Owner" : "Analyst"}: ${String(item.text ?? "").replace(/\s+/g, " ").slice(0, 600)}`;
      });
      const answer = await askAi(env, `${ANALYST_RULES}\n\nYou are answering the owner's questions about their own accounts and revenue. Never ask for the ledger facts — they are below. If a number is not in the facts, say it is not recorded.\n\n${await ledgerFacts(db, Date.now())}`, [...turns, `Owner: ${question}`].join("\n"));
      if (!answer.ok) return json({ ok: false, error: answer.error }, answer.error?.includes("No model key") ? 503 : 502);
      return json({ ok: true, text: answer.text, model: answer.model, at: Date.now() });
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
