-- A station may have printed a label before the host could verify its composition.
-- Keep the case even if the attempted pallet never opened on this host.
ALTER TABLE warehouse_pallets ADD COLUMN assembly_cancelled_at TEXT;

CREATE TABLE warehouse_pallet_close_issues (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id),
  pallet_id TEXT NOT NULL,
  sscc TEXT NOT NULL,
  block_id TEXT NOT NULL,
  serial INTEGER NOT NULL CHECK (serial >= 0),
  reported_boxes INTEGER NOT NULL CHECK (reported_boxes > 0),
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','cancelled','reclosed')),
  approved_boxes TEXT CHECK (approved_boxes IS NULL OR json_type(approved_boxes) = 'array'),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1)),
  CHECK ((status IN ('approved','reclosed')) = (approved_boxes IS NOT NULL)),
  CHECK (retired = 0 OR status = 'cancelled')
);
CREATE UNIQUE INDEX warehouse_pallet_close_issues_active
  ON warehouse_pallet_close_issues (device_id) WHERE status IN ('pending','approved');
CREATE INDEX warehouse_pallet_close_issues_cancelled
  ON warehouse_pallet_close_issues (device_id, pallet_id) WHERE status = 'cancelled';
CREATE INDEX warehouse_pallet_close_issues_retired_serial
  ON warehouse_pallet_close_issues (block_id, serial) WHERE retired = 1;
CREATE INDEX warehouse_pallet_close_issues_retired_sscc
  ON warehouse_pallet_close_issues (sscc) WHERE retired = 1;
