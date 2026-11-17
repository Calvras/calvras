import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_VERSION, releaseArtifacts, updateManifest } from "../lib/release";
import { checkForUpdate, readRelease } from "../lib/update";
import { DOWNLOAD } from "../lib/download";
import { LANDING_HTML } from "../lib/landing-html";

const require = createRequire(import.meta.url);
const { downloadInstaller, launchInstaller, latestRelease, isNewerVersion } = require("../../electron/update-core.cjs") as {
  downloadInstaller: (url: string, destination: string, options?: Record<string, unknown>) => Promise<{ file: string; bytes: number }>;
  launchInstaller: (file: string, options: { openPath: (file: string) => Promise<string>; quit: () => void }) => Promise<void>;
  latestRelease: (options?: { fetchImpl: typeof fetch }) => Promise<{ version: string; url: string; sha256?: string }>;
  isNewerVersion: (remote: string, local: string) => boolean;
};

const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(512, 0x2a)]);

function response(chunks: Buffer[], { type = "application/octet-stream", status = 200, stream = false } = {}) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = stream
    ? new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } })
    : { [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk; } };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => ({ "content-type": type, "content-length": String(total) } as Record<string, string | null>)[name.toLowerCase()] ?? null },
    body,
  };
}

async function tmp() {
  const dir = await mkdtemp(path.join(tmpdir(), "calvras-update-"));
  return { dir, file: path.join(dir, "updates", "Calvras-Setup-10.0.4.exe") };
}

const feedResponse = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => "application/json; charset=utf-8" }, json: async () => body });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the published release", () => {
  it("names the version this repo is actually at", () => {
    const config = JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "electron-builder.kraken.json"), "utf8")) as { extraMetadata: { version: string } };
    expect(RELEASE_VERSION).toBe(config.extraMetadata.version);
  });

  it("reports the packaged version instead of a stale hardcoded runtime version", () => {
    const runtime = require("node:fs").readFileSync(path.resolve(process.cwd(), "main.cjs"), "utf8") as string;
    expect(runtime).toContain("const APP_VERSION = app.isPackaged ? app.getVersion() : require('./electron-builder.kraken.json').extraMetadata.version;");
  });

  it("feeds the landing page and the app from one source", () => {
    const manifest = updateManifest();
    const release = readRelease(manifest);
    expect(release.version).toBe(RELEASE_VERSION);
    expect(DOWNLOAD.version).toBe(release.version);
    expect(DOWNLOAD.installer).toBe(release.installer);
    expect(DOWNLOAD.portable).toBe(release.portable);
    expect(DOWNLOAD.feed).toBe("https://calvras.com/update.json");
  });

  it("routes every landing-page download button through the current release", () => {
    const page = new DOMParser().parseFromString(LANDING_HTML, "text/html");
    const links = [...page.querySelectorAll("a")].filter(link => /download|get it now/i.test(link.textContent || ""));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every(link => link.getAttribute("href") === "/download")).toBe(true);
    expect(page.title).toContain("Calvras");
    expect(page.body.textContent).toContain("Kracton");
    expect(page.body.textContent).not.toMatch(/\bKraken\b|Zoom company/);
  });

  it("builds artifact names the installer config produces", () => {
    const artifacts = releaseArtifacts("10.4.0");
    expect(artifacts.tag).toBe("v10.4.0");
    expect(artifacts.installer).toBe("https://github.com/Calvras/calvras/releases/download/v10.4.0/Calvras.Setup.10.4.0.exe");
    expect(artifacts.portable).toBe("");
    const builder = JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "electron-builder.kraken.json"), "utf8")) as { nsis: { artifactName: string } };
    expect(builder.nsis.artifactName.replace("${version}", "10.4.0")).toBe(artifacts.installer.split("/").pop());
  });
});

describe("reading the feed", () => {
  it("refuses a manifest that cannot be installed", () => {
    expect(() => readRelease(null)).toThrow(/did not report a published version/);
    expect(() => readRelease({ ok: false })).toThrow(/did not report a published version/);
    expect(() => readRelease({ ok: true, version: "ten", installer: "https://x/y.exe" })).toThrow(/unreadable version/);
    expect(() => readRelease({ ok: true, version: "10.0.4", installer: "http://x/y.exe" })).toThrow(/no secure download link/);
  });

  it("offers an update only when the published version is ahead of this one", async () => {
    const feed = { ...updateManifest(), version: "99.0.0", installer: "https://example.test/Calvras-Setup-99.0.0.exe" };
    vi.stubGlobal("fetch", vi.fn(async () => feedResponse(feed)));
    const result = await checkForUpdate("10.0.3");
    expect(result.state).toBe("available");
    expect(result.state === "available" && result.release.version).toBe("99.0.0");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://calvras.com/update.json");
  });

  it("says nothing when this app is already the published version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => feedResponse(updateManifest())));
    expect((await checkForUpdate(RELEASE_VERSION)).state).toBe("latest");
    expect((await checkForUpdate("99.0.0")).state).toBe("latest");
  });

  it("treats the landing page served in place of the feed as no information", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" }, json: async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE\" ... is not valid JSON"); } })));
    const html = await checkForUpdate("10.0.3");
    expect(html.state).toBe("unreachable");
    expect(html.state === "unreachable" && html.error).toBe("The published update feed is not readable yet, so Calvras stayed put.");
  });

  it("reports an unreachable feed as a reason, never as an update", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const missing = await checkForUpdate("10.0.3");
    expect(missing.state).toBe("unreachable");
    expect(missing.state === "unreachable" && missing.error).toBe("The update feed answered 404.");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const offline = await checkForUpdate("10.0.3");
    expect(offline.state).toBe("unreachable");
    expect(offline.state === "unreachable" && offline.error).toBe("offline");
  });
});

describe("desktop upgrade", () => {
  const version = "99.1.0";
  const url = `https://github.com/Calvras/calvras/releases/download/v${version}/Calvras.Setup.${version}.exe`;
  const asset = { name: `Calvras.Setup.${version}.exe`, browser_download_url: url, digest: `sha256:${"a".repeat(64)}` };
  const github = { tag_name: `v${version}`, assets: [asset] };

  it("selects the named public installer, not another executable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => feedResponse({ ...github, assets: [{ name: "other.exe" }, asset] })));
    expect(await latestRelease()).toEqual({ version, url, sha256: "a".repeat(64) });
  });

  it("uses the website feed when GitHub rate-limits the check", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: false, status: 403 }).mockResolvedValueOnce(feedResponse({ ok: true, version, installer: url }));
    vi.stubGlobal("fetch", request);
    expect(await latestRelease()).toEqual({ version, url });
    expect(request.mock.calls[1][0]).toBe("https://calvras.com/update.json");
  });

  it("never launches an arbitrary URL supplied by a release", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => feedResponse({ ...github, assets: [{ ...asset, browser_download_url: "https://example.test/malware.exe" }] })));
    await expect(latestRelease()).rejects.toThrow(/official Calvras installer/);
  });

  it("refuses missing installers rather than constructing an old download URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(feedResponse({ ...github, assets: [] })).mockResolvedValueOnce({ ok: false, status: 404 }));
    await expect(latestRelease()).rejects.toThrow(/404/);
  });

  it("compares actual semantic versions and refuses equal or older releases", () => {
    expect(isNewerVersion("9.10.0", "9.9.0")).toBe(true);
    expect(isNewerVersion(RELEASE_VERSION, RELEASE_VERSION)).toBe(false);
    expect(isNewerVersion("9.7.1", RELEASE_VERSION)).toBe(false);
    expect(isNewerVersion("latest", RELEASE_VERSION)).toBe(false);
  });

  it("waits for Windows to open interactive setup before quitting", async () => {
    const quit = vi.fn();
    let finish!: (error: string) => void;
    const openPath = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const pending = launchInstaller("C:/Temp/Calvras.Setup.exe", { openPath, quit });
    expect(quit).not.toHaveBeenCalled();
    finish("");
    await pending;
    expect(openPath).toHaveBeenCalledWith("C:/Temp/Calvras.Setup.exe");
    expect(quit).toHaveBeenCalledOnce();
  });

  it("keeps the app open when Windows refuses or cancels setup", async () => {
    const quit = vi.fn();
    await expect(launchInstaller("setup.exe", { openPath: async () => "Access denied", quit })).rejects.toThrow(/Access denied/);
    await expect(launchInstaller("setup.exe", { openPath: async () => { throw new Error("cancelled"); }, quit })).rejects.toThrow(/cancelled/);
    expect(quit).not.toHaveBeenCalled();
  });

  it("packages the downloader used by the real desktop process", () => {
    const builder = JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "electron-builder.kraken.json"), "utf8"));
    expect(builder.files).toContain("electron/update-core.cjs");
  });
});

describe("downloading the installer", () => {
  it("discards a truncated response even when it exceeds minimum size", async () => {
    const { dir, file } = await tmp();
    const partial = response([EXE]);
    const getHeader = partial.headers.get;
    partial.headers.get = name => name === "content-length" ? "1000" : getHeader(name);
    await expect(downloadInstaller("https://example.test/a.exe", file, { fetchImpl: async () => partial, minimumBytes: 100 })).rejects.toThrow(/incomplete/);
    expect(await stat(file).catch(() => null)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("verifies the GitHub checksum before running downloaded bytes", async () => {
    const { dir, file } = await tmp();
    await expect(downloadInstaller("https://example.test/a.exe", file, { fetchImpl: async () => response([EXE]), minimumBytes: 100, sha256: "0".repeat(64) })).rejects.toThrow(/checksum/);
    expect(await stat(file).catch(() => null)).toBeNull();
    const sha256 = require("node:crypto").createHash("sha256").update(EXE).digest("hex");
    await expect(downloadInstaller("https://example.test/a.exe", file, { fetchImpl: async () => response([EXE]), minimumBytes: 100, sha256 })).resolves.toMatchObject({ bytes: EXE.length });
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a Windows program and reports real progress", async () => {
    const { dir, file } = await tmp();
    const progress: { percent: number }[] = [];
    const result = await downloadInstaller("https://example.test/Calvras-Setup-10.0.4.exe", file, {
      fetchImpl: async () => response([EXE.subarray(0, 200), EXE.subarray(200)]),
      onProgress: (event: { percent: number }) => progress.push(event),
      minimumBytes: 100,
    });
    expect(result.bytes).toBe(EXE.length);
    expect((await stat(file)).size).toBe(EXE.length);
    expect((await readFile(file)).subarray(0, 2).toString("latin1")).toBe("MZ");
    expect(progress.at(-1)?.percent).toBe(100);
    expect(progress.length).toBeGreaterThan(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("streams a web response body, not only a node one", async () => {
    const { dir, file } = await tmp();
    const result = await downloadInstaller("https://example.test/a.exe", file, { fetchImpl: async () => response([EXE], { stream: true }), minimumBytes: 100 });
    expect(result.bytes).toBe(EXE.length);
    await rm(dir, { recursive: true, force: true });
  });

  it("deletes a response that is a web page instead of a build", async () => {
    const { dir, file } = await tmp();
    await expect(downloadInstaller("https://example.test/login", file, { fetchImpl: async () => response([Buffer.from("<html>sign in to GitHub to download</html>".repeat(40))], { type: "text/html; charset=utf-8" }) }))
      .rejects.toThrow(/not published yet/);
    expect(await stat(file).catch(() => null)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("deletes bytes that are not a Windows program", async () => {
    const { dir, file } = await tmp();
    await expect(downloadInstaller("https://example.test/a.exe", file, { fetchImpl: async () => response([Buffer.from("GIF89a".padEnd(400, "z"))]), minimumBytes: 100 }))
      .rejects.toThrow(/not a Windows installer/);
    expect(await stat(file).catch(() => null)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("discards a download that stops short of a real installer", async () => {
    const { dir, file } = await tmp();
    await expect(downloadInstaller("https://example.test/a.exe", file, { fetchImpl: async () => response([EXE]) }))
      .rejects.toThrow(/stopped after \d+ bytes/);
    expect(await stat(file).catch(() => null)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("fails on a download that answers with an error", async () => {
    const { dir, file } = await tmp();
    await expect(downloadInstaller("https://example.test/gone.exe", file, { fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, body: null }) }))
      .rejects.toThrow(/answered 404/);
    await rm(dir, { recursive: true, force: true });
  });
});
