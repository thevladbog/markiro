-- Plan РК-С: the station's side of a host restored from a copy. The host's
-- `hello` names a new `restoreEpoch` at every restore (plan РК); the link
-- reads it on each connection, and a pairing that sees a new one owes the
-- host its SSCC blocks (`POST /v1/device/sscc/blocks/known`), a sync of the
-- copies from zero and its acknowledged records of the last 30 days again.
-- The row is that obligation: written before anything else is done, it
-- survives a restart, and the outbox waits while `reconciled_at` is NULL.
-- `refused` counts the blocks the host refused at the last reconciliation:
-- no serial of them is used again (`next_serial` past their end), and the
-- floor's status bar says how many. One row per pairing, no foreign key (see
-- `0006`); a forget empties the table with the copies
-- (`TableClass::Disposable`): the new pairing owes the host nothing of the
-- old one's. Times are UTC RFC 3339 text as `Date.toISOString` writes it.
CREATE TABLE floor_restore_epochs (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  reconciled_at TEXT,
  refused INTEGER NOT NULL DEFAULT 0 CHECK (refused >= 0),
  PRIMARY KEY (host_id, device_id)
);
