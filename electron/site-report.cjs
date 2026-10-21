'use strict';

// A sign-in is only useful to the owner if calvras.com actually hears about it.
//
// The page used to make that call itself, right where the user signed in — and the workspace
// reloads the moment a sign-in succeeds, so Chromium dropped the request mid-flight. Real accounts
// spent a day signed in with nothing in the owner's ledger. This runs from the shell instead: the
// main process holds the ID token, never navigates, and can keep trying after the window is gone.
//
// Everything it needs — the filesystem, the encrypted store, fetch, the waits — is passed in, so
// the retry and the replay are testable without a Google account or an Electron window.

const SITE_ORIGIN = 'https://calvras.com';
const SESSION_PATH = '/api/site/session';
const ATTEMPTS = 4;
const ID_TOKEN_FRESH_MS = 50 * 60 * 1000;

/**
 * `file` is where a sign-in the site never confirmed is kept between launches. It holds a live
 * Google token, so it is written only through the encrypted store the API keys use, and it is
 * deleted as soon as the site answers about that token for real — accepted or rejected.
 */
function createSignInReport({
  fs,
  file,
  storage,
  fetchImpl = fetch,
  siteOrigin = SITE_ORIGIN,
  getInfo = () => ({ platform: process.platform, version: '' }),
  timeoutMs = 15_000,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  const store = (token) => {
    try {
      if (!storage.isEncryptionAvailable()) return;
      fs.writeFileSync(file, storage.encryptString(JSON.stringify({ idToken: token, at: now() })));
    } catch { /* nothing kept for the next launch */ }
  };

  const kept = () => {
    try {
      if (!storage.isEncryptionAvailable()) return null;
      const stored = JSON.parse(storage.decryptString(fs.readFileSync(file)));
      const idToken = typeof stored.idToken === 'string' ? stored.idToken : '';
      if (!idToken || now() - (Number(stored.at) || 0) > ID_TOKEN_FRESH_MS) { drop(); return null; }
      return idToken;
    } catch { return null; }
  };

  function drop() {
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  }

  async function report(idToken) {
    if (!idToken) return { ok: false, error: 'Google did not hand back an identity token.' };
    const { platform, version } = getInfo();
    const payload = JSON.stringify({ idToken, platform, version });
    let last = { ok: false, error: 'calvras.com did not answer.' };
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (attempt) await wait(attempt === 1 ? 700 : 2000);
      try {
        const response = await fetchImpl(`${siteOrigin}${SESSION_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.json().catch(() => ({}));
        const ok = response.status === 200 && body.ok === true;
        last = {
          ok,
          ...(typeof body.plan === 'string' && body.plan ? { plan: body.plan } : {}),
          ...(typeof body.email === 'string' && body.email ? { email: body.email } : {}),
          ...(typeof body.session === 'string' && body.session ? { session: body.session } : {}),
          ...(body.blocked === true ? { blocked: true } : {}),
          ...(!ok ? { error: String(body.error || `The site answered ${response.status}.`) } : {}),
        };
        // A 4xx other than a timeout or rate limit is the site answering about this token itself.
        // Either answer is final, so there is nothing left on disk to replay.
        if (ok || (response.status < 500 && response.status !== 408 && response.status !== 429)) {
          drop();
          return last;
        }
      } catch (error) {
        last = { ok: false, error: error instanceof Error ? error.message : 'calvras.com could not be reached.' };
      }
    }
    store(idToken);
    return last;
  }

  /** One replay per launch: a sign-in the site never confirmed, while Google still trusts the token. */
  async function replay() {
    const token = kept();
    if (!token) return null;
    return report(token);
  }

  return { report, replay };
}

module.exports = { createSignInReport };
