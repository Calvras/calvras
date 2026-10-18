'use strict';

// Google sign-in for a desktop install: authorization code + PKCE out through the system
// browser and back in through a loopback listener, which is what lets the window come back
// to the foreground on its own once an account has been chosen.
//
// Google treats a desktop client's secret as part of the install rather than as a credential —
// it is issued precisely so it can ship inside an app. PKCE still does the real work of proving
// the browser and this process are the same app; the secret is only what Google's token endpoint
// demands alongside it. So it stays in the local config file, never in the bundle.

const crypto = require('crypto');
const http = require('http');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPE = 'openid email profile';
const WAIT_MS = 5 * 60 * 1000;

const base64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const LANDING = (message) => `<!doctype html><meta charset=utf-8><title>Calvras</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#121212;color:#fff;font:15px/1.6 system-ui">
<p style="margin:0 24px;text-align:center">${message}</p></body>`;

/** Waits for Google to hand the code back on loopback. The state is compared before anything
 *  else because a stray request to a free port must not be able to sign anyone in.
 *  `onReturn` fires the moment a matching callback arrives — before the answer is known —
 *  because that is when the browser has finished with the user and the window should come back. */
function waitForCallback(server, expectedState, timeoutMs, onReturn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Google did not answer in time. Try again.')), timeoutMs);
    server.on('request', (request, response) => {
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      if (query.get('state') !== expectedState) {
        response.end(LANDING('This page is stale, so nothing was sent to Calvras.'));
        return;
      }
      onReturn?.();
      if (query.get('error')) {
        response.end(LANDING('You can close this tab.'));
        finish(new Error(query.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : `Google said: ${query.get('error_description') || query.get('error')}`));
        return;
      }
      const code = query.get('code');
      if (!code) { response.end(LANDING('This page is stale, so nothing was sent to Calvras.')); return; }
      response.end(LANDING("You're signed in to Calvras. You can close this tab."));
      finish(null, code);
    });
    server.on('error', (error) => finish(error));
  });
}

async function listen() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback on the literal address: "localhost" can resolve to ::1 first on Windows, and
    // the redirect URI has to point at the socket this process is actually holding.
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

async function signInWithGoogle({ clientId, clientSecret, openBrowser, onReturn, fetchImpl = fetch, timeoutMs = WAIT_MS }) {
  if (!clientId) throw new Error('Google sign-in is not configured on this computer yet.');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const { server, port } = await listen();
  const redirectUri = `http://127.0.0.1:${port}/`;
  try {
    const authorize = new URL(AUTH_URL);
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', SCOPE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('prompt', 'select_account');
    // Listening first and opening second: a browser that answers instantly, or one restored
    // from a previous attempt, must not arrive on a socket that has no handler yet.
    const pending = waitForCallback(server, state, timeoutMs, onReturn);
    // A rejection nobody has awaited yet counts as unhandled, and Node takes that as an
    // invitation to kill the process — which a cancelled sign-in would otherwise do.
    pending.catch(() => {});
    await openBrowser(authorize.toString());
    const code = await pending;

    const tokenResponse = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const token = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !token.access_token) {
      throw new Error(token.error_description || 'Google refused to exchange the sign-in code.');
    }

    const profileResponse = await fetchImpl(USERINFO_URL, { headers: { authorization: `Bearer ${token.access_token}` } });
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || !profile.email) throw new Error('Google did not return an account.');

    return { email: profile.email, name: profile.name || String(profile.email).split('@')[0], picture: profile.picture || null };
  } finally {
    server.close();
  }
}

module.exports = { signInWithGoogle, base64url };
