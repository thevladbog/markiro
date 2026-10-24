-- Demo data (spec 2026-10-21-standalone-wizard-demo-data-design): the station's copy keeps the
-- demo product's flag, so its shifts show «Демо» and a demo shift previews its labels instead of
-- printing them. A copy stored before this migration is no demo; the host's record sends the
-- flag only when true.
ALTER TABLE ref_products ADD COLUMN demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1));
