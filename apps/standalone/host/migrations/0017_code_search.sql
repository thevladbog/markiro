-- Code search in the office (owner's beta feedback «Поиск кодов»,
-- `routes/office_codes.rs`): the placements of codes are found by a box,
-- a GTIN or a period of scan instants as well as by a code and a shift,
-- each through an index. Indexes only: no row is written or changed.

-- Every accepted scan into a box, its code taken out since or not: each
-- names its box as its item does (`registry::claim`). `box_items_live`
-- holds only the live items; an index of every item by box would take the
-- live lists of a box away from it, one of accepted scans does not.
CREATE INDEX scans_ok_box ON scans (box_id) WHERE verdict = 'ok';

-- Accepted scans by product and by instant, newest first within either.
CREATE INDEX scans_ok_gtin ON scans (gtin14, scanned_at) WHERE verdict = 'ok';
CREATE INDEX scans_ok_scanned ON scans (scanned_at) WHERE verdict = 'ok';
