-- Everywhere an account has signed in from, newest last and separated by semicolons. A person who
-- uses Calvras at home and at work shows both places in the owner's console instead of only whichever
-- city reported last. The IP address itself is never stored.

ALTER TABLE accounts ADD COLUMN places TEXT NOT NULL DEFAULT '';
