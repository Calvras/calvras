'use strict';

// node scripts/verify-browser-tools.cjs [--node-only]
// Runs pure checks, then an independent Electron process with a temporary profile,
// two loopback HTTP servers and sandboxed cross-origin webviews. No providers,
// credentials, external references or running application instances are contacted.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createBrowserTools, validation: v } = require('../electron/browser-tools.cjs');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
async function checkAsync(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }

function pureTests() {
  check('URL scheme, embedded credentials and guest action validation', () => {
    for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'data:text/html,a', 'https://user:pass@example.test', '//example.test', '']) assert.throws(() => v.httpUrl(url));
    assert.equal(v.httpUrl('http://127.0.0.1:3100/preview').hostname, '127.0.0.1');
    assert.throws(() => v.validateAction({ action: 'evaluate', text: '1 + 1' }));
    assert.throws(() => v.validateAction({ action: 'press', selector: 'input', value: 'Control+A' }));
    assert.throws(() => v.validateAction({ action: 'scroll', value: { y: Infinity } }));
    assert.throws(() => v.validateAction({ action: 'scroll', value: { y: '20' } }));
    assert.throws(() => v.validateAction({ action: 'fill', selector: '#x', text: 'x'.repeat(4001) }));
    for (const value of [0, 3, '1.25', Infinity]) assert.throws(() => v.validateAction({ action: 'zoom', value }));
    assert.equal(v.validateAction({ action: 'zoom', value: 1.25 }).value, 1.25);
    const text = '\"); globalThis.injected = true; //';
    assert.equal(v.validateAction({ action: 'fill', selector: '#x', text }).text, text);
  });
  check('Metadata redacts queries, fragments, credentials and token-like paths', () => {
    assert.equal(v.publicUrl('https://example.test/path?token=dummy#secret'), 'https://example.test/path');
    assert.equal(v.publicUrl('https://user:pass@example.test/path'), '');
    assert(!v.publicUrl('https://example.test/token/DO_NOT_RETURN').includes('DO_NOT_RETURN'));
    assert(!v.redactText('password=dummy token=fixture Authorization: Bearer abc.def').includes('dummy'));
    assert.equal(v.redactText('x '.repeat(20000)).length, 12000);
  });
  check('Dribbble prioritizes the target shot rather than larger related images', () => {
    const result = v.rankImages([
      { selector: '.related', width: 3000, loaded: true, related: true, inMain: true, shotMedia: true },
      { selector: '.avatar', width: 600, loaded: true, inMain: true },
      { selector: '.target', width: 240, loaded: true, inMain: true, shotMedia: true, src: 'https://cdn.test/target.png' },
    ], 'https://dribbble.com/shots/123456-Requested-shot');
    assert.equal(result.referenceImage.selector, '.target');
    assert.equal(result.images[0].selector, '.target');
    assert.equal(v.rankImages([{ selector: '.big', loaded: true, inMain: true, width: 3000 }], 'https://dribbble.com/shots/123456-Requested-shot').referenceImage, null);
    assert.equal(v.rankImages([{ selector: '.related', loaded: true, related: true, shotMedia: true }], 'https://dribbble.com/shots/123456-Requested-shot').referenceImage, null);
    assert.equal(v.rankImages([{ selector: '.fake', loaded: true, shotMedia: true }], 'https://dribbble.com/').referenceImage, null);
    assert.equal(v.rankImages([{ selector: '.broken', loaded: false, shotMedia: true }], 'https://dribbble.com/shots/123456-X').referenceImage, null);
  });
  check('Image formats and decompression dimensions are bounded before decoding', () => {
    for (const image of ['', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,bm90LXBuZw==', 'data:image/jpeg;base64,bm90LWpwZWc=']) assert.throws(() => v.imageDimensions(image));
    const header = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(13, 8); header.write('IHDR', 12); header.writeUInt32BE(100000, 16); header.writeUInt32BE(100000, 20);
    assert.throws(() => v.imageDimensions(`data:image/png;base64,${header.toString('base64')}`));
  });
}

async function electronTests() {
  const { app, BrowserWindow, webContents, nativeImage } = require('electron');
  const http = require('node:http');
  const fs = require('node:fs');
  const profile = process.env.BROWSER_TOOLS_TEST_PROFILE;
  assert(profile && fs.statSync(profile).isDirectory(), 'An isolated pre-created profile is required.');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  // No single-instance lock, application main import, certificate bypass or sandbox overrides.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const windows = new Set(), servers = [];
  let tools, main;
  const timeout = setTimeout(() => { console.error('FAIL Electron verification timed out'); app.exit(1); }, 90000);
  function window(options = {}) {
    const win = new BrowserWindow({ width: 1000, height: 850, show: true, webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: true,
      partition: `verify-browser-tools-host-${process.pid}`,
    }, ...options });
    windows.add(win);
    win.on('closed', () => windows.delete(win));
    win.webContents.on('will-attach-webview', (_event, prefs) => {
      delete prefs.preload;
      Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false });
    });
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    return win;
  }
  async function server(handler) {
    const instance = http.createServer(handler);
    servers.push(instance);
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${instance.address().port}`;
  }
  async function waitFor(fn, message, ms = 5000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const result = await fn();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(message);
  }
  const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  function solid(width, height, b = 30, g = 80, r = 200) {
    const bitmap = Buffer.alloc(width * height * 4);
    for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = b; bitmap[i + 1] = g; bitmap[i + 2] = r; bitmap[i + 3] = 255; }
    return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
  }
  const target = solid(240, 100), targetPng = target.toPNG();
  try {
    const fixtureUrl = await server((request, response) => {
      const url = new URL(request.url, 'http://test.invalid');
      if (url.pathname === '/target.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(targetPng); return; }
      if (url.pathname === '/missing.png' || url.pathname === '/fail') { response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('Test failure'); return; }
      if (url.pathname === '/download') { response.writeHead(200, { 'Content-Disposition': 'attachment; filename="blocked.txt"' }); response.end('Must not be downloaded'); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Rendered fixture</title><style>
        body{font:16px sans-serif;margin:16px;background:white} h1{margin:4px 0;line-height:40px} p{margin:6px 0;line-height:20px}
        .shot-media img{width:240px;height:100px;display:block}.related-shots img{width:480px;height:110px;display:block}
        .row{display:flex;gap:8px;margin:6px 0}form{margin:6px 0}input,button,select{min-height:24px} .overflow{width:1400px;height:24px}
        .spacer{height:2200px}
      </style></head><body>
      <main><h1>Requested reference</h1><p>Visible fixture text</p><div class="shot-media"><img id="target" src="/target.png?token=DUMMY_QUERY_TOKEN" alt="Target design"></div>
      <div class="related-shots"><img src="/target.png" alt="Unrelated gallery image"></div>
      <div class="row"><button id="counter">Increment</button><span id="count">0</span><input id="draft" aria-label="Draft" value="FIELD_VALUE_MUST_NOT_ESCAPE"><select id="choice"><option value="one">One</option><option value="two">Two</option></select></div>
      <form id="sign-in"><label>User <input name="username" value="PRIVATE_USERNAME_FIXTURE"></label><input id="pass" type="password" value="PRIVATE_PASSWORD_FIXTURE"><input id="otp" autocomplete="one-time-code" value="PRIVATE_OTP_FIXTURE"><button id="signin" type="submit">Sign in</button></form>
      <div class="row"><input id="upload" type="file"><input id="card" autocomplete="cc-number" value="PRIVATE_PAYMENT_FIXTURE"><input id="hidden" type="hidden" value="PRIVATE_HIDDEN_FIXTURE"><button id="disabled" disabled>Disabled</button></div>
      <label id="file-label" for="upload"><span id="file-label-child">Choose file</span></label><button id="login-button"><span id="login-child">Sign in</span></button><input id="plain-code" name="code" value="PRIVATE_CODE_FIXTURE">
      <a id="unsafe" href="javascript:globalThis.unsafeRan=true">Unsafe link</a><a id="download" href="/download" download>Download</a>
      <img id="broken" src="/missing.png" width="24" height="24" alt="Broken test image"><button id="unnamed"></button>
      <div class="overflow">Horizontal overflow test</div><div style="display:none">HIDDEN_TEXT_MUST_NOT_ESCAPE</div><div class="spacer"></div></main>
      <script>
        document.querySelector('#counter').addEventListener('click',()=>{document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1});
        document.querySelector('#draft').addEventListener('input',()=>{document.body.dataset.filled='yes'});
        document.querySelector('form').addEventListener('submit', event=>{event.preventDefault();globalThis.didSubmit=true});
      </script></body></html>`);
    });
    const hostUrl = await server((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><body style="margin:0"></body></html>');
    });
    async function attach(host, src = `${fixtureUrl}/fixture`, partition = `verify-browser-tools-guest-${process.pid}`) {
      await host.loadURL(hostUrl);
      const id = await host.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        const view=document.createElement('webview');view.style.cssText='display:flex;width:960px;height:780px';
        view.setAttribute('partition',${JSON.stringify(partition)});view.setAttribute('webpreferences','contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes');
        view.src=${JSON.stringify(src)};view.addEventListener('dom-ready',()=>resolve(view.getWebContentsId()),{once:true});
        view.addEventListener('did-fail-load',event=>{if(event.isMainFrame)reject(new Error('fixture load failed'))});document.body.append(view);
      })`);
      const guest = webContents.fromId(id);
      await waitFor(() => guest.executeJavaScript('document.querySelector("#target").complete'), 'fixture image did not load');
      return guest;
    }
    main = window();
    tools = createBrowserTools({ BrowserWindow, webContents, nativeImage, getMainWindow: () => main });
    const guest = await attach(main), guestId = guest.id;
    await checkAsync('Real cross-origin webview inspection is rendered, sanitized and isolated', async () => {
      const prefs = guest.getLastWebPreferences();
      assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true);
      assert.notEqual(new URL(guest.getURL()).port, new URL(main.webContents.getURL()).port);
      const result = success(await tools.inspect({ guestId }));
      assert.equal(result.title, 'Rendered fixture');
      assert(result.visibleText.includes('Visible fixture text'));
      assert(result.headings.some(heading => heading.text === 'Requested reference'));
      assert(result.elements.some(element => element.text === 'Increment' && element.selector));
      assert(result.elements.some(element => element.role === 'input' && element.label === 'Draft' && element.selector));
      assert.equal(result.images[0].alt, 'Target design');
      assert.equal(result.images[0].ancestor.kind, 'shot-media');
      assert(result.referenceImage.selector);
      assert(result.visibleText.length <= 12000);
      for (const sentinel of ['PRIVATE_', 'FIELD_VALUE_', 'HIDDEN_TEXT_', 'DUMMY_QUERY_TOKEN']) assert(!JSON.stringify(result).includes(sentinel));
      // Page-world monkey-patching must not take over the fixed isolated program.
      await guest.executeJavaScript('document.querySelectorAll = () => { throw new Error("page override"); }; void 0;');
      success(await tools.inspect({ guestId }));
      await guest.executeJavaScript('delete document.querySelectorAll;');
    });
    await checkAsync('Foreign guests, top-level windows, invalid ids and unsafe URLs are rejected', async () => {
      assert.equal((await tools.inspect({ guestId: main.webContents.id })).code, 'GUEST_NOT_OWNED');
      assert.equal((await tools.inspect({ guestId: String(guestId) })).code, 'INVALID_GUEST');
      assert.equal((await tools.inspect({ guestId: 2147483000 })).code, 'GUEST_NOT_OWNED');
      const foreign = window();
      const stranger = await attach(foreign);
      assert.equal((await tools.inspect({ guestId: stranger.id })).code, 'GUEST_NOT_OWNED');
      foreign.destroy();
      await guest.loadURL('data:text/html,<h1>Not an allowed preview URL</h1>');
      assert.equal((await tools.inspect({ guestId })).code, 'INVALID_URL');
      assert.equal((await tools.login({ guestId })).code, 'INVALID_URL');
      await guest.loadURL(`${fixtureUrl}/fixture`);
      await waitFor(() => guest.executeJavaScript('document.querySelector("#target").complete'), 'fixture did not reload');
    });
    await checkAsync('Click, fill, native select, real key press and scroll change rendered state', async () => {
      success(await tools.action({ guestId, action: 'click', selector: '#counter' }));
      assert.equal(await guest.executeJavaScript('document.querySelector("#count").textContent'), '1');
      const text = '\"); globalThis.injected = true; //';
      success(await tools.action({ guestId, action: 'fill', selector: '#draft', text }));
      assert.equal(await guest.executeJavaScript('document.querySelector("#draft").value'), text);
      assert.equal(await guest.executeJavaScript('document.body.dataset.filled'), 'yes');
      assert.equal(await guest.executeJavaScript('typeof globalThis.injected'), 'undefined');
      success(await tools.action({ guestId, action: 'select', selector: '#choice', value: 'two' }));
      assert.equal(await guest.executeJavaScript('document.querySelector("#choice").value'), 'two');
      main.focus();
      success(await tools.action({ guestId, action: 'press', selector: '#counter', value: 'Enter' }));
      await waitFor(async () => await guest.executeJavaScript('document.querySelector("#count").textContent') === '2', 'real key press did not activate button');
      success(await tools.action({ guestId, action: 'scroll', value: { y: 700 } }));
      assert(await guest.executeJavaScript('scrollY') > 0);
      success(await tools.action({ guestId, action: 'scroll', value: { y: -100000 } }));
    });
    await checkAsync('Real page zoom and touch swipe change the viewport', async () => {
      const zoom = success(await tools.action({ guestId, action: 'zoom', value: 1.25 }));
      assert.equal(zoom.factor, 1.25);
      success(await tools.action({ guestId, action: 'zoom', value: 1 }));
      await guest.executeJavaScript(`window.swipeEvents=[];for(const type of ['touchstart','touchmove','touchend','wheel'])document.addEventListener(type,event=>window.swipeEvents.push({type,trusted:event.isTrusted,x:event.touches?.[0]?.clientX,y:event.touches?.[0]?.clientY}),{passive:true});`);
      success(await tools.action({ guestId, action: 'swipe', value: { y: 300 } }));
      await waitFor(async () => await guest.executeJavaScript('scrollY') > 0, 'real swipe did not scroll');
      const events = await guest.executeJavaScript('window.swipeEvents');
      assert(events.some(event => event.type === 'touchmove' && event.trusted));
      assert(events.filter(event => event.type.startsWith('touch')).every(event => event.trusted));
      assert.equal((await tools.action({ guestId, action: 'swipe', value: { x: 0, y: 0 } })).code, 'INVALID_SWIPE');
      success(await tools.action({ guestId, action: 'swipe', value: { y: -200 } }));
      success(await tools.action({ guestId, action: 'swipe', value: { x: 200 } }));
      await waitFor(async () => await guest.executeJavaScript('scrollX') > 0, 'horizontal swipe did not scroll');
      await guest.executeJavaScript(`new Promise(resolve=>{let previous='',stable=0;function frame(){const position=scrollX+','+scrollY;stable=position===previous?stable+1:0;previous=position;if(stable===6)resolve(true);else requestAnimationFrame(frame);}frame();})`);
      success(await tools.action({ guestId, action: 'scroll', value: { x: -100000, y: -100000 } }));
    });
    await checkAsync('Approval denial and changed targets prevent browser dispatch', async () => {
      const before = await guest.executeJavaScript('document.querySelector("#count").textContent');
      const denied = createBrowserTools({ BrowserWindow, webContents, nativeImage, getMainWindow: () => main, beforeAction: async () => { throw new Error('Denied'); } });
      try { assert.equal((await denied.action({ guestId, action: 'click', selector: '#counter' })).ok, false); }
      finally { denied.dispose(); }
      assert.equal(await guest.executeJavaScript('document.querySelector("#count").textContent'), before);
      const changed = createBrowserTools({ BrowserWindow, webContents, nativeImage, getMainWindow: () => main, beforeAction: async () => { await guest.executeJavaScript('document.querySelector("#counter").textContent="Changed"'); } });
      try { assert.equal((await changed.action({ guestId, action: 'click', selector: '#counter' })).code, 'PAGE_CHANGED'); }
      finally { changed.dispose(); }
      assert.equal(await guest.executeJavaScript('document.querySelector("#count").textContent'), before);
      await guest.executeJavaScript('document.querySelector("#counter").textContent="Increment"');
    });
    await checkAsync('Authentication, OTP, payment, file, hidden, disabled and unsafe actions are denied', async () => {
      for (const selector of ['#pass', '#otp', '#signin', '#card', '#upload', '#hidden', '#disabled', '#unsafe', '#download', '#file-label-child', '#login-child', '#plain-code']) {
        const result = await tools.action({ guestId, action: 'click', selector });
        assert.equal(result.ok, false, `${selector} unexpectedly allowed`);
      }
      assert.equal((await tools.action({ guestId, action: 'fill', selector: '#pass', text: 'no' })).code, 'MANUAL_LOGIN_REQUIRED');
      assert.equal((await tools.action({ guestId, action: 'press', selector: '#signin', value: 'Enter' })).code, 'MANUAL_LOGIN_REQUIRED');
      assert.equal((await tools.action({ guestId, action: 'click', selector: 'input' })).code, 'SELECTOR_NOT_UNIQUE');
      assert.equal((await tools.action({ guestId, action: 'click', selector: '[' })).code, 'INVALID_SELECTOR');
      assert.equal((await tools.action({ guestId, action: 'eval' })).code, 'INVALID_ACTION');
      assert.equal(await guest.executeJavaScript('Boolean(globalThis.didSubmit || globalThis.unsafeRan)'), false);
    });
    let cropped;
    await checkAsync('Actual capturePage PNG, element crop and sensitive-area masking', async () => {
      success(await tools.action({ guestId, action: 'scroll', value: { y: -100000 } }));
      main.show(); main.focus();
      await guest.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      cropped = success(await tools.capture({ guestId, selector: '#target' }));
      assert.equal(cropped.source, 'webContents.capturePage');
      assert.equal(cropped.crop.width, 240); assert.equal(cropped.crop.height, 100);
      assert.equal(cropped.width, Math.round(240 * cropped.viewport.devicePixelRatio));
      assert.equal(cropped.height, Math.round(100 * cropped.viewport.devicePixelRatio));
      assert.equal(cropped.redactedRegions, 0);
      const bitmap = nativeImage.createFromDataURL(cropped.dataUrl).toBitmap();
      assert.deepEqual([...bitmap.subarray(0, 4)], [30, 80, 200, 255]);
      const full = success(await tools.capture({ guestId }));
      assert(full.width > cropped.width && full.height > cropped.height);
      assert(full.redactedRegions > 0);
      const field = success(await tools.capture({ guestId, selector: '#draft' }));
      const masked = nativeImage.createFromDataURL(field.dataUrl).toBitmap();
      assert.deepEqual([...masked.subarray(0, 4)], [36, 36, 36, 255]);
      assert.equal((await tools.capture({ guestId, selector: '#hidden' })).code, 'ELEMENT_NOT_VISIBLE');
      guest.setZoomFactor(2);
      try {
        await guest.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        const zoomed = success(await tools.capture({ guestId, selector: '#target' }));
        assert.equal(zoomed.requestedCrop.width, 240);
        assert.equal(zoomed.width, Math.round(240 * zoomed.viewport.devicePixelRatio));
        const zoomPixels = nativeImage.createFromDataURL(zoomed.dataUrl).toBitmap();
        assert.deepEqual([...zoomPixels.subarray(Math.floor(zoomPixels.length / 8) * 4, Math.floor(zoomPixels.length / 8) * 4 + 4)], [30, 80, 200, 255]);
      } finally {
        guest.setZoomFactor(1);
        await guest.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      }
    });
    await checkAsync('Open and closed shadow roots are masked including visible overflow', async () => {
      await guest.executeJavaScript(`for (const mode of ['open','closed']) {
        const host = document.createElement('div'); host.id='shadow-'+mode;
        host.style.cssText='position:fixed;left:20px;top:'+ (mode==='open'?80:160)+'px;width:20px;height:20px;z-index:100;background:rgb(255,0,0)';
        const root=host.attachShadow({mode}); root.innerHTML='<span style="display:block;width:180px;height:30px;background:rgb(255,0,0)">PRIVATE_SHADOW_FIXTURE</span>'; document.body.append(host);
      }`);
      await guest.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      const full = success(await tools.capture({ guestId }));
      const image = nativeImage.createFromDataURL(full.dataUrl), bitmap = image.toBitmap({ scaleFactor: 1 });
      const scale = full.width / full.viewport.width;
      for (const y of [90, 170]) {
        const offset = (Math.floor(y * scale) * image.getSize().width + Math.floor(150 * scale)) * 4;
        assert.deepEqual([...bitmap.subarray(offset, offset + 4)], [36, 36, 36, 255]);
      }
      assert(!JSON.stringify(success(await tools.inspect({ guestId }))).includes('PRIVATE_SHADOW_FIXTURE'));
      await guest.executeJavaScript(`document.getElementById('shadow-open').remove(); document.getElementById('shadow-closed').remove();`);
    });
    await checkAsync('Pixel comparisons use real PNG/JPEG data and label mismatch limitations', async () => {
      const compared = success(await tools.compare({ referenceDataUrl: target.toDataURL(), actualDataUrl: cropped.dataUrl }));
      assert.equal(compared.pixelMismatchRatio, 0);
      assert.equal(compared.exactMatch, cropped.width === 240 && cropped.height === 100);
      assert.equal(success(await tools.compare({ referenceDataUrl: cropped.dataUrl, actualDataUrl: cropped.dataUrl })).exactMatch, true);
      assert.equal(compared.pair.length, 2);
      const changed = success(await tools.compare({ referenceDataUrl: target.toDataURL(), actualDataUrl: solid(240, 100, 255, 0, 0).toDataURL() }));
      assert.equal(changed.pixelMismatchRatio, 1); assert.equal(changed.exactMatch, false);
      const aspect = success(await tools.compare({ referenceDataUrl: target.toDataURL(), actualDataUrl: solid(100, 240).toDataURL() }));
      assert.equal(aspect.aspectRatioCompatible, false); assert.equal(aspect.exactMatch, false);
      assert(aspect.summary.includes('not an exact-match'));
      const jpeg = `data:image/jpeg;base64,${target.toJPEG(95).toString('base64')}`;
      success(await tools.compare({ referenceDataUrl: jpeg, actualDataUrl: cropped.dataUrl }));
      assert.equal((await tools.compare({ actualDataUrl: cropped.dataUrl })).code, 'MISSING_COMPARISON_IMAGE');
      assert.equal((await tools.compare({ referenceDataUrl: 'data:image/png;base64,bm90LXBuZw==', actualDataUrl: cropped.dataUrl })).ok, false);
    });
    await checkAsync('Live console and HTTP failures, broken images, overflow and bounded logs', async () => {
      const first = success(await tools.diagnostics({ guestId }));
      assert.equal(first.tracking.networkStatus, 'active');
      await guest.executeJavaScript(`console.warn('unlabeled PRIVATE_CONSOLE_FIXTURE');console.error('TypeError: token=PRIVATE_TOKEN_FIXTURE');fetch('/fail?token=PRIVATE_NETWORK_FIXTURE').catch(()=>{});`);
      const result = await waitFor(async () => {
        const result = success(await tools.diagnostics({ guestId }));
        return result.network.some(entry => entry.status === 503 && entry.url.endsWith('/fail')) && result.console.length >= 2 ? result : null;
      }, 'live diagnostic events were not captured');
      assert(result.dom === undefined);
      assert(result.brokenImages.some(image => image.alt === 'Broken test image'));
      assert.equal(result.overflow.horizontal, true);
      assert(result.controls.unnamed.length > 0);
      assert(!JSON.stringify(result).includes('PRIVATE_'));
      await guest.executeJavaScript('for(let i=0;i<130;i++)console.warn("bounded test")');
      const bounded = success(await tools.diagnostics({ guestId }));
      assert.equal(bounded.console.length, 100); assert(bounded.tracking.droppedConsole > 0);
      const observer = createBrowserTools({ BrowserWindow, webContents, nativeImage, getMainWindow: () => main });
      try { assert.equal(success(await observer.diagnostics({ guestId })).tracking.networkStatus, 'unavailable-debugger-in-use'); }
      finally { observer.dispose(); }
      assert.equal(guest.debugger.isAttached(), true, 'a second observer must not detach the existing debugger');
    });
    await checkAsync('Manual window shares session, stays sandboxed and hardens nested popups', async () => {
      const before = new Set(BrowserWindow.getAllWindows());
      const pending = tools.login({ guestId });
      const manual = await waitFor(() => BrowserWindow.getAllWindows().find(win => !before.has(win)), 'manual window did not open');
      windows.add(manual);
      assert(manual.isVisible()); assert.equal(manual.webContents.session, guest.session);
      await waitFor(() => !manual.webContents.isLoading() && manual.webContents.getURL().startsWith(fixtureUrl), 'manual page did not load');
      const prefs = manual.webContents.getLastWebPreferences();
      for (const key of ['nodeIntegration', 'nodeIntegrationInSubFrames', 'webviewTag']) assert.equal(prefs[key], false, key);
      assert.notEqual(prefs.nodeIntegrationInWorker, true);
      assert.equal(manual.webContents.isDevToolsOpened(), false);
      assert.equal(await manual.webContents.executeJavaScript('typeof require'), 'undefined');
      for (const key of ['contextIsolation', 'sandbox', 'webSecurity']) assert.equal(prefs[key], true, key);
      const existing = new Set(BrowserWindow.getAllWindows());
      await manual.webContents.executeJavaScript(`window.open(${JSON.stringify(`${fixtureUrl}/popup`)}, '_blank', 'nodeIntegration=yes,contextIsolation=no,sandbox=no');void 0;`);
      const popup = await waitFor(() => BrowserWindow.getAllWindows().find(win => !existing.has(win)), 'secure popup did not open');
      windows.add(popup);
      assert.equal(popup.webContents.session, guest.session);
      const popupPrefs = popup.webContents.getLastWebPreferences();
      assert.equal(popupPrefs.nodeIntegration, false); assert.equal(popupPrefs.contextIsolation, true); assert.equal(popupPrefs.sandbox, true);
      await waitFor(() => !popup.webContents.isLoading() && popup.webContents.getURL().includes('/popup'), 'popup did not load');
      assert.equal(await popup.webContents.executeJavaScript('Boolean(window.opener)'), true);
      await manual.webContents.executeJavaScript('window.open("file:///should-never-open", "_blank");void 0;');
      assert.equal(BrowserWindow.getAllWindows().length, existing.size + 1);
      const permission = await manual.webContents.executeJavaScript('navigator.permissions.query({name:"geolocation"}).then(result=>result.state)');
      assert.equal(permission, 'denied');
      const blockedDownload = new Promise(resolve => {
        guest.session.once('will-download', (event, item) => {
          const denied = event.defaultPrevented;
          if (!denied) item.cancel(); // Safety net: this isolated test must never save a file.
          resolve(denied);
        });
      });
      await manual.webContents.executeJavaScript('location.href="/download";void 0;');
      assert.equal(await blockedDownload, true);
      manual.close();
      const result = await pending;
      assert.equal(result.status, 'closed'); assert.equal(result.authentication, 'unknown'); assert.equal(result.sessionPreserved, true);
      assert(popup.isDestroyed());
      success(await tools.inspect({ guestId }));
    });
    await checkAsync('Manual login timeout closes only flow windows (accelerated test timer)', async () => {
      const originalTimer = global.setTimeout;
      let pending;
      try {
        global.setTimeout = (callback, delay, ...args) => originalTimer(callback, delay === v.LIMITS.loginMs ? 50 : delay, ...args);
        pending = tools.login({ guestId });
      } finally { global.setTimeout = originalTimer; }
      const result = await pending;
      assert.equal(result.status, 'timed-out'); assert.equal(result.authentication, 'unknown');
      assert.equal(guest.isDestroyed(), false);
    });
    await checkAsync('Disposal cancels pending manual login, detaches listeners and preserves the preview', async () => {
      const pending = tools.login({ guestId });
      await waitFor(() => BrowserWindow.getAllWindows().some(win => win !== main), 'second manual window did not open');
      assert.equal(guest.debugger.isAttached(), true);
      success(tools.dispose());
      assert.equal((await pending).status, 'cancelled');
      assert.equal(guest.debugger.isAttached(), false);
      assert.equal(guest.isDestroyed(), false);
      assert.equal((await tools.inspect({ guestId })).code, 'DISPOSED');
      success(tools.dispose());
    });
    console.log(`Electron ${process.versions.electron}: ${checks} integration checks passed. Actual screenshots and comparison pairs were verified in memory.`);
    console.log('Limitations: no live Dribbble/provider access or real authentication was attempted; Dribbble selection is fixture/validation tested. The login timeout branch uses an accelerated test timer. App IPC/UI wiring is intentionally outside these two files.');
  } finally {
    clearTimeout(timeout);
    tools?.dispose();
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    await Promise.all(servers.map(instance => new Promise(resolve => instance.close(resolve))));
  }
  app.exit(0);
}

async function nodeMain() {
  pureTests();
  console.log(`${checks} pure validation checks passed.`);
  if (process.argv.includes('--node-only')) { console.log('Electron integration not run (--node-only).'); return; }
  let executable;
  try { executable = require('electron'); } catch { throw new Error('Electron is unavailable. Pure tests passed; run with --node-only to explicitly limit verification.'); }
  const fs = require('node:fs'), os = require('node:os'), { spawn } = require('node:child_process');
  const parent = os.tmpdir();
  assert(fs.statSync(parent).isDirectory(), 'Temporary profile parent must exist');
  const profile = fs.mkdtempSync(path.join(parent, 'browser-tools-verify-'));
  const env = { ...process.env, BROWSER_TOOLS_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    const code = await new Promise((resolve, reject) => {
      child = spawn(executable, [__filename, '--electron'], { env, stdio: 'inherit', windowsHide: false });
      child.once('error', reject);
      child.once('exit', (code, signal) => signal ? reject(new Error(`Isolated Electron test exited via ${signal}`)) : resolve(code));
    });
    assert.equal(code, 0, 'Isolated Electron integration failed');
  } finally {
    // Only this test-created profile is removed. The user's application is untouched.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch { console.warn(`Temporary test profile still in use: ${profile}`); }
  }
}

if (process.versions.electron && process.argv.includes('--electron')) {
  electronTests().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
  nodeMain().catch(error => { console.error(error); process.exitCode = 1; });
}
