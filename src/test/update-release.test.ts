import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_VERSION, releaseArtifacts, updateManifest } from "../lib/release";
import { checkForUpdate, readRelease } from "../lib/update";
import { DOWNLOAD } from "../lib/download";

const require = createRequire(import.meta.url);
const { downloadInstaller } = require("../../electron/update-core.cjs") as {
  downloadInstaller: (url: string, destination: string, options?: Record<string, unknown>) => Promise<{ file: string; bytes: number }>;
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
    const pkg = JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(RELEASE_VERSION).toBe(pkg.version);
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

  it("builds artifact names the installer config produces", () => {
    const artifacts = releaseArtifacts("10.4.0");
    expect(artifacts.tag).toBe("v10.4.0");
    expect(artifacts.installer).toBe("https://github.com/Calvras/calvras/releases/download/v10.4.0/Calvras-Setup-10.4.0.exe");
    expect(artifacts.portable).toBe("https://github.com/Calvras/calvras/releases/download/v10.4.0/Calvras-10.4.0-win.zip");
    const builder = JSON.parse(require("node:fs").readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { build: { nsis: { artifactName: string }; win: { zip: { artifactName: string } } } };
    expect(builder.build.nsis.artifactName).toBe("Calvras-Setup-${version}.exe");
    expect(builder.build.win.zip.artifactName).toBe("Calvras-${version}-win.zip");
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

describe("downloading the installer", () => {
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
