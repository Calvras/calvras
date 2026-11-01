// @vitest-environment node
// The bug this guards: sign-in worked on the machine that registered the OAuth apps and said
// "not configured on this computer yet" on every other laptop, because the only config source was
// that machine's %LOCALAPPDATA%\Calvras. Both sources are faked here; nothing touches the disk of
// the machine running the test.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type Reader = () => {
  googleOAuthConfig: () => { clientId: string | null; clientSecret: string | null };
  githubOAuthConfig: () => { clientId: string | null; clientSecret: string | null };
};

const { createOAuthConfigReader } = createRequire(import.meta.url)("../../electron/oauth-config.cjs") as {
  createOAuthConfigReader: (options: {
    fileSystem: { readFileSync: (file: string) => string };
    env: Record<string, string | undefined>;
    homeDir: string;
    baseDir: string;
  }) => ReturnType<Reader>;
};

/** A machine with `shipped` bundled at build time and `stored` in the per-user folder. */
const reader = ({ shipped = {}, stored = {}, configured = true }: { shipped?: Record<string, unknown>; stored?: Record<string, unknown>; configured?: boolean } = {}) => createOAuthConfigReader({
  env: { LOCALAPPDATA: "C:\\Users\\anyone\\AppData\\Local" },
  homeDir: "/home/anyone",
  baseDir: "/app/electron",
  fileSystem: {
    readFileSync: (file: string) => {
      if (file.endsWith("oauth-defaults.json")) {
        if (!Object.keys(shipped).length) throw new Error("ENOENT");
        return JSON.stringify(shipped);
      }
      if (!configured || !(file in stored)) throw new Error("ENOENT");
      return JSON.stringify((stored as Record<string, unknown>)[file]);
    },
  },
});

const BUNDLED = { google: { clientId: "google.apps", clientSecret: "google-secret" }, github: { clientId: "gh-oauth-app" } };

describe("sign-in config resolution", () => {
  it("signs in on a laptop that never configured anything", () => {
    // A stranger's machine: no Calvras folder at all, only what the installer shipped with.
    const config = reader({ shipped: BUNDLED });
    expect(config.googleOAuthConfig()).toEqual({ clientId: "google.apps", clientSecret: "google-secret" });
    // GitHub's desktop exchange needs its secret too; an install without one is still a config
    // error, so the bundled file has to carry both halves the same way the per-user file did.
    expect(config.githubOAuthConfig()).toEqual({ clientId: "gh-oauth-app", clientSecret: null });
  });

  it("still reads the per-user file when it exists, so a build can be repointed without a rebuild", () => {
    const config = reader({
      shipped: BUNDLED,
      stored: { "C:\\Users\\anyone\\AppData\\Local\\Calvras\\google-oauth.json": { clientId: "my-own.apps", clientSecret: "my-own-secret" } },
    });
    expect(config.googleOAuthConfig()).toEqual({ clientId: "my-own.apps", clientSecret: "my-own-secret" });
    expect(config.githubOAuthConfig()).toEqual({ clientId: "gh-oauth-app", clientSecret: null });
  });

  it("says nothing is configured when neither source has the provider", () => {
    // The old message stays reachable: an install built on a machine with no OAuth apps must not
    // invent a client id.
    expect(reader().googleOAuthConfig()).toEqual({ clientId: null, clientSecret: null });
  });

  it("prefers a broken bundled file over failing the sign-in outright", () => {
    const config = createOAuthConfigReader({
      env: { LOCALAPPDATA: "C:\\Users\\anyone\\AppData\\Local" },
      homeDir: "/home/anyone",
      baseDir: "/app/electron",
      fileSystem: {
        readFileSync: (file: string) => {
          if (file.endsWith("oauth-defaults.json")) return "{ not json";
          if (file.endsWith("google-oauth.json")) return JSON.stringify({ clientId: "mine.apps", clientSecret: "mine-secret" });
          throw new Error("ENOENT");
        },
      },
    });
    expect(config.googleOAuthConfig()).toEqual({ clientId: "mine.apps", clientSecret: "mine-secret" });
  });
});
