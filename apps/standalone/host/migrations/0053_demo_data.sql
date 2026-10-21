-- Demo data (spec 2026-10-21-standalone-wizard-demo-data-design): the wizard's demo product. A
-- shift is a demo shift when its product is, so its facts, boxes, pallets and exports are demo
-- too; the flag is set only by the wizard and never changes.
ALTER TABLE products ADD COLUMN demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1));

-- The ids of demo shifts «Удалить демо-данные» removed: a station's late fact of one is
-- acknowledged and dropped, so its queue drains without an error.
CREATE TABLE demo_removed_shifts (
  id TEXT PRIMARY KEY,
  removed_at TEXT NOT NULL
);

-- A demo shift's number is drawn from the counter `DEMO` (`DEMO-001`, decision Д3), so it spends
-- no number of the organization's months. The table only had five-character month keys
-- (`OCT26`); it is rebuilt with its rows and rowids. Nothing refers to it: no foreign key,
-- trigger or view names it.
CREATE TABLE shift_number_counters_rebuilt (
  month_key TEXT PRIMARY KEY CHECK (length(month_key) = 5 OR month_key = 'DEMO'),
  last_seq INTEGER NOT NULL CHECK (last_seq > 0)
);
INSERT INTO shift_number_counters_rebuilt (rowid, month_key, last_seq)
  SELECT rowid, month_key, last_seq FROM shift_number_counters;
DROP TABLE shift_number_counters;
ALTER TABLE shift_number_counters_rebuilt RENAME TO shift_number_counters;

-- The statistics leave the demo product's shifts out (`product_id NOT IN (… demo = 1)`): this
-- index holds that one row, so no query reads the catalog for it.
CREATE INDEX products_demo ON products (id) WHERE demo = 1;
