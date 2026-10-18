-- Additive indexed read paths; accepted snapshots need no export/reimport.
-- Flat-only reprocessing rows may omit the denormalized GTIN; import validation
-- guarantees the canonical AI 01 prefix. Index that identity without changing snapshots.
CREATE INDEX cloud_history_codes_gtin_time ON cloud_history_codes(COALESCE(gtin14, substr(canonical, 3, 14)), julianday(scanned_at), shift_id, hash);
CREATE INDEX cloud_history_codes_time ON cloud_history_codes(julianday(scanned_at), shift_id, hash);
CREATE INDEX cloud_history_owners_time ON cloud_history_owners(julianday(scanned_at), hash);
