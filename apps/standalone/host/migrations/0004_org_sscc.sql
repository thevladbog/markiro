-- The organization (one row). Default label template columns are added with
-- the templates table in plan 1e.
CREATE TABLE org_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  inn TEXT CHECK (inn IS NULL OR (length(inn) IN (10, 12) AND inn NOT GLOB '*[^0-9]*')),
  gln TEXT NOT NULL CHECK (length(gln) = 13 AND gln NOT GLOB '*[^0-9]*'),
  gs1_prefixes TEXT NOT NULL CHECK (json_valid(gs1_prefixes) AND json_type(gs1_prefixes) = 'array'),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  rev INTEGER NOT NULL
);

-- SSCC counters per issuer prefix (the first 9 digits of the GLN, as in the
-- cloud) and extension digit (0 = box, 1 = pallet).
CREATE TABLE sscc_counters (
  issuer_prefix TEXT NOT NULL
    CHECK (length(issuer_prefix) BETWEEN 4 AND 12 AND issuer_prefix NOT GLOB '*[^0-9]*'),
  extension INTEGER NOT NULL CHECK (extension IN (0, 1)),
  next_serial INTEGER NOT NULL CHECK (next_serial >= 0),
  rev INTEGER NOT NULL,
  PRIMARY KEY (issuer_prefix, extension)
);
