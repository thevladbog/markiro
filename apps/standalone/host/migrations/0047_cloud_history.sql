-- One immutable accepted source batch. Parts stay accepted after ownership release.
CREATE TABLE cloud_history_batches (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  manifest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE cloud_history_parts (
  batch_id TEXT NOT NULL REFERENCES cloud_history_batches(id),
  part_index INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  counts TEXT NOT NULL,
  PRIMARY KEY (batch_id, part_index)
);
CREATE TABLE cloud_history_shifts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES cloud_history_batches(id),
  number TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,
  production_date TEXT,
  closed_at TEXT,
  product_id TEXT NOT NULL,
  gtin14 TEXT NOT NULL,
  in_window INTEGER NOT NULL,
  shelf_life_days INTEGER,
  source_json TEXT NOT NULL
);
CREATE INDEX cloud_history_shifts_page ON cloud_history_shifts(batch_id, in_window, closed_at, id);
CREATE INDEX cloud_history_shifts_product ON cloud_history_shifts(product_id, production_date, id);
CREATE TABLE cloud_history_codes (
  batch_id TEXT NOT NULL REFERENCES cloud_history_batches(id),
  shift_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  canonical TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  gtin14 TEXT,
  serial TEXT,
  flat_only INTEGER NOT NULL,
  PRIMARY KEY (shift_id, hash)
);
CREATE INDEX cloud_history_codes_hash ON cloud_history_codes(hash, flat_only);
CREATE INDEX cloud_history_codes_page ON cloud_history_codes(shift_id, scanned_at, hash);
CREATE TABLE cloud_history_boxes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES cloud_history_batches(id),
  shift_id TEXT NOT NULL,
  sscc TEXT UNIQUE,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  disassembled_at TEXT,
  pallet_id TEXT
);
CREATE INDEX cloud_history_boxes_shift ON cloud_history_boxes(shift_id, id);
CREATE INDEX cloud_history_boxes_pallet ON cloud_history_boxes(pallet_id, id);
CREATE TABLE cloud_history_items (
  batch_id TEXT NOT NULL REFERENCES cloud_history_batches(id),
  box_id TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (box_id, hash)
);
CREATE TABLE cloud_history_pallets (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES cloud_history_batches(id),
  shift_id TEXT,
  kind TEXT NOT NULL,
  product_id TEXT,
  product_name TEXT,
  gtin14 TEXT,
  shelf_life_days INTEGER,
  sscc TEXT UNIQUE,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  disassembled_at TEXT
);
CREATE INDEX cloud_history_pallets_shift ON cloud_history_pallets(shift_id, id);
CREATE TABLE cloud_history_owners (
  hash TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES cloud_history_batches(id),
  shift_id TEXT NOT NULL,
  number TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  box_id TEXT,
  released_at TEXT
);
CREATE INDEX cloud_history_owners_shift ON cloud_history_owners(shift_id, hash);
CREATE INDEX cloud_history_owners_number ON cloud_history_owners(number, shift_id);
CREATE INDEX cloud_history_owners_box ON cloud_history_owners(box_id, hash);
