ALTER TABLE ref_products ADD COLUMN set_items TEXT
  CHECK (set_items IS NULL OR (json_valid(set_items) AND json_type(set_items) = 'array'));

-- A mark is claimed across this device's shifts. An assembly commits all
-- its claims and the complete outbox fact in the same transaction. The raw
-- marks of a completed assembly live in the outbox, subject to its retention.
CREATE TABLE floor_set_marks (
  seq INTEGER PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code TEXT CHECK (code IS NULL OR (json_valid(code) AND json_type(code) = 'object')),
  assembly_id TEXT,
  is_set INTEGER NOT NULL DEFAULT 0 CHECK (is_set IN (0, 1)),
  CHECK (is_set = 0 OR assembly_id IS NOT NULL),
  CHECK ((assembly_id IS NULL) = (code IS NOT NULL)),
  UNIQUE (host_id, device_id, code_hash)
);
CREATE INDEX floor_set_marks_draft ON floor_set_marks (host_id, device_id, shift_id, seq)
  WHERE assembly_id IS NULL;
CREATE INDEX floor_set_marks_shift ON floor_set_marks (host_id, device_id, shift_id, is_set);
