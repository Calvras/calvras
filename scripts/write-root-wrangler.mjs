// Nitro writes its Cloudflare config inside .output/server, but `wrangler deploy` run from the
// repository root only looks for wrangler.json|jsonc|toml next to itself. Without one it tries to
// auto-configure the project by injecting a Vite plugin, which fails on the Lovable wrapper config.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const generated = resolve(root, ".output/server/wrangler.json");

if (!existsSync(generated)) {
  console.error(`write-root-wrangler: no ${generated} — run the build first.`);
  process.exit(1);
}

const nitro = JSON.parse(readFileSync(generated, "utf8"));
const config = {
  ...nitro,
  main: ".output/server/index.mjs",
  assets: { ...nitro.assets, directory: ".output/public" },
  name: "calvras",
  account_id: "6731a2cf3ac3e76d3f399f505a7e5c11",
  workers_dev: true,
  routes: [{ pattern: "calvras.com", custom_domain: true }],
  // Cloudflare's git build is configured with no build step, only `npx wrangler deploy`, so the
  // config has to trigger the build itself or it uploads an entry point that was never written.
  build: { command: "npm run build" },
};

delete config.custom_domains;

writeFileSync(resolve(root, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `wrangler.json → ${config.name} · main ${config.main} · assets ${config.assets.directory} · routes ${(config.routes ?? []).map((r) => r.pattern).join(", ") || "workers.dev"}`,
);
