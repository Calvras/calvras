// @vitest-environment node
// The full loop over a real socket: a desktop sign-in carries a locally signed Google token, the
// Worker verifies it, the ledger records the person, and the owner console reads and changes that
// same row. Nothing here is stubbed at the handler — the requests are HTTP and the database is
// SQLite, so a broken route or a mistyped column fails this test the way it would fail the site.
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA } from "../lib/runtime/ledger";
import { type SiteEnv } from "../lib/site-api";
import { clearGoogleKeyCache } from "../lib/runtime/google-identity";
import { d1Shim } from "./sqlite-d1";
import { startSiteServer, type SiteServer } from "./site-server";

const CLIENT_ID = "calvras-desktop.apps.googleusercontent.com";
const ADMIN_TOKEN = "console-owner-token";
const EMAIL = "dev@calvras.com";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

type GoogleJwk = { kty: string; n: string; e: string; alg: string; kid: string };
let privateKey: CryptoKey;
let jwk: GoogleJwk;
let site: SiteServer;
let base = "";
const sqlite = new DatabaseSync(":memory:");

async function signedToken(claims: Record<string, unknown>) {
  const header = encode({ alg: "RS256", kid: jwk.kid, typ: "ID_TOKEN" });
  const body = encode(claims);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${body}`))));
  return `${header}.${body}.${signature}`;
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)) as unknown as Omit<GoogleJwk, "kid">, kid: "verify-key-1" };

  sqlite.exec(LEDGER_SCHEMA);
  const env: SiteEnv = { CALVRAS_DB: d1Shim(sqlite), CALVRAS_ADMIN_TOKEN: ADMIN_TOKEN, GOOGLE_CLIENT_ID: CLIENT_ID };

  // Google's certificates come from the real URL, because that is where the verifier looks; every
  // other request goes over the loopback socket below.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("googleapis.com/oauth2/v3/certs")) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    return originalFetch(input as never, init as never);
  }) as typeof fetch;

  site = await startSiteServer(env);
  base = site.base;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  clearGoogleKeyCache();
  await site?.close();
  sqlite.close();
});

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
const getJson = async (path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
};
const postJson = async (path: string, payload: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
};

describe("the sign-in loop over HTTP", () => {
  it("records a verified Google sign-in and hands the plan back to the app", async () => {
    const now = Math.floor(Date.now() / 1000);
    const answer = await postJson("/api/site/session", {
      idToken: await signedToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "112233", exp: now + 3600, iat: now, email: "Dev@Calvras.com", email_verified: true, name: "Shikari", picture: "https://lh3.googleusercontent.com/a/fixture" }),
      platform: "Win32",
      version: "10.0.3",
    }, { "cf-ipcity": "Lahore", "cf-ipcountry": "pk" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, email: EMAIL, plan: "free", signins: 1 });
    const rows = sqlite.prepare("SELECT email, name, platform, version, city, country FROM accounts").all() as Record<string, unknown>[];
    expect(rows).toEqual([expect.objectContaining({ email: EMAIL, name: "Shikari", platform: "Win32", version: "10.0.3", city: "Lahore", country: "PK" })]);
  });

  it("refuses a token signed by somebody else", async () => {
    const rogue = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const header = encode({ alg: "RS256", kid: "verify-key-1", typ: "ID_TOKEN" });
    const body = encode({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "999", exp: Math.floor(Date.now() / 1000) + 3600, email: "ceo@google.com", email_verified: true });
    const signature = b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rogue.privateKey, new TextEncoder().encode(`${header}.${body}`))));
    const answer = await postJson("/api/site/session", { idToken: `${header}.${body}.${signature}` });
    expect(answer.status).toBe(401);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email = 'ceo@google.com'").get()).toEqual(expect.objectContaining({ n: 0 }));
  });

  it("counts a second sign-in without resetting the plan", async () => {
    sqlite.prepare("UPDATE accounts SET plan = 'ultra', plan_set_by = 'owner' WHERE email = ?").run(EMAIL);
    const now = Math.floor(Date.now() / 1000);
    const answer = await postJson("/api/site/session", {
      idToken: await signedToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "112233", exp: now + 3600, iat: now, email: EMAIL, email_verified: true, name: "Shikari" }),
    });
    expect(answer.body).toMatchObject({ plan: "ultra", signins: 2 });
    // The second request came in with no geolocation headers at all, so the console still shows the
    // place the account was last seen rather than a blank.
    expect(sqlite.prepare("SELECT city, country FROM accounts WHERE email = ?").get(EMAIL)).toEqual(expect.objectContaining({ city: "Lahore", country: "PK" }));
  });

  it("lets the console see, change and forget that account", async () => {
    const before = await getJson("/api/site/admin/summary", admin);
    expect(before.status).toBe(200);
    expect(before.body.summary).toMatchObject({ accounts: 1, paid: 1 });
    expect(before.body.accounts[0]).toMatchObject({ email: EMAIL, plan: "ultra", city: "Lahore", country: "PK" });

    const granted = await postJson("/api/site/admin/grant", { email: EMAIL, plan: "pro" }, admin);
    expect(granted.body).toMatchObject({ ok: true, account: { plan: "pro", plan_set_by: "owner" } });

    const history = await getJson(`/api/site/admin/history?email=${encodeURIComponent(EMAIL)}`, admin);
    expect(history.body.events.map((event: { kind: string }) => event.kind)).toContain("plan");

    const removed = await postJson("/api/site/admin/remove", { email: EMAIL }, admin);
    expect(removed.body.ok).toBe(true);
    expect((await getJson("/api/site/admin/summary", admin)).body.accounts).toEqual([]);
  });

  it("shuts the console to a caller without the owner token", async () => {
    expect((await getJson("/api/site/admin/summary")).status).toBe(401);
    expect((await getJson("/api/site/admin/summary", { authorization: "Bearer not-it" })).status).toBe(401);
  });

  it("answers a browser preflight so the desktop app can post from its own origin", async () => {
    const response = await fetch(`${base}/api/site/session`, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
