-- Beta 3 (owner feedback «нет фото продукции»): the station shows a product's
-- photo on its shift cards and on the new-shift product card.
--
-- `ref_products.photo_checksum`: the SHA-256 the host's product record names
-- (`photoChecksum`), NULL without a photo and for a record an older host sent.
ALTER TABLE ref_products ADD COLUMN photo_checksum TEXT;

-- The photo's bytes, fetched from `GET /v1/device/products/{id}/photo` when
-- `ref_products.photo_checksum` differs from `checksum` here. A JPEG of at most
-- 640 x 640 and 300 000 bytes, kept as standard base64 text (the webview reads
-- no BLOBs; 400 000 characters at most). `Disposable` (a copy of the host's
-- data): a forget empties it with the other copies, a sync from zero refills it.
-- No foreign key (the copies are wiped and refilled in any order).
CREATE TABLE ref_product_photos (
  product_id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 640),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 640),
  data_base64 TEXT NOT NULL CHECK (length(data_base64) BETWEEN 4 AND 400000)
);
