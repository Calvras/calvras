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
};
export type EventRow = { id: number; email: string; kind: string; detail: string; at: number };

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
  country TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_email_idx ON events (email, at DESC);
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
  accounts: number; paid: number; byPlan: Record<string, number>; newThisWeek: number;
  activeThisWeek: number; lastSeen: number;
};

export async function summarize(db: D1Database, at: number): Promise<LedgerSummary> {
  const week = at - 7 * 24 * 60 * 60 * 1000;
  const one = <T>(sql: string, bind: unknown[] = []) => db.prepare(sql).bind(...bind).first<T>();
  const totals = await one<{ accounts: number; paid: number; lastSeen: number }>("SELECT COUNT(*) AS accounts, SUM(CASE WHEN plan != 'free' THEN 1 ELSE 0 END) AS paid, MAX(last_seen) AS lastSeen FROM accounts");
  const fresh = await one<{ count: number }>("SELECT COUNT(*) AS count FROM accounts WHERE first_seen >= ?", [week]);
  const active = await one<{ count: number }>("SELECT COUNT(*) AS count FROM accounts WHERE last_seen >= ?", [week]);
  const plans = await db.prepare("SELECT plan, COUNT(*) AS count FROM accounts GROUP BY plan").all<{ plan: string; count: number }>();
  const byPlan: Record<string, number> = { free: 0, pro: 0, ultra: 0 };
  for (const row of plans.results) byPlan[row.plan] = row.count;
  return {
    accounts: totals?.accounts ?? 0, paid: totals?.paid ?? 0, byPlan,
    newThisWeek: fresh?.count ?? 0, activeThisWeek: active?.count ?? 0, lastSeen: totals?.lastSeen ?? 0,
  };
}

/** Forget one person entirely — the record, and everything the ledger knows they did. */
export async function deleteAccount(db: D1Database, email: string): Promise<void> {
  const target = accountEmail(email);
  await db.prepare("DELETE FROM events WHERE email = ?").bind(target).run();
  const gone = await db.prepare("DELETE FROM accounts WHERE email = ?").bind(target).run();
  if (!gone.meta?.changes) throw new Error(`No account matched ${target}.`);
}
