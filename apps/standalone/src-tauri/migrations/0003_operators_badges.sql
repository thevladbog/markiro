-- The station's copies of operators and their badges (stage 1 spec §5.3,
-- plan 1d4). The change feed sends an operator only while active and a badge
-- only while not revoked; each leaves as a tombstone, and the webview's
-- reference sync deletes its copy. The station's sign-in (plan 1f) reads
-- them; `device_forget` empties both tables (`LocalDb::clear_copies`).
--
-- No foreign key from a badge to its operator: the feed keeps sending the
-- badge of an operator who was turned off, and a badge can come in a page
-- before its operator. No uniqueness besides the key either: the host keeps
-- personnel numbers and active badges unique, and a copy that refused a row
-- would abort its whole page and stop the sync for good. `pin_phc` and
-- `badge_phc` are PBKDF2 PHC strings, never a PIN or a badge code.
CREATE TABLE ref_operators (
  id TEXT PRIMARY KEY,
  -- The personnel number: 3-12 digits, leading zeros included.
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  pin_phc TEXT NOT NULL,
  rev INTEGER NOT NULL
);

CREATE INDEX ref_operators_login ON ref_operators (login);

CREATE TABLE ref_operator_badges (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  badge_phc TEXT NOT NULL,
  label TEXT,
  rev INTEGER NOT NULL
);

CREATE INDEX ref_operator_badges_operator ON ref_operator_badges (operator_id);

CREATE INDEX ref_operator_badges_phc ON ref_operator_badges (badge_phc);
