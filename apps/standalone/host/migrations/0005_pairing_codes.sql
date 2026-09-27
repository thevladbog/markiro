-- One-time pairing codes (spec §4.7). Only the SHA-256 of the normalized
-- code is stored. A code is live until it is used, expires (10 minutes) or
-- reaches 5 failed attempts; a claim with an unknown code counts against
-- every live code, because the hash cannot tell which one was meant.
CREATE TABLE pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES office_users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0)
);
CREATE INDEX pairing_codes_live ON pairing_codes (expires_at) WHERE used_at IS NULL;
