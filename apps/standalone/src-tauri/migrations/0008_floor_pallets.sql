-- The station's pallets (pilot spec §6.2, plan ПЛ-Ц): a shift with pallets
-- fills its open pallet with the boxes it closes, closes it with the serial of
-- one of this station's pallet blocks (extension 1) when it holds the shift's
-- boxes per pallet or when the operator closes it early, and keeps the
-- pallet's exceptions — a reprint, a disassembly — as `pallet_exception`
-- facts. Like `0006` and `0007` these are this device's data
-- (`TableClass::DeviceData`): every row carries the pairing it was written
-- under, a forget keeps them, and there is no foreign key (see `0006`).
--
-- The print jobs of a pallet's label are rows of `floor_print_jobs` with
-- `purpose = 'pallet'` (`0007` already allows it). The SSCC blocks of pallets
-- are rows of `floor_sscc_blocks` and `floor_block_requests` with
-- `extension = 1`. Times are UTC RFC 3339 text as `Date.toISOString` writes
-- it.

-- What the host's list says of a shift with pallets (protocol 3,
-- `DeviceShift`): boxes per pallet and the pallet template; both NULL for a
-- shift without pallets. `pallets_enabled` is in `0006` already.
ALTER TABLE floor_shifts ADD COLUMN pallet_box_capacity INTEGER
  CHECK (pallet_box_capacity IS NULL OR pallet_box_capacity > 0);
ALTER TABLE floor_shifts ADD COLUMN pallet_template_id TEXT;

-- The pallet a closed box joined as it closed, in the transaction of its
-- close (the `palletId` of its `box_closed` record); NULL in a shift without
-- pallets. Only a closed box is on a pallet.
ALTER TABLE floor_boxes ADD COLUMN pallet_id TEXT
  CHECK (pallet_id IS NULL OR closed_at IS NOT NULL);

CREATE INDEX floor_boxes_pallet ON floor_boxes (pallet_id) WHERE pallet_id IS NOT NULL;

-- A pallet of a shift: open from the close of its first box (`opened_at` is
-- that box's `closed_at`) until it closes with the serial of one of this
-- station's pallet blocks. How many boxes it holds is never stored: it is
-- counted, as the closed boxes with its `pallet_id` that are not taken apart.
-- A pallet's SSCC starts with the extension digit 1 and is never on two
-- pallets, under any pairing.
CREATE TABLE floor_pallets (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  sscc TEXT CHECK (sscc IS NULL OR (length(sscc) = 18 AND sscc NOT GLOB '*[^0-9]*'
    AND substr(sscc, 1, 1) = '1')),
  block_id TEXT,
  serial INTEGER,
  closed_by TEXT,
  disassembled_at TEXT,
  CHECK (CASE WHEN closed_at IS NULL
    THEN sscc IS NULL AND block_id IS NULL AND serial IS NULL AND disassembled_at IS NULL
    ELSE sscc IS NOT NULL AND block_id IS NOT NULL AND serial IS NOT NULL END)
);

CREATE UNIQUE INDEX floor_pallets_sscc ON floor_pallets (sscc) WHERE sscc IS NOT NULL;

-- One open pallet per shift and pairing: the station's rule, not the host's
-- (plan ПЛ-Х).
CREATE UNIQUE INDEX floor_pallets_open
  ON floor_pallets (host_id, device_id, shift_id) WHERE closed_at IS NULL;

-- A shift's pallets, open or closed: the closed ones of the exceptions screen
-- and the retention's delete of a purged shift's rows search it, as the other
-- tables of a shift's records do (`floor_boxes_shift`, `floor_print_jobs_shift`).
CREATE INDEX floor_pallets_shift ON floor_pallets (host_id, device_id, shift_id);

-- A pallet's exception (a `pallet_exception` fact): a reprint or a
-- disassembly, always with a reason code of its kind's list, and words only
-- with the reason `other`.
CREATE TABLE floor_pallet_exceptions (
  id TEXT NOT NULL PRIMARY KEY,
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reprint', 'disassemble')),
  pallet_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_text TEXT,
  occurred_at TEXT NOT NULL,
  operator_id TEXT,
  CHECK (reason_text IS NULL OR reason_code = 'other')
);
