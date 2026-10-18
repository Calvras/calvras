import { RELEASE_VERSION, UPDATE_FEED_URL, releaseArtifacts } from "./release";

const artifacts = releaseArtifacts(RELEASE_VERSION);

export const DOWNLOAD = {
  version: artifacts.version,
  platform: "Windows 10 / 11",
  architecture: "x64 (64-bit Intel or AMD)",
  installerSize: "135 MB",
  portableSize: "184 MB",
  installer: artifacts.installer,
  portable: artifacts.portable,
  release: artifacts.release,
  feed: UPDATE_FEED_URL,
};
