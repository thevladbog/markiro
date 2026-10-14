-- Plan ОБН-1 (spec §10.11.7): when the host first heard a device report the
-- version and protocol it runs now (the shell's `X-Markiro-App-Version` on
-- every request). `app_version` and `protocol` exist since 0002 and hold what
-- the device said when it paired until it reports; NULL here means it has
-- not reported since (an app before plan ОБН-1).
ALTER TABLE devices ADD COLUMN version_seen_at TEXT;
