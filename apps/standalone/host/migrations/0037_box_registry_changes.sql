-- When a closed box last changed what a handheld's registry shows (plan ТСД-Х, spec 6.4, 6.5): it
-- closed, was taken apart, stood on a pallet or left one, or the pallet it stands on closed or was
-- taken apart. The host's clock, in the stored timestamp format, set by `facts::registry_touch` in
-- the transaction that changes the box. A rowid would do, but a copy (`VACUUM INTO`) does not
-- promise to keep it. NULL for an open box: it has no SSCC and is in no registry.
ALTER TABLE boxes ADD COLUMN changed_at TEXT;
-- Existing boxes: the host's own time of receipt; a box taken apart is later than that.
UPDATE boxes SET changed_at = CASE
  WHEN disassembled_at IS NOT NULL AND disassembled_at > received_at THEN disassembled_at
  ELSE received_at END
WHERE sscc IS NOT NULL;
CREATE INDEX boxes_registry ON boxes (changed_at, sscc) WHERE sscc IS NOT NULL;
