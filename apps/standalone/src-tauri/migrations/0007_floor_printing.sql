-- The station's printing (stage 2a spec §5.3 and §5.7.5, plan 2a7): the print
-- jobs of the labels it printed and this computer's workstation settings.
--
-- `floor_print_jobs` is this device's data (`TableClass::DeviceData`): every
-- row carries the pairing it was written under, and a forget keeps it. A job
-- is written in the transaction that closes its box, with the label's bytes
-- (base64 text: `local_query` reads no BLOB) and the snapshot of the printer
-- profile they were rendered for, and then walks:
--
--   prepared -> sending -> sent [-> verified | skipped]
--                       -> failed  (nothing left this computer)
--                       -> unknown (a label may exist: never sent again
--                                   without the operator's decision)
--
-- `sending` is written before the bytes go to the shell, so a job found in
-- `sending` after a restart is `unknown`. `purpose` and `subject_id` name what
-- the label is for — a box today, a pallet with the pallets' plan (ПЛ-Ц) —
-- so that plan adds no rebuild of this table. `verify` is the workstation's
-- «check the printed label» setting at the time the job was made: a `sent`
-- job with `verify = 1` still waits for the scan of its label.
--
-- `workstation_settings` belongs to the computer, not to a pairing
-- (`TableClass::Workstation`): printers and their purposes, COM scanners,
-- sound and the label check outlive a forget. One JSON value per key.
--
-- No foreign keys (see `0006`). Times are UTC RFC 3339 text as
-- `Date.toISOString` writes it. A single-column key says NOT NULL, as in
-- `0006`: `TEXT PRIMARY KEY` alone would take NULL.

CREATE TABLE floor_print_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('box', 'pallet')),
  subject_id TEXT NOT NULL,
  sscc TEXT NOT NULL CHECK (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*'),
  state TEXT NOT NULL CHECK (state IN
    ('prepared', 'sending', 'sent', 'failed', 'unknown', 'verified', 'skipped')),
  verify INTEGER NOT NULL CHECK (verify IN (0, 1)),
  template_id TEXT NOT NULL,
  template_rev INTEGER NOT NULL CHECK (template_rev >= 0),
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  printer TEXT CHECK (printer IS NULL OR json_valid(printer)),
  bytes_base64 TEXT CHECK (bytes_base64 IS NULL OR length(bytes_base64) > 0),
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Bytes are always rendered for a printer.
  CHECK (bytes_base64 IS NULL OR printer IS NOT NULL),
  -- Only a job with bytes can have gone to a printer.
  CHECK (state NOT IN ('sending', 'sent', 'unknown', 'verified') OR bytes_base64 IS NOT NULL),
  -- A reason exactly for a failed or unknown job.
  CHECK ((error_code IS NOT NULL) = (state IN ('failed', 'unknown'))),
  -- A prepared job has never been sent.
  CHECK (state <> 'prepared' OR attempts = 0),
  -- Verified only where the check was asked.
  CHECK (state <> 'verified' OR verify = 1)
);

-- At most one job of a label waits for the operator or the printer: the
-- next box does not close while one does, and a reprint of plan 2a8 cannot
-- start a second.
CREATE UNIQUE INDEX floor_print_jobs_open
  ON floor_print_jobs (host_id, device_id, purpose, subject_id)
  WHERE state IN ('prepared', 'sending', 'failed', 'unknown')
    OR (state = 'sent' AND verify = 1);

CREATE INDEX floor_print_jobs_shift ON floor_print_jobs (host_id, device_id, shift_id);

CREATE TABLE workstation_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
