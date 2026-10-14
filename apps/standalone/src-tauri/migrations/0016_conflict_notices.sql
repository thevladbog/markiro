-- Plan КНФ, the station's part: what the host tells this station of its own
-- conflicts. `office_reviewed_at` — the host's instant at which the office
-- marked a conflicting record's conflict reviewed; the station then resolves
-- the record itself (`resolution = 'dismissed'`, `resolved_at` its own clock,
-- `resolved_by` NULL: no operator of this station did it), so the status bar,
-- the queue screen and the retention stop counting it. NULL for every record
-- written before this migration and for every one the office did not review.
ALTER TABLE outbox ADD COLUMN office_reviewed_at TEXT
  CHECK (office_reviewed_at IS NULL OR resolved_at IS NOT NULL);

-- The scans of this station an earlier scan elsewhere took the code from
-- (`GET /v1/device/displacements`): the host had accepted them, so no receipt
-- says it. One row per conflict and pairing, as the host sent it; the winner
-- by its shift's number and whether it is this station's own (never a
-- device's name: the station keeps no list of devices). `learned_at` and
-- `resolved_at` are this computer's clock (`Date.toISOString`), `detected_at`
-- and `office_reviewed_at` the host's. A person resolves a row on the queue
-- screen (`resolved_by` the operator), or the office's review does
-- (`office_reviewed_at`, `resolved_by` NULL). `DeviceData`, no `shift_id`
-- retention: the rows are few, and the newest one is the cursor of the next
-- read, which must never go back. No foreign key (see `0006`).
CREATE TABLE floor_displacements (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  conflict_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  box_id TEXT,
  detected_at TEXT NOT NULL,
  winner_shift_number TEXT NOT NULL,
  winner_same_device INTEGER NOT NULL CHECK (winner_same_device IN (0, 1)),
  winner_scanned_at TEXT NOT NULL,
  learned_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  office_reviewed_at TEXT,
  -- The shift's number and the box's SSCC as they were when the row was first
  -- written (the host's, or this station's SSCC of a box the host still had
  -- open), never taken again: the retention deletes the shift's copy and its
  -- boxes, and the row must still say which box to check.
  shift_number TEXT,
  box_sscc TEXT,
  PRIMARY KEY (host_id, device_id, conflict_id),
  CHECK (resolved_by IS NULL OR resolved_at IS NOT NULL),
  CHECK (office_reviewed_at IS NULL OR resolved_at IS NOT NULL)
);
-- One row per record too: a restored host writes a conflict again under a
-- new id and a later instant, and the station keeps the row it has.
CREATE UNIQUE INDEX floor_displacements_record
  ON floor_displacements (host_id, device_id, record_id);
-- The cursor of the next read: the pairing's newest detection.
CREATE INDEX floor_displacements_cursor
  ON floor_displacements (host_id, device_id, detected_at, conflict_id);
-- The open ones: the status bar's count, the queue screen, the status read.
CREATE INDEX floor_displacements_open ON floor_displacements (host_id, device_id)
  WHERE resolved_at IS NULL;
