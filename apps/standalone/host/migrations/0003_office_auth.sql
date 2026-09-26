-- Office users (spec §4.3). Logins are ASCII and compared without case.
CREATE TABLE office_users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(login) BETWEEN 3 AND 64),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  role TEXT NOT NULL CHECK (role IN ('admin', 'technologist')),
  password_phc TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  rev INTEGER NOT NULL
);

-- Office sessions, bound to the device they were opened on. Only the SHA-256
-- of the token is stored. `expires_at` is the absolute limit; the idle limit
-- is computed from `last_seen_at`. Ended and expired sessions are deleted;
-- the audit log keeps the history of logins and logouts.
CREATE TABLE office_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES office_users (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX office_sessions_user ON office_sessions (user_id);
