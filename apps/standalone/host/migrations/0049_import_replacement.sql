-- Dataset replacement is distinct from restoring a backup: stations must
-- discard the old queues, never replay acknowledged production.
ALTER TABLE site ADD COLUMN dataset_epoch TEXT;
ALTER TABLE site ADD COLUMN replacement_pending INTEGER NOT NULL DEFAULT 0 CHECK (replacement_pending IN (0, 1));
ALTER TABLE site ADD COLUMN replacement_backup_file TEXT;
