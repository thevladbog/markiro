# Task 5 Report: Retry, Setup, Verification, and Explicit Skip

## Result

Implemented durable aggregation-box print recovery. A closed box now keeps its
existing SSCC and blocks product intake until its label is printed and, when
configured, verified, or the operator explicitly confirms continuing without a
label. Retry only re-runs printing for the persisted box. Printer setup leaves
that work durable so returning to the floor restores the same recovery.

## Behavior and areas changed

- Added `attemptBoxPrint` with independent template, printer, render, and
  transport classifications. Render and transport logs contain fixed categories
  only; native error text is neither returned nor logged.
- Added the RU/EN `BoxPrintRecovery` full-screen flow with complete SSCC,
  retry, conditional printer setup, and a second explicit skip confirmation.
  Pending work disables every recovery action, including Escape/back.
- Integrated Task 4's persisted print lifecycle into `WorkScreen`: unresolved
  work hydrates before a box is opened or input is admitted; failures remain
  visible; successful prints transition to optional scan-back verification;
  skip/verification mutations remain inside the floor work barrier.
- Added queue-head admission checks and explicit buffered-scan disposal when a
  close enters recovery, while preserving ordered non-scan jobs. A product scan
  already buffered behind the closing scan is discarded before journal/outbox
  writes, preventing a second box/SSCC even when printing succeeds quickly.
- Wired the recovery gate through `App`: operator switching, update/window
  actions, and shift exit are blocked, while printer setup remains available.
- Kept the recovery and confirmation fixed-viewport/no-scroll with floor-sized
  controls; added a reusable disabled-back contract to `FullScreenDialog`.
- Removed the former timed `box.printNotAvailable` path and updated the legacy
  close/verification tests to the new durable blocking semantics.

## TDD evidence

RED:

```text
apps/station/node_modules/.bin/vitest run test/box-printing.test.ts --reporter=verbose
FAIL: Failed to resolve import "../src/lib/box-printing.js"
```

GREEN focused gate (direct package binary; see command caveat below):

```text
node_modules/.bin/vitest run test/box-printing.test.ts test/scan-queue.test.ts \
  test/work-screen.test.tsx test/App.test.tsx test/print-verification.test.tsx \
  test/fixed-viewport-source.test.tsx --reporter=dot
6 files passed; 158 tests passed
```

Additional shared-dialog regression:

```text
packages/ui/node_modules/.bin/vitest run test/components.test.tsx --reporter=dot
1 file passed; 68 tests passed
```

## Final automated checks

- Station full suite: `node_modules/.bin/vitest run --reporter=dot` — 64 files,
  729 tests passed.
- Station typecheck: `node_modules/.bin/tsc -p apps/station/tsconfig.json --noEmit`
  — passed.
- Station lint: `node_modules/.bin/eslint apps/station --ignore-pattern
  'src-tauri/target/**' --ignore-pattern 'src-tauri/gen/**'` — passed.
- Station build: `apps/station/node_modules/.bin/vite build` — passed (398
  modules transformed).
- UI focused test/typecheck/lint/build — passed: 68 tests, both UI TypeScript
  configs, ESLint, and `tsc -p packages/ui/tsconfig.json`.
- `git diff --check` — passed.

The requested `pnpm --filter ...` wrapper could not start because pnpm 11.10.0
rejected the repository lockfile's package-manager dependency resolution:
`The packageManager dependency "pnpm@11.10.0" in pnpm-lock.yaml must use a
registry package path and an integrity-only resolution`. No lockfile/config was
changed. The same checked-in package binaries were run directly for all gates.

## Manual and external verification

No physical printer, scanner, Tauri/Windows host, or real floor viewport was
available. Automated DOM/source checks do not replace those external acceptance
gates. No browser, hardware, Windows, or live updater claim is made.

## Self-review

- Retry never invokes `closeCurrentBox` and therefore cannot allocate a second
  SSCC.
- Setup is the sole recovery navigation; persisted recovery is re-read after
  the work screen remounts.
- Skip exists only on the aggregation print-recovery surface, requires a second
  confirmation, and is never automatic.
- A scan emitted during recovery and a scan buffered immediately behind the
  closing scan both produce no journal or outbox row.
- Error UI and print-boundary logs expose categories only, not raw native
  details.

## Review remediation: setup latch, admission seal, restart reprint, sanitized error

The four blocking review findings were addressed without changing the Task 2
scan semantics, Task 3 grid/ordinal behavior, or Task 4 durable lifecycle:

- `App` now latches recovery-origin printer setup across the `WorkScreen`
  unmount. The cleanup `false` is ignored until the remounted screen first
  rehydrates the persisted row and later reports its actual resolution. Update,
  operator-switch, and window controls remain disabled in Setup and after the
  return to the unresolved recovery.
- `WorkScreen` now seals product admission synchronously when a durable close
  enters printing and keeps it sealed until the successor box has been opened.
  Both stale physical callbacks and queue-head scans re-check that seal, so an
  immediately successful, verification-off print cannot leak a scan into the
  journal/outbox while its queue entry drains.
- Restart-restored `printed` verification entries retain the persisted item
  count. Reprint regenerates the label from the same persisted SSCC/box data;
  it never closes a box or allocates another SSCC.
- Verification reprint failures log only the fixed category
  `station: box label reprint failed`; caught native errors are not logged.

### Review RED evidence

Baseline focused run after adding the App/WorkScreen regressions:

```text
node_modules/.bin/vitest run test/work-screen.test.tsx test/App.test.tsx
2 files failed; 4 tests failed; 121 tests passed

App setup latch: expected disabled true, received false
Restart-restored reprint: expected print once, received 0 calls
Sanitized reprint log: received Error { message: "native COM7 secret-message" }
Immediate-print callback regression: failed before the admission transition was observable
```

The final deterministic stale-callback test was also mutation-checked with the
new admission checks removed:

```text
node_modules/.bin/vitest run test/work-screen.test.tsx \
  -t "drops a stale source callback after an immediately successful print with verification off" \
  --reporter=dot
1 test failed: expected no scan_events_mirror row, received
{ raw: "0104600000000015215Ab2" }
```

### Review GREEN evidence

```text
node_modules/.bin/vitest run test/work-screen.test.tsx test/App.test.tsx --reporter=dot
2 files passed; 125 tests passed

node_modules/.bin/vitest run test/work-screen.test.tsx \
  -t "drops a stale source callback after an immediately successful print with verification off" \
  --reporter=dot
1 file passed; 1 test passed; 61 tests skipped
```

Latest final gates after the review fixes:

- Station full suite: `node_modules/.bin/vitest run --reporter=dot` — 64 files,
  732 tests passed.
- Station typecheck: `node_modules/.bin/tsc -p tsconfig.json --noEmit` from
  `apps/station` — passed.
- Station lint: `../../node_modules/.bin/eslint . --ignore-pattern
  'src-tauri/target/**' --ignore-pattern 'src-tauri/gen/**'` from `apps/station`
  — passed.
- Station build: `node_modules/.bin/vite build` from `apps/station` — passed,
  398 modules transformed.
- Focused Prettier check and `git diff --check` — passed.

The original physical printer/scanner, Tauri/Windows, browser, live updater,
and real floor viewport limitations remain unchanged; none of those external
acceptance gates was exercised by this review fix.
