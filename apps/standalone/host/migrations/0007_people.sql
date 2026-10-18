-- People and counterparties (spec §4.3). Operators sign in on stations with a
-- PIN or a badge; the office computes both hashes with `@markiro/domain`, so
-- the host stores PBKDF2 PHC strings and never sees a PIN or a badge code.
-- Counterparties are the customers of contract manufacturing; they are not in
-- the station feed.
CREATE TABLE counterparties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  inn TEXT CHECK (inn IS NULL OR (length(inn) IN (10, 12) AND inn NOT GLOB '*[^0-9]*')),
  gln TEXT NOT NULL CHECK (length(gln) = 13 AND gln NOT GLOB '*[^0-9]*'),
  gs1_prefixes TEXT NOT NULL CHECK (json_valid(gs1_prefixes) AND json_type(gs1_prefixes) = 'array'),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  rev INTEGER NOT NULL
);

-- An operator is in the station feed only while active: a deactivation writes
-- a tombstone, a reactivation drops it and sends the record again (`feed`).
-- `login` is the personnel number typed on the station keypad.
CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE CHECK (length(login) BETWEEN 3 AND 12 AND login NOT GLOB '*[^0-9]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  role TEXT CHECK (role IS NULL OR length(trim(role)) BETWEEN 1 AND 120),
  pin_phc TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  rev INTEGER NOT NULL
);
CREATE INDEX operators_rev ON operators (rev);

-- A badge is hashed with the site's badge salt, so one badge code always gives
-- one string and the partial unique index keeps it on one operator. A badge is
-- in the station feed only while not revoked: a revocation writes a tombstone,
-- and a revoked badge never comes back (a new badge gets a new id).
CREATE TABLE operator_badges (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators (id),
  badge_phc TEXT NOT NULL,
  label TEXT CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX operator_badges_active_phc ON operator_badges (badge_phc) WHERE revoked_at IS NULL;
CREATE INDEX operator_badges_operator ON operator_badges (operator_id);
CREATE INDEX operator_badges_rev ON operator_badges (rev);
