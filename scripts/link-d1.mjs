// Records which Cloudflare D1 database the account ledger lives in, so write-root-wrangler.mjs can
// bind it when it builds the deploy config. Run it with the id `wrangler d1 create` prints.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const ledger = resolve(root, "d1.json");
const databaseId = String(process.argv[2] || "").trim();

if (!databaseId) {
  const current = existsSync(ledger) ? String(JSON.parse(readFileSync(ledger, "utf8")).database_id || "") : "";
  console.log(current ? `${ledger} · ${current}` : `no ledger database linked — node scripts/link-d1.mjs <database_id>`);
  process.exit(0);
}

if (!/^[0-9a-f-]{16,64}$/i.test(databaseId)) {
  console.error(`link-d1: "${databaseId}" is not a D1 database id.`);
  process.exit(1);
}

const previous = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : {};
writeFileSync(ledger, `${JSON.stringify({ ...previous, database_id: databaseId }, null, 2)}\n`);
console.log(`linked ledger database ${databaseId} → ${ledger}`);
