// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHECKOUT_URLS, LIST_PRICES, buyerEmail, listPrice, packageCatalog, planForAmount, verifyPaymentsAiSignature } from "../lib/billing";

describe("Payments AI catalog", () => {
  it("sells only the two monthly hosted checkouts", () => {
    expect(packageCatalog()).toEqual([
      { plan: "lite", label: "Lite", price: "12.00", checkout: CHECKOUT_URLS.lite },
      { plan: "pro", label: "Pro", price: "30.00", checkout: CHECKOUT_URLS.pro },
    ]);
    expect(CHECKOUT_URLS.lite).toBe("https://mor.payments.ai/payment/01a1e81a-f39f-792d-b320-8a32c2c49905");
    expect(CHECKOUT_URLS.pro).toBe("https://mor.payments.ai/payment/01a1e81d-0489-740f-89e4-4c477f0d58cc");
    for (const row of packageCatalog()) expect(Number(listPrice(row.plan))).toBe(LIST_PRICES[row.plan]);
  });

  it("maps major-unit payment amounts without inventing a plan", () => {
    expect(planForAmount(12)).toBe("lite");
    expect(planForAmount("12.00")).toBe("lite");
    expect(planForAmount(30)).toBe("pro");
    for (const amount of [1200, 3000, 10, 20, 0, -12, null, undefined, "unknown"]) expect(planForAmount(amount)).toBeNull();
  });

  it("normalizes the customer.created email", () => {
    expect(buyerEmail({ email: " Buyer@Calvras.com " })).toBe("buyer@calvras.com");
    expect(buyerEmail({ customerId: "cust_1" })).toBe("");
  });
});

describe("Payments AI webhook signature", () => {
  const secret = "payments_ai_fixture_key";
  const body = '{ "eventType": "payment.completed", "amount": 12 }';
  const now = 1_800_000_000_000;
  const stamp = Math.floor(now / 1000);
  const sign = (ts: number, payload = body, key = secret) => `sha256=${createHmac("sha256", key).update(`${ts}.${payload}`).digest("hex")}`;

  it("verifies the exact timestamp and raw body", async () => {
    await expect(verifyPaymentsAiSignature(sign(stamp), String(stamp), body, secret, now)).resolves.toBe(true);
    await expect(verifyPaymentsAiSignature(sign(stamp), String(stamp), JSON.stringify(JSON.parse(body)), secret, now)).resolves.toBe(false);
  });

  it("rejects altered amounts and signatures from another key", async () => {
    await expect(verifyPaymentsAiSignature(sign(stamp), String(stamp), body.replace("12", "30"), secret, now)).resolves.toBe(false);
    await expect(verifyPaymentsAiSignature(sign(stamp, body, "other_fixture_key"), String(stamp), body, secret, now)).resolves.toBe(false);
  });

  it("accepts provider retries but rejects stale and future replays", async () => {
    for (const age of [60, 15 * 60, 60 * 60]) {
      await expect(verifyPaymentsAiSignature(sign(stamp - age), String(stamp - age), body, secret, now)).resolves.toBe(true);
    }
    for (const age of [-48 * 60 * 60, 48 * 60 * 60]) {
      await expect(verifyPaymentsAiSignature(sign(stamp - age), String(stamp - age), body, secret, now)).resolves.toBe(false);
    }
  });

  it("rejects malformed or missing headers and configuration", async () => {
    for (const header of [null, "", "v1=abc", "sha256=zzzz", "sha256=aa", `sha256=${"0".repeat(64)}`]) {
      await expect(verifyPaymentsAiSignature(header, String(stamp), body, secret, now)).resolves.toBe(false);
    }
    for (const ts of [null, "", "not-a-number", `${stamp}.5`, `${stamp}e0`]) {
      await expect(verifyPaymentsAiSignature(sign(stamp), ts, body, secret, now)).resolves.toBe(false);
    }
    await expect(verifyPaymentsAiSignature(sign(stamp), String(stamp), body, "", now)).resolves.toBe(false);
  });
});
