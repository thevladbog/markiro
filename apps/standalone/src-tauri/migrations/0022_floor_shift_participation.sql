-- Plan 2b (several devices in one shift), the station's part: what the host's
-- list (`GET /v1/device/shifts`) and the answers of an entry and a leave say of
-- a shift several devices may work — the line's limit, every participant, this
-- station's own state, the whole shift's totals and each device's part — as the
-- last read saw it, one row per shift of the pairing; and this station's own
-- pending pause («Выйти из смены» while the host was away, or not yet answered).
--
-- A cache of the host's figures, never recalculated here: a read whose `as_of`
-- (the host's time of the read, `totals.asOf`) is older than the row's replaces
-- nothing, so two overlapping refreshes never take the figures back — unless
-- this computer saw the row more than a minute before (`seen_at`), so a host
-- clock set back cannot freeze the figures. The
-- station's own counts stay in `floor_codes` and `floor_boxes`; the screens add
-- them to the others' part (`sharedCount`). A planned shift and a host before
-- protocol 7 carry none of these fields: no row, and the floor is stage 2a's.
--
-- `TableClass::Disposable`: a forget empties it with the copies (the next pairing
-- reads its own), and every list read deletes the rows of shifts the pairing no
-- longer keeps. The JSON columns hold the host's arrays and object as sent.
-- `as_of` is the host's instant, `leave_requested_at` this computer's
-- (`Date.toISOString`), `seen_at` Unix milliseconds of this computer, as
-- `floor_shifts.seen_at`. No foreign key (see `0006`).
--
-- The host's list carries `totals` and `byDevice` for an active shift only; a
-- closed shift in the list updates `max_stations`, `my_state` and
-- `participants` of a row already there and keeps its figures (the last the
-- station saw; never zeros); a closed shift with no row is not inserted, so
-- `totals`, `by_device` and `as_of` stay NOT NULL. `joined_rev` is this
-- station's own leave token (`participants[me].joinedRev`, the host revision of
-- the write that took its slot), sent back as `{ "joinedRev": n }` with a
-- pause; NULL while no answer named one (an older host).
CREATE TABLE floor_shift_participation (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  max_stations INTEGER NOT NULL CHECK (max_stations BETWEEN 1 AND 16),
  my_state TEXT CHECK (my_state IS NULL OR my_state IN ('active', 'left', 'closed')),
  participants TEXT NOT NULL
    CHECK (json_valid(participants) AND json_type(participants) = 'array'),
  totals TEXT NOT NULL CHECK (json_valid(totals) AND json_type(totals) = 'object'),
  by_device TEXT NOT NULL CHECK (json_valid(by_device) AND json_type(by_device) = 'array'),
  as_of TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  leave_requested_at TEXT,
  joined_rev INTEGER CHECK (joined_rev IS NULL OR joined_rev >= 0),
  PRIMARY KEY (host_id, device_id, shift_id)
);
