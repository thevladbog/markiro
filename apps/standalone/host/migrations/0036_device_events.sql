-- The receipts of a device's events outside a shift (plan ТСД-Х, spec 6.4): the idempotent outbox of
-- `POST /v1/device/pallet-events`. `fact_receipts` is not reused on purpose: its rows are indexed
-- by shift. A record is kept as its SHA-256 (`facts::rules::record_digest`): the same id with the
-- same digest answers the stored receipt, with another digest `payload_mismatch`, kept nowhere.
CREATE TABLE device_event_receipts (
  device_id TEXT NOT NULL REFERENCES devices (id),
  record_id TEXT NOT NULL,
  kind TEXT,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'conflict', 'rejected')),
  code TEXT,
  details TEXT CHECK (details IS NULL OR (json_valid(details) AND json_type(details) = 'object')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, record_id),
  CHECK ((outcome = 'rejected') = (code IS NOT NULL))
);
