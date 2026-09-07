# US-03 receiving draft persistence plan

**Design:** [approved draft behavior](../specs/2026-09-06-us-03-receiving-draft-persistence.md).
**Execution:** sequential because contracts, migration and transaction semantics
are coupled; independent review follows implementation. No commit, push or release.

1. Add failing public contract tests for create/save commands and lossless draft
   records. Implement strict schemas without weakening incomplete-draft input.
   Add schema/migration tests and additive migration 0121 with tenant foreign keys,
   lifecycle guards and exact quantity storage. Rebuild DB/contracts consumers.
2. Add failing owned-database store tests. Implement create/read/full replacement,
   fresh authorization, reference checks, row locking, tenant-command operation
   receipts and exact atomic audit. Verify races, rollback and no lot mutations.
3. Add failing real-HTTP tests. Register only the three draft routes in the US
   composition and narrowly increase receiving write body bounds. Verify current
   MFA/role/host/origin protections and closed lifecycle routes. Update check-only
   CI and current implementation docs. Run focused then package gates, review the
   complete diff and report remaining browser/finalization boundaries explicitly.

## Verification — 2026-09-07

All three implementation steps are complete for the server-only scope. Failing
contract/schema/store/HTTP tests preceded implementation. The migration test also
reproduced an incorrectly escaped decimal separator before its correction; the
schema, unapplied migration and snapshot now agree. Snapshot comparison confirms
exactly five added tables, unchanged existing definitions and an intact chain.

Independent read-only storage and HTTP reviews report no remaining findings.
The review's second-writer test gap was filled with an actual different member,
original response/actor assertions and no additional audit. Same-key save races,
no-op receipts after later saves, number allocation races and inactive reference
branches have additional coverage.

- Contracts: 405 tests across 21 files, no skips.
- DB: 298 passing tests; 141 primary-environment tests explicitly skipped. The
  receiving schema/migration contributes 20 passing cases on owned scratch DBs.
- US API plus entry/environment regression: 366 tests across 19 files, no skips;
  this includes 29 receiving-store and six real-MFA receiving HTTP cases.
- Contracts, DB and API: typecheck, lint and builds pass. Admin consumer typecheck
  also passes; no frontend code was changed.
- Isolation/browser-entry contracts: 17 pass; release-lock checker passes.
  Compiled runtime/owner-command smoke: four pass, with readiness still closed.
- Repository formatting and whitespace checks pass.

The broader API package run has 1,804 passing tests and 1,411 skips, but is not
green: eight primary-product files fail in preparation (nine suites) because
primary DB/auth configuration is absent, followed by three teardown errors from
the failed setup. These are the same environment-dependent boundaries recorded
in the preceding document increment. No US test failed. Primary configuration was
deliberately not loaded and these primary integration tests were not repaired or
claimed as verified by this US increment.

The first full DB run reproduced a legacy catalog migration test comparing host
time with PostgreSQL time. It now captures the DB clock immediately before the
unchanged migration, retaining both full legacy-row equality and timestamp-order
assertions. Focused rerun passes 22 cases; the subsequent full DB run is green.
This test-only correction also passed independent review.

Only randomly owned, disposable synthetic US databases were migrated. The base US
database, primary environment, primary database and operational workflows were
not changed. No browser/UI, finalization, hosted infrastructure, external service,
hardware, attachment or export acceptance is claimed. The local graph is absent,
so no graph update was applicable. Work stays uncommitted in `codex/us-mvp`; no
push, PR, merge, release, publication or deployment is included.
