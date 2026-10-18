-- Warehouse pallets (plan ТСД-Х, spec 6.4, decision Д5): a pallet a handheld builds OUTSIDE a shift
-- from boxes that other shifts closed. Not `pallets.kind`: `pallets.shift_id` is NOT NULL, and a
-- SQLite column constraint changes only by rebuilding the table with the foreign keys that point
-- at it (`boxes.pallet_id`, `pallet_exceptions`, the disaggregation lines). The CHECKs are the
-- production pallets' (`0012`); the pallet carries one product.
CREATE TABLE warehouse_pallets (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id),
  product_id TEXT NOT NULL REFERENCES products (id),
  gtin14 TEXT NOT NULL CHECK (length(gtin14) = 14 AND gtin14 NOT GLOB '*[^0-9]*'),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT REFERENCES sscc_blocks (id),
  serial INTEGER,
  box_count_reported INTEGER CHECK (box_count_reported IS NULL OR box_count_reported > 0),
  operator_id TEXT,
  disassembled_at TEXT,
  received_at TEXT NOT NULL,
  CHECK ((closed_at IS NULL) = (sscc IS NULL)),
  CHECK ((closed_at IS NULL) = (block_id IS NULL)),
  CHECK ((closed_at IS NULL) = (serial IS NULL)),
  CHECK ((closed_at IS NULL) = (box_count_reported IS NULL)),
  CHECK (disassembled_at IS NULL OR closed_at IS NOT NULL),
  CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc GLOB '1*'))
);
CREATE UNIQUE INDEX warehouse_pallets_sscc ON warehouse_pallets (sscc) WHERE sscc IS NOT NULL;
CREATE UNIQUE INDEX warehouse_pallets_block_serial ON warehouse_pallets (block_id, serial)
  WHERE block_id IS NOT NULL AND serial IS NOT NULL;
CREATE INDEX warehouse_pallets_device_open ON warehouse_pallets (device_id) WHERE closed_at IS NULL;

-- The boxes on a warehouse pallet, one row per stay: a box that left and came back has two. A box
-- stands on one live pallet only (`removed_at IS NULL`): the index is the host's check of two
-- handhelds racing for one box, and the reason of `box_on_pallet`.
CREATE TABLE warehouse_pallet_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pallet_id TEXT NOT NULL REFERENCES warehouse_pallets (id),
  box_sscc TEXT NOT NULL CHECK (length(box_sscc) = 18),
  added_at TEXT NOT NULL,
  removed_at TEXT,
  operator_id TEXT,
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id)
);
CREATE UNIQUE INDEX warehouse_pallet_boxes_live ON warehouse_pallet_boxes (box_sscc)
  WHERE removed_at IS NULL;
CREATE INDEX warehouse_pallet_boxes_pallet ON warehouse_pallet_boxes (pallet_id);
