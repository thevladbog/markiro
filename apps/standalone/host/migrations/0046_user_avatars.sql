-- An office user's photo (plan АВА, owner decision of the office redesign):
-- one JPEG, PNG or WebP the office cropped to a square before it uploaded,
-- 128 to 4096 dots a side and at most 2 MiB. It lives in a table of its own,
-- not in `office_users`, so a list of users stays light and a copy of the
-- host carries the pictures with the rest of the file.
--
-- `media_type`, `width` and `height` are the host's reading of the picture's
-- own header (`avatar.rs`), never a word of the client. `checksum` is the
-- SHA-256 of `data` in lower-case hex, the raw route's ETag. `version` is
-- the host's time of the change in milliseconds, raised above the row's
-- previous version when the clock did not move forward, so a client that
-- caches by version never meets one twice; a change takes no host revision
-- (a photo is not in the station feed).
CREATE TABLE user_avatars (
  user_id TEXT PRIMARY KEY REFERENCES office_users (id),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width INTEGER NOT NULL CHECK (width BETWEEN 128 AND 4096),
  height INTEGER NOT NULL CHECK (height BETWEEN 128 AND 4096),
  data BLOB NOT NULL CHECK (length(data) BETWEEN 4 AND 2097152),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL
);
