// @vitest-environment node
// A webhook is money: it must grant a plan exactly once, keep access that was paid for, take it back
// when RevenueCat says the subscription expired, and never do any of it on a body it did not sign.
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA, findByEmail, grantPlan, recordSignIn, type D1Database } from "../lib/runtime/ledger";
import { PACKAGE_IDS, PRODUCT_IDS } from "../lib/billing";
import { handleSiteApi } from "../lib/site-api";
import { d1Shim } from "./sqlite-d1";

const SECRET = "rc_webhook_fixture_secret";
const DAY = 24 * 60 * 60 * 1000;
const LATER = Date.now() + 30 * DAY;
let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEDGER_SCHEMA);
  db = d1Shim(sqlite);
});

const sign = (body: string, secret = SECRET) => {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
};

const deliver = (event: Record<string, unknown>, options: { secret?: string; signature?: string | null; authorization?: string } = {}) => {
  const body = JSON.stringify({ api_version: "1.0", event: { id: "evt_1", environment: "PRODUCTION", ...event } });
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === null ? undefined : options.signature ?? sign(body, options.secret ?? SECRET);
  if (signature) headers["x-revenuecat-webhook-signature"] = signature;
  if (options.authorization) headers["authorization"] = options.authorization;
  return handleSiteApi(
    new Request("https://calvras.com/api/site/billing/webhook", { method: "POST", headers, body }),
    { CALVRAS_DB: db, REVENUECAT_WEBHOOK_SECRET: SECRET, REVENUECAT_WEBHOOK_AUTH: "rc-auth-fixture" },
  );
};

const event = (type: string, input: {
  email?: string;
  productId?: string;
  entitlements?: string[];
  transactionId?: string;
  expiresAt?: number;
} = {}) => ({
  type,
  app_user_id: input.email ?? "buyer@calvras.com",
  product_id: input.productId ?? PRODUCT_IDS.pro.month,
  entitlement_ids: input.entitlements ?? ["pro"],
  original_transaction_id: input.transactionId ?? "txn_1",
  transaction_id: input.transactionId ?? "txn_1",
  expiration_at_ms: input.expiresAt ?? LATER,
  purchased_at_ms: Date.now() - DAY,
  currency: "USD",
  store: "REVENUECAT_BILLING",
  period_type: "NORMAL",
});

describe("RevenueCat purchases", () => {
  it("puts the plan on the account the checkout named", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    const response = await deliver(event("INITIAL_PURCHASE", { email: "Buyer@Calvras.com" }));
    expect(response?.status).toBe(200);
    const account = await findByEmail(db, "buyer@calvras.com");
    expect(account?.plan).toBe("pro");
    expect(account?.plan_set_by).toBe("revenuecat");
  });

  it("understands a yearly package the same way", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("INITIAL_PURCHASE", { productId: PRODUCT_IDS.ultra.year, entitlements: ["ultra"], expiresAt: Date.now() + 365 * DAY }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("ultra");
  });

  it("keeps access when a subscription is cancelled, until the paid time runs out", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("INITIAL_PURCHASE", { productId: PRODUCT_IDS.ultra.month, entitlements: ["ultra"] }));
    await deliver(event("CANCELLATION", { productId: PRODUCT_IDS.ultra.month, entitlements: ["ultra"] }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("ultra");
    // The clock passing the paid-through date takes the plan back.
    await deliver(event("EXPIRATION", { productId: PRODUCT_IDS.ultra.month, entitlements: ["ultra"], expiresAt: Date.now() - 1000 }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("free");
  });

  it("takes an expired row out of the plan even while the event says active", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("INITIAL_PURCHASE"));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("pro");
    // A renewal recorded with a paid-through date already in the past must not keep the plan alive.
    await deliver(event("RENEWAL", { expiresAt: Date.now() - 1000 }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("free");
  });

  it("keeps access while a renewal is past due, and restores it when it is paid", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("INITIAL_PURCHASE", { productId: PRODUCT_IDS.ultra.month, entitlements: ["ultra"] }));
    await deliver(event("BILLING_ISSUE", { productId: PRODUCT_IDS.ultra.month, entitlements: ["ultra"] }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("ultra");
    await deliver(event("RENEWAL", { productId: PRODUCT_IDS.ultra.month, entitlements: ["ultra"] }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("ultra");
  });

  it("lets an owner's grant outrank a cancelled subscription", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await grantPlan(db, "buyer@calvras.com", "ultra", "owner", 2);
    await deliver(event("CANCELLATION", { expiresAt: Date.now() - 1000 }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("ultra");
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan_set_by).toBe("owner");
  });

  it("applies the same delivery twice without stacking anything", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("INITIAL_PURCHASE"));
    await deliver(event("INITIAL_PURCHASE"));
    const rows = sqlite.prepare("SELECT COUNT(*) AS count FROM subscriptions").get() as { count: number };
    expect(rows.count).toBe(1);
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("pro");
  });

  it("refuses a body it did not sign, and changes nothing", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    const response = await deliver(event("INITIAL_PURCHASE"), { secret: "someone_else" });
    expect(response?.status).toBe(401);
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("free");
  });

  it("accepts the plain Authorization value configured in the dashboard", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    const response = await deliver(event("INITIAL_PURCHASE"), { signature: null, authorization: "rc-auth-fixture" });
    expect(response?.status).toBe(200);
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("pro");
    expect((await deliver(event("INITIAL_PURCHASE", { transactionId: "txn_2" }), { signature: null, authorization: "wrong" }))?.status).toBe(401);
  });

  it("says so when the site has no webhook secret rather than trusting the caller", async () => {
    const response = await handleSiteApi(
      new Request("https://calvras.com/api/site/billing/webhook", { method: "POST", body: JSON.stringify({ event: event("INITIAL_PURCHASE") }) }),
      { CALVRAS_DB: db },
    );
    expect(response?.status).toBe(503);
  });

  it("leaves a purchase for a product this catalog does not sell alone", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("INITIAL_PURCHASE", { productId: "calvras_not_ours", entitlements: [] }));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("free");
  });

  it("ignores RevenueCat's own test delivery", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("TEST"));
    expect((await findByEmail(db, "buyer@calvras.com"))?.plan).toBe("free");
  });

  it("hands the plan over when the person signs in after paying", async () => {
    const { issueSession, signingKey } = await import("../lib/runtime/session-token");
    // No account exists yet at purchase time: the delivery is kept, and the sign-in picks it up.
    await deliver(event("INITIAL_PURCHASE", { email: "late@calvras.com" }));
    expect(await findByEmail(db, "late@calvras.com")).toBeNull();
    await recordSignIn(db, { email: "late@calvras.com", at: 2 });
    const session = await issueSession(await signingKey(db), "late@calvras.com", Date.now());
    const response = await handleSiteApi(new Request("https://calvras.com/api/site/pulse", { method: "POST", body: JSON.stringify({ session }) }), { CALVRAS_DB: db });
    expect(response?.status).toBe(200);
    expect((await response!.json() as { plan?: string }).plan).toBe("pro");
  });
});

describe("RevenueCat config and sales", () => {
  it("hands the checkout page the public key and package list, never the webhook secret", async () => {
    const response = await handleSiteApi(new Request("https://calvras.com/api/site/billing/config"), {
      CALVRAS_DB: db,
      REVENUECAT_PUBLIC_KEY: "rcb_public_fixture",
      REVENUECAT_WEBHOOK_SECRET: SECRET,
    });
    const payload = (await response!.json()) as { apiKey?: string; offering?: string; packages?: { packageId: string; price: string }[] };
    expect(payload.apiKey).toBe("rcb_public_fixture");
    expect(payload.offering).toBe("calvras");
    expect(payload.packages?.map((row) => row.packageId)).toEqual([PACKAGE_IDS.pro.month, PACKAGE_IDS.pro.year, PACKAGE_IDS.ultra.month, PACKAGE_IDS.ultra.year]);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it("shows delivered subscriptions in the console with the plan's list price", async () => {
    await recordSignIn(db, { email: "buyer@calvras.com", at: 1 });
    await deliver(event("INITIAL_PURCHASE", { productId: PRODUCT_IDS.ultra.year, entitlements: ["ultra"] }));
    const response = await handleSiteApi(
      new Request("https://calvras.com/api/site/admin/summary", { headers: { authorization: "Bearer k" } }),
      { CALVRAS_DB: db, CALVRAS_ADMIN_TOKEN: "k" },
    );
    const body = (await response!.json()) as { sales?: { configured?: boolean; sales?: { email: string; plan: string; amount: string; currency: string; billing: string }[] } };
    expect(body.sales?.configured).toBe(true);
    expect(body.sales?.sales?.[0]).toMatchObject({ email: "buyer@calvras.com", plan: "Ultra", amount: "179.00", currency: "USD", billing: "year" });
  });
});
