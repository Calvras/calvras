/**
 * Every download affordance on the marketing site, checked against what is actually published.
 *
 * A button that points at a GitHub release asset nobody uploaded looks identical to a working
 * one until someone clicks it, so this starts the built server, reads each page the way a
 * visitor does, and then asks the real URL for its first bytes.
 *
 *   node scripts/verify-download-buttons.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";

const PAGES = ["/", "/capabilities", "/pricing", "/docs", "/about", "/changelog", "/support", "/partner", "/privacy", "/terms"];
const report = { ok: true, checks: [], pages: {}, links: {} };

function say(label, passed, extra) {
  report.checks.push({ label, passed, ...(extra ? { extra } : {}) });
  if (!passed) report.ok = false;
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${JSON.stringify(extra)}` : ""}`);
}

async function freePort() {
  const server = net.createServer();
  await once(server.listen(0), "listening");
  const { port } = server.address();
  await once(server.close(), "close");
  return port;
}

/** Follow redirects and take only the head of the body — enough to tell an exe from an error page. */
async function probe(url) {
  try {
    const response = await fetch(url, { headers: { range: "bytes=0-3" }, redirect: "follow" });
    const head = Buffer.from(await response.arrayBuffer());
    return {
      url,
      status: response.status,
      type: response.headers.get("content-type") || "",
      length: Number(response.headers.get("content-range")?.split("/")[1] ?? response.headers.get("content-length") ?? 0),
      magic: head.subarray(0, 2).toString("latin1"),
    };
  } catch (error) {
    return { url, status: 0, type: "", length: 0, magic: "", error: String(error) };
  }
}

const port = await freePort();
const child = spawn(process.execPath, [".output/server/index.mjs"], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: "ignore" });
try {
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${base}/update.json`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const expected = await (await fetch(`${base}/update.json`)).json();
  say(`the site publishes v${expected.version} with an installer at ${expected.installer}`,
    /^https:\/\/github\.com\/Calvras\/calvras\/releases\/download\/v[\d.]+\/Calvras-Setup-[\d.]+\.exe$/.test(expected.installer));

  const hrefs = new Set();
  for (const page of PAGES) {
    const html = await (await fetch(base + page)).text();
    const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
      .map(([, attrs, inner]) => ({ href: /href="([^"]*)"/.exec(attrs)?.[1] ?? "", text: inner.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim() }))
      .filter(({ text, href }) => /download|portable|release/i.test(text) && /^https?:/.test(href));
    report.pages[page] = links;
    for (const link of links) hrefs.add(link.href);
    say(`${page} offers ${links.length} download link(s)${links.length ? `: ${links.map((l) => l.text).join(" | ")}` : ""}`, true);
  }

  const installerLinks = [...hrefs].filter((href) => /\.exe$/.test(href));
  const zipLinks = [...hrefs].filter((href) => /\.zip$/.test(href));
  const otherLinks = [...hrefs].filter((href) => !/\.exe$|\.zip$/.test(href));

  say(`${installerLinks.length} distinct installer target(s), all naming the published version`,
    installerLinks.length > 0 && installerLinks.every((href) => href === expected.installer), installerLinks.filter((href) => href !== expected.installer));
  say(`${zipLinks.length} portable target(s), all matching the manifest`,
    zipLinks.length > 0 && zipLinks.every((href) => href === expected.portable), zipLinks.filter((href) => href !== expected.portable));
  say(`${otherLinks.length} release page link(s) point at the published tag`,
    otherLinks.every((href) => href === expected.release), otherLinks);

  for (const href of [...installerLinks, ...zipLinks]) {
    const result = await probe(href);
    const isExe = href.endsWith(".exe");
    say(`${href.split("/").pop()} answers ${result.status} as ${result.type || "unknown"} (${Math.round(result.length / 1024 / 1024)} MB, magic ${JSON.stringify(result.magic)})`,
      (result.status === 200 || result.status === 206) && result.length > 20 * 1024 * 1024 && result.magic === (isExe ? "MZ" : "PK"), result);
  }
} finally {
  child.kill();
  report.summary = { pages: PAGES.length, installerLinks: Object.keys(report.links).length };
  console.log(JSON.stringify(report, null, 1));
}
process.exit(report.ok ? 0 : 1);
