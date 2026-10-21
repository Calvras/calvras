import { verifyGoogleIdentity } from "./runtime/google-identity";
import { accountEvents, accountUsage, deleteAccount, findByEmail, grantPlan, ledgerRevision, listAccounts, note, readMeta, recentEvents, recentPrompts, recordSignIn, recordTask, setBlocked, summarize, touchUsed, usageBoard, writeMeta, type D1Database } from "./runtime/ledger";
import { issueSession, readSession, signingKey } from "./runtime/session-token";

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

  if (url.pathname === "/api/site/session" && request.method === "POST") {
    const payload = await body(request);
    const idToken = String(payload["idToken"] || "");
    if (!idToken) return json({ ok: false, error: "A Google sign-in token is required." }, 400);
    if (!env.GOOGLE_CLIENT_ID) return json({ ok: false, error: "The site cannot check Google sign-ins yet: no client id is configured." }, 503);
    try {
      const identity = await verifyGoogleIdentity(idToken, env.GOOGLE_CLIENT_ID);
      const blocked = await findByEmail(db, identity.email);
      if (blocked?.blocked) {
        // Record the attempt, refuse the sign-in, and say why in the console rather than silently.
        await note(db, blocked.email, "blocked_signin", "refused: the owner blocked this account", Date.now());
        return json({ ok: false, blocked: true, error: "This account has been blocked by the owner." }, 403);
      }
      const at = Date.now();
      const account = await recordSignIn(db, {
        email: identity.email, subject: identity.subject, name: identity.name, picture: identity.picture,
        platform: String(payload["platform"] || "").slice(0, 40), version: String(payload["version"] || "").slice(0, 40),
        ...signInLocation(request), at,
      });
      // The app keeps this and comes back with it on boot and after every turn. Without it the site
      // would have no way to reach a person who signed in yesterday — and no way to switch them off.
      return json({ ok: true, email: account.email, plan: account.plan, firstSeen: account.first_seen, lastSeen: account.last_seen, signins: account.signins, session: await issueSession(await signingKey(db), account.email, at) });
    } catch (error) {
      // The reason is about this token, not the ledger, so it is safe to say out loud.
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
    if (url.pathname === "/api/site/pulse") {
      await touchUsed(db, account.email, at);
      // A grant or a block made in the console reaches the app here, on the next time it opens.
      return json({ ok: true, email: account.email, plan: account.plan, firstSeen: account.first_seen, lastSeen: account.last_seen, at });
    }
    await recordTask(db, {
      email: account.email, status: String(payload["status"] || ""), prompt: String(payload["prompt"] || ""),
      tools: Number(payload["tools"]) || 0, seconds: Number(payload["seconds"]) || 0,
      plan: account.plan, platform: String(payload["platform"] || "").slice(0, 40), version: String(payload["version"] || "").slice(0, 40), at,
    });
    return json({ ok: true, plan: account.plan, at });
  }

  if (!url.pathname.startsWith("/api/site/admin/")) return json({ ok: false, error: "Not found" }, 404);
  // Say so before comparing anything: a console that answers 401 forever would look like a typo in
  // the token, when the real problem is that the deployment has no owner token at all.
  if (!env.CALVRAS_ADMIN_TOKEN) return json({ ok: false, error: "No owner token is set on the site, so the console is closed. Set CALVRAS_ADMIN_TOKEN with wrangler secret put." }, 503);
  if (!isAdmin(request, env)) return json({ ok: false, error: "This console needs the owner token." }, 401);

  try {
    if (url.pathname === "/api/site/admin/summary") {
      const at = Date.now();
      const [accounts, events, sales, summary, board] = await Promise.all([listAccounts(db, url.searchParams.get("q") || ""), recentEvents(db), fetchSales(env), summarize(db, at), usageBoard(db, at)]);
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
