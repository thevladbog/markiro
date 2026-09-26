-- Lines: created now so devices can reference them; the office screens for
-- lines arrive in plan 1d. `name_key` is the trimmed, Unicode-lowercased name
-- computed by the host (SQLite's lower() folds ASCII only).
CREATE TABLE lines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  name_key TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX lines_active_name_key ON lines (name_key) WHERE archived = 0;

-- Paired devices. Only the SHA-256 of the device key is stored.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('station', 'office', 'handheld')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  line_id TEXT REFERENCES lines (id),
  key_hash TEXT NOT NULL UNIQUE,
  app_version TEXT NOT NULL,
  protocol INTEGER NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

-- Audit trail (spec §4.9). `details` never holds secrets or hashes.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('office_user', 'device', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
  details TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(details) AND json_type(details) = 'object')
);
CREATE INDEX audit_log_at ON audit_log (at);
