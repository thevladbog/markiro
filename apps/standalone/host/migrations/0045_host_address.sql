-- The administrator's mark that the host's address stays (plan ТСД-П, task П4, spec 9.1): set by the
-- wizard's step or by the office, cleared by the office. NULL: not confirmed, and the office shows
-- its notice while an address is not static. In the database, not in `host.json`: the office reads
-- it live and an older build reads a database it has no column for.
ALTER TABLE site ADD COLUMN address_confirmed_at TEXT;
