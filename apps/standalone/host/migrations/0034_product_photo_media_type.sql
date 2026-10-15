-- Beta 3.2 (owner feedback «PNG без фона сохраняется с белым фоном»): a photo
-- keeps its true media type, so a transparent PNG or WebP keeps its alpha.
-- The host derives the type from the picture's magic bytes
-- (`validate::product_photo`); a photo kept before this migration is a JPEG.
ALTER TABLE product_photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image/jpeg'
  CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp'));
