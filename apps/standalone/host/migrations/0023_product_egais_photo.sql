-- A product's EGAIS code, default counterparty and photo (plan ТОВ, parity
-- spec §5.5). The EGAIS code is the one the labels print (the cloud's
-- `products.egais_code`, its regulatory profile's primary code): trimmed,
-- 1 to 64 characters; only a product of ЧЗ group 15 carries one — the
-- host's rule (`routes/products.rs`), as the group may still change.
-- The default counterparty is a preference the office's shift dialog
-- offers; a counterparty archived later stays named here.
ALTER TABLE products ADD COLUMN egais_code TEXT
  CHECK (egais_code IS NULL OR length(trim(egais_code)) BETWEEN 1 AND 64);
ALTER TABLE products ADD COLUMN default_counterparty_id TEXT
  REFERENCES counterparties (id);
CREATE INDEX products_default_counterparty ON products (default_counterparty_id);

-- A product's photo: one JPEG the office made (at most 640 × 640 and
-- 300 000 bytes). Not in the station feed and not in a shift's snapshot;
-- a change takes no catalog revision. `checksum` is SHA-256 of `data` in
-- lower-case hex.
CREATE TABLE product_photos (
  product_id TEXT PRIMARY KEY REFERENCES products (id),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 640),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 640),
  data BLOB NOT NULL CHECK (length(data) BETWEEN 4 AND 300000),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  updated_at TEXT NOT NULL
);
