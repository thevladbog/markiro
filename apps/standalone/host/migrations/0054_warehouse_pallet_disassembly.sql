-- A handheld takes a closed warehouse pallet apart (`warehouse_pallet_disassembled`, protocol 8):
-- `disassembled_at` (0035) is the device's time of it; the reason is a code of the box
-- exceptions' list, with words only for `other`, as `pallet_exceptions` keeps it for a production
-- pallet; the operator is evidence, no foreign key. Existing rows were never taken apart.
ALTER TABLE warehouse_pallets ADD COLUMN disassembly_reason_code TEXT;
ALTER TABLE warehouse_pallets ADD COLUMN disassembly_reason_text TEXT
  CHECK (disassembly_reason_text IS NULL OR disassembly_reason_code = 'other');
ALTER TABLE warehouse_pallets ADD COLUMN disassembly_operator_id TEXT;
