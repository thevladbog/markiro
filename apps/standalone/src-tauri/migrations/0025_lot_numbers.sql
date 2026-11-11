-- The profile controls station input. Shift and box copies support offline display and packing.
ALTER TABLE ref_org ADD COLUMN use_lot_numbers INTEGER NOT NULL DEFAULT 0 CHECK (use_lot_numbers IN (0, 1));
ALTER TABLE floor_shifts ADD COLUMN lot_number TEXT;
ALTER TABLE pallet_assembly_members ADD COLUMN lot_number TEXT;
ALTER TABLE ref_templates ADD COLUMN lot_number_source_id TEXT;
ALTER TABLE pallet_registry_state ADD COLUMN lot_numbers_supported INTEGER NOT NULL DEFAULT 0 CHECK (lot_numbers_supported IN (0, 1));
