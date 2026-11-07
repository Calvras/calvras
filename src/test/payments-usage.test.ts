import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentsCatalog, paymentsStatus, setPaymentsConfig } from "../lib/runtime/payments";
import { usageStats } from "../lib/runtime/usage-stats";

const KEY = `pai_live_${"0".repeat(64)}`;
const MERCHANT = "2f7c1a44-9d3e-4f0a-8b6c-1d2e3f4a5b6c";
const original = process.env["LOCALAPPDATA"];
let dir = "";

const seed = (config: { apiKey?: string; merchantId?: string }) => {
  fs.mkdirSync(path.join(dir, "Calvras"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Calvras", "payments.json"), JSON.stringify(config));
};
const json = (payload: unknown, ok = true, status = 200) => ({ ok, status, json: async () => payload });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "calvras-payments-")); process.env["LOCALAPPDATA"] = dir; });
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env["LOCALAPPDATA"]; else process.env["LOCALAPPDATA"] = original;
  vi.unstubAllGlobals();
});

describe("payments store", () => {
  it("keeps the credential on this computer and hands the window only a hint", () => {
    const status = setPaymentsConfig({ apiKey: KEY, merchantId: MERCHANT.toUpperCase() });
    expect(status).toEqual({ hasKey: true, live: true, keyHint: `…${KEY.slice(-4)}`, merchantId: MERCHANT });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "Calvras", "payments.json"), "utf8")).apiKey).toBe(KEY);
    expect(paymentsStatus().merchantId).toBe(MERCHANT);
  });

  it("refuses a credential that is not a Payments AI key", () => {
    expect(() => setPaymentsConfig({ apiKey: "sk-or-v1-deadbeef" })).toThrow(/start with pai_live/);
    expect(() => setPaymentsConfig({ merchantId: "calvras" })).toThrow(/36-character/);
    expect(paymentsStatus()).toEqual({ hasKey: false, live: false, keyHint: "", merchantId: "" });
  });

  it("says what is missing before it would ask the store", async () => {
    const answer = await paymentsCatalog();
    expect(answer).toEqual({ ok: false, plans: [], error: "Calvras has no Payments AI merchant id saved yet." });
  });

  it("reads the live catalogue with the saved key and gives every plan a checkout link", async () => {
    seed({ apiKey: KEY, merchantId: MERCHANT });
    const request = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe(`https://mor.payments.ai/api/v1/public-api/merchants/${MERCHANT}/products`);
      expect(init?.headers?.["authorization"]).toBe(`Bearer ${KEY}`);
      return json({ data: [{ id: "prod_1", name: "Calvras Pro", plans: [{ id: "plan_1", name: "Monthly", amount: 9, currency: "USD", interval: "month" }] }] });
    });
    vi.stubGlobal("fetch", request);
    const answer = await paymentsCatalog();
    expect(answer.ok).toBe(true);
    expect(answer.plans).toEqual([{ planId: "plan_1", planName: "Monthly", productName: "Calvras Pro", amount: 9, currency: "usd", interval: "month", checkoutUrl: "https://mor.payments.ai/payment/plan_1" }]);
  });

  it("fetches plans separately for a product that does not carry them", async () => {
    seed({ apiKey: KEY, merchantId: MERCHANT });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/products")
      ? json([{ id: "prod_9", name: "Calvras Ultra" }])
      : json({ items: [{ id: "plan_9", name: "Yearly", amount: 179, interval: "year", checkoutUrl: "https://mor.payments.ai/payment/plan_9" }] })));
    const answer = await paymentsCatalog();
    expect(answer.plans).toMatchObject([{ planId: "plan_9", productName: "Calvras Ultra", amount: 179, interval: "year", checkoutUrl: "https://mor.payments.ai/payment/plan_9" }]);
  });

  it("passes the store's own refusal through instead of inventing a reason", async () => {
    seed({ apiKey: KEY, merchantId: MERCHANT });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ message: "Invalid merchant id" }) })));
    const answer = await paymentsCatalog();
    expect(answer).toEqual({ ok: false, plans: [], error: "HTTP 403: Invalid merchant id" });
  });
});

describe("usage totals", () => {
  const writeState = (folder: string, state: unknown) => {
    const target = path.join(dir, "Calvras", "projects", folder);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "state.json"), JSON.stringify(state));
  };

  it("totals the operation logs the agent actually wrote", () => {
    writeState("a", { memory: {}, tasks: [{ id: "1", title: "t", status: "done" }, { id: "2", title: "u", status: "running" }], logs: [
      { time: "2026-10-18T09:00:00.000Z", tool: "write_file", ok: true, detail: "" },
      { time: "2026-10-18T09:01:00.000Z", tool: "run_command", ok: false, detail: "exit 1" },
      { time: "2026-10-18T09:02:00.000Z", tool: "write_file", ok: true, detail: "" },
    ] });
    writeState("b", { memory: {}, tasks: [], logs: [{ time: "2026-10-17T08:00:00.000Z", tool: "read_file", ok: true, detail: "" }] });
    expect(usageStats()).toMatchObject({ available: true, projects: 2, toolCalls: 4, failures: 1, tasksDone: 1, tasksOpen: 1, capped: false });
    expect(usageStats().byTool.slice(0, 2)).toEqual([{ tool: "write_file", calls: 2, failures: 0 }, { tool: "run_command", calls: 1, failures: 1 }]);
    expect(new Date(usageStats().firstAt).toISOString()).toBe("2026-10-17T08:00:00.000Z");
  });

  it("reports that there is nothing to total rather than showing zero as a fact", () => {
    expect(usageStats()).toMatchObject({ available: false, toolCalls: 0, byTool: [] });
    writeState("c", { memory: {}, tasks: [], logs: [] });
    expect(usageStats()).toMatchObject({ available: true, projects: 1, toolCalls: 0 });
  });

  it("marks the window when a folder has already dropped older operations", () => {
    writeState("d", { memory: {}, tasks: [], logs: Array.from({ length: 300 }, (_, index) => ({ time: "2026-10-18T09:00:00.000Z", tool: "read_file", ok: true, detail: String(index) })) });
    expect(usageStats()).toMatchObject({ toolCalls: 300, capped: true });
  });
});
