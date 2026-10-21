/**
 * The hosted Worker had no storage at all, so the account ledger starts here: one D1 database,
 * reached through the narrow shape below rather than a Cloudflare types dependency.
 */

export type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};
export type D1Database = { prepare(sql: string): D1Statement };

export type AccountRow = {
  email: string; subject: string; name: string; picture: string; plan: string;
  plan_set_by: string; plan_set_at: number; first_seen: number; last_seen: number;
  signins: number; platform: string; version: string; city: string; country: string;
  blocked: number; blocked_at: number; blocked_by: string; last_used: number;
};
export type EventRow = { id: number; email: string; kind: string; detail: string; at: number };
export type UsageRow = {
  id: number; email: string; status: string; prompt: string; tools: number;
  seconds: number; plan: string; platform: string; version: string; at: number;
};

/** Every timestamp in the ledger is milliseconds, so the app clock and the row agree. */
export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  plan_set_by TEXT NOT NULL DEFAULT '',
  plan_set_at INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  signins INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_at INTEGER NOT NULL DEFAULT 0,
  blocked_by TEXT NOT NULL DEFAULT '',
  last_used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_email_idx ON events (email, at DESC);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  tools INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_email_idx ON usage (email, at DESC);
CREATE INDEX IF NOT EXISTS usage_at_idx ON usage (at DESC);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const PLAN_NAMES = ["free", "pro", "ultra"];
export const paidPlans = ["pro", "ultra"];

export function normalizePlan(value: unknown): string | null {
  const plan = String(value ?? "").trim().toLowerCase();
  return PLAN_NAMES.includes(plan) ? plan : null;
}

function text(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

export function accountEmail(value: unknown): string {
  const email = text(value, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A verified email address is required.");
  return email;
}

/**
 * One sign-in, recorded once. A returning account keeps its first_seen and its plan: a grant the
 * owner made by hand must never be wiped by the person signing in again the next day. A sign-in that
 * arrives with no geolocation at all keeps the last place the console saw them from.
 */
export async function recordSignIn(db: D1Database, input: { email: string; subject?: string; name?: string; picture?: string; platform?: string; version?: string; city?: string; country?: string; at: number }): Promise<AccountRow> {
  const email = accountEmail(input.email);
  const city = text(input.city, 60);
  const country = text(input.country, 2).toUpperCase();
  const from = [city, country].filter(Boolean).join(", ");
  await db.prepare(`INSERT INTO accounts (email, subject, name, picture, plan, first_seen, last_seen, signins, platform, version, city, country)
    VALUES (?, ?, ?, ?, 'free', ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET subject = excluded.subject, name = excluded.name, picture = excluded.picture,
      last_seen = excluded.last_seen, signins = signins + 1, platform = excluded.platform, version = excluded.version,
      city = COALESCE(NULLIF(excluded.city, ''), accounts.city), country = COALESCE(NULLIF(excluded.country, ''), accounts.country)`)
    .bind(email, text(input.subject, 100), text(input.name, 120), text(input.picture, 500), input.at, input.at, text(input.platform, 40), text(input.version, 40), city, country).run();
  await note(db, email, "signin", from ? `from ${from}` : "", input.at);
  return (await db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first<AccountRow>())!;
}

export async function note(db: D1Database, email: string, kind: string, detail: string, at: number): Promise<void> {
  await db.prepare("INSERT INTO events (email, kind, detail, at) VALUES (?, ?, ?, ?)").bind(text(email, 200).toLowerCase(), text(kind, 40), text(detail, 600), at).run();
}

/** Move someone up (or back down) by hand. The writer is kept so the table can say who did it. */
export async function grantPlan(db: D1Database, email: string, plan: string, by: string, at: number): Promise<AccountRow> {
  const wanted = normalizePlan(plan);
  if (!wanted) throw new Error("A plan is one of free, pro, or ultra.");
  const target = accountEmail(email);
  const changes = await db.prepare("UPDATE accounts SET plan = ?, plan_set_by = ?, plan_set_at = ? WHERE email = ?").bind(wanted, text(by, 200), at, target).run();
  if (!changes.meta?.changes) throw new Error(`No account is signed in as ${target} yet, so there is nothing to change.`);
  await note(db, target, "plan", `${by || "admin"} set ${wanted}`, at);
  return (await db.prepare("SELECT * FROM accounts WHERE email = ?").bind(target).first<AccountRow>())!;
}

/** Turn a person's app off. The flag is what /api/site/session, the boot pulse and every usage
 * report check, so one click in the console stops the account working rather than only hiding it. */
export async function setBlocked(db: D1Database, email: string, blocked: boolean, by: string, at: number): Promise<AccountRow> {
  const target = accountEmail(email);
  const changes = await db.prepare("UPDATE accounts SET blocked = ?, blocked_at = ?, blocked_by = ? WHERE email = ?")
    .bind(blocked ? 1 : 0, blocked ? at : 0, blocked ? text(by, 200) : "", target).run();
  if (!changes.meta?.changes) throw new Error(`No account is signed in as ${target} yet, so there is nothing to block.`);
  await note(db, target, "block", blocked ? `${by || "admin"} blocked the account` : `${by || "admin"} unblocked the account`, at);
  return (await db.prepare("SELECT * FROM accounts WHERE email = ?").bind(target).first<AccountRow>())!;
}

export async function findByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  return await db.prepare("SELECT * FROM accounts WHERE email = ?").bind(accountEmail(email)).first<AccountRow>() ?? null;
}

/** One finished turn, as the app describes it. The prompt is whatever the person typed, truncated to
 * the first 300 characters — long enough to see what people ask, short enough that a whole document
 * pasted into a composer does not end up in the ledger. */
export async function recordTask(db: D1Database, input: { email: string; status: string; prompt?: string; tools?: number; seconds?: number; plan?: string; platform?: string; version?: string; at: number }): Promise<void> {
  const target = accountEmail(input.email);
  const status = text(input.status, 20).toLowerCase() || "finished";
  await db.prepare(`INSERT INTO usage (email, status, prompt, tools, seconds, plan, platform, version, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(target, status, text(input.prompt, 300), Math.max(0, Math.min(9999, Math.round(Number(input.tools) || 0))), Math.max(0, Math.min(86_400, Math.round(Number(input.seconds) || 0))),
      text(input.plan, 20).toLowerCase(), text(input.platform, 40), text(input.version, 40), input.at).run();
  await db.prepare("UPDATE accounts SET last_used = ? WHERE email = ? AND last_used < ?").bind(input.at, target, input.at).run();
}

/** An app that opened with a session it already holds. This is what makes "last active" mean
 * today rather than the last time the person happened to go through Google. */
export async function touchUsed(db: D1Database, email: string, at: number): Promise<void> {
  await db.prepare("UPDATE accounts SET last_used = ? WHERE email = ?").bind(at, accountEmail(email)).run();
}

export async function accountUsage(db: D1Database, email: string, limit = 60): Promise<UsageRow[]> {
  const { results } = await db.prepare("SELECT * FROM usage WHERE email = ? ORDER BY at DESC LIMIT ?").bind(accountEmail(email), Math.max(1, Math.min(200, limit))).all<UsageRow>();
  return results;
}

export type UsageBoard = {
  tasks: number; tasksToday: number; people: number; failures: number; medianTools: number;
  byPlan: Record<string, number>; perAccount: { email: string; tasks: number; lastUsed: number; failures: number }[];
  asks: { prompt: string; count: number; lastAt: number }[];
};

/** The numbers the owner asked for: who used it, how much, and what they kept asking for.
 * "asks" is a plain count of the same opening words, so the console can say what people want
 * without a model deciding it. */
export async function usageBoard(db: D1Database, at: number): Promise<UsageBoard> {
  const day = at - 24 * 60 * 60 * 1000;
  const one = <T>(sql: string, bind: unknown[] = []) => db.prepare(sql).bind(...bind).first<T>();
  const totals = await one<{ tasks: number; people: number; failures: number; tasksToday: number }>(
    "SELECT COUNT(*) AS tasks, COUNT(DISTINCT email) AS people, SUM(CASE WHEN status IN ('blocked','stopped','limit') THEN 1 ELSE 0 END) AS failures, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS tasksToday FROM usage",
    [day],
  );
  const counts = await db.prepare("SELECT tools FROM usage ORDER BY tools LIMIT 400").all<{ tools: number }>();
  const sorted = counts.results.map((row) => row.tools).sort((a, b) => a - b);
  const plans = await db.prepare("SELECT plan, COUNT(*) AS count FROM usage GROUP BY plan").all<{ plan: string; count: number }>();
  const byPlan: Record<string, number> = {};
  for (const row of plans.results) byPlan[row.plan || "unknown"] = row.count;
  const perAccount = await db.prepare(`SELECT email, COUNT(*) AS tasks, MAX(at) AS lastUsed,
      SUM(CASE WHEN status IN ('blocked','stopped','limit') THEN 1 ELSE 0 END) AS failures
      FROM usage GROUP BY email ORDER BY tasks DESC LIMIT 100`).all<{ email: string; tasks: number; lastUsed: number; failures: number }>();
  return {
    tasks: totals?.tasks ?? 0,
    tasksToday: totals?.tasksToday ?? 0,
    people: totals?.people ?? 0,
    failures: totals?.failures ?? 0,
    medianTools: sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0,
    byPlan,
    perAccount: perAccount.results,
    asks: await topAsks(db, 24),
  };
}

/** The things people ask, most-frequent first. Prompts are grouped by their first few words because
 * that is where a request says what it wants — "build me a landing page" and "build a login form"
 * share a verb, and the owner reads the shared part as the demand. */
export async function topAsks(db: D1Database, limit = 12): Promise<{ prompt: string; count: number; lastAt: number }[]> {
  const { results } = await db.prepare("SELECT prompt, at FROM usage WHERE prompt != '' ORDER BY at DESC LIMIT 2000").all<{ prompt: string; at: number }>();
  const grouped = new Map<string, { prompt: string; count: number; lastAt: number }>();
  for (const row of results) {
    const lead = row.prompt.replace(/\s+/g, " ").trim().toLowerCase();
    if (!lead) continue;
    const key = lead.split(" ").slice(0, 4).join(" ");
    const seen = grouped.get(key);
    if (seen) { seen.count += 1; seen.lastAt = Math.max(seen.lastAt, row.at); continue; }
    grouped.set(key, { prompt: row.prompt.replace(/\s+/g, " ").trim().slice(0, 120), count: 1, lastAt: row.at });
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, limit);
}

/** Reads a value the Worker keeps for itself in the same database as the ledger. */
export async function readMeta(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return String(row?.value ?? "");
}

/** Written once and read by every request afterwards. If another request won the race, the insert
 * does nothing and the first key stands — two Workers minting different keys would invalidate
 * sessions the moment a request landed on the other one. */
export async function writeMetaIfAbsent(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(key, value).run();
}

export async function writeMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** One number that changes whenever anything in the ledger changes. The console asks for this every
 * few seconds because it is two MAX() lookups, and only reads the whole ledger when it moves. */
export async function ledgerRevision(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT (SELECT MAX(id) FROM events) AS events, (SELECT MAX(id) FROM usage) AS tasks, (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT MAX(plan_set_at) FROM accounts) AS grants").first<{ events: number | null; tasks: number | null; accounts: number; grants: number | null }>();
  return `${row?.events ?? 0}-${row?.tasks ?? 0}-${row?.accounts ?? 0}-${row?.grants ?? 0}`;
}

/** The most recent prompts, newest first — the raw material for the console's daily report. */
export async function recentPrompts(db: D1Database, limit = 120): Promise<{ email: string; plan: string; prompt: string; status: string; at: number }[]> {
  const { results } = await db.prepare("SELECT email, plan, prompt, status, at FROM usage WHERE prompt != '' ORDER BY at DESC LIMIT ?").bind(Math.max(1, Math.min(400, limit))).all<{ email: string; plan: string; prompt: string; status: string; at: number }>();
  return results;
}

export async function listAccounts(db: D1Database, query: string): Promise<AccountRow[]> {
  const needle = text(query, 120).toLowerCase();
  const sql = needle ? "SELECT * FROM accounts WHERE email LIKE ? OR lower(name) LIKE ? ORDER BY last_seen DESC LIMIT 500" : "SELECT * FROM accounts ORDER BY last_seen DESC LIMIT 500";
  const bound = needle ? `%${needle}%` : "";
  const { results } = await db.prepare(sql).bind(...(needle ? [bound, bound] : [])).all<AccountRow>();
  return results;
}

export async function accountEvents(db: D1Database, email: string): Promise<EventRow[]> {
  const { results } = await db.prepare("SELECT * FROM events WHERE email = ? ORDER BY at DESC LIMIT 60").bind(accountEmail(email)).all<EventRow>();
  return results;
}

export async function recentEvents(db: D1Database): Promise<EventRow[]> {
  const { results } = await db.prepare("SELECT * FROM events ORDER BY at DESC LIMIT 80").all<EventRow>();
  return results;
}

export type LedgerSummary = {
  accounts: number; paid: number; blocked: number; byPlan: Record<string, number>; newThisWeek: number;
  activeThisWeek: number; activeToday: number; lastSeen: number; lastUsed: number;
};

export async function summarize(db: D1Database, at: number): Promise<LedgerSummary> {
  const week = at - 7 * 24 * 60 * 60 * 1000;
  const day = at - 24 * 60 * 60 * 1000;
  const one = <T>(sql: string, bind: unknown[] = []) => db.prepare(sql).bind(...bind).first<T>();
  const totals = await one<{ accounts: number; paid: number; blocked: number; lastSeen: number; lastUsed: number; activeToday: number }>(
    "SELECT COUNT(*) AS accounts, SUM(CASE WHEN plan != 'free' THEN 1 ELSE 0 END) AS paid, SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked, MAX(last_seen) AS lastSeen, MAX(last_used) AS lastUsed, SUM(CASE WHEN last_used >= ? THEN 1 ELSE 0 END) AS activeToday FROM accounts",
    [day],
  );
  const fresh = await one<{ count: number }>("SELECT COUNT(*) AS count FROM accounts WHERE first_seen >= ?", [week]);
  const active = await one<{ count: number }>("SELECT COUNT(*) AS count FROM accounts WHERE last_seen >= ? OR last_used >= ?", [week, week]);
  const plans = await db.prepare("SELECT plan, COUNT(*) AS count FROM accounts GROUP BY plan").all<{ plan: string; count: number }>();
  const byPlan: Record<string, number> = { free: 0, pro: 0, ultra: 0 };
  for (const row of plans.results) byPlan[row.plan] = row.count;
  return {
    accounts: totals?.accounts ?? 0, paid: totals?.paid ?? 0, blocked: totals?.blocked ?? 0, byPlan,
    newThisWeek: fresh?.count ?? 0, activeThisWeek: active?.count ?? 0, activeToday: totals?.activeToday ?? 0,
    lastSeen: totals?.lastSeen ?? 0, lastUsed: totals?.lastUsed ?? 0,
  };
}

/** Forget one person entirely — the record, everything the ledger knows they did, and what they asked. */
export async function deleteAccount(db: D1Database, email: string): Promise<void> {
  const target = accountEmail(email);
  await db.prepare("DELETE FROM usage WHERE email = ?").bind(target).run();
  await db.prepare("DELETE FROM events WHERE email = ?").bind(target).run();
  const gone = await db.prepare("DELETE FROM accounts WHERE email = ?").bind(target).run();
  if (!gone.meta?.changes) throw new Error(`No account matched ${target}.`);
}
