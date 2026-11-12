-- Preserve existing SSCC rows and rowids. No table references a line yet.
CREATE TABLE disaggregation_document_lines_rebuilt (
  id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES disaggregation_documents (id),
  position INTEGER NOT NULL CHECK (position > 0),
  sscc_input TEXT NOT NULL CHECK (length(sscc_input) BETWEEN 1 AND 1027),
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*')),
  set_code TEXT CHECK (set_code IS NULL OR length(CAST(set_code AS BLOB)) BETWEEN 19 AND 82),
  box_id TEXT REFERENCES boxes (id),
  pallet_id TEXT REFERENCES pallets (id),
  warehouse_pallet_id TEXT REFERENCES warehouse_pallets (id),
  cloud_box_id TEXT REFERENCES cloud_history_boxes (id),
  cloud_pallet_id TEXT REFERENCES cloud_history_pallets (id),
  cloud_product_id TEXT,
  cloud_product_name TEXT,
  set_device_id TEXT,
  set_record_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'not_closed', 'shift_open',
    'already_disassembled', 'duplicate')),
  product_id TEXT REFERENCES products (id),
  code_count INTEGER NOT NULL DEFAULT 0 CHECK (code_count >= 0),
  validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (set_device_id, set_record_id) REFERENCES set_assemblies (device_id, record_id),
  UNIQUE (document_id, position),
  CHECK ((set_device_id IS NULL) = (set_record_id IS NULL)),
  CHECK (set_code IS NULL OR sscc IS NULL),
  CHECK (set_record_id IS NULL OR set_code IS NOT NULL),
  CHECK ((box_id IS NOT NULL) + (pallet_id IS NOT NULL) + (cloud_box_id IS NOT NULL)
    + (cloud_pallet_id IS NOT NULL) + (warehouse_pallet_id IS NOT NULL)
    + (set_record_id IS NOT NULL) <= 1),
  CHECK ((cloud_box_id IS NULL AND cloud_pallet_id IS NULL) OR product_id IS NULL),
  CHECK ((status IN ('not_found', 'duplicate')) = (box_id IS NULL AND pallet_id IS NULL
    AND cloud_box_id IS NULL AND cloud_pallet_id IS NULL AND warehouse_pallet_id IS NULL
    AND set_record_id IS NULL)),
  CHECK (sscc IS NOT NULL OR set_code IS NOT NULL OR status IN ('not_found', 'duplicate'))
);
INSERT INTO disaggregation_document_lines_rebuilt (
  rowid, id, document_id, position, sscc_input, sscc, box_id, pallet_id, cloud_box_id,
  cloud_pallet_id, cloud_product_id, cloud_product_name, warehouse_pallet_id, status, product_id,
  code_count, validated_at, created_at
)
SELECT rowid, id, document_id, position, sscc_input, sscc, box_id, pallet_id, cloud_box_id,
  cloud_pallet_id, cloud_product_id, cloud_product_name, warehouse_pallet_id, status, product_id,
  code_count, validated_at, created_at FROM disaggregation_document_lines;
DROP TABLE disaggregation_document_lines;
ALTER TABLE disaggregation_document_lines_rebuilt RENAME TO disaggregation_document_lines;

CREATE UNIQUE INDEX disaggregation_lines_document_sscc
  ON disaggregation_document_lines (document_id, sscc) WHERE sscc IS NOT NULL;
CREATE UNIQUE INDEX disaggregation_lines_document_set_code
  ON disaggregation_document_lines (document_id, set_code) WHERE set_code IS NOT NULL;
CREATE INDEX disaggregation_lines_box
  ON disaggregation_document_lines (box_id) WHERE box_id IS NOT NULL;
CREATE INDEX disaggregation_lines_pallet
  ON disaggregation_document_lines (pallet_id) WHERE pallet_id IS NOT NULL;
CREATE INDEX disaggregation_lines_cloud_box
  ON disaggregation_document_lines (cloud_box_id) WHERE cloud_box_id IS NOT NULL;
CREATE INDEX disaggregation_lines_cloud_pallet
  ON disaggregation_document_lines (cloud_pallet_id) WHERE cloud_pallet_id IS NOT NULL;
CREATE INDEX disaggregation_lines_warehouse_pallet
  ON disaggregation_document_lines (warehouse_pallet_id) WHERE warehouse_pallet_id IS NOT NULL;

-- A release archives the original assembly through the applied line. Its
-- parent code stays reserved. This row is also the durable device feed.
CREATE TABLE set_releases (
  line_id TEXT NOT NULL PRIMARY KEY REFERENCES disaggregation_document_lines (id),
  device_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev > 0),
  UNIQUE (device_id, record_id),
  FOREIGN KEY (device_id, record_id) REFERENCES set_assemblies (device_id, record_id)
);
CREATE INDEX set_releases_rev ON set_releases (rev, line_id);
CREATE INDEX set_codes_assembly ON set_codes (device_id, record_id);
