// @vitest-environment node
// The ledger is the one piece of the site that has to be exactly right: it decides who is on Pro.
// So it is tested against real SQLite, reached through a D1-shaped shim, rather than a stub that
// would only prove the calls were made.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA, accountEmail, deleteAccount, findByEmail, grantPlan, listAccounts, normalizePlan, recentEvents, recordSignIn, saveSubscription, summarize, quotaStatus, debitChat, setDailyChats, DEFAULT_DAILY_CHATS, randomLockDays, LOCK_DAYS_MIN, LOCK_DAYS_MAX, type D1Database } from "../lib/runtime/ledger";
import { PRODUCT_IDS } from "../lib/billing";
import { handleSiteApi, platformBindings } from "../lib/site-api";
import { d1Shim } from "./sqlite-d1";

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEDGER_SCHEMA);
  db = d1Shim(sqlite);
});

describe("ledger schema", () => {
  it("is the SQL the deployed migrations apply", () => {
    const read = (name: string) => readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
    const deployed = new DatabaseSync(":memory:");
    for (const file of ["0001_ledger.sql", "0002_account_location.sql", "0003_block_and_usage.sql", "0004_account_places.sql", "0005_subscriptions.sql", "0006_subscription_expiry.sql", "0007_daily_quota.sql", "0008_chats_and_lock.sql"]) deployed.exec(read(file));
    const shape = (handle: DatabaseSync) =>
      [
        ...["accounts", "events", "usage", "meta", "subscriptions"].flatMap((table) => (handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => `${table}.${column["name"]}`)),
        ...["events", "usage", "subscriptions"].flatMap((table) => (handle.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((index) => `${table}.index.${index["name"]}`)),
      ].sort();
    expect(shape(deployed)).toEqual(shape(sqlite));
    deployed.close();
  });

  it("names plans in the three the app sells", () => {
    expect(normalizePlan("LITE")).toBe("lite");
    expect(normalizePlan("ultra")).toBeNull();
    expect(normalizePlan("enterprise")).toBeNull();
    expect(normalizePlan("")).toBeNull();
  });

  it("refuses anything that is not an email", () => {
    expect(accountEmail("  Hello@Calvras.COM ")).toBe("hello@calvras.com");
    expect(() => accountEmail("nope")).toThrow(/verified email/);
    expect(() => accountEmail("a b@c.com")).toThrow(/verified email/);
  });
});

describe("sign-ins", () => {
  it("records a first sign-in as free and logs the event", async () => {
    const account = await recordSignIn(db, { email: "Dev@Calvras.com", name: "Dev", subject: "111", at: 1_700_000_000_000 });
    expect(account.email).toBe("dev@calvras.com");
    expect(account.plan).toBe("free");
    expect(account.signins).toBe(1);
    const events = await recentEvents(db);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ email: "dev@calvras.com", kind: "signin" })]));
  });

  it("keeps the plan and first-seen when the same person returns", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", name: "Dev", at: 1_000 });
    await grantPlan(db, "dev@calvras.com", "pro", "owner", 1_500);
    const again = await recordSignIn(db, { email: "dev@calvras.com", name: "Dev Renamed", at: 2_000 });
    expect(again.plan).toBe("pro");
    expect(again.plan_set_by).toBe("owner");
    expect(again.first_seen).toBe(1_000);
    expect(again.last_seen).toBe(2_000);
    expect(again.signins).toBe(2);
    expect(again.name).toBe("Dev Renamed");
  });

  it("notes where the sign-in came from and keeps the last known place", async () => {
    const first = await recordSignIn(db, { email: "dev@calvras.com", at: 1_000, city: "lahore", country: "pk" });
    expect(first.city).toBe("lahore");
    expect(first.country).toBe("PK");
    expect((await recentEvents(db))[0]?.detail).toBe("from lahore, PK");
    const second = await recordSignIn(db, { email: "dev@calvras.com", at: 2_000 });
    expect([second.city, second.country]).toEqual(["lahore", "PK"]);
  });

  it("keeps every place one account signs in from", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1_000, city: "lahore", country: "pk" });
    await recordSignIn(db, { email: "dev@calvras.com", at: 2_000, city: "karachi", country: "pk" });
    const both = await recordSignIn(db, { email: "dev@calvras.com", at: 3_000, city: "lahore", country: "pk" });
    // A city seen again is not listed twice, and a sign-in with no geolocation adds nothing.
    expect(both.places).toBe("lahore, PK;karachi, PK");
    await recordSignIn(db, { email: "dev@calvras.com", at: 4_000 });
    expect((await findByEmail(db, "dev@calvras.com"))?.places).toBe("lahore, PK;karachi, PK");
  });
});

describe("grants", () => {
  it("changes only a signed-in address", async () => {
    await expect(grantPlan(db, "ghost@calvras.com", "pro", "owner", 1)).rejects.toThrow(/No account is signed in/);
  });

  it("refuses a plan the store does not sell", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1 });
    await expect(grantPlan(db, "dev@calvras.com", "diamond", "owner", 2)).rejects.toThrow(/free, lite, or pro/);
  });

  it("records who set it and downgrades too", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1 });
    const pro = await grantPlan(db, "dev@calvras.com", "pro", "owner", 2);
    expect(pro.plan).toBe("pro");
    const free = await grantPlan(db, "dev@calvras.com", "free", "owner", 3);
    expect(free.plan).toBe("free");
    const events = await recentEvents(db);
    expect(events.filter((event) => event.kind === "plan").map((event) => event.detail)).toEqual(["owner set free", "owner set pro"]);
  });
});

describe("summaries and forgetting", () => {
  it("counts accounts, paid people and the week", async () => {
    const now = Date.now();
    await recordSignIn(db, { email: "a@calvras.com", at: now });
    await recordSignIn(db, { email: "b@calvras.com", at: now - 40 * 86_400_000 });
    await grantPlan(db, "a@calvras.com", "pro", "owner", now);
    const summary = await summarize(db, now);
    expect(summary).toMatchObject({ accounts: 2, paid: 1, byPlan: { free: 1, lite: 0, pro: 1 }, newThisWeek: 1, activeThisWeek: 1 });
    expect(summary.lastSeen).toBe(now);
  });

  it("searches by email or name", async () => {
    await recordSignIn(db, { email: "ada@calvras.com", name: "Ada", at: 1 });
    await recordSignIn(db, { email: "bob@calvras.com", name: "Robert", at: 2 });
    expect((await listAccounts(db, "rob")).map((row) => row.email)).toEqual(["bob@calvras.com"]);
    expect((await listAccounts(db, "")).length).toBe(2);
  });

  it("deletes the account and its events together", async () => {
    await recordSignIn(db, { email: "ada@calvras.com", at: 1 });
    await deleteAccount(db, "ada@calvras.com");
    expect(await listAccounts(db, "")).toEqual([]);
    expect(await recentEvents(db)).toEqual([]);
    await expect(deleteAccount(db, "ada@calvras.com")).rejects.toThrow(/No account matched/);
  });
});

describe("the site API in front of the ledger", () => {
  const request = (pathname: string, init: RequestInit = {}) => new Request(`https://calvras.com${pathname}`, init);
  const jsonInit = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("answers nothing outside its own namespace", async () => {
    expect(await handleSiteApi(request("/api/agent/tools"), { CALVRAS_DB: db })).toBeNull();
  });

  it("says the ledger is missing rather than pretending to be empty", async () => {
    const response = await handleSiteApi(request("/api/site/admin/summary"), { CALVRAS_ADMIN_TOKEN: "t" });
    expect(response?.status).toBe(503);
    expect((await response?.json())?.error).toMatch(/not attached/);
  });

  it("closes the console without the owner token", async () => {
    for (const authorization of [undefined, "Bearer wrong", "Bearer"]) {
      const response = await handleSiteApi(request("/api/site/admin/summary", { headers: authorization ? { authorization } : {} }), { CALVRAS_DB: db, CALVRAS_ADMIN_TOKEN: "secretpart" });
      expect(response?.status).toBe(401);
    }
    const configured = await handleSiteApi(request("/api/site/admin/summary"), { CALVRAS_DB: db });
    expect((await configured?.json())?.error).toMatch(/CALVRAS_ADMIN_TOKEN/);
  });

  it("lists, grants and forgets through the console", async () => {
    const env = { CALVRAS_DB: db, CALVRAS_ADMIN_TOKEN: "secretpart" };
    const headers = { authorization: "Bearer secretpart" };
    await recordSignIn(db, { email: "ada@calvras.com", name: "Ada", at: Date.now() });

    const summary = await (await handleSiteApi(request("/api/site/admin/summary", { headers }), env))?.json();
    expect(summary.ok).toBe(true);
    expect(summary.accounts.map((row: { email: string }) => row.email)).toEqual(["ada@calvras.com"]);
    expect(summary.sales.configured).toBe(true);
    expect(summary.sales.sales).toEqual([]);
    expect(summary.sales.note).toMatch(/RevenueCat/);

    const granted = await (await handleSiteApi(request("/api/site/admin/grant", jsonInit({ email: "ada@calvras.com", plan: "pro" }, headers)), env))?.json();
    expect(granted.account.plan).toBe("pro");

    const refused = await handleSiteApi(request("/api/site/admin/grant", jsonInit({ email: "ada@calvras.com", plan: "diamond" }, headers)), env);
    expect(refused?.status).toBe(400);

    const history = await (await handleSiteApi(request("/api/site/admin/history?email=ada@calvras.com", { headers }), env))?.json();
    expect(history.events.map((event: { kind: string }) => event.kind)).toEqual(["plan", "signin"]);

    const gone = await handleSiteApi(request("/api/site/admin/remove", jsonInit({ email: "ada@calvras.com" }, headers)), env);
    expect((await gone?.json()).ok).toBe(true);
    expect((await (await handleSiteApi(request("/api/site/admin/summary", { headers }), env))?.json()).accounts).toEqual([]);
  });

  it("refuses a session report whose token it cannot verify", async () => {
    const response = await handleSiteApi(request("/api/site/session", jsonInit({ idToken: "not.a.jwt" })), { CALVRAS_DB: db, GOOGLE_CLIENT_ID: "app.apps.googleusercontent.com" });
    expect(response?.status).toBe(401);
    expect((await response?.json())?.error).toMatch(/not a Google ID token/i);
  });

  it("reads sales from the subscriptions RevenueCat recorded, without a store key", async () => {
    await recordSignIn(db, { email: "ada@calvras.com", at: 1 });
    await saveSubscription(db, { id: "txn_1", email: "Ada@Calvras.com", plan: "pro", productId: PRODUCT_IDS.pro.month, status: "active", currency: "USD", expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, at: 2 });
    const response = await handleSiteApi(request("/api/site/admin/summary", { headers: { authorization: "Bearer k" } }), { CALVRAS_DB: db, CALVRAS_ADMIN_TOKEN: "k" });
    const text = await response?.text() || "";
    expect(text).toContain("txn_1");
    expect(text).toContain("ada@calvras.com");
    expect(text).toContain("Pro");
    expect(text).toContain("20.00");
  });
});

/**
 * The deployed Worker's fetch handler is called with an empty second argument: the Cloudflare runtime
 * entry keeps the bindings on the request it hands to the SSR service. Reading only the argument made
 * every /api/site call answer "the ledger is not attached" even after the database was created and
 * bound, which is how the owner console stayed shut.
 */
describe("the bindings the deployed Worker actually hands over", () => {
  const cloudRequest = (env: unknown, authorization = "Bearer secretpart") => {
    const request = new Request("https://calvras.com/api/site/admin/summary", { headers: { authorization } });
    Object.assign(request, { runtime: { cloudflare: { env } } });
    return request;
  };

  it("reads the ledger off the request when the fetch argument carries nothing", async () => {
    const request = cloudRequest({ CALVRAS_DB: db, CALVRAS_ADMIN_TOKEN: "secretpart" });
    const response = await handleSiteApi(request, platformBindings(request, undefined));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, accounts: [], summary: { accounts: 0 } });
  });

  it("still prefers the argument when a runtime does pass bindings through", async () => {
    const request = cloudRequest({});
    expect(platformBindings(request, { CALVRAS_DB: db }).CALVRAS_DB).toBe(db);
  });

  it("answers the honest 503 when neither carries a ledger", async () => {
    const request = cloudRequest(undefined);
    const response = await handleSiteApi(request, platformBindings(request, undefined));
    expect(response?.status).toBe(503);
    expect((await response?.json())?.error).toMatch(/not attached/);
  });
});

describe("daily chat quota and multi-day lock", () => {
  const DAY = 24 * 60 * 60 * 1000;
  it("starts at zero and allows inference", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1_000 });
    const status = await quotaStatus(db, "dev@calvras.com", 2_000);
    expect(status.allowed).toBe(true);
    expect(status.used).toBe(0);
    expect(status.limit).toBe(DEFAULT_DAILY_CHATS);
    expect(status.percent).toBe(0);
  });

  it("debits one chat per turn and reports percentage", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1_000 });
    const after = await debitChat(db, "dev@calvras.com", 2_000);
    expect(after.used).toBe(1);
    expect(after.percent).toBe(Math.round((1 / DEFAULT_DAILY_CHATS) * 100));
    expect(after.allowed).toBe(true);
    expect(after.exhausted).toBe(false);
  });

  it("draws a random 3-10 day lock when the limit is hit and stores it", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1_000 });
    for (let i = 0; i < DEFAULT_DAILY_CHATS; i++) await debitChat(db, "dev@calvras.com", 5_000 + i);
    const status = await quotaStatus(db, "dev@calvras.com", 6_000);
    expect(status.allowed).toBe(false);
    expect(status.exhausted).toBe(true);
    expect(status.percent).toBe(100);
    expect(status.lockDays).toBeGreaterThanOrEqual(LOCK_DAYS_MIN);
    expect(status.lockDays).toBeLessThanOrEqual(LOCK_DAYS_MAX);
    expect(status.lockedUntil).toBe(5_000 + (DEFAULT_DAILY_CHATS - 1) + status.lockDays * DAY);
    expect(status.resetAt).toBe(status.lockedUntil);
    // The drawn lock is persisted, not re-rolled on the next read.
    const again = await quotaStatus(db, "dev@calvras.com", 7_000);
    expect(again.lockDays).toBe(status.lockDays);
    expect(again.lockedUntil).toBe(status.lockedUntil);
  });

  it("stays locked through the old 24h window and opens after the drawn days", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1_000 });
    for (let i = 0; i < DEFAULT_DAILY_CHATS; i++) await debitChat(db, "dev@calvras.com", 5_000 + i);
    const locked = await quotaStatus(db, "dev@calvras.com", 6_000);
    const stillLocked = await quotaStatus(db, "dev@calvras.com", 5_000 + DAY + 1);
    expect(stillLocked.allowed).toBe(false);
    const later = locked.lockedUntil + 1;
    const status = await quotaStatus(db, "dev@calvras.com", later);
    expect(status.allowed).toBe(true);
    expect(status.used).toBe(0);
    expect(status.exhausted).toBe(false);
    expect(status.lockDays).toBe(0);
  });

  it("respects a per-account override", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1_000 });
    await setDailyChats(db, "dev@calvras.com", 2);
    await debitChat(db, "dev@calvras.com", 2_000);
    const after = await debitChat(db, "dev@calvras.com", 3_000);
    expect(after.limit).toBe(2);
    expect(after.exhausted).toBe(true);
  });

  it("accumulates across multiple chats in the same window", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1_000 });
    await debitChat(db, "dev@calvras.com", 2_000);
    await debitChat(db, "dev@calvras.com", 3_000);
    const status = await quotaStatus(db, "dev@calvras.com", 4_000);
    expect(status.used).toBe(2);
  });

  it("scales the allowance by plan: lite 2x, pro 4x", async () => {
    await recordSignIn(db, { email: "lite@calvras.com", at: 1 });
    await grantPlan(db, "lite@calvras.com", "lite", "owner", 2);
    await recordSignIn(db, { email: "pro@calvras.com", at: 1 });
    await grantPlan(db, "pro@calvras.com", "pro", "owner", 2);
    expect((await quotaStatus(db, "lite@calvras.com", 3)).limit).toBe(DEFAULT_DAILY_CHATS * 2);
    expect((await quotaStatus(db, "pro@calvras.com", 3)).limit).toBe(DEFAULT_DAILY_CHATS * 4);
  });

  it("randomLockDays stays inside the 3-10 band", () => {
    for (const r of [0, 0.5, 0.999]) {
      const days = randomLockDays(() => r);
      expect(days).toBeGreaterThanOrEqual(LOCK_DAYS_MIN);
      expect(days).toBeLessThanOrEqual(LOCK_DAYS_MAX);
    }
    expect(randomLockDays(() => 0)).toBe(LOCK_DAYS_MIN);
    expect(randomLockDays(() => 0.999)).toBe(LOCK_DAYS_MAX);
  });
});
