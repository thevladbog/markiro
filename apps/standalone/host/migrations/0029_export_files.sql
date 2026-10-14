-- Every file the office generates is kept on the host (beta 3 feedback: «файлы
-- должны быть доступны всегда для выгрузки»). Until now a shift's export was
-- rendered in the office's window, written to the PC's Documents folder and
-- only RECORDED (`shift.export`, an audit row): a file lost from that PC could
-- not be had again. Now the exact bytes go to the host first, are served back
-- unchanged (their SHA-256 is checked on every serve) and are re-downloadable
-- from the shift's drawer and the box, pallet and disaggregation cards.
--
-- The bytes live in this database, not beside it: a copy (`VACUUM INTO`) and
-- a restore (`markiro-host restore`) then carry them with no second place to
-- keep in step. They are cut into chunks of at most 1 MiB, each deflated
-- when that is smaller (the ЧЗ XML, TXT and CSV shrink about tenfold), so a
-- 30 MB document is a few MB of the database, every transfer is bounded and
-- the webview never holds more than the file it works on. The cost is that
-- every copy of the database carries the files stored before it; the
-- retention setting below (default: keep always) and the store's cap bound it.

CREATE TABLE export_files (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  -- One export's files share a batch: the `documentId` of a shift's or a
  -- pallet's export (the same as its `shift.export` audit row), a UUID of
  -- its own for a form and a disaggregation file.
  batch_id TEXT NOT NULL CHECK (length(batch_id) = 36),
  part_no INTEGER NOT NULL CHECK (part_no BETWEEN 1 AND 100000),
  kind TEXT NOT NULL CHECK (kind IN ('shift_export', 'pallet_export', 'disaggregation_xml', 'form')),
  -- What the file belongs to: the card it is listed on.
  target_type TEXT NOT NULL CHECK (target_type IN ('shift', 'pallet', 'box', 'disaggregation_document')),
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

-- The administrator's retention for stored files: NULL keeps them always (the
-- default); a number of days lets the host delete a file older than that when
-- the next file is stored or the setting is saved, and says so in the audit
-- trail.
CREATE TABLE export_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days BETWEEN 30 AND 3650)
);
INSERT INTO export_settings (id) VALUES (1);
