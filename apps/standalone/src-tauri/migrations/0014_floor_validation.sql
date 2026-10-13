-- Validation shifts (plan РЕЖ, part A): a code a station accepts in a
-- validation shift goes into no box, so its row of `floor_codes` and its
-- accepted scan in `floor_scans` name none. SQLite drops neither a NOT NULL
-- nor a CHECK without rebuilding the table, so both tables are rebuilt the
-- usual way: a new table under another name, every row copied, the old one
-- dropped, the new one renamed into place (SQLite then records its name
-- quoted), and every index of `0006` created again with its own text. The
-- rest of each table is exactly as `0006` wrote it. Every row keeps its
-- rowid: «Снять последний код» takes a box's newest code by it
-- (`LAST_CODE_SQL`, `src/floor/exceptions/box-exceptions.ts`), and a copy
-- without it would renumber the rows past every deleted one.
--
-- `floor_codes.box_id` may be NULL; `floor_scans` keeps a box on an accepted
-- scan only, but an accepted scan may have none: `box_id IS NULL OR verdict =
-- 'ok'`. The rule "an aggregation shift's accepted scan is in a box" is the
-- station's own (`src/floor/work/scan-pipeline.ts`), as the other rules of a
-- shift's work are. Nothing refers to these tables: no foreign key (see
-- `0006`), no trigger, no view, and no later migration added an index to
-- them. Both stay `TableClass::DeviceData`.

CREATE TABLE floor_codes_rebuilt (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  box_id TEXT,
  scan_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (host_id, device_id, code_hash)
);
INSERT INTO floor_codes_rebuilt (rowid, host_id, device_id, code_hash, shift_id, box_id,
  scan_id, scanned_at)
SELECT rowid, host_id, device_id, code_hash, shift_id, box_id, scan_id, scanned_at
FROM floor_codes;
DROP TABLE floor_codes;
ALTER TABLE floor_codes_rebuilt RENAME TO floor_codes;
CREATE INDEX floor_codes_box ON floor_codes (host_id, device_id, box_id, code_hash);
CREATE INDEX floor_codes_shift ON floor_codes (host_id, device_id, shift_id);

CREATE TABLE floor_scans_rebuilt (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  box_id TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'duplicate', 'wrong_gtin', 'invalid')),
  duplicate_source TEXT CHECK (duplicate_source IN ('local', 'host')),
  raw_kind TEXT NOT NULL CHECK (raw_kind IN ('km', 'gtin', 'sscc', 'unknown')),
  raw_length INTEGER NOT NULL CHECK (raw_length >= 0),
  code_hash TEXT,
  gtin14 TEXT,
  serial TEXT,
  canonical TEXT,
  scanned_at TEXT NOT NULL,
  operator_id TEXT,
  conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
  CHECK ((verdict = 'duplicate') = (duplicate_source IS NOT NULL)),
  CHECK ((verdict = 'invalid') = (raw_kind <> 'km')),
  CHECK (box_id IS NULL OR verdict = 'ok'),
  CHECK (CASE WHEN raw_kind = 'km'
    THEN code_hash IS NOT NULL AND gtin14 IS NOT NULL AND serial IS NOT NULL
      AND canonical IS NOT NULL
    ELSE code_hash IS NULL AND gtin14 IS NULL AND serial IS NULL AND canonical IS NULL END)
);
INSERT INTO floor_scans_rebuilt (rowid, id, host_id, device_id, shift_id, box_id,
  verdict, duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical,
  scanned_at, operator_id, conflict)
SELECT rowid, id, host_id, device_id, shift_id, box_id, verdict, duplicate_source, raw_kind,
  raw_length, code_hash, gtin14, serial, canonical, scanned_at, operator_id, conflict
FROM floor_scans;
DROP TABLE floor_scans;
ALTER TABLE floor_scans_rebuilt RENAME TO floor_scans;
CREATE INDEX floor_scans_shift ON floor_scans (host_id, device_id, shift_id);
