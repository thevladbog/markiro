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
-- `prepared` event carries their digest and the printer's resolution, and
-- the cloud prepares a label only on a configured printer. Its attempt walks
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
-- its check is pending, or it needs none and its attempt was not sent.
--
-- The full code never leaves `fields` (the label's fields as rendered, which
-- the check compares the scanned label with) and the bytes; `code_hash` is
-- the code without its crypto tail, `payload_digest` and `bytes_digest` the
-- SHA-256 of the printed text and of the printer's bytes, each in lowercase
-- hex as the fact carries them. The retention deletes the whole row.
-- `verification_policy` is the shift's frozen policy, kept on the job so
-- that its status reads without the shift's snapshot. No foreign keys (see
-- `0006`). Times are UTC as `Date.toISOString` writes them.

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
  printer TEXT NOT NULL CHECK (json_valid(printer) AND json_type(printer) = 'object'),
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

-- At most one job of a shift and pairing is unresolved: the next unit of a
-- required check waits for it, and a station enters the shift on it. Word
-- for word `UNRESOLVED_UNIT_LABEL_SQL` (`src/floor/unit-labels/unit-label-store.ts`),
-- so its reads search this index.
CREATE UNIQUE INDEX floor_unit_labels_unresolved
  ON floor_unit_labels (host_id, device_id, shift_id)
  WHERE (verification = 'pending' OR (verification = 'not_required' AND attempt_state <> 'sent'));

-- A shift's jobs: «История этикеток» newest first (by rowid, which the index
-- keeps in order within a shift), and the retention's delete by shift.
CREATE INDEX floor_unit_labels_shift ON floor_unit_labels (host_id, device_id, shift_id);

-- The recovery at start: the pairing's jobs left in `sending` (a handful at
-- most, none in a quiet start), without walking the pairing's every job.
CREATE INDEX floor_unit_labels_sending ON floor_unit_labels (host_id, device_id)
  WHERE attempt_state = 'sending';
