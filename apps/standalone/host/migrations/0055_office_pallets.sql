-- Office pallets use the authenticated office PC, with an explicit office author.
-- Existing handheld rows and their identity stay unchanged; no table rebuild.
ALTER TABLE warehouse_pallets ADD COLUMN source TEXT NOT NULL DEFAULT 'device'
  CHECK (source IN ('device', 'cabinet'));
ALTER TABLE warehouse_pallets ADD COLUMN created_by_user_id TEXT REFERENCES office_users(id);
ALTER TABLE warehouse_pallets ADD COLUMN creation_request_id TEXT;
ALTER TABLE warehouse_pallets ADD COLUMN creation_hash TEXT;
CREATE UNIQUE INDEX warehouse_pallets_creation_request ON warehouse_pallets(creation_request_id)
  WHERE creation_request_id IS NOT NULL;
CREATE TRIGGER warehouse_pallets_office_insert BEFORE INSERT ON warehouse_pallets
WHEN (NEW.source='cabinet' AND (NEW.created_by_user_id IS NULL OR NEW.creation_request_id IS NULL
  OR NEW.creation_hash IS NULL OR length(NEW.creation_hash) <> 64 OR NEW.closed_at IS NULL))
  OR (NEW.source='device' AND (NEW.created_by_user_id IS NOT NULL OR NEW.creation_request_id IS NOT NULL OR NEW.creation_hash IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'warehouse pallet provenance'); END;
CREATE TRIGGER warehouse_pallets_office_update
BEFORE UPDATE OF source,created_by_user_id,creation_request_id,creation_hash,closed_at ON warehouse_pallets
WHEN (NEW.source='cabinet' AND (NEW.created_by_user_id IS NULL OR NEW.creation_request_id IS NULL
  OR NEW.creation_hash IS NULL OR length(NEW.creation_hash) <> 64 OR NEW.closed_at IS NULL))
  OR (NEW.source='device' AND (NEW.created_by_user_id IS NOT NULL OR NEW.creation_request_id IS NOT NULL OR NEW.creation_hash IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'warehouse pallet provenance'); END;
