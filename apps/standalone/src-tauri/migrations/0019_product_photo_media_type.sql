-- Beta 3.2 (owner feedback «PNG без фона сохраняется с белым фоном»): the
-- station's copy of a product photo keeps the media type the host named, so a
-- transparent PNG or WebP is shown with its alpha. A copy stored before this
-- migration is a JPEG (the only type the host kept then).
ALTER TABLE ref_product_photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image/jpeg'
  CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp'));
