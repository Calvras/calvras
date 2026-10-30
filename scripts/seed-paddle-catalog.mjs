#!/usr/bin/env node
/**
 * Seed the live Paddle catalog for Calvras (Pro $9/mo, Ultra $20/mo) and write
 * the created ids to scripts/paddle-catalog.json.
 *
 * Requires Node 18+ (global fetch) and PADDLE_API_KEY with product.write and
 * price.write permissions (Paddle > My account > Settings > Authentication).
 *
 * In cmd:
 *   set PADDLE_API_KEY=pdl_live_your_key_here
 *   node scripts\seed-paddle-catalog.mjs
 *
 * Durable hosted checkout links (https://buy.paddle.com/...) cannot be created
 * via API — create them in the dashboard under Catalog > Payment links, one per
 * price, and hand the two URLs to your agent to wire into src/lib/plans.ts.
 *
 * Products and prices are reused when a same-name / same-price entry already
 * exists, so re-runs do not duplicate the catalog.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.PADDLE_BASE || "https://api.paddle.com").replace(/\/+$/, "");
const KEY = process.env.PADDLE_API_KEY || "";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PLANS = [
  { key: "pro", name: "Pro", amount: "900", description: "Calvras Pro plan" },
  { key: "ultra", name: "Ultra", amount: "2000", description: "Calvras Ultra plan" },
];

if (!KEY) {
  console.error("FAIL  PADDLE_API_KEY is not set.");
  console.error("      In cmd: set PADDLE_API_KEY=pdl_live_your_key_here  then rerun.");
  process.exit(1);
}

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!response.ok) {
    const detail = json?.error ? JSON.stringify(json.error) : text;
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${String(detail).slice(0, 800)}`);
  }
  return json;
}

async function listAll(path) {
  const items = [];
  let after = null;
  for (let page = 0; page < 25; page++) {
    const query = after ? `${path}${path.includes("?") ? "&" : "?"}after=${encodeURIComponent(after)}` : path;
    const json = await api("GET", query);
    items.push(...(json.data ?? []));
    const next = json?.meta?.pagination?.next;
    if (!next) return items;
    try { after = new URL(next).searchParams.get("after"); } catch { return items; }
    if (!after) return items;
  }
  return items;
}

async function ensurePlan(plan, existingProducts) {
  let product = existingProducts.find((p) => p.name === plan.name && p.status !== "archived");
  if (product) {
    console.log(`OK    product ${plan.name}: exists (${product.id})`);
  } else {
    const created = await api("POST", "/products", {
      name: plan.name,
      tax_category: "saas",
      description: plan.description,
    });
    product = created.data;
    console.log(`OK    product ${plan.name}: created (${product.id})`);
  }

  const prices = await listAll(`/prices?product_id=${encodeURIComponent(product.id)}`);
  const priceDescription = `${plan.name} monthly USD`;
  const price = prices.find(
    (p) =>
      p.status !== "archived" &&
      p.unit_price?.amount === plan.amount &&
      p.unit_price?.currency_code === "USD" &&
      p.billing_cycle?.interval === "month" &&
      p.billing_cycle?.frequency === 1,
  );
  let priceId;
  if (price) {
    priceId = price.id;
    console.log(`OK    price ${priceDescription}: exists (${priceId})`);
  } else {
    const created = await api("POST", "/prices", {
      product_id: product.id,
      description: priceDescription,
      name: "Monthly",
      unit_price: { amount: plan.amount, currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
    });
    priceId = created.data.id;
    console.log(`OK    price ${priceDescription}: created (${priceId})`);
  }

  return {
    product_id: product.id,
    price_id: priceId,
    price_description: priceDescription,
    unit_price: { amount: plan.amount, currency_code: "USD" },
    billing_cycle: { interval: "month", frequency: 1 },
  };
}

async function main() {
  console.log(`Using Paddle API: ${BASE}`);
  const products = await listAll("/products");
  console.log(`Found ${products.length} existing products.`);

  const catalog = { created_at: new Date().toISOString(), environment: "live", base: BASE, plans: {} };
  for (const plan of PLANS) {
    catalog.plans[plan.key] = await ensurePlan(plan, products);
  }

  const jsonPath = join(root, "scripts", "paddle-catalog.json");
  writeFileSync(jsonPath, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`OK    wrote ${jsonPath}`);

  console.log("\nNext: Paddle dashboard > Catalog > Payment links > New payment link.");
  for (const plan of PLANS) {
    console.log(`  - Link for price "${catalog.plans[plan.key].price_description}" (${plan.name}, $${Number(plan.amount) / 100}/month)`);
  }
  console.log("Copy the two https://buy.paddle.com/... URLs to your agent to finish wiring src/lib/plans.ts.");
}

main().catch((error) => {
  console.error(`FAIL  ${error.message}`);
  console.error("      Re-running is safe: products and prices that already exist are reused.");
  process.exit(1);
});
