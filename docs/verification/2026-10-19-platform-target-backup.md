# Target-local recovery backup adapter verification

Scope: trusted operator library for a recovery copy of an already imported,
stopped target database. No source import, server operation, DNS operation, image
publication or prepared-target admission is performed by this change.

The archive now copies worker output and verifies cleanup before its final writer
fence observation. Publication follows that observation. Focused tests first
failed because the old order left owned workers/volumes present; they pass after
the ordering change. A failed final observation publishes neither dump nor
inventory, and failure evidence remains private.

`createTargetRecoveryBackup` runs existing concrete Docker and PostgreSQL
observers, archive production and isolated restore under the deployment lock.
Tests replace only the process/machine-ID boundaries with existing repository
fixtures; they execute the actual validators, private-file handling, archive,
restore, journal lock and observations. These are local synthetic tests, not a
Linux target or live-data acceptance.

The test matrix covers physical host/image/network mismatch, active workload,
stopped foreign network member, database sessions/prepared transactions, stale or
wrong HBA, connection host/port/database/network retargeting, wrong runtime socket,
executable, provenance, executor and architecture, failed source verification,
altered protected input, failed final re-observation, unreaped subprocess,
uncertain process durability, archive/restore cleanup failure, unresolved journal,
and concurrent deployment at all four boundaries. The enforcement digest is
shared with host command admission, with no relaxed inventory or image checks.

Controller ruling for the existing state helper: it retains the lock only when
`durabilityUncertain` is true and sanitizes other callback flags. The adapter
therefore latches process termination/durability uncertainty before backup/restore
sanitization and translates it or unverified cleanup to durability uncertainty
before crossing that helper. The outer sanitized error separately preserves an
unconfirmed termination flag and requires recovery. A regression first reproduced
loss of a process durability flag, then passed with the latch.

Automated local verification passed:

- `node --test deploy/platform/test/target-backup.test.mjs deploy/platform/test/backup-archive.test.mjs`: 31/31, zero failures/skips (final rerun after readability refactor).
- `node --test deploy/platform/test/*.test.mjs`: 471/471, zero failures/skips (178.1s).
- Scoped ESLint and Prettier checks on all changed JavaScript/docs passed.
- `git diff --check` passed.

Commands used Node 24.18.0 and the repository pnpm through Corepack. The detailed
RED/GREEN evidence is retained in the local task report under
`.superpowers/sdd/2026-10-19-platform-target-backup/task-1-report.md`.
Actual Linux AMD64 target invocation with reviewed source/image provenance, source
import/role transformation, TLS/effective roles, key continuity, egress and
independent off-host recovery remain unrun by these implementation tests.
