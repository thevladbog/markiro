-- The station's own production records (stage 2a spec §5.3, plan 2a5): the
-- copies of its line's shifts with the snapshot of each shift it entered, the
-- SSCC blocks the host issued to it and the requests for them, its boxes, the
-- codes it accepted, every scan, the box exceptions and the outbox of facts
-- for the host. Unlike the reference copies these are this device's data: a
-- forget keeps them (`TableClass::DeviceData` in `src-tauri/src/local_db.rs`),
-- and every row carries the pairing it was written under (`host_id`,
-- `device_id`), so the floor reads only the current pairing's rows and a
-- forget with unsent records leaves them on disk for support.
--
-- No foreign keys: a key between tables of different classes would make a
-- forget fail or, with `ON DELETE CASCADE`, silently change kept rows. The
-- writers keep the links (one `local_transaction` per fact and its outbox
-- record). Times are UTC RFC 3339 text as `Date.toISOString` writes it,
-- except `seen_at` (Unix milliseconds on this computer's clock); a production
-- date is a civil date `YYYY-MM-DD`. `kind` of the outbox has no CHECK on
-- purpose: the pallets of the pilot add kinds, and a SQLite CHECK changes
-- only by rebuilding its table. A single-column `TEXT PRIMARY KEY` would take
-- NULL in SQLite (a legacy quirk of rowid tables), so those keys say NOT NULL.
--
-- JSON columns (`snapshot`, `payload`, `outcome_details`) hold an object, never
-- another kind of JSON: `json_valid(x) AND json_type(x) = 'object'`, with
-- `json_valid` first so that malformed text is a plain constraint failure.
--
-- Indexes: besides the keys, each one serves a read the floor repeats on every
-- scan or box close (plan 2a6), so that the cost does not grow with the
-- history the station keeps (acknowledged facts stay for 30 days, codes and
-- boxes have no retention at all): `outbox_settled` (the status bar's counts
-- of rejected and conflicting records), `floor_codes_box` (the digest of a
-- box being closed), `floor_codes_shift` and `floor_boxes_shift` (the totals
-- of the work screen). The status bar counts the outbox as three separate
-- counts: one `count(*) FILTER (…)` reads every row, payload included.
-- `outbox_settled` is partial on purpose: a plain
-- `(host_id, device_id, outcome)` index would attract the unsent count too,
-- which is cheaper on `outbox_unsent`.

-- What the host lists in `GET /v1/device/shifts` (`DeviceShift`), as the last
-- read saw it, plus what this station keeps of a shift it entered: the
-- snapshot from the answer to `POST …/enter` (the frozen product, layout and
-- issuer prefix; JSON text) and when it first entered. A read replaces the
-- host's fields and never the station's own; `local_state` is this station's
-- close (plan 2a8), which overrides a stale `active` from the host.
CREATE TABLE floor_shifts (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  id TEXT NOT NULL,
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
  mode TEXT NOT NULL,
  pallets_enabled INTEGER NOT NULL CHECK (pallets_enabled IN (0, 1)),
  created_from TEXT NOT NULL CHECK (created_from IN ('office', 'station')),
  line_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_gtin14 TEXT NOT NULL,
  counterparty_name TEXT,
  production_date TEXT NOT NULL,
  planned_qty INTEGER CHECK (planned_qty IS NULL OR planned_qty > 0),
  box_capacity INTEGER NOT NULL CHECK (box_capacity > 0),
  box_template_id TEXT NOT NULL,
  owner_device_id TEXT,
  opened_at TEXT,
  closed_at TEXT,
  snapshot TEXT CHECK (snapshot IS NULL OR (json_valid(snapshot) AND json_type(snapshot) = 'object')),
  entered_at TEXT,
  local_state TEXT CHECK (local_state IN ('closing', 'closed')),
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, device_id, id),
  -- A snapshot is kept exactly for a shift this station entered.
  CHECK ((snapshot IS NULL) = (entered_at IS NULL)),
  -- Only a shift it entered can this station close.
  CHECK (local_state IS NULL OR entered_at IS NOT NULL)
);

CREATE INDEX floor_shifts_line ON floor_shifts (host_id, device_id, line_id);

-- The SSCC serials the host issued to this station (`SsccBlock`):
-- `next_serial` is the next one to use, moved by a compare-and-set in the
-- transaction that closes a box; `to_serial + 1` means the block is used up.
CREATE TABLE floor_sscc_blocks (
  block_id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  from_serial INTEGER NOT NULL CHECK (from_serial >= 0),
  to_serial INTEGER NOT NULL,
  next_serial INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  CHECK (to_serial >= from_serial),
  CHECK (next_serial BETWEEN from_serial AND to_serial + 1)
);

CREATE INDEX floor_sscc_blocks_prefix
  ON floor_sscc_blocks (host_id, device_id, issuer_prefix, extension);

-- A block request without an answer yet: written before the request and
-- deleted in the transaction that keeps the block, so a retry after a failure
-- or a restart repeats the same request (`requestId`), whole.
CREATE TABLE floor_block_requests (
  request_id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  requested_at TEXT NOT NULL
);

-- A box of a shift: open (no SSCC) until it closes with the serial of one of
-- this station's blocks. An SSCC is never on two boxes, under any pairing: a
-- second box with a printed number is a duplicate label.
CREATE TABLE floor_boxes (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT,
  serial INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  closed_by TEXT,
  disassembled_at TEXT,
  needs_fix INTEGER NOT NULL DEFAULT 0 CHECK (needs_fix IN (0, 1)),
  CHECK (CASE WHEN closed_at IS NULL
    THEN sscc IS NULL AND block_id IS NULL AND serial IS NULL AND disassembled_at IS NULL
    ELSE sscc IS NOT NULL AND block_id IS NOT NULL AND serial IS NOT NULL END)
);

CREATE UNIQUE INDEX floor_boxes_sscc ON floor_boxes (sscc) WHERE sscc IS NOT NULL;

-- One open box per shift.
CREATE UNIQUE INDEX floor_boxes_open
  ON floor_boxes (host_id, device_id, shift_id) WHERE closed_at IS NULL;

-- The closed boxes of a shift and the last SSCC (the work screen's totals).
CREATE INDEX floor_boxes_shift ON floor_boxes (host_id, device_id, shift_id, closed_at);

-- The codes this station accepted and still holds in a box: its own check for
-- duplicates (`kmHash`), within the pairing. An exception that takes a code
-- out of a box deletes its row.
CREATE TABLE floor_codes (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (host_id, device_id, code_hash)
);

-- The codes of a box (the digest when it closes; the delete of an exception)
-- and the accepted count of a shift.
CREATE INDEX floor_codes_box ON floor_codes (host_id, device_id, box_id, code_hash);
CREATE INDEX floor_codes_shift ON floor_codes (host_id, device_id, shift_id);

-- Every scan of the work screen, accepted or not (a `scan` fact). A scan that
-- is no code of marking keeps only its length and what it looked like, never
-- its text: it may be a badge, whose code is a secret (decision 15).
CREATE TABLE floor_scans (
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
  CHECK ((verdict = 'ok') = (box_id IS NOT NULL)),
  CHECK (CASE WHEN raw_kind = 'km'
    THEN code_hash IS NOT NULL AND gtin14 IS NOT NULL AND serial IS NOT NULL
      AND canonical IS NOT NULL
    ELSE code_hash IS NULL AND gtin14 IS NULL AND serial IS NULL AND canonical IS NULL END)
);

CREATE INDEX floor_scans_shift ON floor_scans (host_id, device_id, shift_id);

-- A box exception (a `box_exception` fact) with the fields of its kind, as the
-- host's rules have them: `undo` names the code and its scan's time, `clear`
-- nothing, `reprint` and `disassemble` a reason, whose words come only with
-- the reason `other`.
CREATE TABLE floor_exceptions (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('undo', 'clear', 'reprint', 'disassemble')),
  box_id TEXT NOT NULL,
  code_hash TEXT,
  target_scanned_at TEXT,
  reason_code TEXT,
  reason_text TEXT,
  occurred_at TEXT NOT NULL,
  operator_id TEXT,
  CHECK (CASE kind
    WHEN 'undo' THEN code_hash IS NOT NULL AND target_scanned_at IS NOT NULL
      AND reason_code IS NULL
    WHEN 'clear' THEN code_hash IS NULL AND target_scanned_at IS NULL AND reason_code IS NULL
    ELSE code_hash IS NULL AND target_scanned_at IS NULL AND reason_code IS NOT NULL END),
  CHECK (reason_text IS NULL OR reason_code = 'other')
);

-- The facts for the host, in the order they happened (`seq`): `payload` is the
-- whole `FactRecord` as it is sent (`{ id, kind, shiftId, operatorId, data }`),
-- written in the transaction of the fact itself. A record without a receipt
-- (`acked_at IS NULL`) is unsent, and a forget refuses while this pairing has
-- one (`device_forget`, `unsent_facts`). `seq` is a plain rowid alias, not
-- AUTOINCREMENT, which would add the unclassified table `sqlite_sequence`.
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at TEXT,
  outcome TEXT CHECK (outcome IN ('accepted', 'conflict', 'rejected')),
  outcome_code TEXT,
  outcome_details TEXT CHECK (
    outcome_details IS NULL OR (json_valid(outcome_details) AND json_type(outcome_details) = 'object')
  ),
  acked_at TEXT,
  CHECK ((outcome IS NULL) = (acked_at IS NULL)),
  CHECK (outcome IS NOT NULL OR (outcome_code IS NULL AND outcome_details IS NULL))
);

CREATE INDEX outbox_unsent ON outbox (host_id, device_id, seq) WHERE acked_at IS NULL;

-- The records the host settled with a verdict that needs a person's eye: the
-- status bar counts `rejected` and `conflict`.
CREATE INDEX outbox_settled ON outbox (host_id, device_id, outcome) WHERE outcome IS NOT NULL;
