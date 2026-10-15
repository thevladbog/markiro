-- Beta 3.2 (owner feedback «история сканирования»): the office lists a
-- shift's scans newest first a page at a time by a cursor of (scanned_at, id)
-- (`routes/office_scan_history.rs`). `scans_shift` alone finds the shift's
-- rows but leaves the host sorting every one of them for every page; with the
-- instant and the id after the shift the page is read straight off the index,
-- so a page costs the same at the first row of a long shift and at the last.
-- The plan test (`office_scan_history.rs`) fails on a TEMP B-TREE.
CREATE INDEX scans_shift_time ON scans (shift_id, scanned_at DESC, id DESC);
