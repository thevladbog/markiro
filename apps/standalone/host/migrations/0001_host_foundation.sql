-- Global revision counter of reference data. Every transaction that changes
-- a reference table bumps it and stamps the changed rows (plan 1c).
CREATE TABLE host_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL
);
INSERT INTO host_revision (id, rev) VALUES (1, 0);

-- Site-wide settings. `initialized_at` is set by the first-run wizard (plan 1b);
-- the badge salt is created there too.
CREATE TABLE site (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  badge_salt BLOB,
  box_block_size INTEGER NOT NULL DEFAULT 2000 CHECK (box_block_size > 0),
  pallet_block_size INTEGER NOT NULL DEFAULT 200 CHECK (pallet_block_size > 0),
  initialized_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0
);
INSERT INTO site (id) VALUES (1);
