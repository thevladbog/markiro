-- The unit labels of a validation shift that prints the Data Matrix
-- duplicate (plan РЕЖ part B, pilot spec §32): one row per job, the label of
-- one accepted unit. The row holds the job's current attempt, as the
-- domain's projection does (`ProductLabelProjection`,
-- `packages/domain/src/product-labels/state.ts`): a reprint is a new attempt
-- of the same job with the same bytes, so it moves the row on
-- (`attempt_no` + 1, a reason, `prepared` again) rather than adding one.
-- Each event of every attempt goes to the host as a `unit_label` fact in the
-- outbox, which is the attempts' history; «История этикеток» lists the jobs
-- with their attempt number and reason, as the cloud's history does.
--
-- This device's data (`TableClass::DeviceData`): every row carries the
-- pairing it was written under, a forget keeps it, and the retention deletes
-- it with its shift (`RETAINED_TABLES`, `src/local/retention.ts`). The job is
-- written in the transaction that accepts its unit (`floor_scans`,
-- `floor_codes`, the outbox's `scan` and `unit_label` `prepared`), with the
-- label's bytes already rendered for the duplicate printer: the domain's
-- `prepared` event carries their digest and the printer's resolution. A unit
-- is not accepted at all — refused before that transaction, as the cloud
-- answers `error: "printer"` — while no duplicate printer is assigned or the
-- label cannot be rendered, so the bytes exist from `prepared` on.
--
-- The bytes are rendered for one print identity, kept in `print_mode`,
-- `language` and `dpi` (the domain's `ProductLabelPrintIdentity` and `dpi`):
-- `raw` with the printer's language, or `windows_driver`, the
-- `mono-raster-v1` page of the Windows driver (plan ДРВ), which has no
-- language. A send reads the printer assigned to the duplicate at that
-- moment and compares it with them, as the cloud does: no printer is
-- `failed_before_send` with `printer_unconfigured` (one may be removed
-- between the preparation and the send), another way of printing or
-- resolution `printer_changed`. The job keeps no copy of the printer
-- profile: where a label goes is never the job's, only what its bytes are.
-- A job whose label can never be printed (no printer of its identity comes
-- back) stays in attention and keeps its shift from the retention, as the
-- cloud's does (an owner question). The trigger `floor_unit_labels_fixed`
-- keeps a job's origin, its print identity and its bytes for good: a reprint
-- sends the same bytes (the domain refuses a `prepared` with other bytes,
-- another format or another dpi), and the station's step (`MOVE_JOB_SQL`)
-- writes none of them. A job's attempt walks
--
--   prepared -> sending -> sent
--                       -> delivery_unknown (a label may exist: never sent
--                                            again without the operator)
--   prepared -> failed_before_send          (nothing left this computer)
--   sent | failed_before_send | delivery_unknown -> prepared (a reprint)
--
-- and its check: `not_required` (the shift asks none) or `pending`, then
-- `verified` (after `sent` of a required check, or after `delivery_unknown`)
-- or `skipped` (only after `sent` of a required check). `sending` is written
-- before the bytes go to the shell, so a job found in `sending` after a
-- restart is `delivery_unknown` with `interrupted`. A job is unresolved
-- while it is not completed in the domain's words (`productLabelStatus`):
-- its check is pending, or it needs none and its attempt was not sent. A
-- station has at most one unresolved job whatever its shift, as the cloud
-- (`PRODUCT_LABEL_BUSY` across shifts; entering any shift opens it), and one
-- job per accepted unit (`scan_id`).
--
-- The full code never leaves `fields` (the label's fields as rendered, which
-- the check compares the scanned label with) and the bytes; `code_hash` is
-- the code without its crypto tail, `payload_digest` and `bytes_digest` the
-- SHA-256 of the printed text and of the printer's bytes, each in lowercase
-- hex as the fact carries them. The retention deletes the whole row.
-- `verification_policy` is the shift's frozen policy, kept on the job so
-- that its status reads without the shift's snapshot. No foreign keys (see
-- `0006`), and no CHECK of an id's shape: no table of the station checks one
-- (its ids are the app's own `crypto.randomUUID`). Times are UTC as
-- `Date.toISOString` writes them.

CREATE TABLE floor_unit_labels (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  code_hash TEXT NOT NULL
    CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  scan_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  attempt_state TEXT NOT NULL CHECK (attempt_state IN
    ('prepared', 'sending', 'sent', 'failed_before_send', 'delivery_unknown')),
  verification_policy TEXT NOT NULL CHECK (verification_policy IN ('none', 'required')),
  verification TEXT NOT NULL CHECK (verification IN
    ('not_required', 'pending', 'verified', 'skipped')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('not_printed', 'damaged', 'lost')),
  error_code TEXT,
  print_mode TEXT NOT NULL CHECK (print_mode IN ('raw', 'windows_driver')),
  language TEXT CHECK (language IS NULL OR language IN ('zpl', 'tspl')),
  dpi INTEGER NOT NULL CHECK (dpi IN (203, 300)),
  bytes_base64 TEXT NOT NULL CHECK (length(bytes_base64) > 0),
  bytes_digest TEXT NOT NULL
    CHECK (length(bytes_digest) = 64 AND bytes_digest NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL
    CHECK (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  template_id TEXT NOT NULL,
  template_rev INTEGER NOT NULL CHECK (template_rev >= 0),
  fields TEXT NOT NULL CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A language exactly for RAW bytes: the driver's page has none.
  CHECK ((language IS NULL) = (print_mode = 'windows_driver')),
  -- A reprint's reason, exactly on an attempt after the first.
  CHECK ((reason IS NOT NULL) = (attempt_no > 1)),
  -- An error code exactly in the two error states, from that state's list
  -- (the fact's `UNIT_LABEL_ERROR_CODES`).
  CHECK (CASE attempt_state
    WHEN 'failed_before_send'
      THEN error_code IS NOT NULL AND error_code IN ('printer_unconfigured', 'printer_changed')
    WHEN 'delivery_unknown' THEN error_code IS NOT NULL
      AND error_code IN ('transport_failed', 'persistence_failed', 'interrupted')
    ELSE error_code IS NULL END),
  -- The check follows the policy: none is never pending nor skipped, a
  -- required one is never `not_required`; a skip only after `sent`, a
  -- verification only after `delivery_unknown` or `sent` of a required check.
  CHECK (CASE verification
    WHEN 'not_required' THEN verification_policy = 'none'
    WHEN 'pending' THEN verification_policy = 'required'
    WHEN 'skipped' THEN verification_policy = 'required' AND attempt_state = 'sent'
    ELSE attempt_state = 'delivery_unknown'
      OR (attempt_state = 'sent' AND verification_policy = 'required') END)
);

-- At most one job of a pairing is unresolved, whatever its shift: the next
-- unit of a required check waits for it, and a station enters any shift on
-- it. Word for word `UNRESOLVED_UNIT_LABEL_SQL`
-- (`src/floor/unit-labels/unit-label-store.ts`), so its reads search this
-- index: the pairing's unresolved job, and the retention's «no unresolved job
-- of this shift» (one row at most to look at).
CREATE UNIQUE INDEX floor_unit_labels_unresolved
  ON floor_unit_labels (host_id, device_id)
  WHERE (verification = 'pending' OR (verification = 'not_required' AND attempt_state <> 'sent'));

-- One job per accepted unit of a pairing.
CREATE UNIQUE INDEX floor_unit_labels_scan ON floor_unit_labels (host_id, device_id, scan_id);

-- A shift's jobs: «История этикеток» newest first (by rowid, which the index
-- keeps in order within a shift), and the retention's delete by shift.
CREATE INDEX floor_unit_labels_shift ON floor_unit_labels (host_id, device_id, shift_id);

-- The recovery at start: the pairing's jobs left in `sending` (a handful at
-- most, none in a quiet start), without walking the pairing's every job.
CREATE INDEX floor_unit_labels_sending ON floor_unit_labels (host_id, device_id)
  WHERE attempt_state = 'sending';

-- A job's origin, its print identity and its bytes never change (see the
-- head of this file); a column written with its own value is no change.
CREATE TRIGGER floor_unit_labels_fixed
  BEFORE UPDATE OF id, host_id, device_id, shift_id, scan_id, code_hash, verification_policy,
    print_mode, language, dpi, bytes_base64, bytes_digest, payload_digest, template_id,
    template_rev, fields, created_at
  ON floor_unit_labels
  WHEN NEW.id IS NOT OLD.id OR NEW.host_id IS NOT OLD.host_id
    OR NEW.device_id IS NOT OLD.device_id OR NEW.shift_id IS NOT OLD.shift_id
    OR NEW.scan_id IS NOT OLD.scan_id OR NEW.code_hash IS NOT OLD.code_hash
    OR NEW.verification_policy IS NOT OLD.verification_policy
    OR NEW.print_mode IS NOT OLD.print_mode OR NEW.language IS NOT OLD.language
    OR NEW.dpi IS NOT OLD.dpi OR NEW.bytes_base64 IS NOT OLD.bytes_base64
    OR NEW.bytes_digest IS NOT OLD.bytes_digest OR NEW.payload_digest IS NOT OLD.payload_digest
    OR NEW.template_id IS NOT OLD.template_id OR NEW.template_rev IS NOT OLD.template_rev
    OR NEW.fields IS NOT OLD.fields OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'a unit label job keeps its origin, its print identity and its bytes');
END;
