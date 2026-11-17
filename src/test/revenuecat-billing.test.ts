// @vitest-environment node
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEDGER_SCHEMA, debitTokens, findByEmail, grantPlan, quotaStatus, recordSignIn, type D1Database } from "../lib/runtime/ledger";
import { CHECKOUT_URLS } from "../lib/billing";
import { handleSiteApi } from "../lib/site-api";
import { issueSession, signingKey } from "../lib/runtime/session-token";
import { d1Shim } from "./sqlite-d1";

const SECRET = "payments_ai_fixture_key";
const DAY = 86_400_000;
const EMAIL = "buyer@calvras.com";
let sqlite: DatabaseSync;
let db: D1Database;
let sequence: number;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEDGER_SCHEMA);
  db = d1Shim(sqlite);
  sequence = 0;
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

function delivery(payload: unknown, options: { key?: string; signature?: string | null; raw?: string; database?: D1Database } = {}) {
  const raw = options.raw ?? JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = options.signature === null ? "" : options.signature ?? `sha256=${createHmac("sha256", options.key ?? SECRET).update(`${timestamp}.${raw}`).digest("hex")}`;
  return handleSiteApi(new Request("https://calvras.com/pricing", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-timestamp": timestamp, "x-webhook-signature": signature },
    body: raw,
  }), { CALVRAS_DB: options.database ?? db, PAI_WEBHOOK_SECRET: SECRET });
}

const event = (eventType: string, fields: Record<string, unknown> = {}) => ({ eventId: `evt_${++sequence}`, eventType, customerId: "cust_1", ...fields });
const customer = () => delivery(event("customer.created", { email: " Buyer@Calvras.com " }));
const payment = (amount = 12, fields: Record<string, unknown> = {}) => event("payment.completed", { subscriptionId: "sub_1", transactionId: `txn_${sequence + 1}`, amount, currency: "USD", ...fields });
const subscription = (status: string, days = 30) => event("subscription.updated", { subscriptionId: "sub_1", status, currentPeriodEnd: new Date(Date.now() + days * DAY).toISOString() });
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

async function purchased(amount = 12) {
  await recordSignIn(db, { email: EMAIL, at: Date.now() });
  expect((await customer())?.status).toBe(200);
  expect((await delivery(payment(amount)))?.status).toBe(200);
  await delivery(subscription("active"));
}

describe("Payments AI account upgrades", () => {
  it.each([[12, "lite", 200_000], [30, "pro", 400_000]] as const)("grants a $%s purchase as %s with %s tokens", async (amount, plan, limit) => {
    await purchased(amount);
    expect(await findByEmail(db, EMAIL)).toMatchObject({ plan, plan_set_by: "payments-ai" });
    expect((await quotaStatus(db, EMAIL, Date.now())).limit).toBe(limit);
  });

  it("holds a payment until customer.created supplies the email", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    const paid = payment(30);
    await delivery(paid);
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    expect(sqlite.prepare("SELECT processed FROM pai_events WHERE event_id = ?").get(paid.eventId)).toMatchObject({ processed: 0 });
    await delivery(subscription("active"));
    await customer();
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
    expect(sqlite.prepare("SELECT processed FROM pai_events WHERE event_id = ?").get(paid.eventId)).toMatchObject({ processed: 1 });
  });

  it("keeps subscription period data delivered before the payment", async () => {
    await delivery(subscription("active"));
    await delivery(payment());
    await customer();
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    const session = await issueSession(await signingKey(db), EMAIL, Date.now());
    const response = await handleSiteApi(new Request("https://calvras.com/api/site/pulse", { method: "POST", body: JSON.stringify({ session }) }), { CALVRAS_DB: db });
    expect(await response!.json()).toMatchObject({ plan: "lite" });
    expect((sqlite.prepare("SELECT expires_at FROM subscriptions WHERE id = 'sub_1'").get() as { expires_at: number }).expires_at).toBeGreaterThan(Date.now());
  });

  it("deduplicates stable event ids across delivery retries", async () => {
    await purchased();
    const paid = payment(30);
    await delivery(paid);
    const eventsBefore = count("events");
    expect(await (await delivery(paid))!.json()).toMatchObject({ duplicate: true });
    expect(count("subscriptions")).toBe(1);
    expect(count("events")).toBe(eventsBefore);
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
  });

  it("retries an event whose first ledger application failed", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    await customer();
    await delivery(subscription("active"));
    const paid = payment();
    let fail = true;
    const flaky: D1Database = { prepare(sql) {
      if (fail && sql.includes("INSERT INTO subscriptions")) { fail = false; throw new Error("fixture interruption"); }
      return db.prepare(sql);
    } };
    expect((await delivery(paid, { database: flaky }))?.status).toBe(503);
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    expect((await delivery(paid))?.status).toBe(200);
    expect((await findByEmail(db, EMAIL))?.plan).toBe("lite");
  });

  it("keeps cancelled access only through the paid period", async () => {
    await purchased(30);
    await delivery(subscription("canceling"));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
    await delivery(subscription("inactive", -1));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
  });

  it("does not keep an active subscription past its paid-through date", async () => {
    await purchased();
    await delivery(subscription("active", -1));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
  });

  it("takes refunded access back and lets owner grants outrank billing", async () => {
    await purchased(30);
    await delivery(event("payment.refunded", { subscriptionId: "sub_1", transactionId: "txn_2", refundId: "refund_1", amount: 30, currency: "USD" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    await grantPlan(db, EMAIL, "pro", "owner", Date.now());
    await delivery(subscription("inactive", -1));
    expect(await findByEmail(db, EMAIL)).toMatchObject({ plan: "pro", plan_set_by: "owner" });
  });

  it("lifts a Free exhaustion lock after a paid upgrade without erasing spent tokens", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    expect((await debitTokens(db, EMAIL, 100_000, Date.now())).exhausted).toBe(true);
    await customer();
    await delivery(payment());
    await delivery(subscription("active"));
    expect(await quotaStatus(db, EMAIL, Date.now())).toMatchObject({ limit: 200_000, used: 100_000, allowed: true, lockDays: 0 });
  });

  it("waits for a paid-through period instead of granting permanent payment access", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    await customer();
    const paid = payment();
    await delivery(paid);
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    await delivery(event("subscription.created", { subscriptionId: "sub_1", status: "active", currentPeriodEnd: null }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    expect(sqlite.prepare("SELECT processed FROM pai_events WHERE event_id = ?").get(paid.eventId)).toMatchObject({ processed: 0 });
    await delivery(subscription("active"));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("lite");
  });

  it("recovers nullable payment links only through an explicit matching order", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    await customer();
    const paid = payment(30, { subscriptionId: null, customerId: null, orderId: "order_1" });
    await delivery(paid);
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    await delivery({ ...subscription("active"), orderId: "order_1" });
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
    expect(count("subscriptions")).toBe(1);
    expect(sqlite.prepare("SELECT processed FROM pai_events WHERE event_id = ?").get(paid.eventId)).toMatchObject({ processed: 1 });
  });

  it("does not guess an account for an unlinked payment", async () => {
    await purchased();
    const paid = payment(30, { subscriptionId: null, customerId: null, orderId: null });
    await delivery(paid);
    await delivery(subscription("active"));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("lite");
    expect(sqlite.prepare("SELECT processed FROM pai_events WHERE event_id = ?").get(paid.eventId)).toMatchObject({ processed: 0 });
  });

  it("keeps partial refunds active and revokes only the cumulative full refund", async () => {
    await purchased(30);
    await delivery(event("payment.refunded", { subscriptionId: "sub_1", transactionId: "txn_2", refundId: "refund_1", amount: 10, currency: "USD" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
    await delivery(event("payment.refunded", { subscriptionId: "sub_1", transactionId: "txn_2", refundId: "refund_2", amount: 20, currency: "USD" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    await delivery(subscription("active"));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
  });

  it("does not revoke a newer renewal when an older payment is refunded", async () => {
    await purchased(30);
    await delivery(payment(30, { occurredAt: new Date().toISOString() }));
    await delivery(event("payment.refunded", { subscriptionId: "sub_1", transactionId: "txn_2", refundId: "refund_1", amount: 30, currency: "USD" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
  });

  it("does not revive a fully refunded transaction when payment arrives late", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    await customer();
    await delivery(subscription("active"));
    await delivery(event("payment.refunded", { subscriptionId: "sub_1", transactionId: "delayed_transaction", refundId: "refund_1", amount: 30, currency: "USD" }));
    await delivery(payment(30, { transactionId: "delayed_transaction" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    await delivery(subscription("active"));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
  });

  it("does not let a delayed old completion replace a newer purchase", async () => {
    await purchased(30);
    await delivery(payment(30, { transactionId: "new_payment", occurredAt: "2026-11-02T00:00:00Z" }));
    await delivery(payment(12, { transactionId: "old_payment", occurredAt: "2026-11-01T00:00:00Z" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
    await delivery(event("payment.refunded", { subscriptionId: "sub_1", transactionId: "old_payment", refundId: "old_refund", amount: 12, currency: "USD" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
  });

  it("revokes the latest order-linked payment even when its refund has no links", async () => {
    await purchased();
    await delivery({ ...subscription("active"), orderId: "new_order" });
    await delivery(payment(30, { subscriptionId: null, customerId: null, orderId: "new_order", transactionId: "order_payment", occurredAt: "2026-11-02T00:00:00Z" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
    await delivery(event("payment.refunded", { subscriptionId: null, customerId: null, orderId: null, transactionId: "order_payment", refundId: "new_refund", amount: 30, currency: "USD" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
  });

  it("protects a newer order-linked payment from an older refund", async () => {
    await purchased();
    await delivery({ ...subscription("active"), orderId: "new_order" });
    await delivery(payment(30, { subscriptionId: null, customerId: null, orderId: "new_order", transactionId: "order_payment", occurredAt: "2026-11-02T00:00:00Z" }));
    await delivery(event("payment.refunded", { subscriptionId: "sub_1", transactionId: "txn_2", refundId: "old_refund", amount: 12, currency: "USD" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("pro");
  });

  it("does not apply a pending payment twice during nested customer reconciliation", async () => {
    await delivery(subscription("active"));
    await delivery(payment());
    await customer();
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'billing' AND detail = 'Lite active (Payments AI)'").get() as { count: number }).count).toBe(1);
  });

  it("ignores amounts and currencies outside this catalog", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    await customer();
    await delivery(payment(1200));
    await delivery(payment(12, { currency: "EUR" }));
    expect((await findByEmail(db, EMAIL))?.plan).toBe("free");
    expect(count("subscriptions")).toBe(0);
  });
});

describe("Payments AI HTTP boundary", () => {
  it("rejects unsigned or wrongly signed payments without recording them", async () => {
    for (const options of [{ key: "other_fixture_key" }, { signature: null }]) expect((await delivery(payment(), options))?.status).toBe(401);
    expect(count("pai_events")).toBe(0);
  });

  it("rejects malformed signed JSON and non-event bodies", async () => {
    expect((await delivery({}, { raw: "not json" }))?.status).toBe(400);
    for (const payload of [null, [], {}, { eventId: "missing_type" }]) expect((await delivery(payload))?.status).toBe(400);
  });

  it("acknowledges the provider test ping without changing accounts", async () => {
    expect(await (await delivery({ type: "webhook.test", createdAt: new Date().toISOString() }))!.json()).toMatchObject({ ok: true, test: true });
    expect(count("pai_events")).toBe(0);
    expect(count("subscriptions")).toBe(0);
  });

  it("fails closed when the Worker secret is missing", async () => {
    const response = await handleSiteApi(new Request("https://calvras.com/pricing", { method: "POST", body: "{}" }), { CALVRAS_DB: db });
    expect(response?.status).toBe(503);
  });

  it("returns public checkout URLs, never the signing key", async () => {
    const response = await handleSiteApi(new Request("https://calvras.com/api/site/billing/config"), { CALVRAS_DB: db, PAI_WEBHOOK_SECRET: SECRET });
    const payload = await response!.json();
    expect(payload.packages.map((row: { checkout: string }) => row.checkout)).toEqual([CHECKOUT_URLS.lite, CHECKOUT_URLS.pro]);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it("shows a $30 monthly Pro purchase in owner sales", async () => {
    await purchased(30);
    const response = await handleSiteApi(new Request("https://calvras.com/api/site/admin/summary", { headers: { authorization: "Bearer fixture_owner" } }), { CALVRAS_DB: db, CALVRAS_ADMIN_TOKEN: "fixture_owner" });
    expect((await response!.json()).sales.sales[0]).toMatchObject({ email: EMAIL, plan: "Pro", amount: "30.00", currency: "USD", billing: "month" });
  });
});

describe("metered provider streaming", () => {
  it.each(["deepseek-ai/DeepSeek-V4.1-Flash-1017", "client-selected-model", undefined])("uses the server model instead of the desktop model %s", async (model) => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    const session = await issueSession(await signingKey(db), EMAIL, Date.now());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleSiteApi(new Request("https://calvras.com/api/site/chat", {
      method: "POST",
      body: JSON.stringify({ session, model, messages: [{ role: "user", content: "Hi" }] }),
    }), { CALVRAS_DB: db, CALVRAS_AI_KEY: "fixture_provider_key", CALVRAS_AI_MODEL: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    expect(response?.status).toBe(200);
    await response!.text();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.together.xyz/v1/chat/completions");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });

  it("charges reported input and output tokens and sends quota before one DONE frame", async () => {
    await recordSignIn(db, { email: EMAIL, at: Date.now() });
    const session = await issueSession(await signingKey(db), EMAIL, Date.now());
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"usage":{"prompt_tokens":1000,"completion_tokens":234}}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetchMock);
    const response = await handleSiteApi(new Request("https://calvras.com/api/site/chat", { method: "POST", body: JSON.stringify({ session, messages: [{ role: "user", content: "Hi" }] }) }), { CALVRAS_DB: db, CALVRAS_AI_KEY: "fixture_provider_key" });
    const stream = await response!.text();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.together.xyz/v1/chat/completions");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", stream_options: { include_usage: true } });
    expect((await quotaStatus(db, EMAIL, Date.now())).used).toBe(1234);
    expect(stream).toContain('"used":1234');
    expect(stream.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(stream.indexOf('"quota"')).toBeLessThan(stream.indexOf("data: [DONE]"));
  });
});
