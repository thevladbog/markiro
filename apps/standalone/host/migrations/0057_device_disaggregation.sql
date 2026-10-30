-- Rebuild the parent under deferred FKs. Insert the preserved rows AFTER recreating
-- the parent: renaming a populated replacement leaves SQLite's deferred DROP debt.
-- Child rowids, code releases, cloud links and stored export bytes stay untouched.
PRAGMA defer_foreign_keys = ON;
CREATE TEMP TABLE disaggregation_documents_preserved AS SELECT rowid AS preserved_rowid,* FROM disaggregation_documents;
DROP TABLE disaggregation_documents;
CREATE TABLE disaggregation_documents (
  id TEXT NOT NULL PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  doc_no TEXT NOT NULL UNIQUE CHECK (doc_no GLOB 'DSG-[0-9][0-9]-[0-9][0-9][0-9][0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'applied', 'cancelled')),
  reason_id TEXT REFERENCES disaggregation_reasons(id),
  comment TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 500),
  source TEXT NOT NULL CHECK (source IN ('manual','import')),
  created_by TEXT REFERENCES office_users(id),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  applied_by TEXT REFERENCES office_users(id),
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES office_users(id),
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL,
  device_id TEXT REFERENCES devices(id),
  operator_id TEXT REFERENCES operators(id),
  device_request_id TEXT,
  device_request_json TEXT,
  UNIQUE(device_id,device_request_id),
  CHECK ((created_by IS NOT NULL AND device_id IS NULL AND operator_id IS NULL AND device_request_id IS NULL AND device_request_json IS NULL)
    OR (created_by IS NULL AND device_id IS NOT NULL AND operator_id IS NOT NULL AND device_request_id IS NOT NULL AND device_request_json IS NOT NULL
      AND status='applied' AND applied_by IS NULL AND cancelled_by IS NULL AND source='manual')),
  CHECK ((status='applied')=(applied_at IS NOT NULL)),
  CHECK (device_id IS NOT NULL OR ((applied_at IS NULL)=(applied_by IS NULL))),
  CHECK ((status='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL)=(cancelled_by IS NULL)),
  CHECK (status<>'applied' OR reason_id IS NOT NULL)
);
INSERT INTO disaggregation_documents(rowid,id,seq,doc_no,status,reason_id,comment,source,created_by,created_at,applied_at,applied_by,cancelled_at,cancelled_by,updated_at,rev)
 SELECT preserved_rowid,id,seq,doc_no,status,reason_id,comment,source,created_by,created_at,applied_at,applied_by,cancelled_at,cancelled_by,updated_at,rev FROM disaggregation_documents_preserved;
DROP TABLE disaggregation_documents_preserved;
CREATE INDEX disaggregation_documents_created ON disaggregation_documents(created_at);
CREATE INDEX disaggregation_documents_status ON disaggregation_documents(status,created_at);

-- Display names are shared by the office list, act and history. Office identities
-- stay nullable and never contain a device/operator identifier.
CREATE VIEW disaggregation_authors AS
 SELECT d.id AS document_id, d.created_by, d.applied_by,
   COALESCE(cu.name,o.name||' · '||dev.name) AS created_by_name,
   COALESCE(au.name,o.name||' · '||dev.name) AS name,
   d.device_id,d.operator_id,dev.name AS device_name,o.name AS operator_name
 FROM disaggregation_documents d
 LEFT JOIN office_users cu ON cu.id=d.created_by
 LEFT JOIN office_users au ON au.id=d.applied_by
 LEFT JOIN devices dev ON dev.id=d.device_id
 LEFT JOIN operators o ON o.id=d.operator_id;
