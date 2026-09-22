# Device replacement execution acceptance

Initial verification: 2026-09-17. Final API verification resumed on 2026-09-22.
This is software verification and an operational acceptance record, not
production deployment or factory acceptance.

Implementation branch: `codex/device-replacement-execution`.
Branch base: `d26129dc45b18389e1b20ed330b482a6493d5580`.
Task 9 input: `f95af0efc6909a50a34058a3a4c41f8dd5162f41`.
Range reviewed against fetched `origin/main` at
`9d880fd620c0131a1eef780693448121f7adf090`.
The final Task 9 commit contains this record; exact commit/result metadata is also
retained in the ignored local SDD `task-9-report.md`.

The [approved design](../superpowers/specs/2026-09-16-device-replacement-execution-design.md)
and [implementation plan](../superpowers/plans/2026-09-16-device-replacement-execution.md)
cover ordinary and emergency replacement, source evidence recovery and both web
surfaces. The [operations guide](../operations/entitlements-p1b2.md#executing-a-replacement)
is the operator entrypoint.

## Required behavior and evidence owners

| Acceptance boundary                                                                 | Automated evidence                                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Prepared source remains unchanged; legacy rows survive                              | `device-replacement-admission.test.ts`; contract legacy parse cases; DB forward-migration byte comparison.                             |
| Old/stale/wrong-epoch clients cannot start ordinary drain                           | Authenticated capability integration and native header tests; no intent or admission write before proof.                               |
| Drain measures every required channel and survives restart                          | API readiness tests; Station SQLite reopen/ACK/race suites; Handheld Room/recovery/coordinator suites.                                 |
| Unknown/unsupported, conflicts, retained grants and server work prevent false ready | Strict contracts, report/storage high-water tests and web factual blocker scenarios.                                                   |
| One target after crash/retry/concurrent execution; fair durable repair scheduling   | PostgreSQL execution/repair/authority tests, >100 failed-row fairness, due/restart/backoff/replica checks and targeted CLI tests.      |
| No target authority before source revocation and server deadline                    | Target pairing, historical-epoch/upstream-boundary, waiting write-off/evidence tests and native durable fence tests.                   |
| Recovery cannot start new production                                                | Real API restricted credential route matrix, tenant/subscription denials, native admission tests and exact saved-print reconciliation. |
| Recovery retains evidence and reports incompleteness honestly                       | Replay/quarantine/roster tests; zero-completion revocation; `evidence_unavailable` exact audit.                                        |
| Cabinet/SaaS retain mutation identities and factual blockers                        | Component/client matrices plus local Chromium RU/EN at 1440/390 px.                                                                    |
| Migrations precede readers and every changed runtime has a delivery/check owner     | Production bundle deployment contracts, CI classification and browser suite ownership assertions.                                      |

## Automated checks

The isolated verification uses the existing local PostgreSQL 17
container `markiro-task6-postgres` on loopback port 55466, per-suite disposable
databases, synthetic example configuration and local SQLite/Room. No user `.env`
or shared/production database is loaded or rewritten.

The final command sequence is dependency-ordered shared builds, focused replacement
contracts/integration, `corepack pnpm turbo lint typecheck test build --concurrency=1 --force`,
production bundle contracts, separate Station package gates, separate Android
`testDebugUnitTest lintDebug assembleDebug`, format and diff checks. Turbo's child
processes use a temporary Corepack shim because the host's global pnpm version
is older than the repository pin; no lockfile or dependency policy is changed.

| Completed integrated check               | Result                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Shared contracts/DB/UI ordered builds    | Exit 0.                                                                                                            |
| Full workspace lint/typecheck/test/build | 52/52 tasks passed, zero cached; 980 test files and 11,463 tests passed, with 2 files / 4 external tests skipped.  |
| Database full test package               | 111 files / 611 tests passed; no skips.                                                                            |
| API full test package                    | 396 files passed / 2 skipped; 4,462 tests passed / 4 skipped.                                                      |
| Repair/CLI/crash-window integration      | 4 files / 18 tests passed; no skips.                                                                               |
| Production bundle/deployment contracts   | 567 passed; no skips.                                                                                              |
| CI classifier/workflow contracts         | 45 passed; no skips.                                                                                               |
| Station final test/typecheck/lint/build  | 118 files / 1,767 tests passed; no skips; static gates and build exit 0.                                           |
| Android final unit/lint/debug APK        | 143 suites / 1,016 tests; zero failures/errors/skips; all three Gradle gates passed.                               |
| Local Cabinet Chromium                   | 20 passed.                                                                                                         |
| Local SaaS Chromium                      | 24 passed, including 4 existing equipment cases.                                                                   |
| Browser harness TypeScript               | Exit 0.                                                                                                            |
| Operations diagnostic SQL                | All 5 queries prepared/explained against isolated PostgreSQL in a read-only transaction.                           |
| Compiled manual repair entrypoint        | Expected exit 1 for missing arguments; successful/replayed repair covered by the PostgreSQL CLI integration suite. |

The API skips are explicit external opt-ins: `local-infrastructure.e2e.test.ts`
(Mailpit/MinIO lifecycle), `national-catalog.live.test.ts` (live catalog), and one
case each in `national-catalog-image.test.ts` (private MinIO) and
`provision-tenant-owner.e2e.test.ts` (the real provisioning subprocess with local
infrastructure). They were not exercised; database-backed replacement tests ran.

## Final branch review corrections

The final review of input `9a1ad3cf6c44b51de7e96baae0d4a6cf56c31e44` found
security revoke skipping source recovery authority, a legacy ingestion/cutover
race, and missing capability-refusal classification in both web applications.
The correction round covers all three:

- Migration 0168 gives explicit security revocation its own monotone generation.
  Revoke retires unused recovery codes and active keys under the source lock,
  fences queued issuance by epoch/execution revision, and preserves the original
  revocation date and released assignment. Real-service races exercise both lock
  orderings, repeated revoke, no key, active recovery and fresh authorized reissue.
  The existing ordinary-device duplicate-revoke assertion remains unchanged.
- Legacy mutation owners recheck replacement in the same source-locked business
  transaction. Eleven HTTP channels losing to emergency cutover retain stable
  quarantine receipts without business changes; recovery retries return the same
  receipt. Normal transfer is fenced too. Native proof and ACK behavior remain.
- Both strict error decoders classify `client_upgrade_required` as definitive.
  Supported-to-stale component and Chromium scenarios clear the refused attempt,
  refetch current facts and keep emergency available.

Correction gates completed on 2026-09-17: Cabinet 114 files / 1,460 tests; SaaS 52 / 545; Station
118 / 1,767; DB 112 / 613; contracts 36 / 358; forced Android execution 143 suites /
1,016 tests, lint and APK; production bundle contracts 567. All passed without
skips. Relevant package typecheck/lint/build and browser typecheck passed; Cabinet
lint reports five existing hook warnings and no errors. Browser scenarios passed
24 Cabinet + 28 SaaS cases across both locales and viewport widths, including the
new transition. Two representative transition screenshots were inspected.

Final API verification on 2026-09-22 used a fresh disposable database migrated
through 0168 in the same isolated PostgreSQL container, with synthetic test
configuration. The uninterrupted full package run exited 0: **395 files / 4,449
tests passed**, with 4 files / 26 tests skipped. Two inventory suites require the
separate `INVENTORY_TEST_DATABASE_URL` alias; after configuring it to that same
disposable database, their focused supplement exited 0: **2 files / 22 tests
passed**, no skips. Combined coverage is **397 files / 4,471 tests passed**.
The four remaining skips are the explicit external opt-ins: Mailpit/MinIO
lifecycle (`local-infrastructure.e2e.test.ts`), live National Catalog
(`national-catalog.live.test.ts`), private MinIO image storage
(`national-catalog-image.test.ts`) and the real local-infrastructure provisioning
subprocess (`provision-tenant-owner.e2e.test.ts`). No database-backed replacement
or inventory test remains skipped. This is combined full-run and focused-supplement
evidence, not a claim of one four-skip invocation.

Repository `format:check`, final document formatting and staged/unstaged
`git diff --check` passed on 2026-09-22. Snapshot 0168 has the correct 0167
predecessor and changes only the new `station_devices` column and check metadata.
Other affected package gates above were completed on 2026-09-17 and were not
rerun on 2026-09-22. Earlier RED reproductions, runner configuration corrections,
exact correction commit metadata and local result summaries are retained in the
ignored SDD `final-review-fix-report.md`; they are not prerequisites for reading
these acceptance results. No additional unrelated workspace, Rust, physical
hardware or deployment acceptance is implied by this correction.

## Local browser evidence

Both browser harnesses use fixture authentication and HTTP responses served by
local Vite. They exercise real Cabinet/SaaS components and contract decoders, not
a deployed API or a real authentication provider. The scenarios cover ready,
emergency recovery, recovery blocked by server facts despite all-zero local
measurements, factual preparation prerequisites, and unsupported-client refusal of ordinary
drain with emergency still available in RU/EN on desktop/mobile.
Assertions check copy/value visibility, missing translations, unhandled requests
and horizontal overflow. Representative saved ready, blocked recovery and
unsupported-client PNGs were inspected directly. Saved PNGs remain ignored under
`tools/production-browser/test-results/device-replacement` and
`tools/production-browser/test-results/tenant-equipment`.

There is no dedicated browser harness for native replacement drain/recovery
screens in this checkout. Station DOM/component tests, real local SQLite restart
and saved-print tests provide automated UI/state evidence. Android uses host
JUnit/Robolectric/Compose/Room checks. Neither substitutes for a launched
Windows/Tauri app, emulator/device screen walkthrough or physical scan/print test.

## Production and physical acceptance — NOT RUN

No PR, merge, artifact publication, protected production workflow, image pull,
DNS/TLS smoke, real provider login, native installation or factory trial was
performed by this task. These are explicit outstanding acceptance gates:

1. Bind the final tested SHA to approved API/edge digests and signed Station/APK
   release artifacts. Apply migrations before readers; exercise designated test
   tenant routes and record release SHA headers and health evidence.
2. On physical Station/Windows and industrial Handheld, prove fresh capability
   negotiation, ordinary drain, cancellation ACK after network loss/restart,
   and no new work from delayed scans or grant responses.
3. Exercise scanner input and printer transport, including interrupted/sending/
   delivery-unknown jobs and full original-code verification. Check preserved
   print bytes and paper output; no automatic resend may be inferred safe.
4. Demonstrate emergency pairing before the boundary, blocked target work in
   online/offline/observe states, restart with a waiting fence, and admission only
   at the authoritative deadline. Verify source recovery on its original medium.
5. Confirm existing CHZ/1C integration and customer throughput/production
   reconciliation with real external systems if the factory workflow uses them.
   API mocks and accepted local receipts are not CHZ/1C or customer acceptance.

Keep evidence-unavailable recovery visibly incomplete. No automated gate creates
missing production evidence or proves that an artifact is installed on a device.
