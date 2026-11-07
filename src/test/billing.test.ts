// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIST_PRICES, PACKAGE_IDS, PRODUCT_IDS, buyerEmail, listPrice, packageCatalog, packageKey, planForEntitlements, planForProduct, verifyRevenueCatSignature } from "../lib/billing";

describe("RevenueCat catalog", () => {
  it("maps every product id back to the plan and period it sells", () => {
    expect(planForProduct(PRODUCT_IDS.pro.month)).toEqual({ plan: "pro", billing: "month" });
    expect(planForProduct(PRODUCT_IDS.pro.year)).toEqual({ plan: "pro", billing: "year" });
    expect(planForProduct(PRODUCT_IDS.ultra.month)).toEqual({ plan: "ultra", billing: "month" });
    expect(planForProduct(PRODUCT_IDS.ultra.year)).toEqual({ plan: "ultra", billing: "year" });
    // The dashboard is case-insensitive about identifiers; a delivery may echo it in any case.
    expect(planForProduct(PRODUCT_IDS.ultra.year.toUpperCase())?.plan).toBe("ultra");
    expect(planForProduct("calvras_something_else")).toBeNull();
    expect(planForProduct("")).toBeNull();
  });

  it("names the package the checkout page has to look up", () => {
    expect(packageKey("pro", "month")).toBe(PACKAGE_IDS.pro.month);
    expect(packageKey("ultra", "year")).toBe(PACKAGE_IDS.ultra.year);
    expect(packageKey("pro", "weekly")).toBe(PACKAGE_IDS.pro.month);
    expect(packageKey("starter", "month")).toBe("");
  });

  it("prints exactly the prices the dashboard products were created with", () => {
    for (const row of packageCatalog()) expect(row.price).toBe(LIST_PRICES[row.plan][row.billing]);
    expect(listPrice("pro", "month")).toBe("9.00");
    expect(listPrice("pro", "year")).toBe("79.00");
    expect(listPrice("ultra", "month")).toBe("20.00");
    expect(listPrice("ultra", "year")).toBe("179.00");
    expect(packageCatalog()).toHaveLength(4);
  });

  it("lets the higher entitlement win when a delivery carries both", () => {
    expect(planForEntitlements(["pro"])).toBe("pro");
    expect(planForEntitlements(["pro", "ultra"])).toBe("ultra");
    expect(planForEntitlements(["ULTRA"])).toBe("ultra");
    expect(planForEntitlements([])).toBeNull();
    expect(planForEntitlements(["something"])).toBeNull();
  });

  it("reads the buyer out of the identity RevenueCat sends", () => {
    expect(buyerEmail({ app_user_id: "Buyer@Calvras.com" })).toBe("buyer@calvras.com");
    expect(buyerEmail({ identity: { app_user_id: "ada@calvras.com" } })).toBe("ada@calvras.com");
    expect(buyerEmail({ original_app_user_id: "old@calvras.com" })).toBe("old@calvras.com");
    expect(buyerEmail({})).toBe("");
  });
});

describe("RevenueCat webhook signature", () => {
  const secret = "rc_webhook_fixture_secret";
  const body = JSON.stringify({ api_version: "1.0", event: { type: "INITIAL_PURCHASE" } });
  const now = 1_800_000_000_000;
  const stamp = Math.floor(now / 1000);
  const sign = (ts: number, payload = body, key = secret) => `t=${ts},v1=${createHmac("sha256", key).update(`${ts}.${payload}`).digest("hex")}`;

  it("accepts a delivery RevenueCat signed", async () => {
    await expect(verifyRevenueCatSignature(sign(stamp), body, secret, now)).resolves.toBe(true);
  });

  it("accepts when any of the listed v1 signatures matches", async () => {
    const header = `t=${stamp},v1=${"0".repeat(64)},v1=${createHmac("sha256", secret).update(`${stamp}.${body}`).digest("hex")}`;
    await expect(verifyRevenueCatSignature(header, body, secret, now)).resolves.toBe(true);
  });

  it("refuses a body that changed after it was signed", async () => {
    await expect(verifyRevenueCatSignature(sign(stamp), body.replace("INITIAL", "EXPIRATION"), secret, now)).resolves.toBe(false);
  });

  it("refuses a signature made with another secret", async () => {
    await expect(verifyRevenueCatSignature(sign(stamp, body, "someone_else"), body, secret, now)).resolves.toBe(false);
  });

  it("refuses a delivery old enough to be a replay", async () => {
    await expect(verifyRevenueCatSignature(sign(stamp - 48 * 60 * 60), body, secret, now)).resolves.toBe(false);
    // A deploy can make RevenueCat retry much later; a day-old delivery is still the same purchase and
    // its replay only rewrites the same ledger row.
    await expect(verifyRevenueCatSignature(sign(stamp - 60 * 60), body, secret, now)).resolves.toBe(true);
  });

  it("refuses malformed headers and a missing secret", async () => {
    for (const header of ["", "v1=abc", "t=not-a-number,v1=abc", `t=${stamp},v1=zzzz`, `t=${stamp}`]) {
      await expect(verifyRevenueCatSignature(header, body, secret, now), header).resolves.toBe(false);
    }
    await expect(verifyRevenueCatSignature(sign(stamp), body, "", now)).resolves.toBe(false);
  });
});
