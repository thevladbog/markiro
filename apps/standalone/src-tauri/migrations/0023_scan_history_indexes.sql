-- The scan lag fix: two indexes for the work screen's history read, which runs
-- after every scan (`SCAN_HISTORY_SQL`, `src/floor/work/scan-history.ts`).
-- `floor_scans_shift_time` gives the page of a shift's newest scans in the
-- index's own order, so the shift is no longer sorted for eight rows; the
-- partial `floor_scans_box` lets each listed scan's place in its box count the
-- box's accepted scans only, not every scan of the shift (only an accepted scan
-- of an aggregation shift has a box). With both, the read takes under 0.1 ms
-- at 100 000 scans in a shift, against 92 ms with the paged read alone.
--
-- `floor_scans_shift (host_id, device_id, shift_id)` is a prefix of
-- `floor_scans_shift_time` and stays on purpose: the shift's other reads and
-- deletes (the validation counts, the retention's delete) keep the plans pinned
-- on both SQLite builds, and it costs one more B-tree insert per scan. A later
-- migration may drop it once those plans are re-pinned. The receipt's check of
-- a marked box's other scans moves to `floor_scans_box` (the box, not its
-- whole shift).
--
-- Additive: no row changes, no foreign key (see `0006`). Building them reads
-- the whole table once, in the shell's setup before the window appears.
CREATE INDEX floor_scans_shift_time ON floor_scans (host_id, device_id, shift_id, scanned_at);

CREATE INDEX floor_scans_box ON floor_scans (host_id, device_id, box_id) WHERE box_id IS NOT NULL;
