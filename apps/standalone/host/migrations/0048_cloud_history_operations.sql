-- Imported ownership has no winning local scan. Keep immutable winner provenance.
CREATE TABLE cloud_history_conflicts (
 id TEXT PRIMARY KEY,
 code_hash TEXT NOT NULL,
 loser_scan_id TEXT NOT NULL REFERENCES scans(id),
 winner_shift_id TEXT NOT NULL,
 winner_number TEXT NOT NULL,
 winner_scanned_at TEXT NOT NULL,
 winner_box_id TEXT,
 detected_at TEXT NOT NULL,
 reviewed_at TEXT,
 reviewed_by TEXT REFERENCES office_users(id),
 CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);
CREATE INDEX cloud_history_conflicts_loser ON cloud_history_conflicts(loser_scan_id);
CREATE INDEX cloud_history_conflicts_detected ON cloud_history_conflicts(detected_at,id);
ALTER TABLE cloud_history_items ADD COLUMN removed_at TEXT;
ALTER TABLE cloud_history_boxes ADD COLUMN locally_disassembled_at TEXT;
ALTER TABLE cloud_history_shifts ADD COLUMN late_data_at TEXT;

-- No table references a line. Copy rowid explicitly, preserving native FK/CHECK rules.
CREATE TABLE disaggregation_document_lines_rebuilt (
  id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES disaggregation_documents (id),
  position INTEGER NOT NULL CHECK (position > 0),
  sscc_input TEXT NOT NULL CHECK (length(sscc_input) BETWEEN 1 AND 64),
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*')),
  box_id TEXT REFERENCES boxes (id),
  pallet_id TEXT REFERENCES pallets (id),
  cloud_box_id TEXT REFERENCES cloud_history_boxes(id),
  cloud_pallet_id TEXT REFERENCES cloud_history_pallets(id),
  cloud_product_id TEXT,
  cloud_product_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'not_closed', 'shift_open',
    'already_disassembled', 'duplicate')),
  product_id TEXT REFERENCES products (id),
  code_count INTEGER NOT NULL DEFAULT 0 CHECK (code_count >= 0),
  validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, position),
  CHECK ((box_id IS NOT NULL)+(pallet_id IS NOT NULL)+(cloud_box_id IS NOT NULL)+(cloud_pallet_id IS NOT NULL)<=1),
  CHECK ((cloud_box_id IS NULL AND cloud_pallet_id IS NULL) OR product_id IS NULL),
  CHECK ((status IN ('not_found', 'duplicate')) = (box_id IS NULL AND pallet_id IS NULL AND cloud_box_id IS NULL AND cloud_pallet_id IS NULL)),
  CHECK (sscc IS NOT NULL OR status IN ('not_found', 'duplicate'))
);
INSERT INTO disaggregation_document_lines_rebuilt(rowid,id,document_id,position,sscc_input,sscc,box_id,pallet_id,status,product_id,code_count,validated_at,created_at) SELECT rowid,id,document_id,position,sscc_input,sscc,box_id,pallet_id,status,product_id,code_count,validated_at,created_at FROM disaggregation_document_lines;
DROP TABLE disaggregation_document_lines;
ALTER TABLE disaggregation_document_lines_rebuilt RENAME TO disaggregation_document_lines;
CREATE UNIQUE INDEX disaggregation_lines_document_sscc
  ON disaggregation_document_lines (document_id, sscc) WHERE sscc IS NOT NULL;
CREATE INDEX disaggregation_lines_box
  ON disaggregation_document_lines (box_id) WHERE box_id IS NOT NULL;
CREATE INDEX disaggregation_lines_pallet
  ON disaggregation_document_lines (pallet_id) WHERE pallet_id IS NOT NULL;

CREATE INDEX disaggregation_lines_cloud_box ON disaggregation_document_lines(cloud_box_id) WHERE cloud_box_id IS NOT NULL;
CREATE INDEX disaggregation_lines_cloud_pallet ON disaggregation_document_lines(cloud_pallet_id) WHERE cloud_pallet_id IS NOT NULL;
CREATE TABLE cloud_history_releases (
 box_id TEXT PRIMARY KEY REFERENCES cloud_history_boxes(id),
 shift_id TEXT NOT NULL REFERENCES cloud_history_shifts(id),
 document_id TEXT NOT NULL REFERENCES disaggregation_documents(id),
 code_count INTEGER NOT NULL CHECK(code_count>=0),
 released_at TEXT NOT NULL,
 rev INTEGER NOT NULL
);
