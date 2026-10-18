-- Plan ОЧ: a person resolves what the host did not take. A record the host
-- refused (`rejected`) or found in conflict (`conflict`) stays in the outbox
-- until someone resolves it on the queue screen: `resent` — the refused record
-- went again under a new id (`resent_as` names the record that carries it, data
-- byte for byte); `dismissed` — a person took it off the queue without sending
-- it. Who did it and when: `resolved_by` (the operator's id), `resolved_at` (UTC
-- RFC 3339 as `Date.toISOString` writes it). The retention keeps a shift while
-- any of its refused or conflicting records is unresolved, and the
-- reconciliation after a restore of the host (plan РК-С) leaves a resolved
-- record settled. Every record written before this migration, and every one
-- the host accepted, has NULL in all four.
ALTER TABLE outbox ADD COLUMN resolution TEXT
  CHECK (resolution IS NULL OR resolution IN ('resent', 'dismissed'));
ALTER TABLE outbox ADD COLUMN resent_as TEXT;
ALTER TABLE outbox ADD COLUMN resolved_at TEXT;
ALTER TABLE outbox ADD COLUMN resolved_by TEXT;

-- The blocks of SSCC serials the host gave this station that the station did
-- not keep (plan ОЧ; plan 2a6 dropped them silently): one that shares a serial
-- with a block the station holds — a host whose counter went back, restored or
-- reinstalled without its copy — or one that is not the block asked for
-- (another prefix or extension, an inverted range). The floor's status bar
-- counts the pairing's rows; each keeps what the host sent, for support. No
-- CHECK on the serials: a block that is not one is exactly what may be kept.
-- One row per block and pairing; no foreign key (see `0006`); a forget keeps
-- them (`TableClass::DeviceData`).
CREATE TABLE floor_block_drops (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL,
  from_serial INTEGER NOT NULL,
  to_serial INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('overlap', 'mismatch')),
  dropped_at TEXT NOT NULL,
  PRIMARY KEY (host_id, device_id, block_id)
);
