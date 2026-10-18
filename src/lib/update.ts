import { UPDATE_FEED_URL } from "./release";
import { isNewerSemver } from "./version";

export type PublishedRelease = { version: string; tag: string; installer: string; portable: string; release: string };

export type UpdateCheck =
  | { state: "latest"; current: string }
  | { state: "available"; current: string; release: PublishedRelease }
  | { state: "unreachable"; current: string; error: string };

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * The feed is written by this repo but read by whatever version is already installed, so its shape
 * is checked instead of trusted. An app must never offer an update it cannot deliver.
 */
export function readRelease(payload: unknown): PublishedRelease {
  type Feed = { ok?: unknown; version?: unknown; tag?: unknown; installer?: unknown; portable?: unknown; release?: unknown };
  const data = payload as Feed | null;
  if (!data || data.ok !== true) throw new Error("The update feed did not report a published version.");
  const version = String(data.version ?? "").replace(/^v/i, "").trim();
  if (!VERSION_RE.test(version)) throw new Error(`The update feed published an unreadable version: ${version || "none"}`);
  const installer = String(data.installer ?? "");
  if (!/^https:\/\//i.test(installer)) throw new Error(`Calvras ${version} has no secure download link, so it cannot be installed.`);
  return {
    version,
    tag: String(data.tag ?? `v${version}`),
    installer,
    portable: String(data.portable ?? ""),
    release: String(data.release ?? ""),
  };
}

/** Reads calvras.com/update.json once and compares it to the version actually running here. */
export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch, url = UPDATE_FEED_URL): Promise<UpdateCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`The update feed answered ${response.status}.`);
    // Until the feed is actually deployed, calvras.com answers this path with the landing page.
    if (!(response.headers.get("content-type") || "").includes("json")) throw new Error("The published update feed is not readable yet, so Calvras stayed put.");
    const release = readRelease(await response.json());
    return isNewerSemver(release.version, current) ? { state: "available", current, release } : { state: "latest", current };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "The update feed took too long to answer." : error instanceof Error ? error.message : "The update feed could not be read.";
    return { state: "unreachable", current, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
