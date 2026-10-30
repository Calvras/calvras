'use strict';

// GitHub sign-in for a desktop install: authorization code + PKCE out through the system
// browser and back in through a loopback listener, the same shape as Google's.
//
// GitHub OAuth Apps are confidential clients — the token endpoint wants the app's client
// secret alongside the code. PKCE still proves the browser and this process are the same app,
// and GitHub checks it when present. The secret lives in the local config file, never in the
// bundle, exactly like the Google one.

const crypto = require('crypto');
const http = require('http');

const AUTH_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';
const SCOPE = 'read:user user:email';
const WAIT_MS = 5 * 60 * 1000;
// GitHub compares the callback against the redirect URLs saved on the OAuth App literally, port
// included — unlike the RFC 8252 advice, it does not wave a native app through on any free port.
// So the listener has to hold one fixed address, and it has to be the one registered on the app.
const CALLBACK_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
// GitHub rejects a request with no agent, and an honest name is what its API asks for.
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'Calvras', 'x-github-api-version': '2022-11-28' };

const base64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const LANDING = (message) => `<!doctype html><meta charset=utf-8><title>Calvras</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#121212;color:#fff;font:15px/1.6 system-ui">
<p style="margin:0 24px;text-align:center">${message}</p></body>`;

/** Same contract as Google's: the state is compared before anything else, because a stray
 *  request to a free loopback port must not be able to sign anyone in. `onReturn` fires the
 *  moment a matching callback arrives, so the window comes back even when the answer fails. */
function waitForCallback(server, expectedState, timeoutMs, onReturn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('GitHub did not answer in time. Try again.')), timeoutMs);
    server.on('request', (request, response) => {
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      // A kept-alive connection would hold this one fixed port open after the answer, and the
      // next attempt would find it busy.
      response.setHeader('connection', 'close');
      if (query.get('state') !== expectedState) {
        response.end(LANDING('This page is stale, so nothing was sent to Calvras.'));
        return;
      }
      onReturn?.();
      if (query.get('error')) {
        response.end(LANDING('You can close this tab.'));
        finish(new Error(query.get('error') === 'access_denied' ? 'GitHub sign-in was cancelled.' : `GitHub said: ${query.get('error_description') || query.get('error')}`));
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

/** A failed attempt can leave the port in TIME_WAIT, so a busy port is waited on for a few
 *  seconds before it is reported — usually the next try a moment later just works. */
async function listen() {
  const server = http.createServer();
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => { server.removeListener('listening', opened); reject(error); };
        const opened = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', opened);
        server.listen(CALLBACK_PORT, '127.0.0.1');
      });
      return { server, port: CALLBACK_PORT };
    } catch (error) {
      if (error.code === 'EADDRINUSE' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (error.code === 'EADDRINUSE') throw new Error(`Port ${CALLBACK_PORT} is busy, so GitHub cannot hand the sign-in back to Calvras. Close whatever is using that port and try again.`);
      throw error;
    }
  }
}

/** GitHub only vouches for an address the person has actually confirmed, so a private email is
 *  fine as long as it is verified — the ledger keys people by address, and an unverified one
 *  would let anybody claim somebody else's place in it. */
async function verifiedEmail(accessToken, fetchImpl) {
  const response = await fetchImpl(EMAILS_URL, { headers: { ...HEADERS, authorization: `Bearer ${accessToken}` } });
  const emails = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(emails)) throw new Error('GitHub did not list the email addresses on this account.');
  const usable = emails.filter((entry) => entry && entry.verified === true && typeof entry.email === 'string' && entry.email.trim());
  const chosen = usable.find((entry) => entry.primary === true) || usable[0];
  if (!chosen) throw new Error('This GitHub account has no verified email address, so Calvras cannot identify its owner.');
  return chosen.email.trim().toLowerCase();
}

async function signInWithGitHub({ clientId, clientSecret, openBrowser, onReturn, fetchImpl = fetch, timeoutMs = WAIT_MS }) {
  if (!clientId) throw new Error('GitHub sign-in is not configured on this computer yet.');
  if (!clientSecret) throw new Error('GitHub sign-in is missing its app secret on this computer.');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const { server } = await listen();
  const redirectUri = REDIRECT_URI;
  try {
    const authorize = new URL(AUTH_URL);
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', SCOPE);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    // Listening before opening: a browser that answers instantly must not arrive on a socket
    // that has no handler yet.
    const pending = waitForCallback(server, state, timeoutMs, onReturn);
    pending.catch(() => {});
    await openBrowser(authorize.toString());
    const code = await pending;

    const tokenResponse = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const token = await tokenResponse.json().catch(() => ({}));
    // GitHub answers 200 with an error field for a bad code, so the body has to be read too.
    if (!tokenResponse.ok || !token.access_token) {
      throw new Error(token.error_description || token.error || 'GitHub refused to exchange the sign-in code.');
    }

    const profileResponse = await fetchImpl(USER_URL, { headers: { ...HEADERS, authorization: `Bearer ${token.access_token}` } });
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || !profile.id) throw new Error('GitHub did not return an account.');
    const email = await verifiedEmail(token.access_token, fetchImpl);

    // The access token goes back to the shell, which reports it to calvras.com where the site
    // checks it against GitHub's own API. It is never written to the local user record.
    return {
      email,
      name: profile.name || profile.login || String(email).split('@')[0],
      picture: profile.avatar_url || null,
      accessToken: token.access_token,
    };
  } finally {
    // One fixed port means the socket has to be released the moment this attempt ends — a
    // half-open connection left behind would block the next click for as long as it lingers.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

module.exports = { signInWithGitHub, base64url };
