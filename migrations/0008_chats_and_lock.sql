-- Usage moves from raw tokens to chats per day (free 15, lite 2x, pro 4x), and hitting the limit
-- now locks the account for a random 3-10 days instead of a flat 24h reset. The drawn lock is stored
-- on the account so the countdown survives restarts and cannot be re-rolled by refreshing.
-- Tiers rename to free / lite / pro: the old pro becomes lite, the old ultra becomes pro.

ALTER TABLE accounts ADD COLUMN daily_chats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN chats_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN chats_reset_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN lock_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN lock_days INTEGER NOT NULL DEFAULT 0;

UPDATE accounts SET plan = 'lite' WHERE plan = 'pro';
UPDATE accounts SET plan = 'pro' WHERE plan = 'ultra';
UPDATE subscriptions SET plan = 'lite' WHERE plan = 'pro';
UPDATE subscriptions SET plan = 'pro' WHERE plan = 'ultra';

-- The token budget is replaced by chats; drop the columns nothing reads anymore.
ALTER TABLE accounts DROP COLUMN daily_tokens;
ALTER TABLE accounts DROP COLUMN tokens_used;
ALTER TABLE accounts DROP COLUMN tokens_reset_at;