-- No table references a line. Copy rowid explicitly, preserving native FK/CHECK rules.
CREATE TABLE disaggregation_document_lines_rebuilt (
  id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES disaggregation_documents (id),
  position INTEGER NOT NULL CHECK (position > 0),
  sscc_input TEXT NOT NULL CHECK (length(sscc_input) BETWEEN 1 AND 64),
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*')),
  box_id TEXT REFERENCES boxes (id),
  pallet_id TEXT REFERENCES pallets (id),
  warehouse_pallet_id TEXT REFERENCES warehouse_pallets(id),
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
  CHECK ((box_id IS NOT NULL)+(pallet_id IS NOT NULL)+(cloud_box_id IS NOT NULL)+(cloud_pallet_id IS NOT NULL)+(warehouse_pallet_id IS NOT NULL)<=1),
  CHECK ((cloud_box_id IS NULL AND cloud_pallet_id IS NULL) OR product_id IS NULL),
  CHECK ((status IN ('not_found', 'duplicate')) = (box_id IS NULL AND pallet_id IS NULL AND cloud_box_id IS NULL AND cloud_pallet_id IS NULL AND warehouse_pallet_id IS NULL)),
  CHECK (sscc IS NOT NULL OR status IN ('not_found', 'duplicate'))
);
INSERT INTO disaggregation_document_lines_rebuilt(rowid,id,document_id,position,sscc_input,sscc,box_id,pallet_id,cloud_box_id,cloud_pallet_id,cloud_product_id,cloud_product_name,status,product_id,code_count,validated_at,created_at) SELECT rowid,id,document_id,position,sscc_input,sscc,box_id,pallet_id,cloud_box_id,cloud_pallet_id,cloud_product_id,cloud_product_name,status,product_id,code_count,validated_at,created_at FROM disaggregation_document_lines;
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
CREATE INDEX disaggregation_lines_warehouse_pallet ON disaggregation_document_lines(warehouse_pallet_id) WHERE warehouse_pallet_id IS NOT NULL;

-- Preserve stored bytes and stable rowids while broadening the target CHECK.
CREATE TABLE export_files_preserved AS SELECT rowid AS preserved_rowid,* FROM export_files;
CREATE TABLE export_chunks_preserved AS SELECT rowid AS preserved_rowid,* FROM export_file_chunks;
DROP TABLE export_file_chunks;
DROP TABLE export_files;
CREATE TABLE export_files (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  -- One export's files share a batch: the `documentId` of a shift's or a
  -- pallet's export (the same as its `shift.export` audit row), a UUID of
  -- its own for a form and a disaggregation file.
  batch_id TEXT NOT NULL CHECK (length(batch_id) = 36),
  part_no INTEGER NOT NULL CHECK (part_no BETWEEN 1 AND 100000),
  kind TEXT NOT NULL CHECK (kind IN ('shift_export', 'pallet_export', 'disaggregation_xml', 'form')),
  -- What the file belongs to: the card it is listed on.
  target_type TEXT NOT NULL CHECK (target_type IN ('shift', 'pallet', 'warehouse_pallet', 'box', 'disaggregation_document')),
  target_id TEXT NOT NULL,
  -- The shift the drawer lists the file under: the shift itself, the shift
  -- of a pallet or a box; none for a disaggregation document.
  shift_id TEXT,
  format_id TEXT NOT NULL CHECK (length(format_id) BETWEEN 1 AND 100),
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 100),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 268435456),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 256),
  -- SHA-256 of the file's exact bytes, lower-case hex, checked when the
  -- upload completes and again on every download.
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  -- What generated the file: the office build (the format's own version is
  -- `format_version`).
  generator TEXT NOT NULL CHECK (length(generator) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'ready')),
  -- What the chunks occupy in the database (after deflate).
  stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  created_at TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES office_users (id),
  UNIQUE (batch_id, part_no)
);

-- The drawer's lists: by shift, newest first; a card's by its target.
CREATE INDEX export_files_shift ON export_files (shift_id, kind, created_at);
CREATE INDEX export_files_target ON export_files (target_type, target_id, created_at);
-- The retention purge and the stale-upload sweep read by age.
CREATE INDEX export_files_created ON export_files (created_at);

CREATE TABLE export_file_chunks (
  file_id TEXT NOT NULL REFERENCES export_files (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 255),
  encoding TEXT NOT NULL CHECK (encoding IN ('identity', 'deflate')),
  -- SHA-256 of the chunk as the office made it (before deflate): every serve
  -- of the chunk checks it, so a damaged chunk is never handed on.
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content BLOB NOT NULL,
  PRIMARY KEY (file_id, seq)
);

INSERT INTO export_files(rowid,id,batch_id,part_no,kind,target_type,target_id,shift_id,format_id,format_version,file_name,media_type,size_bytes,chunk_count,sha256,generator,state,stored_bytes,created_at,actor_id) SELECT preserved_rowid,id,batch_id,part_no,kind,target_type,target_id,shift_id,format_id,format_version,file_name,media_type,size_bytes,chunk_count,sha256,generator,state,stored_bytes,created_at,actor_id FROM export_files_preserved;
INSERT INTO export_file_chunks(rowid,file_id,seq,encoding,sha256,content) SELECT preserved_rowid,file_id,seq,encoding,sha256,content FROM export_chunks_preserved;
DROP TABLE export_chunks_preserved;
DROP TABLE export_files_preserved;
