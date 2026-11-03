// @vitest-environment node
// The only duplication test that reaches the public web. It stays skipped in a normal `vitest run`
// and executes when CALVRAS_LIVE_DUPLICATE=1, because its point is the two numbers the user actually
// asked about: what a real page costs to take, and how much of that page's own wording ends up in the
// project. The reference is the survey taken in the same session, so the comparison is the page
// against its own copy rather than against a second load that may show different banners.
//   CALVRAS_LIVE_DUPLICATE=1 CALVRAS_LIVE_URL=https://example.com/ npx vitest run src/test/browser-duplicate-live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeBrowserSessions, executeBrowserTool } from '../lib/runtime/browser-tools';

const live = process.env['CALVRAS_LIVE_DUPLICATE'] === '1';
const target = process.env['CALVRAS_LIVE_URL'] || 'https://www.cloudflare.com/';
const dir = 'page-copy';

describe.skipIf(!live)('taking a live page end to end', () => {
  let project: string;
  beforeAll(async () => { project = await mkdtemp(path.join(tmpdir(), 'calvras-live-duplicate-')); }, 30_000);
  afterAll(async () => {
    await closeBrowserSessions();
    await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('saves the page and its stylesheet, then reports what it cost and what carried over', async () => {
    // The take is first, and the survey then reads the document that is already loaded — the same one
    // the snapshot came from. Surveying before the take would compare the copy against a second load,
    // and a page with rotating sections answers differently twice in a row.
    const started = Date.now();
    const taken = await executeBrowserTool('duplicate_page', { url: target, dir }, project);
    const seconds = (Date.now() - started) / 1000;
    expect(taken.ok).toBe(true);
    const survey = await executeBrowserTool('read_page', { full: true }, project);
    const html = await readFile(path.join(project, dir, 'index.html'), 'utf8');
    const css = await readFile(path.join(project, dir, 'calvras-page.css'), 'utf8');
    expect(html).toContain('href="./calvras-page.css"');
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/(?:src|href)="https?:\/\//);
    expect(css.length).toBeGreaterThan(1000);
    // What the same session measured is the spec the copy is graded against: every band it saw, with
    // its height, and the whole page's text in reading order.
    const wanted = [...new Set(String(survey.documentText || '').split('\n').map((line: string) => line.trim()).filter((line: string) => line.length > 24 && /[a-z]/i.test(line)))] as string[];
    // Grade the copy on the text it actually renders, not on its raw bytes: the saved markup carries
    // apostrophes and dashes as entities and splits a heading across tags, so a substring test on the
    // file would count a faithful copy as missing lines.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const view = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await view.goto(`file:///${path.join(project, dir, 'index.html').replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await view.evaluate(async () => {
      const height = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let y = 0; y < height(); y += 600) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((resolve) => setTimeout(resolve, 80)); }
    });
    const rendered = await view.evaluate(() => document.body.innerText);
    const copyHeight = await view.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    await browser.close();
    const flatten = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const haystack = flatten(rendered);
    const matched = wanted.filter((line) => haystack.includes(flatten(line).slice(0, 60)));
    const anchors = (survey.sections ?? []).filter((band: any) => (band?.headings?.length || 0) > 0);
    // A heading is not compared as an exact string: an auto-rotating carousel has already moved to
    // another slide by the time the survey re-reads the page, and the snapshot is of one of them. What
    // has to hold is that every band contributes its own words to the copy.
    const bands = (survey.sections ?? []) as any[];
    const covered = bands.filter((band: any) => String(band?.text || "").split("\n").map((line: string) => line.trim()).filter((line: string) => line.length > 8).some((line: string) => haystack.includes(flatten(line))));
    console.log(`LIVE DUPLICATE ${target}: ${seconds.toFixed(1)}s to take · ${Math.round(css.length / 1024)}KB of its own CSS · reference ${survey.documentHeightPx}px, copy renders ${copyHeight}px · ${wanted.length} text lines, ${matched.length} shown by the copy · ${bands.length} bands, ${covered.length} carrying their own words · ${anchors.length} headed bands`);
    expect(matched.length / Math.max(1, wanted.length)).toBeGreaterThan(0.9);
    expect(covered.length / Math.max(1, bands.length)).toBeGreaterThan(0.9);
    expect(copyHeight).toBeGreaterThan(Number(survey.documentHeightPx ?? 0) * 0.7);
    expect(seconds).toBeLessThan(120);
  }, 240_000);
});
