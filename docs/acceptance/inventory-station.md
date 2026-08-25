# Station inventory automated acceptance

## Result

**PASS — automated evidence.** The deterministic Station gallery passed all 96 rows: 16 inventory
fixtures × 2 locales (`ru`, `en`) × 3 exact viewports (`1024×768`, `1280×800`, `1280×1024`). The
connected real-PostgreSQL API fixture passed all 15 inventory-sync cases across two device
identities. The evidence was generated from immutable code commit
`320be2fcc3a1aa8b036854513102e661a441ce03` on branch `codex/inventory-station-v1`.

**NOT RUN — physical acceptance.** No packaged Windows/Tauri build, HID or serial scanner, two
physical terminals, offline factory network, restart of an installed app, physical printer/driver,
label stock/readability, touchscreen/gloves, or customer operator was exercised. Those items remain
unchecked in `docs/hardware-acceptance-checklist.md`.

## Environment

- macOS host; Node `v24.18.0`; pnpm `11.22.0`.
- Chromium `151.0.7922.34`, isolated local Station Vite server on `127.0.0.1:43179`.
- Disposable PostgreSQL `17.10` container and database created only for this acceptance run;
  migrations applied through the repository migration journal. No shared database was used.
- Gallery facts are frozen at `2026-08-19`; fixtures make no API, database, Tauri, printer, random,
  or current-time calls and contain no full raw KM, credential, PIN, pairing code, token, or
  production identifier.

## Browser matrix

| Viewport  |   Russian |   English |     Total |
| --------- | --------: | --------: | --------: |
| 1024×768  |     16/16 |     16/16 |     32/32 |
| 1280×800  |     16/16 |     16/16 |     32/32 |
| 1280×1024 |     16/16 |     16/16 |     32/32 |
| **Total** | **48/48** | **48/48** | **96/96** |

Every row asserted the exact window/document bounds, no document or nested scroll, no clipped or
overlapping visible action, all visible inventory floor actions at least 64×64 px, visible keyboard
focus, and non-color-only status meaning. Recorded totals are zero console errors, console warnings,
page errors, failed requests, HTTP failures, nested scroll regions, clipped/overlapping actions,
sub-64 actions, status defects, and sensitive leaks; keyboard focus passed 96/96.

The complete reproducible result is
[`inventory-station-browser-matrix.json`](inventory-station-browser-matrix.json). It lists every
fixture, locale, requested and actual viewport, measured document bounds, individual defects, error
channels, screenshot name, tested commit, and result.

Registered fixtures: warehouse-operations selection; other-line confirmation; simple box accepted;
duplicate on another terminal; known ineligible; protected `MOVING_BY_UD`; not in snapshot; repack
awaiting old box; repack scanning; repack capacity 20; repack box ready; corrections; production-date
change; leave with open box; durable print recovery; same-SSCC reprint confirmation. The existing
shift exception/disaggregation surface was not changed and no inventory disaggregation operation was
added.

## Representative screenshots

- [Capacity 20, 1024×768 RU](screenshots/inventory-repack-capacity-20-1024x768-ru.png)
- [Corrections, 1024×768 RU](screenshots/inventory-repack-corrections-1024x768-ru.png)
- [Print failure/recovery, 1024×768 RU](screenshots/inventory-print-recovery-1024x768-ru.png)
- [Protected MOVING_BY_UD, 1024×768 RU](screenshots/inventory-protected-moving-by-ud-1024x768-ru.png)
- [Other-line confirmation, 1024×768 RU](screenshots/inventory-other-line-confirmation-1024x768-ru.png)
- [Simple box accepted, 1280×800 RU](screenshots/inventory-simple-box-accepted-1280x800-ru.png)

All six images were inspected at their original resolution after the matrix passed.

## Two-device API scenario

The existing connected fixture in `apps/api/test/station-inventory-sync.e2e.test.ts` was run as one
complete 15-test sequence because its progress cursor intentionally observes facts produced by
earlier steps. It uses the real `StationInventorySyncService` contract, real migrations and
PostgreSQL locks with two distinct server-authorized device identities.

The run proves:

- concurrent same-code submissions converge on the deterministic `(scannedAt, deviceId, eventId)`
  winner and preserve the losing conflict evidence;
- the other active terminal receives shared monotonic claim/correction progress;
- each event retains its terminal's observed production date, while focused Station journal tests
  prove a changed local date affects only subsequent scans and survives restart;
- each open repack box has exactly one server-side owner; competing membership invalidates the losing
  box and a foreign terminal cannot mutate the owner's box;
- pending work blocks leave, while zero-pending leave preserves a synchronized open box and leaves
  the inventory `running`;
- participant pending/open counts, authoritative open/invalidated box rows, progress revisions and
  audit facts remain queryable server-side as the current admin/API close-blocker projection. The
  current product has no normal admin close endpoint, so this record does not invent or claim one.

This is automated API and local-browser evidence, not evidence from two physical terminals,
scanners, or printers.

## Commands and results

```text
corepack pnpm --filter @markiro/station exec vitest run test/screen-gallery.test.tsx
PASS — 42/42

INVENTORY_TEST_DATABASE_URL=<disposable-local-db> corepack pnpm --filter @markiro/api exec vitest run test/station-inventory-sync.e2e.test.ts
PASS — 15/15

corepack pnpm --filter @markiro/station exec vitest run test/inventory-simple-work.test.tsx test/inventory-journal.test.ts -t 'persists a changed date|orders a date change|persists the active date'
PASS — 3/3 selected (37 not selected)

INVENTORY_ACCEPTANCE_ARTIFACTS=1 INVENTORY_ACCEPTANCE_COMMIT=320be2fcc3a1aa8b036854513102e661a441ce03 corepack pnpm --dir tools/production-browser --ignore-workspace run test:station-inventory
PASS — 96/96 matrix rows, 1/1 Playwright scenario

corepack pnpm --filter @markiro/db build
PASS

DATABASE_URL=<disposable-local-db> INVENTORY_TEST_DATABASE_URL=<same-disposable-local-db> corepack pnpm --filter @markiro/api test
PASS — 195 files passed, 1 skipped; 1980 tests passed, 2 skipped

corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
PASS — all three

corepack pnpm --filter @markiro/station test
PASS — 83 files, 1116 tests

corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
corepack pnpm --filter @markiro/station build
PASS — all three; build retained the existing large-chunk warning

corepack pnpm format:check
git diff --check
PASS — both after formatting the generated JSON and this document
```

The full API gate's one skipped file/two skipped tests are repository-declared skips, reported
separately from the 1980 connected passes. The Station test run emitted jsdom's known canvas
diagnostic without a failed test. `graphify update .` also passed after the sandboxed first attempt
was retried with its required filesystem access (18,265 nodes / 35,945 edges). Local database URLs
and test-only credentials are omitted; no production secret was used or recorded.
