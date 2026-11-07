// @vitest-environment node
// Verifying a Google ID token is the only thing standing between the ledger and anyone who types an
// email address. So the tests sign real RSA tokens locally and serve real JWKs, which exercises the
// same WebCrypto path the Worker runs — a stubbed verifier would prove nothing.
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { clearGoogleKeyCache, verifyGoogleIdentity } from "../lib/runtime/google-identity";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

const CLIENT_ID = "calvras-desktop.apps.googleusercontent.com";

type GoogleJwk = { kty: string; n: string; e: string; alg: string; kid?: string };
type Material = { key: CryptoKey; jwk: GoogleJwk; header: string };
let material: Material;
let foreign: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as unknown as GoogleJwk;
  jwk.kid = "key-1";
  material = { key: pair.privateKey, jwk, header: encode({ alg: "RS256", kid: "key-1", typ: "ID_TOKEN" }) };
  foreign = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair).privateKey;
});

afterEach(() => clearGoogleKeyCache());

async function token(claims: Record<string, unknown>, signer: CryptoKey = material.key, kid = "key-1") {
  const header = encode({ alg: "RS256", kid, typ: "ID_TOKEN" });
  const body = encode(claims);
  const signature = b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(`${header}.${body}`))));
  return `${header}.${body}.${signature}`;
}

const keysFetch = (keys: GoogleJwk[]) => (async () => new Response(JSON.stringify({ keys }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const deadFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;

const fresh = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1122334455", exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
  email: "Dev@Calvras.com", email_verified: true, name: "Dev", picture: "https://lh3.googleusercontent.com/a/dev", ...over,
});

describe("verifying a Google identity token", () => {
  it("accepts a token Google could have signed and lowercases the address", async () => {
    const identity = await verifyGoogleIdentity(await token(fresh()), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) });
    expect(identity).toEqual({ email: "dev@calvras.com", subject: "1122334455", name: "Dev", picture: "https://lh3.googleusercontent.com/a/dev" });
  });

  it("falls back to the address when Google sent no name", async () => {
    const claims = fresh();
    delete (claims as Record<string, unknown>)["name"];
    const identity = await verifyGoogleIdentity(await token(claims), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) });
    expect(identity.name).toBe("dev");
  });

  it("rejects anything that is not three dot-separated parts", async () => {
    await expect(verifyGoogleIdentity("", CLIENT_ID, { fetchImpl: deadFetch })).rejects.toThrow(/not a Google ID token/);
    await expect(verifyGoogleIdentity("a.b", CLIENT_ID, { fetchImpl: deadFetch })).rejects.toThrow(/not a Google ID token/);
    await expect(verifyGoogleIdentity("!!!.???.###", CLIENT_ID, { fetchImpl: deadFetch })).rejects.toThrow(/not a Google ID token/);
  });

  it("rejects a token naming a key Google does not publish", async () => {
    await expect(verifyGoogleIdentity(await token(fresh(), foreign, "key-9"), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).rejects.toThrow(/no longer publishes the key/);
  });

  it("rejects a token claiming a published kid but signed by somebody else", async () => {
    await expect(verifyGoogleIdentity(await token(fresh(), foreign), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).rejects.toThrow(/signature does not check out/);
  });

  it("accepts a second published key and rejects it the moment it is unpublished", async () => {
    const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", other.publicKey)) as unknown as GoogleJwk;
    jwk.kid = "key-2";
    await expect(verifyGoogleIdentity(await token(fresh(), other.privateKey, "key-2"), CLIENT_ID, { fetchImpl: keysFetch([material.jwk, jwk]) })).resolves.toBeTruthy();
    clearGoogleKeyCache();
    await expect(verifyGoogleIdentity(await token(fresh(), other.privateKey, "key-2"), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).rejects.toThrow(/no longer publishes/);
  });

  it("rejects a token whose content was edited after signing", async () => {
    const signed = await token(fresh());
    const [header, , signature] = signed.split(".");
    const tampered = `${header}.${encode(fresh({ email: "admin@calvras.com" }))}.${signature}`;
    await expect(verifyGoogleIdentity(tampered, CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).rejects.toThrow(/signature does not check out/);
  });

  it("rejects another app's token, another issuer, and an unverified address", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ aud: "someone-else.apps.googleusercontent.com" }, /different app/],
      [{ iss: "https://evil.example" }, /not issued by Google/],
      [{ email_verified: false }, /not marked verified/],
      [{ email_verified: undefined }, /not marked verified/],
      [{ sub: "" }, /no account id/],
      [{ email: "" }, /no email address/],
    ];
    for (const [over, expected] of cases) {
      await expect(verifyGoogleIdentity(await token(fresh(over)), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).rejects.toThrow(expected);
    }
  });

  it("rejects an expired token and one timestamped in the future, but allows clock skew", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verifyGoogleIdentity(await token(fresh({ exp: now - 3600 })), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).rejects.toThrow(/expired/);
    await expect(verifyGoogleIdentity(await token(fresh({ iat: now + 3600 })), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) }, )).rejects.toThrow(/in the future/);
    // One minute late is a clock, not an attack — the allowed skew is five minutes.
    await expect(verifyGoogleIdentity(await token(fresh({ exp: now - 60 })), CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).resolves.toBeTruthy();
  });

  it("refuses a token that claims a weaker algorithm", async () => {
    const header = encode({ alg: "none", kid: "key-1" });
    const body = encode(fresh());
    await expect(verifyGoogleIdentity(`${header}.${body}.`, CLIENT_ID, { fetchImpl: keysFetch([material.jwk]) })).rejects.toThrow(/RS256/);
  });

  it("reads Google's keys once and reuses them for the next sign-in", async () => {
    let calls = 0;
    const counting = (async () => { calls += 1; return new Response(JSON.stringify({ keys: [material.jwk] }), { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    await verifyGoogleIdentity(await token(fresh()), CLIENT_ID, { fetchImpl: counting });
    await verifyGoogleIdentity(await token(fresh({ sub: "999" })), CLIENT_ID, { fetchImpl: counting });
    expect(calls).toBe(1);
    clearGoogleKeyCache();
    await verifyGoogleIdentity(await token(fresh()), CLIENT_ID, { fetchImpl: counting });
    expect(calls).toBe(2);
  });

  it("says so when Google's keys cannot be read at all", async () => {
    const broken = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(verifyGoogleIdentity(await token(fresh()), CLIENT_ID, { fetchImpl: broken })).rejects.toThrow(/signing keys could not be read \(HTTP 503\)/);
  });
});
