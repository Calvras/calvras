import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import server from "@/server";
import { servesWorkspace, workspaceHostFrom } from "@/lib/workspace-host";

const root = path.resolve(__dirname, "../..");
const source = (file: string) => readFileSync(path.resolve(root, file), "utf8");

/** The gate is host-based, so a request built from the public URL exercises the real code path. */
const ask = (url: string) => server.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {}, {});

describe("public site surface", () => {
  it("refuses the desktop workspace and store API over the public domain", async () => {
    for (const url of ["https://calvras.com/api/agent/payments", "https://calvras.com/api/agent/payments/catalog", "https://calvras.com/api/fs/create-project", "https://calvras.com/api/terminal/open", "https://calvras.com/api/terminal/write"]) {
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

  it("serves pricing to the public site", async () => {
    const hosted = await server.fetch(new Request("https://calvras.com/pricing"), {}, {});
    expect(hosted.headers.get("location")).toBeNull();
  });

  it("still serves the public update feed", async () => {
    const response = await server.fetch(new Request("https://calvras.com/update.json"), {}, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("sells plans from a checkout link, never from a credential in the page", async () => {
    const { checkoutFor, paidPlans } = await import("@/lib/plans");
    expect(paidPlans.map((plan) => plan.name)).toEqual(["Pro", "Ultra"]);
    // Empty until the plan exists in the store: the page must not send a buyer to a checkout that cannot take money.
    expect(paidPlans.every((plan) => plan.planId === "")).toBe(true);
    expect(checkoutFor("Pro")).toBe("");
    expect(checkoutFor("nothing")).toBe("");
    const pricing = source("src/routes/pricing.tsx");
    expect(pricing).not.toMatch(/\/api\/agent\/payments/);
    expect(pricing).not.toMatch(/merchantId|apiKey|pai_live/);
  });

  it("takes the app's Upgrade pill to the browser pricing page", () => {
    expect(source("src/components/MarketingLayout.tsx")).toContain('to="/pricing"');
    expect(source("src/components/SettingsPanel.tsx")).toContain("https://calvras.com/pricing");
    expect(source("src/components/SettingsPanel.tsx")).not.toMatch(/Merchant id|merchantDraft|checkStore/);
  });

  it("never shows a store error string to whoever is reading the page", () => {
    const pricing = source("src/routes/pricing.tsx");
    expect(pricing).not.toMatch(/catalog\?\.error/);
    expect(pricing).not.toMatch(/\$\{catalog/);
  });

  it("serves the coding workspace only on the machine or LAN running the app", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "10.0.3.7", "192.168.100.4", "172.16.0.1", "172.31.255.9", "calvras.local"]) {
      expect(servesWorkspace(host), host).toBe(true);
    }
    for (const host of ["calvras.com", "www.calvras.com", "172.32.0.1", "8.8.8.8", "evil-local.com", ""]) {
      expect(servesWorkspace(host), host).toBe(false);
    }
  });

  it("takes the host from the server render context and the address bar on the client", () => {
    expect(workspaceHostFrom({ serverContext: { workspaceHost: "127.0.0.1" } })).toBe("127.0.0.1");
    expect(workspaceHostFrom({ serverContext: { workspaceHost: "calvras.com" } })).toBe("calvras.com");
    expect(workspaceHostFrom({})).toBe(window.location.hostname);
    expect(workspaceHostFrom(undefined)).toBe(window.location.hostname);
  });

  it("keeps the workspace off the home page for anyone but the desktop runtime", () => {
    const index = source("src/routes/index.tsx");
    expect(index).toContain('loader: (context) => ({ workspace: servesWorkspace(workspaceHostFrom(context)) })');
    expect(index).toContain("if (!workspace) return <LandingPage />;");
    expect(source("src/start.ts")).toContain("workspaceHost: new URL(request.url).hostname");
  });

  it("removes /app as a page and leaves it as a redirect to the home route", () => {
    const app = source("src/routes/app.tsx");
    expect(app).toContain("beforeLoad");
    expect(app).toContain('redirect({ to: "/"');
    expect(app).not.toContain("component");
  });
});
