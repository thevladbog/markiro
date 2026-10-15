-- Beta 3 (owner feedback «нет фото продукции»): the station shows a product's
-- photo on its shift cards, so a photo set or cleared must reach the stations'
-- copies. `photo_rev` is the host revision of the last change of the photo (0:
-- never had one). It is a column of its own, not `products.rev`, because
-- `rev` is the office's `expectedRev`: the product dialog uploads a photo
-- while it is open and saves the product after, and a photo that moved `rev`
-- would turn that save into `stale_revision`. The feed re-sends the product at
-- `photo_rev` when it is above the product's own `rev`
-- (`routes/changes.rs`, `FEED_KEYS`), with the photo's checksum in the record.
ALTER TABLE products ADD COLUMN photo_rev INTEGER NOT NULL DEFAULT 0;

-- A photo that exists at the upgrade is announced at the product's own
-- revision (its record carries the checksum from now on); stations that
-- synced before this migration re-sync from zero (`SYNC_SCHEMA_VERSION` 5).
UPDATE products SET photo_rev = rev
  WHERE id IN (SELECT product_id FROM product_photos);
