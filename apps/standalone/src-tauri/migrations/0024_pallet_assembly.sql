-- The box registry belongs to this pairing's current view of the host.
-- A full walk discards it and becomes usable when its last page is committed.
CREATE TABLE pallet_registry_state (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  until_at TEXT NOT NULL,
  restore_epoch TEXT,
  synced_at TEXT,
  can_open_pallets INTEGER CHECK (can_open_pallets IN (0, 1)),
  PRIMARY KEY (host_id, device_id)
);

CREATE TABLE pallet_registry_boxes (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sscc TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (host_id, device_id, sscc)
);

-- The pallet and its facts survive restart and forget, with their original owner.
CREATE TABLE pallet_assembly_pallets (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (json_valid(product)),
  opened_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  abandoned_at TEXT,
  closed_at TEXT,
  sscc TEXT UNIQUE,
  label TEXT CHECK (label IS NULL OR json_valid(label)),
  accepted_label TEXT CHECK (accepted_label IS NULL OR json_valid(accepted_label)),
  accepted_members TEXT CHECK (accepted_members IS NULL OR json_type(accepted_members) = 'array'),
  label_version INTEGER NOT NULL DEFAULT 0 CHECK (label_version >= 0),
  cancelled_at TEXT,
  print_state TEXT NOT NULL DEFAULT 'pending' CHECK (print_state IN ('pending', 'printing', 'sent', 'failed', 'unknown', 'confirmed')),
  print_reason TEXT,
  deferred INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  CHECK ((closed_at IS NULL) = (sscc IS NULL) AND (closed_at IS NULL) = (label IS NULL)),
  CHECK (abandoned_at IS NULL OR closed_at IS NULL),
  CHECK (cancelled_at IS NULL OR closed_at IS NOT NULL)
);

CREATE UNIQUE INDEX pallet_assembly_open ON pallet_assembly_pallets (host_id, device_id)
  WHERE closed_at IS NULL AND abandoned_at IS NULL;
CREATE INDEX pallet_assembly_prints ON pallet_assembly_pallets (host_id, device_id, closed_at)
  WHERE closed_at IS NOT NULL AND print_state <> 'confirmed';

-- The two kinds of pallet share the extension-1 serial pool. In particular,
-- re-pairing after a server reinstall cannot reuse an SSCC already on paper.
CREATE TRIGGER floor_pallet_sscc_not_in_assembly
BEFORE UPDATE OF sscc ON floor_pallets
WHEN NEW.sscc IS NOT NULL AND EXISTS (SELECT 1 FROM pallet_assembly_pallets WHERE sscc = NEW.sscc)
BEGIN
  SELECT RAISE(ABORT, 'pallet SSCC already held by warehouse assembly');
END;

CREATE TABLE pallet_assembly_members (
  add_id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  pallet_id TEXT NOT NULL,
  sscc TEXT NOT NULL,
  shift_number TEXT,
  production_date TEXT,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  removed_at TEXT
);
CREATE INDEX pallet_assembly_members_pallet ON pallet_assembly_members (pallet_id, host_id, device_id);
CREATE INDEX pallet_assembly_members_box ON pallet_assembly_members (host_id, device_id, sscc)
  WHERE removed_at IS NULL;

CREATE TABLE pallet_assembly_outbox (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  pallet_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  box_sscc TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  acked_at TEXT,
  outcome TEXT CHECK (outcome IN ('accepted', 'rejected')),
  outcome_code TEXT,
  outcome_details TEXT CHECK (outcome_details IS NULL OR json_valid(outcome_details)),
  replay_blocked INTEGER NOT NULL DEFAULT 0 CHECK (replay_blocked IN (0, 1)),
  previous_receipt TEXT CHECK (previous_receipt IS NULL OR json_valid(previous_receipt)),
  acknowledged_at TEXT,
  resolved_at TEXT,
  -- An authorized replacement occupies the causal position of the refused close.
  priority_seq INTEGER,
  replaces_id TEXT UNIQUE,
  correction_label TEXT CHECK (correction_label IS NULL OR json_valid(correction_label)),
  correction_boxes TEXT CHECK (correction_boxes IS NULL OR json_type(correction_boxes) = 'array'),
  CHECK ((priority_seq IS NULL) = (replaces_id IS NULL)),
  CHECK ((replaces_id IS NULL) = (correction_label IS NULL) AND (replaces_id IS NULL) = (correction_boxes IS NULL)),
  CHECK ((acked_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX pallet_assembly_outbox_unsent ON pallet_assembly_outbox (host_id, device_id, seq)
  WHERE acked_at IS NULL;
CREATE INDEX pallet_assembly_outbox_pallet ON pallet_assembly_outbox (pallet_id, host_id, device_id, seq);
CREATE INDEX pallet_assembly_outbox_rejected ON pallet_assembly_outbox (host_id, device_id, seq)
  WHERE (outcome = 'rejected' OR replay_blocked = 1) AND resolved_at IS NULL;
CREATE INDEX pallet_assembly_outbox_accepted ON pallet_assembly_outbox (host_id, device_id, acked_at)
  WHERE outcome = 'accepted';

CREATE TABLE pallet_assembly_print_attempts (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  pallet_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  operator_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  retry_reason TEXT,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IN ('sent', 'failed', 'unknown')),
  reason TEXT,
  PRIMARY KEY (host_id, device_id, pallet_id, attempt),
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
