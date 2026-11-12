-- The live recipe belongs to the catalog. Open and closed shifts keep their own snapshot.
ALTER TABLE products ADD COLUMN set_items TEXT CHECK (
  set_items IS NULL OR (json_valid(set_items) AND json_type(set_items) = 'array'
    AND json_array_length(set_items) > 0)
);

-- An assembly is immutable. Conflicts preserve the submitted facts without reserving any codes.
CREATE TABLE set_assemblies (
  device_id TEXT NOT NULL REFERENCES devices (id),
  record_id TEXT NOT NULL,
  shift_id TEXT NOT NULL REFERENCES shifts (id),
  operator_id TEXT,
  assembled_at TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'conflict')),
  PRIMARY KEY (device_id, record_id)
);
CREATE INDEX set_assemblies_shift ON set_assemblies (shift_id, assembled_at, device_id, record_id);

-- Both the outer mark and every component must be unique across accepted sets.
CREATE TABLE set_codes (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  device_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  FOREIGN KEY (device_id, record_id) REFERENCES set_assemblies (device_id, record_id)
);

CREATE INDEX set_assemblies_accepted ON set_assemblies (shift_id, device_id)
  WHERE outcome = 'accepted';
