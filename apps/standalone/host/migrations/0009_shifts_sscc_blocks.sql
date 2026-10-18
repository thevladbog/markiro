-- Shifts and SSCC blocks (stage 2a spec §4.1). A shift is planned in the
-- office or created at a station while the host answers; a station opens it,
-- and the host freezes its snapshot then (the product, the box template's
-- layout, the SSCC issuer prefix and the counterparty's name), so a change of
-- the catalog never changes a shift that runs. Stage 2a puts one device on a
-- shift. Caps that only keep a typing slip out (a box's capacity, a plan)
-- live in `validate.rs`; the CHECKs here hold what no row may break.

-- The number of a shift is drawn from a counter per month (`MONYY`), as the
-- cloud's `shift_number_counters`, without a tenant.
CREATE TABLE shift_number_counters (
  month_key TEXT PRIMARY KEY CHECK (length(month_key) = 5),
  last_seq INTEGER NOT NULL CHECK (last_seq > 0)
);

-- `box_template_id` has no foreign key: once the shift is open its layout
-- lives in `snapshot`, and a template a planned shift names is never deleted
-- (`template_in_use`, `routes/templates.rs`). `create_request_id` is a
-- station's (a repeated create answers the same shift); an office's is NULL,
-- and NULLs never collide in the unique key. `mode` and `pallets_enabled`
-- are the cloud's shape; stage 2a takes only aggregation without pallets.
CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  number_month_key TEXT NOT NULL,
  number_seq INTEGER NOT NULL CHECK (number_seq > 0),
  created_from TEXT NOT NULL CHECK (created_from IN ('office', 'station')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('office_user', 'device')),
  created_by TEXT NOT NULL,
  create_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
  mode TEXT NOT NULL CHECK (mode IN ('aggregation', 'validation')),
  pallets_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pallets_enabled IN (0, 1)),
  product_id TEXT NOT NULL REFERENCES products (id),
  line_id TEXT NOT NULL REFERENCES lines (id),
  counterparty_id TEXT REFERENCES counterparties (id),
  production_date TEXT NOT NULL
    CHECK (production_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  planned_qty INTEGER CHECK (planned_qty IS NULL OR planned_qty > 0),
  box_capacity INTEGER NOT NULL CHECK (box_capacity > 0),
  pallet_box_capacity INTEGER CHECK (pallet_box_capacity IS NULL OR pallet_box_capacity > 0),
  box_template_id TEXT NOT NULL,
  pallet_template_id TEXT,
  owner_device_id TEXT REFERENCES devices (id),
  snapshot TEXT CHECK (snapshot IS NULL OR (json_valid(snapshot)
    AND json_type(snapshot) = 'object' AND length(CAST(snapshot AS BLOB)) <= 327680)),
  opened_at TEXT,
  closed_at TEXT,
  closed_by_kind TEXT CHECK (closed_by_kind IS NULL OR closed_by_kind IN ('office_user', 'device')),
  closed_by TEXT,
  close_reason_code TEXT,
  close_reason_text TEXT,
  late_data_at TEXT,
  created_at TEXT NOT NULL,
  rev INTEGER NOT NULL,
  UNIQUE (number_month_key, number_seq),
  UNIQUE (created_by, create_request_id),
  -- The lifecycle, whole: a planned shift is unopened; an active or closed
  -- one has its snapshot, its opening and its owner; a closed one says when
  -- and by whom it was closed, any other says neither. The reason columns
  -- and `late_data_at` are left open for the station's close (plan 2a2).
  CHECK (CASE WHEN status = 'planned'
    THEN snapshot IS NULL AND opened_at IS NULL AND owner_device_id IS NULL
    ELSE snapshot IS NOT NULL AND opened_at IS NOT NULL AND owner_device_id IS NOT NULL END),
  CHECK (CASE WHEN status = 'closed'
    THEN closed_at IS NOT NULL AND closed_by_kind IS NOT NULL AND closed_by IS NOT NULL
    ELSE closed_at IS NULL AND closed_by_kind IS NULL AND closed_by IS NULL END)
);
CREATE INDEX shifts_line_status ON shifts (line_id, status);
CREATE INDEX shifts_status_production_date ON shifts (status, production_date);
CREATE INDEX shifts_planned_box_template ON shifts (box_template_id) WHERE status = 'planned';

-- The devices that entered a shift: at most one row per shift in stage 2a.
CREATE TABLE shift_participants (
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  first_entered_at TEXT NOT NULL,
  last_entered_at TEXT NOT NULL,
  PRIMARY KEY (shift_id, device_id)
);
CREATE INDEX shift_participants_device ON shift_participants (device_id);

-- A block of SSCC serials issued to one device. Issuing moves its counter
-- past the block in the same transaction, so a block always lies below the
-- counter, and the counter's forward-only rule (`sscc_below_floor`) keeps
-- every issued serial from being issued again. A repeated request of the
-- same device answers the same block.
CREATE TABLE sscc_blocks (
  id TEXT PRIMARY KEY,
  issuer_prefix TEXT NOT NULL,
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  device_id TEXT NOT NULL REFERENCES devices (id),
  request_id TEXT NOT NULL,
  from_serial INTEGER NOT NULL CHECK (from_serial >= 0),
  to_serial INTEGER NOT NULL,
  consumed_through INTEGER,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (device_id, request_id),
  CHECK (to_serial >= from_serial),
  FOREIGN KEY (issuer_prefix, extension) REFERENCES sscc_counters (issuer_prefix, extension)
);
CREATE INDEX sscc_blocks_prefix_device ON sscc_blocks (issuer_prefix, extension, device_id);
