// @vitest-environment node
// The ledger is the one piece of the site that has to be exactly right: it decides who is on Pro.
// So it is tested against real SQLite, reached through a D1-shaped shim, rather than a stub that
// would only prove the calls were made.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA, accountEmail, deleteAccount, grantPlan, listAccounts, normalizePlan, recentEvents, recordSignIn, summarize, type D1Database } from "../lib/runtime/ledger";
import { handleSiteApi } from "../lib/site-api";
import { d1Shim } from "./sqlite-d1";

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEDGER_SCHEMA);
  db = d1Shim(sqlite);
});

describe("ledger schema", () => {
  it("is the SQL the deployed migration applies", () => {
    const migration = readFileSync(resolve(process.cwd(), "migrations/0001_ledger.sql"), "utf8");
    const statements = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean).sort();
    expect(statements(migration)).toEqual(statements(LEDGER_SCHEMA));
  });

  it("names plans in the three the app sells", () => {
    expect(normalizePlan("ULTRA")).toBe("ultra");
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
    await grantPlan(db, "dev@calvras.com", "ultra", "owner", 1_500);
    const again = await recordSignIn(db, { email: "dev@calvras.com", name: "Dev Renamed", at: 2_000 });
    expect(again.plan).toBe("ultra");
    expect(again.plan_set_by).toBe("owner");
    expect(again.first_seen).toBe(1_000);
    expect(again.last_seen).toBe(2_000);
    expect(again.signins).toBe(2);
    expect(again.name).toBe("Dev Renamed");
  });
});

describe("grants", () => {
  it("changes only a signed-in address", async () => {
    await expect(grantPlan(db, "ghost@calvras.com", "pro", "owner", 1)).rejects.toThrow(/No account is signed in/);
  });

  it("refuses a plan the store does not sell", async () => {
    await recordSignIn(db, { email: "dev@calvras.com", at: 1 });
    await expect(grantPlan(db, "dev@calvras.com", "diamond", "owner", 2)).rejects.toThrow(/free, pro, or ultra/);
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
    expect(summary).toMatchObject({ accounts: 2, paid: 1, byPlan: { free: 1, pro: 1, ultra: 0 }, newThisWeek: 1, activeThisWeek: 1 });
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
    expect(summary.sales.configured).toBe(false);

    const granted = await (await handleSiteApi(request("/api/site/admin/grant", jsonInit({ email: "ada@calvras.com", plan: "ultra" }, headers)), env))?.json();
    expect(granted.account.plan).toBe("ultra");

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

  it("reads sales from Payments AI without ever holding the key in the answer", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => new Response(JSON.stringify({ data: [{ id: "tx_1", customerEmail: "Ada@Calvras.com", amount: "9.00", currency: "USD", status: "succeeded", plan: "Pro", createdAt: "2026-10-01T10:00:00Z" }] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const response = await handleSiteApi(request("/api/site/admin/summary", { headers: { authorization: "Bearer k" } }), { CALVRAS_DB: db, CALVRAS_ADMIN_TOKEN: "k", CALVRAS_PAYMENTS_KEY: "pai_live_secret", CALVRAS_PAYMENTS_MERCHANT: "merchant-1" });
      const text = await response?.text() || "";
      expect(text).toContain("tx_1");
      expect(text).toContain("ada@calvras.com");
      expect(text).not.toContain("pai_live_secret");
    } finally {
      globalThis.fetch = original;
    }
  });
});
