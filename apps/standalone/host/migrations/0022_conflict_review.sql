-- Conflicts and the review of a shift (plan КНФ, parity spec §5.2): the
-- office reads `code_conflicts`, which the facts have written since stage 2a
-- (`facts/registry.rs`), and marks a conflict reviewed. Columns and indexes
-- are added; no table is rebuilt, and none of `scans` or `code_owners` (plan
-- РЕЖ rebuilds those) gets an index here.

-- How the loser lost its code: `late` — its scan arrived after the owner's
-- and was scanned later, and its receipt said `conflict`; `displaced` — it
-- owned the code and an earlier scan that arrived later took it, and its
-- receipt had said `accepted`. A row written before this migration takes its
-- kind from the loser's receipt, which the host keeps for good.
ALTER TABLE code_conflicts ADD COLUMN kind TEXT NOT NULL DEFAULT 'late'
  CHECK (kind IN ('late', 'displaced'));
UPDATE code_conflicts SET kind = 'displaced'
WHERE EXISTS (
  SELECT 1 FROM scans s
  JOIN fact_receipts r ON r.device_id = s.device_id AND r.record_id = s.record_id
  WHERE s.id = code_conflicts.loser_scan_id AND r.outcome = 'accepted'
);

-- Who marked the conflict reviewed (`reviewed_at` exists since 0010, nothing
-- set it before this plan): both or neither. An office user is never
-- deleted, only turned off.
ALTER TABLE code_conflicts ADD COLUMN reviewed_by TEXT REFERENCES office_users (id)
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL));

-- A device asks after its own scans' conflicts by their scans (plan КНФ,
-- task 7). The office's filter by the losing shift reads the list in its
-- order and looks each loser's scan up by its key instead.
CREATE INDEX code_conflicts_loser ON code_conflicts (loser_scan_id);
-- The office's list reads newest detection first, a device's displacements
-- oldest first after a cursor.
CREATE INDEX code_conflicts_detected ON code_conflicts (detected_at, id);

-- A shift's refused records: a shift holds one receipt per scan, its
-- refusals are a handful (thousands after a restore); this reads only those.
CREATE INDEX fact_receipts_rejected ON fact_receipts (shift_id, received_at)
  WHERE outcome = 'rejected';

-- A shift's exceptions, newest first (0010 and 0012 index them by box,
-- pallet and record only).
CREATE INDEX box_exceptions_shift ON box_exceptions (shift_id, occurred_at);
CREATE INDEX pallet_exceptions_shift ON pallet_exceptions (shift_id, occurred_at);
