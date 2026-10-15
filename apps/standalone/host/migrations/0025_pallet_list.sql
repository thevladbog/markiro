-- The office's list of every pallet of the site (plan КРТ, parity spec
-- §5.3, the cloud's `GET /pallets`): open pallets first, then closed
-- newest first, paged by a key (`routes/office_pallets.rs`). The key is
-- `ifnull(closed_at, '~')`: a device's instant starts with a digit, so
-- '~' sorts after every one and an open pallet before every closed one
-- when read backwards. Indexes only: no row is written or changed.
CREATE INDEX pallets_list_order ON pallets (ifnull(closed_at, '~'), id);

-- A box card reads every item of a box through the accepted scans into it
-- (`scans_ok_box`, plan «Поиск кодов», `0017`). A rebuild of `scans`
-- (plan РЕЖ, `0020`) drops the table's indexes with it; this makes the
-- index again if that rebuild did not. A migration after `0020` may index
-- `scans` (parity spec §8.1).
CREATE INDEX IF NOT EXISTS scans_ok_box ON scans (box_id) WHERE verdict = 'ok';
