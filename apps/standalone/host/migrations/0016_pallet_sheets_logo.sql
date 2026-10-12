-- A4 pallet sheets and the organization's print logo (plan А4, pilot spec
-- §29). Numbered 0016 by the plans' allocation; sqlx applies a missing lower
-- number later (see `tests/backup_schema.rs`), so the order the plans merge
-- in does not matter.

-- The organization's print logo, one row or none: already monochrome (the
-- office thresholds the picture), rows MSB first, 1 = ink, padded to whole
-- bytes with zero bits, standard base64. `validate::mono_logo` checks the
-- length and the padding; the CHECKs hold what no row may break.
CREATE TABLE org_logo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 512),
  pixels_base64 TEXT NOT NULL CHECK (length(pixels_base64) BETWEEN 4 AND 90000),
  updated_at TEXT NOT NULL
);

-- An A4 pallet sheet (the cloud's `PalletSheetSpecV2`, #702). The host keeps
-- `spec` an object of `schemaVersion` 2 and `kind` "pallet_sheet" of at most
-- 64 KiB; the domain checks the layout in the office and at the station. A
-- stock sheet carries its preset's key, so adding the stock sheets again
-- answers the ones already there. `revision` counts the sheet's own changes
-- (a shift freezes it with the sheet). Sheets are not in the station feed:
-- a station prints a sheet only from a shift's snapshot.
CREATE TABLE pallet_sheet_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  preset_key TEXT UNIQUE CHECK (preset_key IS NULL OR (length(preset_key) BETWEEN 1 AND 64
    AND preset_key NOT GLOB '*[^a-z0-9-]*')),
  spec TEXT NOT NULL CHECK (json_valid(spec) AND json_type(spec) = 'object'
    AND length(CAST(spec AS BLOB)) <= 65536),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The organization's default sheet: an enabled sheet, or none.
ALTER TABLE org_profile ADD COLUMN default_pallet_sheet_template_id TEXT
  REFERENCES pallet_sheet_templates (id);

-- The sheet a shift with pallets prints on an A4 printer. No foreign key, as
-- `box_template_id`: once the shift is open the sheet lives in its snapshot,
-- and a sheet a planned shift names is never deleted (`template_in_use`).
ALTER TABLE shifts ADD COLUMN pallet_sheet_template_id TEXT;
CREATE INDEX shifts_planned_pallet_sheet ON shifts (pallet_sheet_template_id)
  WHERE status = 'planned';

-- Only a shift with pallets names a sheet (`0009` takes no new CHECK without
-- a rebuild, as in `0012`).
CREATE TRIGGER shifts_pallet_sheet_insert BEFORE INSERT ON shifts
WHEN NEW.pallet_sheet_template_id IS NOT NULL AND NEW.pallets_enabled = 0
BEGIN
  SELECT RAISE(ABORT, 'shift pallet sheet: only a shift with pallets');
END;
CREATE TRIGGER shifts_pallet_sheet_update
BEFORE UPDATE OF pallets_enabled, pallet_sheet_template_id ON shifts
WHEN NEW.pallet_sheet_template_id IS NOT NULL AND NEW.pallets_enabled = 0
BEGIN
  SELECT RAISE(ABORT, 'shift pallet sheet: only a shift with pallets');
END;
