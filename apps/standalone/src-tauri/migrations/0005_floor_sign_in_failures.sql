-- Failed operator sign-ins on this station (plan 1f): one row for the whole
-- station (`station`) and one per operator who failed since their last
-- sign-in (`operator:<operator id>`), never a typed personnel number, PIN or
-- badge code. `failures` counts the failures since the last sign-in or the
-- end of the last lockout; `locked_at` is Unix milliseconds on this
-- computer's clock when the current lockout began, NULL when there is none.
-- The webview's sign-in writes the rows (`src/floor/lockout.ts`).
--
-- The first table of data this device owns rather than a copy of the
-- host's, and disposable on purpose: `device_forget` empties it with the
-- copies (`LocalDb::clear_copies` takes every table), since a new pairing
-- brings a new roster and the counts of the old one mean nothing there. A
-- later table this device must keep across a forget (the scan journal, the
-- outbox) still needs its own decision, as `clear_copies` says.
CREATE TABLE floor_sign_in_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures > 0),
  locked_at INTEGER
);
