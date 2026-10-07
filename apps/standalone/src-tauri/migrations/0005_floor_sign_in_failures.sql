-- Failed operator sign-ins on this station (plan 1f): one row for the whole
-- station (`station`) and one per operator who failed since their last
-- sign-in (`operator:<operator id>`), never a typed personnel number, PIN or
-- badge code. `failures` counts the failures since the last sign-in of that
-- operator or the end of the last lockout (for `station`: within a rolling
-- quiet interval, which a sign-in does not reset); `locked_at` is Unix
-- milliseconds on this computer's clock when the current lockout began, NULL
-- when there is none; `last_failure_at` is when the latest failure counted
-- was recorded, from which the station's quiet interval runs. The webview's
-- sign-in writes the rows (`src/floor/lockout.ts`).
--
-- The first table of data this device owns rather than a copy of the
-- host's, and disposable on purpose: `device_forget` empties it with the
-- copies (`LocalDb::clear_copies` takes every table), since a forgotten
-- pairing's roster is gone and the counts of its people mean nothing. The
-- sync's wipe (another pairing, a changed schema) keeps it on purpose: the
-- failures are not a copy of the host's data, and a wipe is no sign-in. A later
-- table this device must keep across a forget (the scan journal, the outbox)
-- still needs its own decision, as `clear_copies` says.
CREATE TABLE floor_sign_in_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures > 0),
  locked_at INTEGER,
  last_failure_at INTEGER NOT NULL
);
