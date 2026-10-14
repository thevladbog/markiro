-- Office disaggregation documents (plan ДЗГ, parity spec §5.1; the cloud's
-- `packages/db/src/schema/disaggregation.ts`). A document takes closed
-- boxes and pallets of closed shifts apart from the office: its lines name
-- them by SSCC, and its apply does to each box what a station's
-- `disassemble` exception does (`host/src/facts/exception.rs`) and to each
-- pallet what a station's pallet `disassemble` does. The fact tables keep a
-- device's records only (`box_exceptions.device_id` and `record_id` are
-- NOT NULL), so the applied document's line is itself the record of the
-- office's action, and a reader of a box's history joins both. As in
-- `0010`, every value is checked before it is written
-- (`host/src/disaggregation.rs`, `routes/disaggregation*.rs`); the CHECKs
-- hold what no row may break.

-- The site's reasons (the cloud's per tenant). Archived instead of deleted:
-- a document keeps naming its reason. Five defaults (owner decision ПР-3)
-- with fixed ids, so every host has the same ones; the office renames or
-- archives them like any other.
CREATE TABLE disaggregation_reasons (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  rev INTEGER NOT NULL
);
INSERT INTO disaggregation_reasons (id, name, sort_order, archived, created_at, rev) VALUES
  ('d15a0000-0000-4000-8000-000000000001', 'Не тот товар', 10, 0,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
  ('d15a0000-0000-4000-8000-000000000002', 'Неверное количество', 20, 0,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
  ('d15a0000-0000-4000-8000-000000000003', 'Повреждена упаковка', 30, 0,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
  ('d15a0000-0000-4000-8000-000000000004', 'Брак по качеству', 40, 0,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0),
  ('d15a0000-0000-4000-8000-000000000005', 'Другое', 90, 0,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 0);

-- The one counter of `DSG-YY-NNNN`, as the cloud's per tenant: never reset
-- by year. A restore lifts it above both databases (`restore.rs`).
CREATE TABLE disaggregation_doc_counters (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq INTEGER NOT NULL CHECK (last_seq >= 0)
);
INSERT INTO disaggregation_doc_counters (id, last_seq) VALUES (1, 0);

-- A document: a draft until it is applied (for good) or cancelled. `seq`
-- is the counter's number, `doc_no` its text with the year of creation.
CREATE TABLE disaggregation_documents (
  id TEXT NOT NULL PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  doc_no TEXT NOT NULL UNIQUE CHECK (doc_no GLOB 'DSG-[0-9][0-9]-[0-9][0-9][0-9][0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'applied', 'cancelled')),
  reason_id TEXT REFERENCES disaggregation_reasons (id),
  comment TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 500),
  source TEXT NOT NULL CHECK (source IN ('manual', 'import')),
  created_by TEXT NOT NULL REFERENCES office_users (id),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  applied_by TEXT REFERENCES office_users (id),
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES office_users (id),
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL,
  CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CHECK ((applied_at IS NULL) = (applied_by IS NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK (status <> 'applied' OR reason_id IS NOT NULL)
);
CREATE INDEX disaggregation_documents_created ON disaggregation_documents (created_at);
CREATE INDEX disaggregation_documents_status ON disaggregation_documents (status, created_at);

-- One line per input: the text as typed or imported, the SSCC the domain
-- read from it (NULL when none, and for a repeat of an SSCC already in the
-- document), and what it named when last checked. An apply checks every
-- line again from the live tables; `product_id` and `code_count` are what
-- the office shows. A line names a box or a pallet, never both (box and
-- pallet SSCCs differ in their extension digit).
CREATE TABLE disaggregation_document_lines (
  id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES disaggregation_documents (id),
  position INTEGER NOT NULL CHECK (position > 0),
  sscc_input TEXT NOT NULL CHECK (length(sscc_input) BETWEEN 1 AND 64),
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*')),
  box_id TEXT REFERENCES boxes (id),
  pallet_id TEXT REFERENCES pallets (id),
  status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'not_closed', 'shift_open',
    'already_disassembled', 'duplicate')),
  product_id TEXT REFERENCES products (id),
  code_count INTEGER NOT NULL DEFAULT 0 CHECK (code_count >= 0),
  validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, position),
  CHECK (box_id IS NULL OR pallet_id IS NULL),
  CHECK ((status IN ('not_found', 'duplicate')) = (box_id IS NULL AND pallet_id IS NULL)),
  CHECK (sscc IS NOT NULL OR status IN ('not_found', 'duplicate'))
);
CREATE UNIQUE INDEX disaggregation_lines_document_sscc
  ON disaggregation_document_lines (document_id, sscc) WHERE sscc IS NOT NULL;
CREATE INDEX disaggregation_lines_sscc
  ON disaggregation_document_lines (sscc) WHERE sscc IS NOT NULL;
CREATE INDEX disaggregation_lines_box
  ON disaggregation_document_lines (box_id) WHERE box_id IS NOT NULL;
CREATE INDEX disaggregation_lines_pallet
  ON disaggregation_document_lines (pallet_id) WHERE pallet_id IS NOT NULL;

-- The station feed's `code_releases` (plan ДЗГ): one row per box whose
-- codes an applied document freed. The unit is the box, not the code: a
-- station deletes its codes of that box, as its own disassembly does, and
-- one apply of thousands of boxes stays a feed revision of thousands of
-- small items. A box is taken apart once, so the box is the key; a row is
-- never deleted and has no tombstone.
CREATE TABLE code_releases (
  box_id TEXT NOT NULL PRIMARY KEY REFERENCES boxes (id),
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  document_id TEXT NOT NULL REFERENCES disaggregation_documents (id),
  code_count INTEGER NOT NULL CHECK (code_count >= 0),
  released_at TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE INDEX code_releases_rev ON code_releases (rev);
CREATE INDEX code_releases_document ON code_releases (document_id);
