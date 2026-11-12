-- Per-account daily token budget. tokens_used counts input+output tokens consumed since
-- tokens_reset_at. When tokens_used >= daily_tokens the account is locked until
-- tokens_reset_at + 24h. daily_tokens = 0 means "use the server default".
ALTER TABLE accounts ADD COLUMN daily_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN tokens_reset_at INTEGER NOT NULL DEFAULT 0;