-- Several devices in one shift of one line (plan 2b, spec
-- 2026-10-20-standalone-multi-station-shift-design.md §4.1). Columns only: no
-- table is rebuilt, so no rowid moves, no trigger is touched and the foreign
-- keys stay. SQLite tests the CHECK of an added column against every row
-- already there, so each column below is nullable or defaults to a value its
-- CHECK accepts, and the backfill runs after every column exists.

-- How many devices (stations and handhelds alike) may work one shift of the
-- line at a time. 1 keeps stage 2a's one device per shift.
ALTER TABLE lines ADD COLUMN max_stations INTEGER NOT NULL DEFAULT 1
  CHECK (max_stations BETWEEN 1 AND 16);

-- A participant's own part: `active` holds one of the line's slots, `left`
-- paused and freed it (it may come back), `closed` closed it for good.
ALTER TABLE shift_participants ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'left', 'closed'));
-- When the device last took a slot: its first entry, or its return from
-- `left`. Nullable only because an added NOT NULL column needs a constant
-- default; every writer sets it and readers fall back on first_entered_at.
ALTER TABLE shift_participants ADD COLUMN joined_at TEXT;
ALTER TABLE shift_participants ADD COLUMN left_at TEXT
  CHECK ((left_at IS NOT NULL) = (state = 'left'));
ALTER TABLE shift_participants ADD COLUMN closed_at TEXT
  CHECK ((closed_at IS NOT NULL) = (state = 'closed'));
-- Who closed the part: the device itself (its `shift_closed` fact) or the
-- office (its close of the whole shift).
ALTER TABLE shift_participants ADD COLUMN closed_by_kind TEXT
  CHECK ((closed_by_kind IS NULL AND state <> 'closed')
    OR (closed_by_kind IN ('device', 'office_user') AND state = 'closed'));
-- The device's own figures of its close, kept as evidence; the office closes
-- with none.
ALTER TABLE shift_participants ADD COLUMN closed_actual_qty INTEGER
  CHECK (closed_actual_qty IS NULL
    OR (closed_actual_qty >= 0 AND closed_by_kind = 'device'));
ALTER TABLE shift_participants ADD COLUMN closed_reason TEXT
  CHECK (closed_reason IS NULL OR closed_by_kind = 'device');
-- When the first fact of the device arrived after its part closed.
ALTER TABLE shift_participants ADD COLUMN late_data_at TEXT
  CHECK (late_data_at IS NULL OR state = 'closed');

-- A shared shift its last device closed without the reason the shift-wide
-- total needed (spec §12.9): it closes anyway, and the office gives the code.
ALTER TABLE shifts ADD COLUMN close_reason_missing INTEGER NOT NULL DEFAULT 0
  CHECK (close_reason_missing IN (0, 1))
  CHECK (close_reason_missing = 0 OR (status = 'closed' AND close_reason_code IS NULL));

-- The rows already there: one device per shift (stage 2a). Every participant
-- took its slot at its first entry. One of an open shift stays `active`; one
-- of a closed shift closed with it, by whoever closed the shift, with the
-- figures of its own accepted close when it sent one.
UPDATE shift_participants SET joined_at = first_entered_at;

UPDATE shift_participants SET
  state = 'closed',
  closed_at = (SELECT s.closed_at FROM shifts s WHERE s.id = shift_participants.shift_id),
  closed_by_kind = (SELECT CASE s.closed_by_kind WHEN 'device' THEN 'device' ELSE 'office_user' END
    FROM shifts s WHERE s.id = shift_participants.shift_id),
  closed_actual_qty = (SELECT e.actual_qty FROM shift_close_events e
    JOIN shifts s ON s.id = e.shift_id AND s.closed_by_kind = 'device'
    WHERE e.shift_id = shift_participants.shift_id
      AND e.device_id = shift_participants.device_id AND e.outcome = 'accepted'
    ORDER BY e.received_at, e.id LIMIT 1),
  closed_reason = (SELECT e.reason_code FROM shift_close_events e
    JOIN shifts s ON s.id = e.shift_id AND s.closed_by_kind = 'device'
    WHERE e.shift_id = shift_participants.shift_id
      AND e.device_id = shift_participants.device_id AND e.outcome = 'accepted'
    ORDER BY e.received_at, e.id LIMIT 1)
WHERE shift_id IN (SELECT id FROM shifts WHERE status = 'closed');
