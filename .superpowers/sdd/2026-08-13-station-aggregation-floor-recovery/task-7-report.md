# Task 7 Report: Cross-Package Gates and Hardware Acceptance Record

## Result

The final domain, DB, API, Station, UI, Rust, formatting, release-contract,
production-bundle-contract, and diff gates passed with the test infrastructure
described below. The hardware checklist now contains the nine concrete
aggregation and box-label recovery checks for the next packaged Windows beta.
Every new Windows, Tauri, scanner, printer, restart, and display item remains
unchecked because none was physically executed in this task.

The documentation change is limited to:

- `docs/hardware-acceptance-checklist.md`, which is the canonical unchecked
  hardware record;
- `docs/runbooks/station-beta-release.md`, which now makes that aggregation
  subsection an explicit beta admission gate.

No deployment, production mutation, beta publication, installer download,
release, push, or live production verification was performed.

## Test infrastructure and command runner

The worktree had dependencies but no `.env`. The existing main-checkout `.env`
was loaded in-process where API test configuration was required; no values were
printed or copied. The shell's ordinary `pnpm` launcher reported version
11.10.0 but could not start a script:

```text
[ERROR] The packageManager dependency "pnpm@11.10.0" in pnpm-lock.yaml must use a registry package path and an integrity-only resolution
```

That pre-test failure is the same launcher incompatibility recorded by earlier
tasks. No manifest or lockfile was changed. All authoritative package results
below used the repository-cached exact binary:

```text
node /Users/thevladbog/.cache/node/corepack/v1/pnpm/11.10.0/bin/pnpm.cjs
```

The first DB suite attempt loaded the main-checkout environment but the sandbox
denied `localhost:5432` with `EPERM`; it exited 1 before producing a valid DB
gate. An escalated rerun against the shared development database was rejected
because the suite performs schema cleanup, including `DROP TABLE`, and shared
data must not be mutated for this task.

The safe replacement was an agent-owned `postgres:16-alpine` container named
`markiro-task7-postgres-20260813`, bound only to `127.0.0.1:55433` with
throwaway credentials. `db:migrate` passed before the DB/API tests. After the
gates, `docker stop markiro-task7-postgres-20260813` stopped and auto-removed
the `--rm` container. It contained no shared or user data.

## Commands and results

In the command list below, `PNPM` means the exact cached pnpm command shown
above. Package script names and arguments are otherwise unchanged from the
task brief.

### Domain

```bash
PNPM --filter @markiro/domain test
PNPM --filter @markiro/domain typecheck
PNPM --filter @markiro/domain lint
PNPM --filter @markiro/domain build
```

Result: all exited 0. Vitest passed 15 files and 190/190 tests. Typecheck, lint,
and build emitted no errors.

### Database

```bash
DATABASE_URL=postgresql://<throwaway>@127.0.0.1:55433/markiro_task7 \
  PNPM --filter @markiro/db db:migrate
DATABASE_URL=postgresql://<throwaway>@127.0.0.1:55433/markiro_task7 \
  PNPM --filter @markiro/db test
PNPM --filter @markiro/db typecheck
PNPM --filter @markiro/db lint
PNPM --filter @markiro/db build
```

Result: all exited 0 against the isolated database. Migrations applied
successfully. Vitest passed 21 files and 108/108 tests with zero skips.
Typecheck, lint, and build emitted no errors.

The earlier sandbox-only DB attempt exited 1 with 8 failed suites, 1 failed
test, 66 passed tests, and 41 skipped tests because every local PostgreSQL
connection was denied with `EPERM`. Those numbers are recorded as environment
failure evidence and are not reported as a product result or a pass.

### API

```bash
set -a
source /Users/thevladbog/PRSOME/q/.env
set +a
DATABASE_URL=postgresql://<throwaway>@127.0.0.1:55433/markiro_task7 \
PLATFORM_AUTH_URL=http://localhost:3000 \
SAAS_ADMIN_ORIGIN=http://localhost:5473 \
  PNPM --filter @markiro/api test
PNPM --filter @markiro/api typecheck
PNPM --filter @markiro/api lint
PNPM --filter @markiro/api build
```

Result: all exited 0. Vitest passed 122 files and 1,235 tests; one file and two
tests were intentionally skipped:

- `test/local-infrastructure.e2e.test.ts`: its single Mailpit/MinIO lifecycle
  test was skipped because `LOCAL_INFRA_SMOKE` was unset;
- `test/provision-tenant-owner.e2e.test.ts`: only `prints only identifiers on
  stdout through the real documented command` was skipped for the same
  `LOCAL_INFRA_SMOKE` condition.

The remaining database-backed API/e2e tests ran against the isolated migrated
Postgres. Expected injected error-path logs appeared for duplicate SSCC,
pairing rollback, invitation audit failure, 1C database outage, and object
storage failure; the final result had zero failures. Typecheck, lint, and build
emitted no errors.

### Station

```bash
PNPM --filter @markiro/station test
PNPM --filter @markiro/station typecheck
PNPM --filter @markiro/station lint
PNPM --filter @markiro/station build
```

Result: all exited 0. Vitest passed 64 files and 743/743 tests with zero skips.
The suite emitted jsdom's expected missing-canvas notice. Typecheck and lint
emitted no errors. The Vite production build transformed 399 modules.

### Shared UI

```bash
PNPM --filter @markiro/ui test
PNPM --filter @markiro/ui typecheck
PNPM --filter @markiro/ui lint
PNPM --filter @markiro/ui build
```

Result: all exited 0. Vitest passed 7 files and 146/146 tests with zero skips.
Typecheck, lint, and build emitted no errors.

### Tauri/Rust

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Result: exited 0 after a clean local compile. The library passed 27/27 unit
tests; the binary and doc-test targets contained zero tests. This macOS host
result is not Windows or packaged-Tauri acceptance.

### Release and production contracts

```bash
PNPM test:station-release:contract
PNPM test:production-bundle:contract
```

Result: the Station release contract passed 87/87 both before and after the
documentation edit. The first sandbox-only production-bundle run passed 251
tests and failed 10 infrastructure probes because Docker access, localhost
listeners, and the pnpm metadata store were denied. The unchanged command was
rerun with the permissions required by its isolated adapters and passed
261/261 with zero skips.

`verify:station-production-cors` and `test:production-docs:browser` were not
run: they exercise live production/external browser surfaces and are not part
of this local acceptance-record change. No production or release action was
authorized.

### Formatting, searches, and diff review

```bash
PNPM format:check
PNPM exec prettier --check \
  docs/hardware-acceptance-checklist.md docs/runbooks/station-beta-release.md
git diff --check
rg -n "printNotAvailable|work-box-fill__track" apps/station/src
rg -n "nextSerial: 0|nextSerial.*min\(0\)" apps/api/src/modules
git diff --stat origin/main...HEAD
```

Results:

- the full repository format check passed;
- the two modified documents passed the focused Prettier check;
- `git diff --check` passed;
- the Station obsolete-production search returned no matches;
- the API search returned only
  `apps/api/src/modules/org-profile/dto.ts:40`, where the shared base schema
  intentionally allows historical/non-box serial zero and the adjacent
  `superRefine` rejects `extensionDigit === 0 && nextSerial < 1`; this is the
  approved compatibility rule, not obsolete box allocation;
- the branch diff contains 58 files, all within the approved spec, Tasks 1-6
  reports/evidence, or this Task 7 acceptance documentation. No unrelated
  working-tree state was present before the Task 7 edits.

After adding this report, the focused documentation/report formatting check,
`git diff --check`, staged-diff review, and Station release documentation
contract are rerun before commit; their final results are recorded in the
commit handoff.

## Hardware and external acceptance

The new checklist items are deliberately unchecked. This task did not execute:

- a packaged Windows/Tauri build at 1280×800 or 1024×768;
- a production EAN-13 or KM DataMatrix scanner;
- a 20-place physical box fill and auto-close;
- a real ZPL or TSPL printer, disconnect, out-of-paper, restore, or print-once
  check;
- restart with unresolved box-label work;
- explicit continue-without-label synchronization on a station;
- GS1-128 `(00)` scan-back verification;
- fullscreen lockdown with the Windows taskbar hidden;
- gloved touch, speaker, physical keyboard, updater, installer, SmartScreen,
  production pairing, or live production CORS.

Task 6's browser matrix remains separate evidence and does not close any of
these physical acceptance items.

## Self-review

- All nine required beta steps appear as unchecked checklist items.
- No existing or new hardware checkbox was marked complete.
- The release runbook points to the canonical hardware subsection and states
  that every item remains unchecked before the real run.
- The report distinguishes initial sandbox failures from authoritative
  permitted reruns and records the two intentional API skips by file and test.
- DB/API gates used only a migrated disposable database; shared development
  Postgres was not mutated.
- The `min(0)` search match was inspected in context and preserves the approved
  historical/non-box compatibility while box extension digit zero starts at
  serial one.
- No secrets, raw credentials, activation values, pairing codes, or production
  payloads were printed or added to the repository.
- No deployment, release, Windows installer, external publication, or push was
  performed.

## Final review request

Final code and operational reviewers must separately inspect:

- SSCC concurrency, migration, tenant scoping, and legacy range behavior;
- restart and operator-switch scan sealing around pending print work;
- retry/skip audit behavior and absence of duplicate serial burns;
- 1280×800 and 1024×768 layout bounds;
- the distinction between automated/browser results and actual
  Windows/scanner/printer acceptance.

## P1 review correction: printer-setup recovery round trip

Review found that the original acceptance record covered printer disconnect,
restart, retry, and skip, but did not independently require the printer-setup
detour to preserve the unresolved print job and scan-admission seal.

The implementation boundary was verified before editing the checklist:

- `WorkScreen` documents `onOpenPrinterSetup` as opening setup without
  resolving the durable print job;
- `BoxPrintRecovery` exposes `Настроить принтер` only from the persistent
  recovery surface;
- the recovery state carries the same box and full SSCC, and the admission
  checks continue to block ordinary scans until retry/verification or explicit
  skip resolves it.

An additional packaged-Windows item now requires the operator to enter printer
setup from persistent recovery, return to the same unresolved box and SSCC,
observe that scans and ordinary controls remain sealed throughout, and finish
through retry plus scan-back verification when enabled without a second box
close or serial allocation. The item remains unchecked because no packaged
Windows, scanner, or printer run was performed.

Focused correction verification:

```bash
PNPM exec prettier --check \
  docs/hardware-acceptance-checklist.md \
  .superpowers/sdd/2026-08-13-station-aggregation-floor-recovery/task-7-report.md
git diff --check
```

Result: both commands exited 0. No package, browser, release, Windows, scanner,
or printer gate was rerun for this documentation-only correction, as requested.
