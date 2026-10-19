-- Where each account last signed in from, as Cloudflare reported it: a city when the plan exposes one,
-- plus the two-letter country. The IP address itself is never stored.

ALTER TABLE accounts ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN country TEXT NOT NULL DEFAULT '';
