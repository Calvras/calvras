/**
 * One place says what version of Calvras is published and where its Windows build is.
 * The desktop app reads this through https://calvras.com/update.json, so a push that changes it
 * is what makes an installed app offer an update — no GitHub token and no API access needed.
 */
export const REPO = "Calvras/calvras";

/** Must match package.json's version; a unit test fails the build if the two drift apart. */
export const RELEASE_VERSION = "10.0.5";

/** Override this only when a build is published somewhere other than the tag's GitHub release. */
export const RELEASE_INSTALLER = "";
export const RELEASE_PORTABLE = "";

export const UPDATE_FEED_PATH = "/update.json";
export const UPDATE_FEED_URL = `https://calvras.com${UPDATE_FEED_PATH}`;

export type ReleaseArtifacts = { version: string; tag: string; installer: string; portable: string; release: string };

export function releaseArtifacts(version: string): ReleaseArtifacts {
  const clean = version.replace(/^v/i, "").trim();
  const tag = `v${clean}`;
  return {
    version: clean,
    tag,
    installer: RELEASE_INSTALLER || `https://github.com/${REPO}/releases/download/${tag}/Calvras-Setup-${clean}.exe`,
    portable: RELEASE_PORTABLE || `https://github.com/${REPO}/releases/download/${tag}/Calvras-${clean}-win.zip`,
    release: `https://github.com/${REPO}/releases/tag/${tag}`,
  };
}

/** The published manifest: a version, its tag, and where its Windows build is. */
export function updateManifest() {
  return { ok: true as const, product: "Calvras", platform: "windows-x64", ...releaseArtifacts(RELEASE_VERSION) };
}
