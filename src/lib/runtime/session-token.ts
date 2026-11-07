import type { D1Database } from "./ledger";
import { readMeta, writeMetaIfAbsent } from "./ledger";

/**
 * A person signs in with Google once, and the site verifies that token then. Everything after that —
 * the boot check, each usage report — has to be proved without asking Google again, so the sign-in
 * hands back this token, signed with a key the Worker keeps in its own database and never sends
 * anywhere. It is what makes a block in the console something the app has to obey.
 */

export type SessionClaims = { email: string; issuedAt: number };

const MAX_AGE_DAYS = 180;

const encoder = new TextEncoder();
const b64 = (data: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...(data instanceof Uint8Array ? data : new Uint8Array(data)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (value: string) => atob(value.replace(/-/g, "+").replace(/_/g, "/"));

async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

/** Equal length, equal work, whatever differs — a token cannot be read out one byte at a time. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function issueSession(secret: string, email: string, at: number): Promise<string> {
  const payload = b64(encoder.encode(JSON.stringify({ email: email.toLowerCase(), issuedAt: at })));
  return `${payload}.${await signature(secret, payload)}`;
}

/** Returns the address the token was minted for, or nothing at all for a token that was tampered
 * with, signed by another key, or issued before the person last used the app. */
export async function readSession(secret: string, token: string, at: number): Promise<SessionClaims | null> {
  const [payload, given] = String(token || "").split(".");
  if (!payload || !given) return null;
  if (!same(given, await signature(secret, payload))) return null;
  let claims: SessionClaims;
  try { claims = JSON.parse(unb64(payload)) as SessionClaims; } catch { return null; }
  const email = String(claims.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const issued = Number(claims.issuedAt) || 0;
  if (!issued || issued > at + 60_000 || at - issued > MAX_AGE_DAYS * 86_400_000) return null;
  return { email, issuedAt: issued };
}

/** The key lives in the ledger, generated the first time someone signs in. Setting it as a secret
 * would mean the owner has to do something before the console can block anybody. */
export async function signingKey(db: D1Database): Promise<string> {
  const stored = await readMeta(db, "session_key");
  if (stored) return stored;
  const fresh = b64(crypto.getRandomValues(new Uint8Array(32)));
  await writeMetaIfAbsent(db, "session_key", fresh);
  // Two Workers can mint a key in the same second; whichever row the database kept is the one both
  // of them have to sign with afterwards.
  return (await readMeta(db, "session_key")) || fresh;
}
