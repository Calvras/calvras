-- What RevenueCat says each buyer currently holds, kept so a plan survives the delivery that granted
-- it. The row id is RevenueCat's original transaction id, which is what makes a retried webhook
-- harmless: the same purchase lands on the same row instead of stacking up grants. Status is
-- RevenueCat's event mapped to our own word, and the account plan is re-derived from these rows after
-- every change.

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',
  price_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  customer_id TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS subscriptions_email_idx ON subscriptions (email, updated_at DESC);
