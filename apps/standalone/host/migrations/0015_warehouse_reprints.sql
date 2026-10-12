-- Warehouse label reprint (plan СКЛ, pilot spec §30): what a station printed
-- again — a unit's code, a box's or a pallet's label of any station and any
-- shift — one row per attempt as the station recorded it. Like the facts,
-- these are production data: no revision, no audit row, and every value is
-- checked before it is written (`routes/warehouse.rs`); the CHECKs hold what
-- no row may break. A reprint changes nothing it printed: no box, pallet,
-- code or SSCC is written by it. `identity` is a code's hash or an SSCC,
-- never a full code. `occurred_at` is the device's instant, `received_at`
-- the host's.
CREATE TABLE warehouse_reprints (
  device_id TEXT NOT NULL REFERENCES devices (id),
  record_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  session_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('unit', 'box', 'pallet')),
  subject_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('not_printed', 'damaged', 'lost')),
  repair TEXT CHECK (repair IS NULL
    OR (repair = 'legacy_tspl_fnc1_literal' AND subject_kind <> 'unit')),
  template_id TEXT NOT NULL,
  template_rev INTEGER NOT NULL CHECK (template_rev >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'unknown', 'failed', 'verified', 'cancelled')),
  error_code TEXT,
  operator_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id),
  CHECK ((error_code IS NOT NULL) = (outcome IN ('failed', 'unknown')))
);
-- The office's history of one label (a later plan) reads by what was printed.
CREATE INDEX warehouse_reprints_identity ON warehouse_reprints (identity);
