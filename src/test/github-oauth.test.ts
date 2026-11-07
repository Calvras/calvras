// @vitest-environment node
// The same shape as the Google flow: the browser is replaced by a request to the loopback address
// it would have hit, and GitHub's own endpoints by a fetch that checks what the app sent. What is
// different is the identity step — GitHub hands out an access token, so the account is read from
// GitHub's API and only an address GitHub marks verified is allowed to name the person.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const { signInWithGitHub } = createRequire(import.meta.url)("../../electron/github-oauth.cjs") as {
  signInWithGitHub: (options: { clientId?: string; clientSecret?: string; openBrowser: (url: string) => Promise<void> | void; onReturn?: () => void; fetchImpl?: typeof fetch; timeoutMs?: number }) => Promise<{ email: string; name: string; picture: string | null; accessToken: string }>;
};

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Email = { email: string; primary: boolean; verified: boolean };

function github(emails: Email[] = [{ email: "Ada@GitHub.dev", primary: true, verified: true }], profile: Record<string, unknown> = { id: 4242, login: "ada", name: "Ada Lovelace", avatar_url: "https://avatars.githubusercontent.com/u/4242" }) {
  const calls: { authorize: URLSearchParams | null; token: URLSearchParams | null; bearer: string | null; agent: string | null } = { authorize: null, token: null, bearer: null, agent: null };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("https://github.com/login/oauth/access_token")) {
      calls.token = new URLSearchParams(String(init?.body ?? ""));
      return Response.json({ access_token: "gho-fixture", token_type: "bearer", scope: "read:user,user:email" });
    }
    const headers = new Headers(init?.headers);
    calls.bearer = headers.get("authorization");
    calls.agent = headers.get("user-agent");
    if (target.endsWith("/user/emails")) return Response.json(emails);
    return Response.json(profile);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const browser = async (params: URLSearchParams, query = "code=code-fixture") => {
  await fetch(`${params.get("redirect_uri")}?${query}&state=${params.get("state")}`);
};

describe("signing in to the desktop app with GitHub", () => {
  it("sends an unguessable PKCE challenge and asks only for identity scopes", async () => {
    const { calls, fetchImpl } = github();
    let authorize: URLSearchParams | null = null;
    await signInWithGitHub({
      clientId: "Iv1.fixture",
      clientSecret: "secret-fixture",
      fetchImpl,
      openBrowser: async (url) => {
        authorize = new URL(url).searchParams;
        await browser(authorize);
      },
    });
    const sent = authorize as unknown as URLSearchParams;
    // GitHub matches this string against the OAuth App's saved redirect URL, so it cannot move.
    expect(sent.get("redirect_uri")).toBe("http://127.0.0.1:53682/callback");
    expect(sent.get("scope")).toBe("read:user user:email");
    expect(sent.get("code_challenge_method")).toBe("S256");
    expect(String(sent.get("state")).length).toBeGreaterThan(16);
    // The secret never rides the browser-facing URL, where it would end up in history.
    expect(sent.has("client_secret")).toBe(false);
    const verifier = calls.token!.get("code_verifier")!;
    expect(base64url(createHash("sha256").update(verifier).digest())).toBe(sent.get("code_challenge"));
  });

  it("exchanges the code on the same address it left on, secret included", async () => {
    const { calls, fetchImpl } = github();
    await signInWithGitHub({
      clientId: "Iv1.fixture",
      clientSecret: "secret-fixture",
      fetchImpl,
      openBrowser: async (url) => browser(new URL(url).searchParams),
    });
    expect(calls.token!.get("client_id")).toBe("Iv1.fixture");
    expect(calls.token!.get("client_secret")).toBe("secret-fixture");
    expect(calls.token!.get("code")).toBe("code-fixture");
    expect(calls.bearer).toBe("Bearer gho-fixture");
    // GitHub's API rejects a request with no agent of its own.
    expect(calls.agent).toBe("Calvras");
  });

  it("names the person by GitHub's own verified primary address, lowercased", async () => {
    const { fetchImpl } = github([
      { email: "old@github.dev", primary: false, verified: true },
      { email: "Ada@GitHub.dev", primary: true, verified: true },
    ]);
    const profile = await signInWithGitHub({
      clientId: "Iv1.fixture",
      clientSecret: "secret-fixture",
      fetchImpl,
      openBrowser: async (url) => browser(new URL(url).searchParams),
    });
    expect(profile).toEqual({ email: "ada@github.dev", name: "Ada Lovelace", picture: "https://avatars.githubusercontent.com/u/4242", accessToken: "gho-fixture" });
  });

  it("falls back to the login when the account has no display name", async () => {
    const { fetchImpl } = github([{ email: "ada@github.dev", primary: true, verified: true }], { id: 7, login: "ada", name: null, avatar_url: null });
    const profile = await signInWithGitHub({
      clientId: "Iv1.fixture",
      clientSecret: "secret-fixture",
      fetchImpl,
      openBrowser: async (url) => browser(new URL(url).searchParams),
    });
    expect(profile.name).toBe("ada");
    expect(profile.picture).toBeNull();
  });

  it("refuses an account whose addresses are all unverified", async () => {
    const { fetchImpl } = github([{ email: "unverified@github.dev", primary: true, verified: false }]);
    await expect(signInWithGitHub({
      clientId: "Iv1.fixture",
      clientSecret: "secret-fixture",
      fetchImpl,
      openBrowser: async (url) => browser(new URL(url).searchParams),
    })).rejects.toThrow(/no verified email address/);
  });

  it("brings the window back as soon as GitHub answers, and passes on a cancellation", async () => {
    const { fetchImpl } = github();
    const returned: string[] = [];
    const run = (query: string) => signInWithGitHub({
      clientId: "Iv1.fixture",
      clientSecret: "secret-fixture",
      fetchImpl,
      onReturn: () => returned.push(query),
      openBrowser: async (url) => browser(new URL(url).searchParams, query),
    });
    await run("code=code-fixture");
    await expect(run("error=access_denied")).rejects.toThrow("GitHub sign-in was cancelled.");
    expect(returned).toEqual(["code=code-fixture", "error=access_denied"]);
  });

  it("ignores a callback that is not answering its own request", async () => {
    const { fetchImpl } = github();
    const profile = await signInWithGitHub({
      clientId: "Iv1.fixture",
      clientSecret: "secret-fixture",
      fetchImpl,
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        const redirect = params.get("redirect_uri")!;
        const stranger = await fetch(`${redirect}?code=not-yours&state=whatever`);
        expect(await stranger.text()).toContain("stale");
        await browser(params);
      },
    });
    expect(profile.email).toBe("ada@github.dev");
  });

  it("gives up rather than holding the window open forever", async () => {
    const { fetchImpl } = github();
    await expect(signInWithGitHub({ clientId: "Iv1.fixture", clientSecret: "secret-fixture", fetchImpl, openBrowser: () => {}, timeoutMs: 40 })).rejects.toThrow(/did not answer in time/);
  });

  it("says what is missing instead of opening a browser on nothing", async () => {
    await expect(signInWithGitHub({ openBrowser: () => {} })).rejects.toThrow("GitHub sign-in is not configured on this computer yet.");
    await expect(signInWithGitHub({ clientId: "Iv1.fixture", openBrowser: () => {} })).rejects.toThrow("GitHub sign-in is missing its app secret on this computer.");
  });
});
