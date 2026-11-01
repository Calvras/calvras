// Resolution of the OAuth app values each sign-in needs.
//
// An installer used to read only %LOCALAPPDATA%\Calvras\{provider}-oauth.json, a folder that
// exists on the machine where the apps were registered — every other laptop got
// "not configured on this computer yet". The build now stages those values into
// oauth-defaults.json next to this file (scripts/prepare-electron-runtime.mjs) so the shipped
// install carries its own copy, and the per-user file is checked first so the same build can be
// repointed at another OAuth app without a rebuild.
const fs = require('node:fs');
const path = require('node:path');

const createOAuthConfigReader = ({
  fileSystem = fs,
  env = process.env,
  homeDir = require('node:os').homedir(),
  baseDir = __dirname,
} = {}) => {
  const localConfigDir = () => path.join(env.LOCALAPPDATA || path.join(homeDir, '.local', 'share'), 'Calvras');

  let bundledDefaults = null;
  const bundled = (provider) => {
    if (bundledDefaults === null) {
      try { bundledDefaults = JSON.parse(fileSystem.readFileSync(path.join(baseDir, 'oauth-defaults.json'), 'utf8')); }
      catch { bundledDefaults = {}; }
    }
    return bundledDefaults[provider] || {};
  };

  /** The per-user file wins field by field: an install can carry a client id while the user
   * pastes their own secret, and neither half of that pair may fall back silently. */
  const oauthConfig = (provider) => {
    const shipped = bundled(provider);
    let stored = {};
    try { stored = JSON.parse(fileSystem.readFileSync(path.join(localConfigDir(), `${provider}-oauth.json`), 'utf8')); }
    catch { /* nothing saved on this machine — the bundled copy is the config */ }
    return {
      clientId: stored.clientId || shipped.clientId || null,
      clientSecret: stored.clientSecret || shipped.clientSecret || null,
    };
  };

  return { oauthConfig, googleOAuthConfig: () => oauthConfig('google'), githubOAuthConfig: () => oauthConfig('github') };
};

module.exports = { createOAuthConfigReader };
