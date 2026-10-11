-- Backups and restore (plan РК). The second folder for copies is an office
-- setting (one row; NULL until an administrator names a folder). The local
-- folder is fixed (`<data dir>/backups`) and is no setting.
CREATE TABLE backup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  second_dir TEXT CHECK (second_dir IS NULL OR length(second_dir) BETWEEN 1 AND 260),
  rev INTEGER NOT NULL DEFAULT 0
);
INSERT INTO backup_settings (id) VALUES (1);

-- A new UUID at every `markiro-host restore`, which `hello` reports as
-- `restoreEpoch`: a device that sees it change knows the host went back to
-- a copy. NULL until the first restore.
ALTER TABLE site ADD COLUMN restore_epoch TEXT;

-- Set by a restore, cleared by an administrator ("resume"): while it is set
-- the host answers the stations' facts and code checks `restore_pending`
-- instead of a receipt, since a receipt is kept for good and the copy may
-- lack the shift or the block a fact names.
ALTER TABLE site ADD COLUMN facts_held_since TEXT;

-- The restore epoch for which a station sent its blocks back
-- (`POST /v1/device/sscc/blocks/known`); the office lists the stations that
-- did not yet.
ALTER TABLE devices ADD COLUMN known_blocks_epoch TEXT;
