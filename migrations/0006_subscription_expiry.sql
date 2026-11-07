-- RevenueCat names what was bought, so the row keeps that product id, and it always says when the
-- paid time runs out. expires_at is 0 for a lifetime purchase and the moment access ends otherwise,
-- which is what lets a cancelled subscription keep working until the period the buyer paid for is over.

ALTER TABLE subscriptions ADD COLUMN product_id TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
