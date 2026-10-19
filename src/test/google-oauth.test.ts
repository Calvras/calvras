// @vitest-environment node
// The whole point of this flow is that it leaves the app, goes through a browser the test
// cannot drive, and comes back on a socket. So the browser is replaced by a request to the
// loopback address it would have hit, and Google's own endpoints by a fetch that checks what
// the app sent it. Nothing here talks to Google, but every byte the real exchange needs is.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const { signInWithGoogle } = createRequire(import.meta.url)("../../electron/google-oauth.cjs") as {
  signInWithGoogle: (options: { clientId?: string; clientSecret?: string; openBrowser: (url: string) => Promise<void> | void; onReturn?: () => void; fetchImpl?: typeof fetch; timeoutMs?: number }) => Promise<{ email: string; name: string; picture: string | null; idToken: string | null }>;
};

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function google(expectations: (search: URLSearchParams, token: URLSearchParams | null) => void) {
  const calls: { authorize: URLSearchParams | null; token: URLSearchParams | null; bearer: string | null } = { authorize: null, token: null, bearer: null };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      calls.token = new URLSearchParams(String(init?.body ?? ""));
      expectations(calls.authorize!, calls.token);
      return Response.json({ access_token: "at-fixture", ...(process.env["OMIT_ID_TOKEN"] === "1" ? {} : { id_token: "idt-fixture" }) });
    }
    calls.bearer = new Headers(init?.headers).get("authorization");
    return Response.json({ email: "hello@calvras.com", name: "Shikari", picture: "https://lh3.googleusercontent.com/a" });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("signing in to the desktop app with Google", () => {
  it("sends an unguessable PKCE challenge out through the browser", async () => {
    const { calls, fetchImpl } = google(() => {});
    let authorize: URLSearchParams | null = null;
    await signInWithGoogle({
      clientId: "fixture.apps.googleusercontent.com",
      fetchImpl,
      openBrowser: async (url) => {
        authorize = new URL(url).searchParams;
        await fetch(`${authorize.get("redirect_uri")}?code=code-fixture&state=${authorize.get("state")}`);
      },
    });
    const sent = authorize as unknown as URLSearchParams;
    expect(new URL(sent.get("redirect_uri")!).hostname).toBe("127.0.0.1");
    expect(sent.get("response_type")).toBe("code");
    expect(sent.get("code_challenge_method")).toBe("S256");
    expect(sent.get("prompt")).toBe("select_account");
    expect(sent.get("scope")).toBe("openid email profile");
    expect(String(sent.get("state")).length).toBeGreaterThan(16);
    // The proof the challenge was derived from the verifier rather than invented beside it.
    const verifier = calls.token!.get("code_verifier")!;
    expect(base64url(createHash("sha256").update(verifier).digest())).toBe(sent.get("code_challenge"));
  });

  it("exchanges the code on the same address it left on and reports the account back", async () => {
    const { calls, fetchImpl } = google(() => {});
    const profile = await signInWithGoogle({
      clientId: "fixture.apps.googleusercontent.com",
      fetchImpl,
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        await fetch(`${params.get("redirect_uri")}?code=code-fixture&state=${params.get("state")}`);
      },
    });
    expect(calls.token!.get("grant_type")).toBe("authorization_code");
    expect(calls.token!.get("code")).toBe("code-fixture");
    expect(calls.token!.get("client_id")).toBe("fixture.apps.googleusercontent.com");
    expect(calls.token!.has("client_secret")).toBe(false);
    expect(calls.bearer).toBe("Bearer at-fixture");
    expect(profile).toEqual({ email: "hello@calvras.com", name: "Shikari", picture: "https://lh3.googleusercontent.com/a", idToken: "idt-fixture" });
  });

  it("sends Google's desktop-client secret only when this install has one", async () => {
    const { calls, fetchImpl } = google(() => {});
    let authorize: URLSearchParams | null = null;
    await signInWithGoogle({
      clientId: "fixture.apps.googleusercontent.com",
      clientSecret: "GOCSPX-fixture",
      fetchImpl,
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        authorize = params;
        await fetch(`${params.get("redirect_uri")}?code=code-fixture&state=${params.get("state")}`);
      },
    });
    expect(calls.token!.get("client_secret")).toBe("GOCSPX-fixture");
    // The secret never rides the browser-facing URL, where it would end up in history.
    expect((authorize as unknown as URLSearchParams).has("client_secret")).toBe(false);
  });

  it("brings the window back as soon as Google answers, not only when it worked", async () => {
    const { fetchImpl } = google(() => {});
    const returned: string[] = [];
    const run = (query: string) => signInWithGoogle({
      clientId: "fixture.apps.googleusercontent.com",
      fetchImpl,
      onReturn: () => returned.push(query),
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        await fetch(`${params.get("redirect_uri")}?${query}&state=${params.get("state")}`);
      },
    });
    await run("code=code-fixture");
    await expect(run("error=access_denied")).rejects.toThrow("cancelled");
    expect(returned).toEqual(["code=code-fixture", "error=access_denied"]);
  });

  it("ignores a callback that is not answering its own request", async () => {
    const { fetchImpl } = google(() => {});
    let state = "";
    const profile = await signInWithGoogle({
      clientId: "fixture.apps.googleusercontent.com",
      fetchImpl,
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        state = params.get("state")!;
        const redirect = params.get("redirect_uri")!;
        // Somebody else on the loopback port, or a tab left over from an earlier attempt.
        const stranger = await fetch(`${redirect}?code=not-yours&state=whatever`);
        expect(await stranger.text()).toContain("stale");
        await fetch(`${redirect}?code=code-fixture&state=${state}`);
      },
    });
    expect(profile.email).toBe("hello@calvras.com");
    expect(state).not.toBe("");
  });

  it("passes on what Google says when the person closes the tab", async () => {
    const { fetchImpl } = google(() => {});
    await expect(signInWithGoogle({
      clientId: "fixture.apps.googleusercontent.com",
      fetchImpl,
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        await fetch(`${params.get("redirect_uri")}?error=access_denied&state=${params.get("state")}`);
      },
    })).rejects.toThrow("Google sign-in was cancelled.");
  });

  it("gives up rather than holding the window open forever", async () => {
    const { fetchImpl } = google(() => {});
    await expect(signInWithGoogle({ clientId: "fixture.apps.googleusercontent.com", fetchImpl, openBrowser: () => {}, timeoutMs: 40 })).rejects.toThrow(/did not answer in time/);
  });

  it("says it is not configured instead of opening a browser on nothing", async () => {
    await expect(signInWithGoogle({ openBrowser: () => {} })).rejects.toThrow("Google sign-in is not configured on this computer yet.");
  });
});
