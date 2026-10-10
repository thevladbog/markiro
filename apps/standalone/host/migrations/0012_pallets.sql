-- Pallets (plan ПЛ-Х, pilot spec §6): a station's pallet fills itself with
-- the boxes it closes and closes with an SSCC of a pallet block (extension
-- 1). The host learns a pallet from the facts: the first closed box that
-- names it opens it, its `pallet_closed` closes it (or opens it closed, when
-- none of its boxes reached the host). Which boxes a pallet holds is derived
-- (`boxes.pallet_id`), never stored; the count the station reported is kept
-- beside it as evidence. As in `0010`, every value is checked before it is
-- written; the CHECKs hold what no row may break.

-- A pallet of one device in one shift. One open pallet per station and
-- shift is the station's rule, not a constraint here: a host that refused a
-- second one would fail a batch the station can never get past.
CREATE TABLE pallets (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT,
  block_id TEXT REFERENCES sscc_blocks (id),
  serial INTEGER,
  box_count_reported INTEGER CHECK (box_count_reported IS NULL OR box_count_reported > 0),
  operator_id TEXT,
  print_verified_at TEXT,
  print_skipped_at TEXT,
  disassembled_at TEXT,
  received_at TEXT NOT NULL,
  CHECK ((closed_at IS NULL) = (sscc IS NULL)),
  CHECK ((closed_at IS NULL) = (block_id IS NULL)),
  CHECK ((closed_at IS NULL) = (serial IS NULL)),
  CHECK ((closed_at IS NULL) = (box_count_reported IS NULL)),
  CHECK (disassembled_at IS NULL OR closed_at IS NOT NULL),
  CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc GLOB '1*'))
);
CREATE UNIQUE INDEX pallets_sscc ON pallets (sscc) WHERE sscc IS NOT NULL;
-- One serial of a pallet block is one label, whatever the check digit says.
CREATE UNIQUE INDEX pallets_block_serial ON pallets (block_id, serial)
  WHERE block_id IS NOT NULL AND serial IS NOT NULL;
CREATE INDEX pallets_shift ON pallets (shift_id);

-- A box joins a pallet when it closes. The link stays when the box or the
-- pallet is taken apart, as in the cloud; a pallet's boxes leave out those
-- taken apart.
ALTER TABLE boxes ADD COLUMN pallet_id TEXT REFERENCES pallets (id)
  CHECK (pallet_id IS NULL OR closed_at IS NOT NULL);
CREATE INDEX boxes_pallet ON boxes (pallet_id) WHERE pallet_id IS NOT NULL;

-- Pallet exceptions: its label printed again, or the pallet taken apart,
-- with a reason code of the box exceptions' lists.
CREATE TABLE pallet_exceptions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reprint', 'disassemble')),
  pallet_id TEXT NOT NULL REFERENCES pallets (id),
  reason_code TEXT NOT NULL,
  reason_text TEXT,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  operator_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK (reason_text IS NULL OR reason_code = 'other')
);
CREATE UNIQUE INDEX pallet_exceptions_record ON pallet_exceptions (device_id, record_id);
CREATE INDEX pallet_exceptions_pallet ON pallet_exceptions (pallet_id);

-- A shift with pallets names their box capacity and their label template,
-- a shift without names neither. `0009` cannot take a new CHECK without
-- rebuilding its table, so two triggers hold the rule.
CREATE TRIGGER shifts_pallets_insert BEFORE INSERT ON shifts
WHEN (NEW.pallets_enabled = 1) <> (NEW.pallet_box_capacity IS NOT NULL)
  OR (NEW.pallets_enabled = 1) <> (NEW.pallet_template_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'shift pallets: capacity and template exactly when enabled');
END;
CREATE TRIGGER shifts_pallets_update
BEFORE UPDATE OF pallets_enabled, pallet_box_capacity, pallet_template_id ON shifts
WHEN (NEW.pallets_enabled = 1) <> (NEW.pallet_box_capacity IS NOT NULL)
  OR (NEW.pallets_enabled = 1) <> (NEW.pallet_template_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'shift pallets: capacity and template exactly when enabled');
END;
-- A planned shift prints its pallets with this template once a station
-- opens it, so the template is not deleted meanwhile (`template_in_use`).
CREATE INDEX shifts_planned_pallet_template ON shifts (pallet_template_id)
  WHERE status = 'planned';
