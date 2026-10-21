import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reportSignIn } from "@/lib/site-session";

const okResponse = (status: number, body: unknown) => ({ status, json: async () => body, ok: status >= 200 && status < 300 }) as Response;

describe("a sign-in report to calvras.com", () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.removeItem("calvras_site_base"); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("records the account and keeps the session the site signed", async () => {
    const fetch = vi.fn(async () => okResponse(200, { ok: true, email: "ada@example.com", plan: "pro", session: "sig.123" }));
    vi.stubGlobal("fetch", fetch);
    const report = await reportSignIn({ idToken: "a.b.c", platform: "Win32", version: "10.0.8" });
    expect(report).toMatchObject({ ok: true, plan: "pro", session: "sig.123" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("takes another run when the request dies on the way", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse(200, { ok: true, email: "ada@example.com", plan: "pro", session: "sig.123" }));
    vi.stubGlobal("fetch", fetch);
    const report = await reportSignIn({ idToken: "a.b.c" });
    expect(report.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after three tries and says what went wrong", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", fetch);
    const report = await reportSignIn({ idToken: "a.b.c" });
    expect(report).toEqual({ ok: false, error: "Failed to fetch" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not argue with a token the site already turned down", async () => {
    const fetch = vi.fn(async () => okResponse(401, { ok: false, error: "This token was issued for a different app." }));
    vi.stubGlobal("fetch", fetch);
    const report = await reportSignIn({ idToken: "a.b.c" });
    expect(report).toEqual({ ok: false, error: "This token was issued for a different app." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
