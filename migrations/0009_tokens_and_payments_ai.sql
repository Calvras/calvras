-- Usage is measured in tokens spent, not chats: the allowance columns keep their rows but say tokens.
ALTER TABLE accounts RENAME COLUMN daily_chats TO daily_tokens;
ALTER TABLE accounts RENAME COLUMN chats_used TO tokens_used;
ALTER TABLE accounts RENAME COLUMN chats_reset_at TO tokens_reset_at;
UPDATE accounts SET plan_set_by = 'payments-ai' WHERE plan_set_by = 'revenuecat';

-- Payments AI tells us a customer id; the buyer's email arrives on customer.created, which can land
-- after the payment it belongs to, so deliveries wait here until their customer is known.
CREATE TABLE IF NOT EXISTS pai_customers (
  customer_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pai_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pai_events_customer_idx ON pai_events (customer_id, processed);