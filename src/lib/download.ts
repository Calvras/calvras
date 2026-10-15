const REPO = "SHIKARI-hey/Calvras";
const RELEASE_TAG = "v10.0.2";

// These are the fallback / current-build values.
// The website fetches the real latest release from GitHub at runtime.
export const DOWNLOAD = {
  version: "10.0.2",
  platform: "Windows 10 / 11",
  architecture: "x64 (64-bit Intel or AMD)",
  installerSize: "105 MB",
  portableSize: "145 MB",
  installer: `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/Calvras-Setup-win-x64.exe`,
  portable: `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/Calvras-10.0.2-win.zip`,
  release: `https://github.com/${REPO}/releases/tag/${RELEASE_TAG}`,
  releaseApi: `https://api.github.com/repos/${REPO}/releases/latest`,
};
