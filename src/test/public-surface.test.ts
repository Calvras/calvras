import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import server from "@/server";

const root = path.resolve(__dirname, "../..");
const source = (file: string) => readFileSync(path.resolve(root, file), "utf8");

/** The gate is host-based, so a request built from the public URL exercises the real code path. */
const ask = (url: string) => server.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {}, {});

describe("public site surface", () => {
  it("refuses the desktop workspace and store API over the public domain", async () => {
    for (const url of ["https://calvras.com/api/agent/payments", "https://calvras.com/api/agent/payments/catalog", "https://calvras.com/api/fs/create-project", "https://calvras.com/api/terminal/exec"]) {
      const response = await ask(url);
      expect(response.status, url).toBe(404);
      expect(await response.json(), url).toEqual({ ok: false, error: "Not found" });
    }
  });

  it("keeps the same API answering on the desktop loopback", async () => {
    const response = await server.fetch(new Request("http://127.0.0.1:3344/api/agent/payments"), {}, {});
    expect(response.status).toBe(200);
    const body = await response.json() as { ok?: unknown; hasKey?: unknown };
    expect(body.ok).toBe(true);
    expect(typeof body.hasKey).toBe("boolean");
  });

  it("sends pricing visitors to the landing page instead of a page that cannot price", async () => {
    const hosted = await server.fetch(new Request("https://calvras.com/pricing"), {}, {});
    expect(hosted.status).toBe(302);
    expect(hosted.headers.get("location")).toBe("https://calvras.com/");
    const local = await server.fetch(new Request("http://127.0.0.1:3344/pricing"), {}, {});
    // The loopback request must fall through to the router rather than be redirected away. SSR itself
    // cannot boot inside the test runner, so the redirect is what is asserted, not the page.
    expect(local.status).not.toBe(302);
    expect(local.headers.get("location")).toBeNull();
  });

  it("still serves the public update feed", async () => {
    const response = await server.fetch(new Request("https://calvras.com/update.json"), {}, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("advertises plans from the app only", () => {
    expect(source("src/components/MarketingLayout.tsx")).not.toContain("to=\"/pricing\"");
    expect(source("src/components/CompanyPage.tsx")).not.toContain("/pricing");
    expect(source("src/components/SettingsPanel.tsx")).toContain('new URL("/pricing", window.location.href)');
    expect(source("src/components/SettingsPanel.tsx")).not.toContain("calvras.com/pricing");
  });

  it("never shows a store error string to whoever is reading the page", () => {
    const pricing = source("src/routes/pricing.tsx");
    expect(pricing).not.toMatch(/catalog\?\.error/);
    expect(pricing).not.toMatch(/\$\{catalog/);
  });
});
