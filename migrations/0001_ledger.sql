-- The account ledger behind calvras.com/api/site and the /admin-calvras console.
-- Generated content must equal LEDGER_SCHEMA in src/lib/runtime/ledger.ts; src/test/ledger.test.ts guards it.

CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  plan_set_by TEXT NOT NULL DEFAULT '',
  plan_set_at INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  signins INTEGER NOT NULL DEFAULT 1,
  platform TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_email_idx ON events (email, at DESC);
