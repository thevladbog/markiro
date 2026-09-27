-- Feed records the reference sync could not accept (stage 1 spec §5.4). A
-- record that fails its schema (damaged, or newer than this build reads) is
-- not applied, and an older local copy of it is deleted; it waits here until
-- the host changes it again or a build that reads it syncs from zero. The
-- webview's reference sync is the only writer. `reason` holds schema issue
-- paths and codes only, never a value; `seen_at` is Unix milliseconds on this
-- computer's clock.
CREATE TABLE sync_quarantine (
  entity TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  reason TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (entity, id)
);
