-- A warehouse reprint of a record the cloud history import brought (plan СКЛ
-- on plan ИМП): the record names a `cloud_history_*` unit, box or pallet, not
-- a native one. `imported` marks it, so the office's history of a label tells
-- a native reprint from an imported one. Existing rows are native. A reprint
-- of an imported record changes none of what it printed: no code, box,
-- pallet or SSCC is written and no counter moves.
ALTER TABLE warehouse_reprints
  ADD COLUMN imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1));
