/**
 * The ledger is only worth having if a stranger cannot type an email address into it. So a sign-in
 * is accepted on the strength of the ID token Google signed, verified here against Google's own
 * keys — not on whatever the app chooses to report about its user.
 */

export type GoogleIdentity = { email: string; subject: string; name: string; picture: string };

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string };
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((segment.length + 3) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("That is not a Google ID token.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function json<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    // Anything that reaches here has three dot-separated parts but is not base64 JSON, so the
    // useful sentence is the same one as a wrong part count — not a decoder's byte report.
    throw new Error("That is not a Google ID token.");
  }
}

let cached: { at: number; keys: Jwk[] } | null = null;

async function googleKeys(fetchImpl: typeof fetch): Promise<Jwk[]> {
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.keys;
  const response = await fetchImpl(KEYS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Google's signing keys could not be read (HTTP ${response.status}).`);
  const body = (await response.json()) as { keys?: Jwk[] };
  cached = { at: Date.now(), keys: body.keys ?? [] };
  return cached.keys;
}

/**
 * Returns the person a token proves, or throws with the reason. `clientId` is the app's own Google
 * client id, which is what stops a token minted for somebody else's product from being accepted.
 */
export async function verifyGoogleIdentity(idToken: string, clientId: string, options: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<GoogleIdentity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const parts = String(idToken ?? "").trim().split(".");
  if (parts.length !== 3) throw new Error("That is not a Google ID token.");
  const [header, payload, signature] = parts as [string, string, string];
  const head = json<{ alg?: string; kid?: string }>(decodeSegment(header));
  if (head.alg !== "RS256") throw new Error(`Google ID tokens are RS256; this one says ${head.alg || "nothing"}.`);
  if (!head.kid) throw new Error("The token carries no key id, so its signature cannot be checked.");
  const keys = await googleKeys(fetchImpl);
  const key = keys.find((entry) => entry.kid === head.kid);
  if (!key) throw new Error("Google no longer publishes the key that signed this token. Try again in a moment.");
  const cryptoKey = await crypto.subtle.importKey("jwk", { kty: "RSA", n: key.n, e: key.e, alg: "RS256" } as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, decodeSegment(signature), new TextEncoder().encode(`${header}.${payload}`));
  if (!valid) throw new Error("The token signature does not check out against Google's keys.");

  const claims = json<{ iss?: string; aud?: string; exp?: number; iat?: number; sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>(decodeSegment(payload));
  if (!ISSUERS.includes(String(claims.iss))) throw new Error("This token was not issued by Google.");
  if (claims.aud !== clientId) throw new Error(`This token was issued for a different app (${String(claims.aud || "no audience")}).`);
  if (!claims.exp || claims.exp * 1000 + CLOCK_SKEW_MS < now) throw new Error("The sign-in token has expired. Sign in again.");
  if (claims.iat && claims.iat * 1000 - CLOCK_SKEW_MS > now) throw new Error("The sign-in token claims a time in the future.");
  if (!claims.sub) throw new Error("Google gave no account id.");
  if (claims.email_verified !== true) throw new Error("That Google address is not marked verified.");
  const email = String(claims.email ?? "").trim().toLowerCase();
  if (!email) throw new Error("Google returned no email address.");
  return { email, subject: String(claims.sub), name: String(claims.name || email.split("@")[0]), picture: String(claims.picture || "") };
}

/** Test seam: the key cache is module state, so a suite that swaps in fake keys must clear it. */
export function clearGoogleKeyCache(): void {
  cached = null;
}
