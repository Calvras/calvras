/**
 * Page-side source for the human-like browsing loop. Both browser executors run these strings
 * verbatim (webview via executeJavaScript, headless via page.evaluate), so one set of coordinates
 * and one mark overlay drives either surface.
 *
 * The point is that a screenshot alone has to be enough to act: the agent looks at the page, reads a
 * number off it, and clicks that spot. Without these marks the only way to aim is read_page or
 * inspect_element first, which is why a browsing task kept re-searching instead of clicking.
 */

/** Find what a person could click, number it on screen, and return each number's coordinates. */
export const COLLECT_TARGETS_SOURCE = `(() => {
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const old = document.getElementById('__calvras_marks');
  if (old) old.remove();
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const selector = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="link"]', '[role="button"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="option"]', '[role="switch"]',
    '[role="slider"]', '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]',
    '[role="listitem"]', '[role="generic"][onclick]', '[contenteditable="true"]', '[onclick]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const named = (node) => {
    const byId = node.getAttribute('aria-labelledby');
    if (byId) {
      const label = clean(byId.split(/\\s+/).map((id) => { const el = document.getElementById(id); return el ? el.textContent : ''; }).join(' '));
      if (label) return label.slice(0, 90);
    }
    return clean(
      node.getAttribute('aria-label') || node.textContent || node.getAttribute('placeholder') ||
      node.getAttribute('alt') || node.getAttribute('title') || node.value || node.getAttribute('name') ||
      (node.tagName === 'IMG' ? (node.currentSrc || node.src || '').split('/').pop() : '') ||
      node.getAttribute('role') || node.tagName.toLowerCase()
    ).slice(0, 90);
  };
  const candidates = [...document.querySelectorAll(selector)];
  const all = [...document.querySelectorAll('body *')].slice(0, 4000);
  for (const node of all) {
    if (candidates.length > 3000) break;
    if (node.tagName === 'A' || node.tagName === 'BUTTON' || node.tagName === 'INPUT') continue;
    let style;
    try { style = getComputedStyle(node); } catch { continue; }
    if (style.cursor === 'pointer') candidates.push(node);
  }
  const usable = (node) => {
    if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) return null;
    if (rect.right <= 2 || rect.bottom <= 2 || rect.left >= vw - 2 || rect.top >= vh - 2) return null;
    let style;
    try { style = getComputedStyle(node); } catch { return null; }
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const x = Math.round(Math.min(vw - 2, Math.max(2, rect.left + rect.width / 2)));
    const y = Math.round(Math.min(vh - 2, Math.max(2, rect.top + rect.height / 2)));
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    if (!(hit === node || node.contains(hit) || hit.contains(node))) return null;
    return { x, y, width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top) };
  };
  const byPoint = new Map();
  const targets = [];
  for (const node of candidates) {
    if (targets.length >= 60) break;
    const spot = usable(node);
    if (!spot) continue;
    const key = spot.x + ',' + spot.y + ',' + spot.width + 'x' + spot.height;
    if (byPoint.has(key)) continue;
    byPoint.set(key, true);
    const role = node.getAttribute('role') || (node.tagName === 'A' ? 'link' : node.tagName === 'INPUT' ? (node.type || 'text') : node.tagName.toLowerCase());
    targets.push({ i: targets.length + 1, ...spot, role, label: named(node) || role });
  }
  const layer = document.createElement('div');
  layer.id = '__calvras_marks';
  layer.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none');
  const sheet = document.createElement('style');
  sheet.textContent = '.__cm{position:absolute;background:#111;color:#fff;border:1px solid #fff;font:600 11px/16px system-ui,sans-serif;padding:0 4px;border-radius:3px;pointer-events:none}.__cb{position:absolute;border:2px solid rgba(255,72,72,.95);border-radius:3px;pointer-events:none;box-sizing:border-box}';
  const parts = [];
  for (const target of targets) {
    parts.push('<span class="__cb" style="left:' + (target.left - 1) + 'px;top:' + (target.top - 1) + 'px;width:' + (target.width + 2) + 'px;height:' + (target.height + 2) + 'px"></span>');
    parts.push('<span class="__cm" style="left:' + Math.max(0, target.left - 2) + 'px;top:' + Math.max(0, target.top - 18) + 'px">' + target.i + '</span>');
  }
  layer.appendChild(sheet);
  layer.insertAdjacentHTML('beforeend', parts.join(''));
  (document.body || document.documentElement).appendChild(layer);
  return { viewport: { width: vw, height: vh }, scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }, targets };
})()`;

/** Remove the numbered overlay so the page the user sees is the page itself again. */
export const CLEAR_MARKS_SOURCE = `(() => { const layer = document.getElementById('__calvras_marks'); if (layer) layer.remove(); return { ok: true }; })()`;

/**
 * What the page already says, read from inside it: the headline and the text within the fold.
 * An open that returns only a title forces a second round just to find out where the agent landed,
 * so the open itself carries this and the first instruction about the page can be answered from it.
 */
export const FIRST_SCREEN_SOURCE = `(() => {
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const body = document.body;
  return {
    heading: clean(document.querySelector('h1')?.textContent).slice(0, 160),
    text: clean(body ? (body.innerText || body.textContent) : '').slice(0, 1200),
  };
})()`;

/** What the page shows rather than says: pictures and moving media, so a text-only read is not blind. */
export const PAGE_MEDIA_SOURCE = `(() => {
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const shown = (node) => { const rect = node.getBoundingClientRect(); if (rect.width < 24 || rect.height < 24) return false; const style = getComputedStyle(node); return !(style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0); };
  const nearby = (node) => {
    let probe = node;
    for (let depth = 0; depth < 4 && probe; depth += 1) {
      probe = probe.parentElement;
      if (!probe) break;
      const text = clean(probe.innerText || probe.textContent);
      if (text.length > 12) return text.slice(0, 220);
    }
    return '';
  };
  const images = [...document.querySelectorAll('img')].filter(shown).slice(0, 30).map((node) => ({
    alt: clean(node.getAttribute('alt')).slice(0, 160),
    src: (node.currentSrc || node.src || '').slice(0, 300),
    size: Math.round(node.getBoundingClientRect().width) + 'x' + Math.round(node.getBoundingClientRect().height),
    context: nearby(node)
  }));
  const videos = [...document.querySelectorAll('video')].slice(0, 10).map((node) => ({
    playing: !node.paused && !node.ended,
    time: Math.round((node.currentTime || 0) * 10) / 10,
    duration: Math.round((node.duration || 0) * 10) / 10,
    muted: node.muted === true,
    size: Math.round(node.getBoundingClientRect().width) + 'x' + Math.round(node.getBoundingClientRect().height),
    caption: clean(node.getAttribute('aria-label') || nearby(node)).slice(0, 220)
  }));
  const audios = [...document.querySelectorAll('audio')].slice(0, 6).map((node) => ({ playing: !node.paused && !node.ended, duration: Math.round((node.duration || 0) * 10) / 10 }));
  const iframes = [...document.querySelectorAll('iframe')].slice(0, 8).map((node) => ({ src: clean(node.getAttribute('src')).slice(0, 200), label: clean(node.getAttribute('title')).slice(0, 120) }));
  return { imageCount: images.length, videoCount: videos.length, images, videos, audios, iframes };
})()`;

/**
 * The whole document, measured. A duplication built from the first screenful guesses at everything
 * below it — the section order, the gaps, the colours — which is exactly what a user sees as "the
 * spacing, colour, size". This walks the page to its real end first (so lazy sections mount), then
 * reports every band with the numbers a stylesheet has to reproduce: its offset and height in
 * pixels, its background and text colours, each heading's size and weight, the padding around the
 * content, and the images and buttons inside it with their sources and rounded corners.
 */
export const SURVEY_SOURCE = `(async () => {
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const lines = (value) => String(value == null ? '' : value).split('\\n').map((line) => clean(line)).filter(Boolean).join('\\n');
  const px = (value) => Math.round(parseFloat(value) || 0);
  const box = (style) => [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)].join(' ');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jump = (top) => { window.scrollTo({ top, left: 0, behavior: 'instant' }); if (document.scrollingElement) document.scrollingElement.scrollTop = top; };
  const height = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const step = Math.max(300, Math.round(window.innerHeight * 0.7));
  let y = 0;
  for (let guard = 0; guard < 60; guard += 1) {
    jump(y);
    await wait(130);
    const next = Math.min(y + step, height());
    if (next === y) break;
    y = next;
  }
  jump(height());
  await wait(400);
  const documentHeight = height();
  jump(0);
  await wait(200);
  // A band is a thing a person would call a section: a semantic block, or a div that behaves like
  // one. The wrappers that merely hold other bands are dropped so the list reads top to bottom.
  const shown = (node) => {
    if (node.id === '__calvras_marks') return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.height > 90 && rect.width > 200 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const bandish = (node) => {
    if (!shown(node)) return false;
    if (['SECTION', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'ARTICLE', 'MAIN'].includes(node.tagName)) return true;
    if (node.tagName !== 'DIV') return false;
    if (node.querySelector('h1,h2,h3')) return true;
    return [...node.children].filter((kid) => ['block', 'flex', 'grid'].includes(getComputedStyle(kid).display)).length >= 3;
  };
  const candidates = [...document.querySelectorAll('body *')].slice(0, 6000).filter(bandish);
  const leaves = candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)));
  const bands = (leaves.length ? leaves : [...document.body.children].filter(shown))
    .sort((a, b) => (a.getBoundingClientRect().top + window.scrollY) - (b.getBoundingClientRect().top + window.scrollY));
  const colors = new Map();
  const note = (value) => { if (value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') colors.set(value, (colors.get(value) || 0) + 1); };
  const sections = bands.slice(0, 48).map((node, index) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    note(style.backgroundColor);
    const headings = [...node.querySelectorAll('h1,h2,h3,h4')].slice(0, 8).map((head) => {
      const headStyle = getComputedStyle(head);
      note(headStyle.color);
      return { tag: head.tagName.toLowerCase(), text: clean(head.textContent).slice(0, 110), sizePx: px(headStyle.fontSize), weight: headStyle.fontWeight, color: headStyle.color, lineHeightPx: px(headStyle.lineHeight) };
    });
    const controls = [...node.querySelectorAll('a[href],button')].slice(0, 10).map((control) => {
      const controlStyle = getComputedStyle(control);
      note(controlStyle.backgroundColor); note(controlStyle.color);
      return { text: clean(control.textContent).slice(0, 50), background: controlStyle.backgroundColor, color: controlStyle.color, radiusPx: px(controlStyle.borderRadius), paddingPx: box(controlStyle), fontSizePx: px(controlStyle.fontSize) };
    });
    const media = [...node.querySelectorAll('img,svg,video')].filter((item) => { const r = item.getBoundingClientRect(); return r.width > 24 && r.height > 24; }).slice(0, 6).map((item) => ({
      tag: item.tagName.toLowerCase(),
      alt: clean(item.getAttribute('alt')).slice(0, 70),
      src: (item.currentSrc || item.src || item.getAttribute('src') || '').toString().slice(0, 180),
      size: Math.round(item.getBoundingClientRect().width) + 'x' + Math.round(item.getBoundingClientRect().height),
    }));
    return {
      index,
      tag: node.tagName.toLowerCase(),
      id: node.id || '',
      classes: (typeof node.className === 'string' ? node.className : '').slice(0, 90),
      topPx: Math.round(rect.top + window.scrollY),
      heightPx: Math.round(rect.height),
      background: style.backgroundColor,
      color: style.color,
      font: style.fontFamily.slice(0, 70),
      baseFontSizePx: px(style.fontSize),
      paddingPx: box(style),
      maxWidthPx: px(style.maxWidth),
      textAlign: style.textAlign,
      headings,
      controls,
      media,
      text: lines(node.innerText || node.textContent).slice(0, 700),
    };
  }).filter((band) => band.text || band.headings.length || band.controls.length || band.media.length);
  return {
    coverage: 'full document',
    url: location.href,
    title: document.title,
    documentHeightPx: documentHeight,
    viewportHeightPx: window.innerHeight,
    viewportWidthPx: window.innerWidth,
    sectionCount: bands.length,
    documentText: lines(document.body ? document.body.innerText : '').slice(0, 24000),
    palette: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([color, used]) => color + ' x' + used),
    sections,
  };
})()`;

export type PageTarget = { i: number; x: number; y: number; width: number; height: number; left: number; top: number; role: string; label: string };export type PageView = { viewport: { width: number; height: number }; scroll: { x: number; y: number }; targets: PageTarget[] };

/**
 * Coordinates the model may click live in the current view only, so the list travels with the
 * screenshot rather than as prose. Compact on purpose: a social feed can hold sixty targets and the
 * prompt is charged for every character.
 */
export function formatTargets(view: PageView | null | undefined): string {
  if (!view || !Array.isArray(view.targets)) return "";
  return view.targets
    .map((target) => `${target.i}: ${target.role} "${(target.label || "").slice(0, 60)}" at x=${target.x} y=${target.y}`)
    .join("\n")
    .slice(0, 6000);
}

/** Keep the JSON the model reads small; the numbered lines above carry the same information. */
export function targetSummary(view: PageView | null | undefined) {
  if (!view) return null;
  return { viewport: view.viewport, scroll: view.scroll, numbered: view.targets.length };
}
