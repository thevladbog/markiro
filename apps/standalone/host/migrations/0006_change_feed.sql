-- Deleted reference records, so devices syncing the change feed learn about
-- deletions (spec §4.4). One row per deleted record; a re-deletion moves it
-- to the newer revision.
CREATE TABLE tombstones (
  entity TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY (entity, id)
);
CREATE INDEX tombstones_rev ON tombstones (rev);
CREATE INDEX lines_rev ON lines (rev);
