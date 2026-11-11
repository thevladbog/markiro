-- Preserve the legacy office/station category used by reporting and older
-- clients. Keep the handheld origin as a fact even if the device is revoked.
ALTER TABLE shifts ADD COLUMN created_on_handheld INTEGER NOT NULL DEFAULT 0
    CHECK (created_on_handheld IN (0, 1) AND (created_on_handheld = 0 OR created_from = 'station'));
ALTER TABLE shifts ADD COLUMN number_origin TEXT
    GENERATED ALWAYS AS (CASE WHEN created_on_handheld = 1 THEN 'handheld' ELSE created_from END) VIRTUAL;
