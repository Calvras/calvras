'use strict';

// The installer download, with no Electron in sight, so the same code that runs in the desktop
// process can be tested against a local fixture.

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

function isNewerVersion(remote, local) {
  if (!/^\d+\.\d+\.\d+$/.test(remote) || !/^\d+\.\d+\.\d+$/.test(local)) return false;
  const a = remote.split('.').map(Number);
  const b = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function latestRelease({ fetchImpl = fetch } = {}) {
  let release;
  try {
    const response = await fetchImpl('https://api.github.com/repos/Calvras/calvras/releases/latest', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    const body = await response.json();
    const version = String(body.tag_name || '').replace(/^v/, '');
    const asset = (body.assets || []).find(item => item.name === `Calvras.Setup.${version}.exe`);
    if (body.draft || body.prerelease || !asset) throw new Error('The release has no published installer.');
    release = { version, url: asset.browser_download_url, sha256: asset.digest?.replace(/^sha256:/, '') };
  } catch {
    const response = await fetchImpl('https://calvras.com/update.json', { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!response.ok) throw new Error(`The update feed answered ${response.status}.`);
    const body = await response.json();
    if (!body.ok) throw new Error('The update feed has no published installer.');
    release = { version: body.version, url: body.installer };
  }
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || release.url !== `https://github.com/Calvras/calvras/releases/download/v${release.version}/Calvras.Setup.${release.version}.exe`) {
    throw new Error('The update feed did not name an official Calvras installer.');
  }
  if (release.sha256 && !/^[a-f0-9]{64}$/i.test(release.sha256)) throw new Error('The installer checksum is invalid.');
  return release;
}

async function launchInstaller(file, { openPath, quit }) {
  const error = await openPath(file);
  if (error) throw new Error(`Windows could not open setup: ${error}`);
  quit();
}

/**
 * Streams the installer to disk and only reports success once the bytes look like a Windows
 * program. A redirect to a login page or a deleted release answers 200 with HTML, and an app that
 * launches that instead of updating is worse than one that says it could not.
 */
async function downloadInstaller(url, destination, { fetchImpl = fetch, onProgress = () => {}, minimumBytes = 5 * 1024 * 1024, timeoutMs = 30 * 60 * 1000, sha256 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let received = 0;
  let total = 0;
  const hash = createHash('sha256');
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`The download answered ${response.status}.`);
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (/text\/html|application\/json/.test(type)) throw new Error(`That build is not published yet (the download answered as ${type.split(';')[0] || 'unknown'}), so nothing was installed.`);
    total = Number(response.headers.get('content-length') || 0) || 0;
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const handle = await fs.promises.open(destination, 'w');
    // The write queue trails the read loop instead of being awaited inside it: pausing the loop for
    // a disk write stopped Chromium's streamed body from waking its reader, and every run died at
    // exactly 256 KB with "The download stopped after 262144 bytes". The handle only closes once the
    // queue is empty, and a failed write still fails the download.
    let written = Promise.resolve();
    try {
      for await (const chunk of chunksOf(response.body)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        hash.update(buffer);
        written = written.then(() => handle.writeFile(buffer));
        written.catch(() => {});
        onProgress({ received, total, percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0 });
      }
      await written;
    } finally {
      try { await written; } finally { await handle.close(); }
    }
    if (total && received !== total) throw new Error(`The download was incomplete (${received} of ${total} bytes).`);
    if (sha256 && hash.digest('hex') !== sha256.toLowerCase()) throw new Error('The installer checksum did not match GitHub, so the download was discarded.');
    if (received < minimumBytes) throw new Error(`The download stopped after ${received} bytes, so the update was discarded.`);
    const magic = Buffer.alloc(2);
    const probe = await fs.promises.open(destination, 'r');
    try { await probe.read(magic, 0, 2, 0); } finally { await probe.close(); }
    if (magic.toString('latin1') !== 'MZ') { await fs.promises.rm(destination, { force: true }); throw new Error('What was downloaded is not a Windows installer, so it was deleted instead of run.'); }
    onProgress({ received, total: total || received, percent: 100 });
    return { file: destination, bytes: received };
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// The body arrives either as a web ReadableStream (what Chromium's fetch hands main) or a Node
// stream (what a test fixture hands it), so take the reader when there is one and iterate otherwise.
async function* chunksOf(body) {
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  if (body && Symbol.asyncIterator in Object(body)) {
    yield* body;
    return;
  }
  throw new Error('The download sent no data.');
}

module.exports = { downloadInstaller, launchInstaller, latestRelease, isNewerVersion };
