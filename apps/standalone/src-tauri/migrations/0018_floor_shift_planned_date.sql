-- Beta 3 (owner feedback «дата смены не видна на станции»): the station shows
-- the shift's own date («Дата смены», the cloud's `plannedDate`) beside the
-- production date on its shift cards, new-shift form and work screen.
--
-- `floor_shifts.planned_date`: the civil date `YYYY-MM-DD` the host's shift
-- list names (`DeviceShift.plannedDate`). NULL for a copy a host before beta 3
-- sent (the field is optional on the wire) and for a copy made before this
-- migration; the screens then show the production date alone, nothing extra.
-- Nullable on purpose: a queued or older copy has none, and the next list
-- refresh fills it. No default: a constant would be the wrong date.
ALTER TABLE floor_shifts ADD COLUMN planned_date TEXT
  CHECK (planned_date IS NULL
    OR planned_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
