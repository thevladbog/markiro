-- The station's copies of the host's reference records (stage 1 spec §5.3),
-- each with the host revision it last changed at. The webview's reference
-- sync writes the rows; `device_forget` empties every table
-- (`LocalDb::clear_copies`). Operators, badges, products and templates join
-- with plans 1d and 1e.
CREATE TABLE ref_org (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  inn TEXT,
  gln TEXT NOT NULL,
  -- JSON array of GS1 company prefixes.
  gs1_prefixes TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE TABLE ref_site (
  id TEXT PRIMARY KEY,
  -- Standard base64 with padding, exactly as the change feed carries it.
  badge_salt TEXT NOT NULL,
  box_block_size INTEGER NOT NULL,
  pallet_block_size INTEGER NOT NULL,
  rev INTEGER NOT NULL
);

CREATE TABLE ref_lines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  rev INTEGER NOT NULL
);

-- `last_rev`: the last fully applied feed revision; `host_id`: the host the
-- records came from.
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
