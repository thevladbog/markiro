-- The print policy of a validation shift and the trace of its unit labels
-- (plan РЕЖ, part B; pilot spec §32). A validation shift may print the Data
-- Matrix duplicate of each accepted unit, with the verification of the
-- printed label required or not; the policy is the cloud's pair (`mode` and
-- `validationPrint`) and is frozen in the shift's snapshot when a station
-- opens it. A station sends each event of a label job as a `unit_label`
-- fact; the host keeps them in `unit_label_events`. As in `0010`, every
-- value is checked before it is written; the CHECKs hold what no row may
-- break.

-- The policy. `validation_print_template_id` has no foreign key, as
-- `box_template_id` (`0009`): once the shift is open the layout lives in its
-- snapshot, so a closed shift never holds its template back, and a template
-- a planned shift names is never deleted nor switched off
-- (`template_in_use`).
ALTER TABLE shifts ADD COLUMN validation_print_mode TEXT NOT NULL DEFAULT 'none'
  CHECK (validation_print_mode IN ('none', 'duplicate_dm'));
ALTER TABLE shifts ADD COLUMN validation_print_verification TEXT
  CHECK (validation_print_verification IS NULL
    OR validation_print_verification IN ('none', 'required'));
ALTER TABLE shifts ADD COLUMN validation_print_template_id TEXT;

-- The cloud's `shifts_validation_print_policy_check`: no policy names a
-- verification or a template; a duplicate is printed only in a validation
-- shift and names both. `0009` takes no CHECK across columns without a
-- rebuild, so two triggers hold the rule (as in `0012`); with the column
-- CHECK keeping the print mode to its two words, their three conditions are
-- the cloud's CHECK, and a word of neither is left to that column CHECK.
-- Every shift written before (and every write that names no policy) has
-- none.
CREATE TRIGGER shifts_validation_print_insert BEFORE INSERT ON shifts
WHEN (NEW.validation_print_mode = 'duplicate_dm') <> (NEW.validation_print_verification IS NOT NULL)
  OR (NEW.validation_print_mode = 'duplicate_dm') <> (NEW.validation_print_template_id IS NOT NULL)
  OR (NEW.validation_print_mode = 'duplicate_dm' AND NEW.mode <> 'validation')
BEGIN
  SELECT RAISE(ABORT, 'shift validation print: duplicate_dm only in a validation shift, with its verification and template');
END;
CREATE TRIGGER shifts_validation_print_update
BEFORE UPDATE OF mode, validation_print_mode, validation_print_verification,
  validation_print_template_id ON shifts
WHEN (NEW.validation_print_mode = 'duplicate_dm') <> (NEW.validation_print_verification IS NOT NULL)
  OR (NEW.validation_print_mode = 'duplicate_dm') <> (NEW.validation_print_template_id IS NOT NULL)
  OR (NEW.validation_print_mode = 'duplicate_dm' AND NEW.mode <> 'validation')
BEGIN
  SELECT RAISE(ABORT, 'shift validation print: duplicate_dm only in a validation shift, with its verification and template');
END;

-- A shift's mode and policy change only while it is planned and has no
-- scan (the owner's rule: the mode does not change once the shift is open).
-- An open or closed shift has them in its snapshot, and `0020`'s box rule
-- (`scans_ok_box_by_mode`) reads the mode of the shift whose scans it
-- already took. The host refuses such an edit first (`conflict` on
-- `shift_status`); the office's edit writes every field, so a write of the
-- same value is no change. `scans_shift` finds a shift's scans.
CREATE TRIGGER shifts_mode_frozen
BEFORE UPDATE OF mode, validation_print_mode, validation_print_verification,
  validation_print_template_id ON shifts
WHEN (NEW.mode IS NOT OLD.mode
    OR NEW.validation_print_mode IS NOT OLD.validation_print_mode
    OR NEW.validation_print_verification IS NOT OLD.validation_print_verification
    OR NEW.validation_print_template_id IS NOT OLD.validation_print_template_id)
  AND (OLD.status <> 'planned' OR EXISTS (SELECT 1 FROM scans WHERE shift_id = OLD.id))
BEGIN
  SELECT RAISE(ABORT, 'shift mode and print policy: frozen once open or scanned');
END;

-- A planned shift prints its duplicates with this template once a station
-- opens it (`template_in_use`, beside `shifts_planned_box_template` and
-- `shifts_planned_pallet_template`); most shifts name none.
CREATE INDEX shifts_planned_duplicate_template ON shifts (validation_print_template_id)
  WHERE status = 'planned' AND validation_print_template_id IS NOT NULL;

-- One event of a unit label job (`markiro_proto::UnitLabelFact`), as the
-- station sent it: the job belongs to the shift the station entered and to
-- the accepted scan of `code_hash` there. The full code never reaches the
-- host: `code_hash` (the code without its crypto tail) and the digests of
-- the printed text and of the printer's bytes, each a SHA-256 in lowercase
-- hex. A reprint's reason is on the `prepared` event of a later attempt and
-- nowhere else; an error code is on the events that have one, from that
-- event's list (the domain's `errorCode` of `failed_before_send` and
-- `delivery_unknown`, its rejection `reason` of `verification_rejected`;
-- `UNIT_LABEL_ERROR_CODES` in `protocol.ts`). A job's events are not unique
-- per kind: a printed label may be rejected more than once. `id` is the
-- host's, `record_id` the station's record (one row per record of a
-- station, as `pallet_exceptions`).
CREATE TABLE unit_label_events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  operator_id TEXT,
  job_id TEXT NOT NULL,
  code_hash TEXT NOT NULL
    CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  event TEXT NOT NULL CHECK (event IN ('prepared', 'sending', 'sent', 'failed_before_send',
    'delivery_unknown', 'verified', 'verification_rejected', 'verification_skipped')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('not_printed', 'damaged', 'lost')),
  error_code TEXT,
  payload_digest TEXT NOT NULL
    CHECK (length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  bytes_digest TEXT NOT NULL
    CHECK (length(bytes_digest) = 64 AND bytes_digest NOT GLOB '*[^0-9a-f]*'),
  at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((reason IS NOT NULL) = (event = 'prepared' AND attempt_no > 1)),
  CHECK (CASE event
    WHEN 'failed_before_send'
      THEN error_code IS NOT NULL AND error_code IN ('printer_unconfigured', 'printer_changed')
    WHEN 'delivery_unknown' THEN error_code IS NOT NULL
      AND error_code IN ('transport_failed', 'persistence_failed', 'interrupted')
    WHEN 'verification_rejected'
      THEN error_code IS NOT NULL AND error_code IN ('invalid', 'mismatch')
    ELSE error_code IS NULL END)
);
CREATE UNIQUE INDEX unit_label_events_record ON unit_label_events (device_id, record_id);
-- A shift's events by job: the counts of its card, a job's history.
CREATE INDEX unit_label_events_shift ON unit_label_events (shift_id, job_id);
