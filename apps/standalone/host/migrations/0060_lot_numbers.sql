-- Existing organizations and shifts keep their behavior. The opened shift's
-- snapshot and the closed warehouse pallet retain their own print values.
ALTER TABLE org_profile ADD COLUMN use_lot_numbers INTEGER NOT NULL DEFAULT 0
    CHECK (use_lot_numbers IN (0, 1));
ALTER TABLE shifts ADD COLUMN lot_number TEXT;
ALTER TABLE warehouse_pallets ADD COLUMN lot_number TEXT;

-- A stock lot variant is a separate template. Frozen historical IDs are unchanged.
ALTER TABLE label_templates ADD COLUMN lot_number_source_id TEXT REFERENCES label_templates(id);
CREATE UNIQUE INDEX label_templates_lot_variant ON label_templates(lot_number_source_id)
    WHERE lot_number_source_id IS NOT NULL;
ALTER TABLE pallet_sheet_templates ADD COLUMN lot_number_source_id TEXT
    REFERENCES pallet_sheet_templates(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX pallet_sheets_lot_variant ON pallet_sheet_templates(lot_number_source_id)
    WHERE lot_number_source_id IS NOT NULL;
-- An administrator may delete a seeded sheet variant; a restart must keep that decision.
ALTER TABLE pallet_sheet_templates ADD COLUMN lot_number_variant_seeded INTEGER NOT NULL DEFAULT 0
    CHECK (lot_number_variant_seeded IN (0, 1));
