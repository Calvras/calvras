// Nitro writes its Cloudflare config inside .output/server, but `wrangler deploy` run from the
// repository root only looks for wrangler.json|jsonc|toml next to itself. Without one it tries to
// auto-configure the project by injecting a Vite plugin, which fails on the Lovable wrapper config.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const generated = resolve(root, ".output/server/wrangler.json");
// Recorded by `node scripts/link-d1.mjs <database_id>` once the account ledger database exists on
// the Cloudflare account. It is not committed, because a placeholder id would deploy a Worker with
// its ledger bound to a database that does not exist.
const ledger = resolve(root, "d1.json");
// The binding also lives in the committed wrangler.json, because d1.json is gitignored and the hosted
// build has never had one: reading it only from the local file meant every deploy from the pipeline
// uploaded a Worker with no ledger attached, and the owner console answered 503 forever.
const committed = existsSync(resolve(root, "wrangler.json")) ? JSON.parse(readFileSync(resolve(root, "wrangler.json"), "utf8")) : {};

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
  // The console's analyst runs on a free model, and the free ones come and go with upstream limits,
  // so the one that answers today is written here rather than left to the code's default. The key
  // itself is a Cloudflare secret; only this name is public config.
  vars: { CALVRAS_AI_MODEL: "minimax/minimax-m3.1-flash:free" },
};

if (existsSync(ledger)) {
  const { database_id: databaseId } = JSON.parse(readFileSync(ledger, "utf8"));
  if (databaseId) {
    config.d1_databases = [{ binding: "CALVRAS_DB", database_name: "calvras-ledger", database_id: String(databaseId), migrations_dir: "migrations" }];
  }
} else if (Array.isArray(committed.d1_databases) && committed.d1_databases.length) {
  config.d1_databases = committed.d1_databases;
}

delete config.custom_domains;

writeFileSync(resolve(root, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `wrangler.json → ${config.name} · main ${config.main} · assets ${config.assets.directory} · routes ${(config.routes ?? []).map((r) => r.pattern).join(", ") || "workers.dev"} · ledger ${config.d1_databases ? "bound" : "not bound"}`,
);
