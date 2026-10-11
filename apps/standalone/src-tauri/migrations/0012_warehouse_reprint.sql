-- Warehouse label reprint (plan СКЛ, pilot spec §30): the station's sessions
-- of reprinting, the print job of each label printed again, and the records
-- of each attempt that go to the host (`POST /v1/device/warehouse/reprints`).
-- A reprint belongs to no shift and makes no code, box or SSCC, so it has
-- tables of its own; `floor_print_jobs` keeps the labels of the line.
--
-- All three are this device's data (`TableClass::DeviceData`): every row
-- carries its pairing, a forget keeps them. No foreign keys (see `0006`).
-- Times are UTC as `Date.toISOString` writes them. A job walks:
--
--   prepared -> sending -> sent [-> verified]
--                       -> failed  (nothing left this computer) [-> cancelled]
--                       -> unknown (a label may exist: never sent again
--                                   without the operator's decision)
--   sent | verified | unknown -> sending (a new attempt with a reason)
--
-- `sending` is written before the bytes go, so a job found in `sending`
-- after a restart is `unknown`. The template's layout and the label's fields
-- are frozen in the job (`template_spec`, `fields`): an attempt repeats them.

CREATE TABLE wh_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('not_printed', 'damaged', 'lost')),
  unit_template_id TEXT,
  box_template_id TEXT,
  pallet_template_id TEXT,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  finished_by TEXT,
  CHECK ((finished_at IS NULL) = (finished_by IS NULL))
);

-- One open session per pairing: a pause leaves it open, the next entry
-- continues it.
CREATE UNIQUE INDEX wh_sessions_open ON wh_sessions (host_id, device_id)
  WHERE finished_at IS NULL;
-- The retention reads the finished sessions by when they finished.
CREATE INDEX wh_sessions_finished ON wh_sessions (host_id, device_id, finished_at)
  WHERE finished_at IS NOT NULL;

CREATE TABLE wh_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unit', 'box', 'pallet')),
  subject_id TEXT NOT NULL,
  -- A unit's code hash or an SSCC: never a full code.
  identity TEXT NOT NULL,
  repair TEXT CHECK (repair IS NULL
    OR (repair = 'legacy_tspl_fnc1_literal' AND kind <> 'unit')),
  reason TEXT NOT NULL CHECK (reason IN ('not_printed', 'damaged', 'lost')),
  state TEXT NOT NULL CHECK (state IN
    ('prepared', 'sending', 'sent', 'failed', 'unknown', 'verified', 'cancelled')),
  template_id TEXT NOT NULL,
  template_rev INTEGER NOT NULL CHECK (template_rev >= 0),
  template_spec TEXT NOT NULL CHECK (json_valid(template_spec)),
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  printer TEXT CHECK (printer IS NULL OR json_valid(printer)),
  bytes_base64 TEXT CHECK (bytes_base64 IS NULL OR length(bytes_base64) > 0),
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (bytes_base64 IS NULL OR printer IS NOT NULL),
  CHECK (state NOT IN ('sending', 'sent', 'unknown', 'verified') OR bytes_base64 IS NOT NULL),
  CHECK ((error_code IS NOT NULL) = (state IN ('failed', 'unknown'))),
  CHECK (state <> 'prepared' OR attempts = 0)
);

-- At most one job of a session waits for the printer or the operator: the
-- session takes no new code and does not finish while one does.
CREATE UNIQUE INDEX wh_jobs_open ON wh_jobs (host_id, device_id, session_id)
  WHERE state IN ('prepared', 'sending', 'failed', 'unknown');
-- A code printed in the session is found by its identity (no repeat without
-- the operator's word); the session's counts and its purge read the same.
CREATE INDEX wh_jobs_session ON wh_jobs (host_id, device_id, session_id, identity);

CREATE TABLE wh_outbox (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at TEXT,
  outcome TEXT CHECK (outcome IN ('accepted', 'rejected')),
  outcome_code TEXT,
  acked_at TEXT,
  CHECK ((outcome IS NULL) = (acked_at IS NULL)),
  CHECK (outcome IS NOT NULL OR outcome_code IS NULL)
);

CREATE INDEX wh_outbox_unsent ON wh_outbox (host_id, device_id, seq) WHERE acked_at IS NULL;
-- The session's purge reads its records by the session. `session_id` leads on
-- purpose: a `(host_id, device_id, session_id)` index would attract the unsent
-- count (host and device only) away from `wh_outbox_unsent`, and the count
-- would then walk every record the pairing keeps for 30 days (as `outbox_settled`
-- in `0006` is partial so as not to attract it).
CREATE INDEX wh_outbox_session ON wh_outbox (session_id, host_id, device_id);
