-- Validation shifts (plan РЕЖ, part A): an accepted scan of a validation
-- shift has no box, and neither has the owner of its code. SQLite drops
-- neither a CHECK nor a NOT NULL without rebuilding the table, so `scans`
-- and `code_owners` are rebuilt; the rule "an accepted scan of an
-- aggregation shift names its box" moves from the CHECK to two triggers
-- that read the shift's mode.
--
-- How, and why not `PRAGMA defer_foreign_keys`: sqlx runs every SQLite
-- migration inside one transaction (`-- no-transaction` is ignored), where
-- `PRAGMA foreign_keys` is a no-op, so the keys stay on. With the keys
-- deferred, `DROP TABLE scans` deletes its rows one by one, each child row
-- of `box_items`, `code_owners` and `code_conflicts` counts as a violation,
-- and renaming the new table to `scans` does not take the count back: the
-- commit fails. So no child of `scans` is left when it is dropped: their
-- rows wait in temporary copies, the children are dropped, `scans` is
-- rebuilt under its own name, and the children are created again
-- (`box_items` and `code_conflicts` exactly as in `0010`, `code_owners`
-- with a box that may be NULL) and refilled, each row's keys checked at
-- once against the new `scans`. Nothing else refers to these four tables
-- (no other foreign key, trigger or view). Every index of theirs from `0010`
-- and `0017` is created again with its own text. A last guard refuses the
-- migration if any of the four tables breaks a foreign key, so a
-- connection with the keys off cannot leave an orphan behind either.
--
-- Every row of the four tables keeps its rowid: it is copied by name, into
-- the temporary copies as `kept_rowid` and back. Nothing of the host reads a
-- rowid today, but a copy without it would renumber every row past a deleted
-- one, and the shell's own rebuild (`0014`) had to keep it: keeping it is the
-- rule of a rebuild.
--
-- The rule as triggers: on INSERT, and on an UPDATE of the verdict, the box
-- or the shift (the host never updates a scan: the journal only grows, but
-- the old CHECK held for every write, and so does the rule). A scan whose
-- shift is missing reads no mode, and `IS NOT` counts that as no
-- validation shift: the rule is not skipped where the foreign key is.

CREATE TEMP TABLE box_items_kept AS SELECT rowid AS kept_rowid, * FROM box_items;
CREATE TEMP TABLE code_owners_kept AS SELECT rowid AS kept_rowid, * FROM code_owners;
CREATE TEMP TABLE code_conflicts_kept AS SELECT rowid AS kept_rowid, * FROM code_conflicts;
DROP TABLE box_items;
DROP TABLE code_owners;
DROP TABLE code_conflicts;

CREATE TABLE scans_rebuilt (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'duplicate', 'wrong_gtin', 'invalid')),
  duplicate_source TEXT CHECK (duplicate_source IS NULL OR duplicate_source IN ('local', 'host')),
  raw_kind TEXT NOT NULL CHECK (raw_kind IN ('km', 'gtin', 'sscc', 'unknown')),
  raw_length INTEGER NOT NULL CHECK (raw_length >= 0),
  code_hash TEXT,
  gtin14 TEXT,
  serial TEXT,
  canonical TEXT,
  box_id TEXT REFERENCES boxes (id),
  operator_id TEXT,
  scanned_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((verdict = 'invalid') = (code_hash IS NULL)),
  CHECK (box_id IS NULL OR verdict = 'ok'),
  CHECK ((verdict = 'duplicate') = (duplicate_source IS NOT NULL)),
  CHECK ((verdict = 'invalid') = (raw_kind <> 'km')),
  CHECK ((code_hash IS NULL) = (gtin14 IS NULL) AND (code_hash IS NULL) = (serial IS NULL)
    AND (code_hash IS NULL) = (canonical IS NULL)),
  CHECK (code_hash IS NULL OR length(code_hash) = 64)
);
INSERT INTO scans_rebuilt (rowid, id, record_id, device_id, shift_id, verdict,
  duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id,
  operator_id, scanned_at, received_at)
SELECT rowid, id, record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, raw_length,
  code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at
FROM scans;
DROP TABLE scans;
ALTER TABLE scans_rebuilt RENAME TO scans;
CREATE UNIQUE INDEX scans_record ON scans (device_id, record_id);
CREATE INDEX scans_shift ON scans (shift_id);
CREATE INDEX scans_code_hash ON scans (code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX scans_ok_box ON scans (box_id) WHERE verdict = 'ok';
CREATE INDEX scans_ok_gtin ON scans (gtin14, scanned_at) WHERE verdict = 'ok';
CREATE INDEX scans_ok_scanned ON scans (scanned_at) WHERE verdict = 'ok';

CREATE TRIGGER scans_ok_box_by_mode BEFORE INSERT ON scans
WHEN NEW.verdict = 'ok' AND NEW.box_id IS NULL
  AND (SELECT mode FROM shifts WHERE id = NEW.shift_id) IS NOT 'validation'
BEGIN
  SELECT RAISE(ABORT, 'scan_needs_box');
END;
CREATE TRIGGER scans_ok_box_by_mode_update
BEFORE UPDATE OF verdict, box_id, shift_id ON scans
WHEN NEW.verdict = 'ok' AND NEW.box_id IS NULL
  AND (SELECT mode FROM shifts WHERE id = NEW.shift_id) IS NOT 'validation'
BEGIN
  SELECT RAISE(ABORT, 'scan_needs_box');
END;

CREATE TABLE box_items (
  scan_id TEXT PRIMARY KEY REFERENCES scans (id),
  box_id TEXT NOT NULL REFERENCES boxes (id),
  code_hash TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_at TEXT,
  displaced_at TEXT
);
INSERT INTO box_items (rowid, scan_id, box_id, code_hash, added_at, removed_at, displaced_at)
SELECT kept_rowid, scan_id, box_id, code_hash, added_at, removed_at, displaced_at
FROM temp.box_items_kept;
CREATE UNIQUE INDEX box_items_live ON box_items (box_id, code_hash)
  WHERE removed_at IS NULL AND displaced_at IS NULL;

CREATE TABLE code_owners (
  code_hash TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  box_id TEXT REFERENCES boxes (id),
  scanned_at TEXT NOT NULL
);
INSERT INTO code_owners (rowid, code_hash, scan_id, shift_id, device_id, box_id, scanned_at)
SELECT kept_rowid, code_hash, scan_id, shift_id, device_id, box_id, scanned_at
FROM temp.code_owners_kept;
-- The owners of a validation shift's codes, which no box lists.
CREATE INDEX code_owners_shift_unboxed ON code_owners (shift_id) WHERE box_id IS NULL;

CREATE TABLE code_conflicts (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  winner_scan_id TEXT NOT NULL REFERENCES scans (id),
  loser_scan_id TEXT NOT NULL REFERENCES scans (id),
  detected_at TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK (winner_scan_id <> loser_scan_id)
);
INSERT INTO code_conflicts (rowid, id, code_hash, winner_scan_id, loser_scan_id,
  detected_at, reviewed_at)
SELECT kept_rowid, id, code_hash, winner_scan_id, loser_scan_id, detected_at, reviewed_at
FROM temp.code_conflicts_kept;
CREATE INDEX code_conflicts_code ON code_conflicts (code_hash);

DROP TABLE temp.box_items_kept;
DROP TABLE temp.code_owners_kept;
DROP TABLE temp.code_conflicts_kept;

-- The guard: a count of violations above zero breaks its CHECK.
CREATE TEMP TABLE fk_guard (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO temp.fk_guard
SELECT (SELECT count(*) FROM pragma_foreign_key_check('scans'))
  + (SELECT count(*) FROM pragma_foreign_key_check('box_items'))
  + (SELECT count(*) FROM pragma_foreign_key_check('code_owners'))
  + (SELECT count(*) FROM pragma_foreign_key_check('code_conflicts'));
DROP TABLE temp.fk_guard;
