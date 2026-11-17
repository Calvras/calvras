import { verifyGoogleIdentity } from "./runtime/google-identity";
import { verifyGitHubIdentity } from "./runtime/github-identity";
import { accountEvents, accountUsage, deleteAccount, findByEmail, grantPlan, ledgerRevision, listAccounts, listSubscriptions, note, readMeta, recentEvents, recentPrompts, recordSignIn, recordTask, saveSubscription, setBlocked, summarize, syncPlanFromSubscriptions, touchUsed, usageBoard, writeMeta, quotaStatus, debitTokens, setDailyTokens, DEFAULT_DAILY_TOKENS, savePaiCustomer, paiCustomerEmail, recordPaiEvent, pendingPaiEvents, markPaiEventProcessed, subscriptionById, type D1Database } from "./runtime/ledger";
import { issueSession, readSession, signingKey } from "./runtime/session-token";
import { buyerEmail, isPlanKey, listPrice, packageCatalog, PLAN_LABELS, planForAmount, verifyPaymentsAiSignature, CHECKOUT_URLS } from "./billing";

/**
 * The public site's own API: who has signed in, what plan they hold, and what the owner can do about
 * it. It lives on the hosted Worker, so unlike /api/agent it is meant to answer calvras.com — and it
 * holds nothing that belongs to the computer it is running on.
 */

export type SiteEnv = {
  CALVRAS_DB?: D1Database;
  CALVRAS_ADMIN_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Payments AI, the merchant of record: the checkout URLs are public, the webhook signing secret
   *  is what makes a delivery trustworthy. It can read nothing else and move no money. */
  PAI_WEBHOOK_SECRET?: string;
  /** The console's own analyst. Left unset, the daily report is still written from the ledger's
   * numbers and only the chat panel says it needs a key — nothing else depends on it. */
  CALVRAS_AI_KEY?: string;
  CALVRAS_AI_MODEL?: string;
  CALVRAS_DAILY_TOKENS?: string;
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
 * Sales are read from the ledger, not from the store's API. Every purchase, renewal and cancellation
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
      note: "No Payments AI purchase has reached this site yet. Each purchase, renewal and cancellation is recorded here as its webhook arrives.",
    };
  }
  const sales = rows.map((row) => {
    return {
      reference: row.id,
      email: row.email,
      amount: isPlanKey(row.plan) ? listPrice(row.plan) : "",
      currency: row.currency || "USD",
      status: row.status,
      plan: isPlanKey(row.plan) ? PLAN_LABELS[row.plan] : "",
      billing: "month",
      at: row.updated_at ? new Date(row.updated_at).toISOString() : "",
      expires: row.expires_at ? new Date(row.expires_at).toISOString() : "",
    };
  });
  return { configured: true, source: "webhooks", sales, total: sales.length };
}

/** Payments AI's billing state, in the words the ledger and the console already use. A cancellation
 *  keeps its access until the period it already paid for ends. */
function subscriptionStatus(state: unknown): string {
  const status = String(state ?? "");
  if (status === "inactive") return "expired";
  if (status === "canceling") return "canceled";
  return "active";
}

const periodEnd = (value: unknown): number => {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * One Payments AI delivery, applied to the ledger. The store says what happened; this site decides
 * what it means, and only an amount from its own catalog can hand out a plan. The buyer's email is
 * not on payment events, so a delivery whose customer is not known yet stays in pai_events until
 * customer.created lands and flushes it. Every branch is idempotent: the store retries a delivery it
 * did not see answered, and the eventId dedupe drops the repeat before any of this runs.
 */
async function applyPaymentsAiEvent(db: D1Database, eventType: string, event: Record<string, unknown>, at: number): Promise<void> {
  const customerId = String(event["customerId"] || "").trim();

  if (eventType === "customer.created") {
    const email = buyerEmail(event);
    if (!customerId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    await savePaiCustomer(db, customerId, email, at);
    for (const pending of await pendingPaiEvents(db, customerId)) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(pending.payload) as Record<string, unknown>; } catch { continue; }
      await applyPaymentsAiEvent(db, pending.event_type, parsed, at);
      await markPaiEventProcessed(db, pending.event_id);
    }
    return;
  }

  const email = await paiCustomerEmail(db, customerId);
  if (!email) return;

  if (eventType === "payment.completed" || eventType === "payment.refunded") {
    const id = String(event["subscriptionId"] || event["transactionId"] || "").trim();
    if (!id) return;
    const existing = await subscriptionById(db, id);
    const plan = planForAmount(event["amount"]) ?? (isPlanKey(existing?.plan) ? existing.plan : null);
    if (!plan) return;
    const refunded = eventType === "payment.refunded";
    await saveSubscription(db, {
      id,
      email,
      plan,
      productId: CHECKOUT_URLS[plan],
      status: refunded ? "refunded" : "active",
      customerId,
      currency: String(event["currency"] || "").toUpperCase(),
      expiresAt: refunded ? at : (existing?.expires_at ?? 0),
      at,
    });
    await syncPlanFromSubscriptions(db, email, at);
    await note(db, email, "billing", `${PLAN_LABELS[plan]} ${refunded ? "refunded" : "active"} (Payments AI)`, at);
    return;
  }

  if (eventType.startsWith("subscription.")) {
    const id = String(event["subscriptionId"] || "").trim();
    if (!id || eventType === "subscription.payment_method_updated") return;
    const existing = await subscriptionById(db, id);
    const status = subscriptionStatus(event["status"]);
    await saveSubscription(db, {
      id,
      email,
      plan: isPlanKey(existing?.plan) ? existing.plan : "",
      productId: existing?.product_id ?? "",
      status,
      customerId,
      currency: existing?.currency ?? "USD",
      expiresAt: periodEnd(event["currentPeriodEnd"]) || existing?.expires_at || 0,
      at,
    });
    await syncPlanFromSubscriptions(db, email, at);
    await note(db, email, "billing", `subscription ${status} (Payments AI)`, at);
  }
}

/** The destination registered in the Payments AI dashboard is the pricing page's own URL, so the
 *  delivery arrives as POST /pricing. Only a signed body is read; the page itself is untouched. */
async function handlePaymentsAiWebhook(request: Request, db: D1Database, env: SiteEnv): Promise<Response> {
  const secret = String(env.PAI_WEBHOOK_SECRET || "").trim();
  if (!secret) return json({ ok: false, error: "No Payments AI webhook secret is set on the site." }, 503);
  const raw = await request.text();
  const at = Date.now();
  if (!await verifyPaymentsAiSignature(request.headers.get("x-webhook-signature"), request.headers.get("x-webhook-timestamp"), raw, secret, at)) {
    return json({ ok: false, error: "That delivery did not come from Payments AI." }, 401);
  }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return json({ ok: false, error: "The delivery was not JSON." }, 400); }
  if (payload["type"] === "webhook.test") return json({ ok: true, test: true });
  const eventId = String(payload["eventId"] || "").trim();
  const eventType = String(payload["eventType"] || "").trim();
  if (!eventId || !eventType) return json({ ok: false, error: "The delivery carried no event id." }, 400);
  const fresh = await recordPaiEvent(db, { eventId, eventType, customerId: String(payload["customerId"] || ""), payload: raw, at });
  if (!fresh) return json({ ok: true, duplicate: true });
  await applyPaymentsAiEvent(db, eventType, payload, at);
  await markPaiEventProcessed(db, eventId);
  return json({ ok: true });
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
  const db = env.CALVRAS_DB;
  // Payments AI posts its deliveries to the URL registered in the dashboard: the pricing page itself.
  if (url.pathname === "/pricing" && request.method === "POST") {
    if (!db) return json({ ok: false, error: "The account ledger is not attached to this deployment." }, 503);
    return await handlePaymentsAiWebhook(request, db, env);
  }
  if (!url.pathname.startsWith("/api/site/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!db) return json({ ok: false, error: "The account ledger is not attached to this deployment." }, 503);

  // The pricing page and the console read what is on sale. The checkout URLs are public by design;
  // the webhook secret is not here and never reaches a browser.
  if (url.pathname === "/api/site/billing/config" || url.pathname === "/api/site/plans") {
    return json({ ok: true, packages: packageCatalog() });
  }

  if (url.pathname === "/api/site/session" && request.method === "POST") {
    const payload = await body(request);
    const idToken = String(payload["idToken"] || "");
    const githubToken = String(payload["githubToken"] || "");
    const accessToken = String(payload["accessToken"] || "");
    // The website and desktop use different OAuth clients.
    const desktopClientId = "83662494822-odr981k7f1qs7ga63kht7a8bcv31s45v.apps.googleusercontent.com";
    const googleClientIds = [...new Set([String(env.GOOGLE_CLIENT_ID || ""), desktopClientId].filter(Boolean))];

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
      if (!u.email || !u.sub || u.email_verified !== true) return null;
      return { email: String(u.email).toLowerCase(), subject: String(u.sub), name: u.name || String(u.email).split("@")[0], picture: u.picture || "" };
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

  // ── Metered inference: the desktop app routes through here when signed in ──
  if (url.pathname === "/api/site/quota" && request.method === "POST") {
    const payload = await body(request);
    const claims = await readSession(await signingKey(db), String(payload["session"] || ""), Date.now());
    if (!claims) return json({ ok: false, error: "Sign in again to check your usage." }, 403);
    const status = await quotaStatus(db, claims.email, Date.now(), Number(env.CALVRAS_DAILY_TOKENS) || DEFAULT_DAILY_TOKENS);
    return json({ ok: true, ...status });
  }

  if (url.pathname === "/api/site/chat" && request.method === "POST") {
    const payload = await body(request);
    const claims = await readSession(await signingKey(db), String(payload["session"] || ""), Date.now());
    if (!claims) return json({ ok: false, error: "Sign in again to continue." }, 403);
    const account = await findByEmail(db, claims.email);
    if (!account) return json({ ok: false, error: "No account record." }, 403);
    if (account.blocked) return json({ ok: false, blocked: true, error: "This account has been blocked." }, 403);
    const serverDefault = Number(env.CALVRAS_DAILY_TOKENS) || DEFAULT_DAILY_TOKENS;
    const quota = await quotaStatus(db, claims.email, Date.now(), serverDefault);
    if (!quota.allowed) return json({ ok: false, exhausted: true, quota, error: quota.lockDays ? `Daily token limit reached. Your usage unlocks in ${quota.lockDays} days.` : "Daily token limit reached. Try again after the reset." }, 429);

    const key = String(env.CALVRAS_AI_KEY || "").trim();
    if (!key) return json({ ok: false, error: "No model key is configured on the server." }, 503);
    const model = String(payload["model"] || env.CALVRAS_AI_MODEL || "").trim() || AI_DEFAULT_MODEL;
    const messages = Array.isArray(payload["messages"]) ? payload["messages"] : [];
    if (!messages.length) return json({ ok: false, error: "No messages to send." }, 400);

    const upstream = await fetch(AI_BASE, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: Math.min(Number(payload["max_tokens"]) || 4096, 16384), temperature: Number(payload["temperature"]) ?? 0.7 }),
      signal: AbortSignal.timeout(120_000),
    }).catch(() => null);
    if (!upstream || !upstream.ok) {
      const reason = upstream ? String((await upstream.text().catch(() => "")).slice(0, 200)) : "unreachable";
      return json({ ok: false, error: `Model provider error: ${reason}` }, 502);
    }

    // Stream SSE back to the client; the turn debits the tokens the provider reports for it.
    const reader = upstream.body?.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let buffer = "";
        let spent = 0;
        try {
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); continue; }
              try {
                const parsed = JSON.parse(data);
                const usage = parsed?.usage;
                if (usage) spent = Math.max(spent, Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0));
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              } catch { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); }
            }
          }
        } catch { /* upstream interrupted */ }
        // Debit after stream completes so an interrupted turn still counts what it spent.
        const finalQuota = await debitTokens(db, claims.email, spent, Date.now(), serverDefault).catch(() => quota);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ quota: finalQuota })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...cors } });
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
    if (url.pathname === "/api/site/admin/quota" && request.method === "POST") {
      const payload = await body(request);
      await setDailyTokens(db, String(payload["email"] || ""), Number(payload["dailyTokens"]) || 0);
      const status = await quotaStatus(db, String(payload["email"] || ""), Date.now(), Number(env.CALVRAS_DAILY_TOKENS) || DEFAULT_DAILY_TOKENS);
      return json({ ok: true, quota: status });
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
