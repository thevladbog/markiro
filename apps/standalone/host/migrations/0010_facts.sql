-- Facts (stage 2a spec §4.4–4.5): what a station sends from the line —
-- scans, closed boxes, label checks, box exceptions and a shift's close —
-- and the receipt the host answers for each record. Every value a device
-- sends is checked before it is written (`host/src/facts`), so no CHECK
-- here can refuse a record; they hold what no row may break. A device's
-- instants are kept as it wrote them (`YYYY-MM-DDTHH:MM:SS.sssZ`, so the
-- text orders them); the host's own (`received_at`, `detected_at`,
-- `displaced_at`) are in its usual format.

-- The receipt of every record that had a readable id, kept for good: a
-- record sent again with the same digest gets this receipt back, with
-- another digest `payload_mismatch`. `kind` is NULL for a record that could
-- not be read; `shift_id` names the shift once the device's entry in it was
-- found (no foreign key: a receipt never keeps a shift from being deleted).
CREATE TABLE fact_receipts (
  device_id TEXT NOT NULL REFERENCES devices (id),
  record_id TEXT NOT NULL,
  kind TEXT,
  shift_id TEXT,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'conflict', 'rejected')),
  code TEXT,
  details TEXT CHECK (details IS NULL OR (json_valid(details) AND json_type(details) = 'object')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id),
  CHECK ((outcome = 'rejected') = (code IS NOT NULL))
);
CREATE INDEX fact_receipts_shift ON fact_receipts (shift_id, received_at);

-- The journal of every scan of the work screen. An `invalid` scan keeps no
-- code (it may have been a badge); an `ok` one names its box.
CREATE TABLE scans (
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
  CHECK ((verdict = 'ok') = (box_id IS NOT NULL)),
  CHECK ((verdict = 'duplicate') = (duplicate_source IS NOT NULL)),
  CHECK ((verdict = 'invalid') = (raw_kind <> 'km')),
  CHECK ((code_hash IS NULL) = (gtin14 IS NULL) AND (code_hash IS NULL) = (serial IS NULL)
    AND (code_hash IS NULL) = (canonical IS NULL)),
  CHECK (code_hash IS NULL OR length(code_hash) = 64)
);
-- A record is one journal row: the same record is never applied twice.
CREATE UNIQUE INDEX scans_record ON scans (device_id, record_id);
CREATE INDEX scans_shift ON scans (shift_id);
CREATE INDEX scans_code_hash ON scans (code_hash) WHERE code_hash IS NOT NULL;

-- Boxes as the facts tell them: opened by the first accepted scan, closed
-- with an SSCC of a block issued to the device. A closed box keeps its SSCC
-- when it is taken apart.
CREATE TABLE boxes (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT REFERENCES sscc_blocks (id),
  serial INTEGER,
  item_count_reported INTEGER,
  membership_digest TEXT,
  digest_matches INTEGER CHECK (digest_matches IS NULL OR digest_matches IN (0, 1)),
  operator_id TEXT,
  print_verified_at TEXT,
  print_skipped_at TEXT,
  disassembled_at TEXT,
  received_at TEXT NOT NULL,
  CHECK ((closed_at IS NULL) = (sscc IS NULL)),
  CHECK ((closed_at IS NULL) = (block_id IS NULL)),
  CHECK ((closed_at IS NULL) = (serial IS NULL)),
  CHECK ((closed_at IS NULL) = (digest_matches IS NULL)),
  CHECK (disassembled_at IS NULL OR closed_at IS NOT NULL)
);
CREATE UNIQUE INDEX boxes_sscc ON boxes (sscc) WHERE sscc IS NOT NULL;
CREATE INDEX boxes_shift ON boxes (shift_id);

-- A box's items: one row per accepted scan that owned its code. An item
-- leaves its box when an exception removes it (`removed_at`) or an earlier
-- scan of the code elsewhere takes the code (`displaced_at`); a live code
-- is in a box once.
CREATE TABLE box_items (
  scan_id TEXT PRIMARY KEY REFERENCES scans (id),
  box_id TEXT NOT NULL REFERENCES boxes (id),
  code_hash TEXT NOT NULL,
  added_at TEXT NOT NULL,
  removed_at TEXT,
  displaced_at TEXT
);
CREATE UNIQUE INDEX box_items_live ON box_items (box_id, code_hash)
  WHERE removed_at IS NULL AND displaced_at IS NULL;

-- The registry of codes: the scan that owns each code now, the earliest
-- accepted scan of it that no exception removed.
CREATE TABLE code_owners (
  code_hash TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  box_id TEXT NOT NULL REFERENCES boxes (id),
  scanned_at TEXT NOT NULL
);

-- Two accepted scans of one code: the earlier won it. Their review in the
-- office comes with plan 2b.
CREATE TABLE code_conflicts (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  winner_scan_id TEXT NOT NULL REFERENCES scans (id),
  loser_scan_id TEXT NOT NULL REFERENCES scans (id),
  detected_at TEXT NOT NULL,
  reviewed_at TEXT,
  CHECK (winner_scan_id <> loser_scan_id)
);
CREATE INDEX code_conflicts_code ON code_conflicts (code_hash);

-- Box exceptions, with the fields of each kind as the cloud's
-- `box_exceptions_kind_payload_check`, and reason codes instead of text.
CREATE TABLE box_exceptions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('undo', 'clear', 'reprint', 'disassemble')),
  box_id TEXT NOT NULL REFERENCES boxes (id),
  code_hash TEXT,
  target_scanned_at TEXT,
  reason_code TEXT,
  reason_text TEXT,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  operator_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((kind = 'undo' AND code_hash IS NOT NULL AND target_scanned_at IS NOT NULL
      AND reason_code IS NULL)
    OR (kind = 'clear' AND code_hash IS NULL AND target_scanned_at IS NULL
      AND reason_code IS NULL)
    OR (kind IN ('reprint', 'disassemble') AND code_hash IS NULL
      AND target_scanned_at IS NULL AND reason_code IS NOT NULL)),
  CHECK (reason_text IS NULL OR reason_code IS 'other')
);
CREATE UNIQUE INDEX box_exceptions_record ON box_exceptions (device_id, record_id);
CREATE INDEX box_exceptions_box ON box_exceptions (box_id);

-- Every close a station sent, also of a shift the office had closed first
-- (`already_closed`).
CREATE TABLE shift_close_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  operator_id TEXT,
  planned_qty_snapshot INTEGER,
  actual_qty INTEGER NOT NULL CHECK (actual_qty >= 0),
  closed_box_count INTEGER NOT NULL CHECK (closed_box_count >= 0),
  reason_code TEXT,
  closed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'already_closed')),
  received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX shift_close_events_record ON shift_close_events (device_id, record_id);
CREATE INDEX shift_close_events_shift ON shift_close_events (shift_id);
