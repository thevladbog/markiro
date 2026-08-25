# Station inventory automated acceptance

## Result

**PASS — automated evidence.** The deterministic Station gallery passed all 96 rows: 16 inventory
fixtures × 2 locales (`ru`, `en`) × 3 exact viewports (`1024×768`, `1280×800`, `1280×1024`). The
connected real-PostgreSQL API fixture passed all 15 inventory-sync cases across two device
identities, and the cabinet inventory-detail boundary returned its tenant-scoped blocker
projection. The evidence was generated from immutable code commit
`f14fd538a3e1e389cb7a91f2991b567543020c4e` on branch `codex/inventory-station-v1`.

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

Every row asserted the exact window/document bounds, no document or nested scroll, no clipped,
occluded, interactive-to-interactive, or action-to-status/content overlap, all visible inventory
floor actions at least 64×64 px, visible keyboard focus, and non-color-only status meaning. The
harness measures every rendered action before center-point hit testing and excludes only actions
intentionally behind an active modal dialog. Recorded totals are zero console errors, console
warnings, page errors, failed requests, HTTP failures, nested scroll regions, clipped actions,
occluded actions, both overlap classes, sub-64 actions, status defects, and sensitive leaks;
keyboard focus passed 96/96.

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

The check and repack fixtures supply frozen synthetic state to `InventoryWorkScreen`; the production
check, repack, correction, date, leave, and print-recovery render branches produce the gallery DOM.
The print-recovery fixture also supplies the same printer-setup callback boundary as the production
app, using a deterministic no-op callback so both enabled recovery actions are measured without
opening hardware setup. The gallery no longer maintains a parallel copy of either production work
page.

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
- device A opens its box with `2026-08-20`, device B opens its box with `2026-08-21`, and B then
  changes only its own empty box to `2026-08-22`; A remains on `2026-08-20` and subsequent B events
  carry `2026-08-22`;
- each open repack box has exactly one server-side owner; device B's explicit `clear-box` attempt
  against device A's open box returns the exact `INVENTORY_REPACK_BOX_NOT_OWNED` denial, while the
  later same-code race still invalidates the losing box deterministically;
- pending work blocks leave, while zero-pending leave preserves a synchronized open box and leaves
  the inventory `running`;
- cabinet `GET /inventories/:id` exposes the tenant-scoped `blockers` projection. Its connected HTTP
  test observes exactly one active participant, three pending events, one participant-reported open
  box, one authoritative open repack box, and one closed box with unresolved printing; the OpenAPI
  response contract pins all five fields. The current product has no normal admin close endpoint, so
  this record does not invent or claim one.

This is automated API and local-browser evidence, not evidence from two physical terminals,
scanners, or printers.

## Commands and results

```text
apps/station/node_modules/.bin/vitest run test/screen-gallery.test.tsx
PASS — 44/44

DATABASE_URL=<disposable-local-db> apps/api/node_modules/.bin/vitest run \
  test/inventories-openapi.test.ts test/inventories.e2e.test.ts \
  -t 'documents CRUD|projects tenant-scoped station close blockers'
PASS — 2/2 selected

INVENTORY_TEST_DATABASE_URL=<disposable-local-db> apps/api/node_modules/.bin/vitest run \
  test/station-inventory-sync.e2e.test.ts -t 'owns repack boxes and membership'
PASS — 1/1 selected (14 not selected)

INVENTORY_ACCEPTANCE_ARTIFACTS=1 \
INVENTORY_ACCEPTANCE_COMMIT=f14fd538a3e1e389cb7a91f2991b567543020c4e \
tools/production-browser/node_modules/.bin/playwright test \
  --config tools/production-browser/station-inventory.playwright.config.ts
PASS — 96/96 matrix rows, 1/1 Playwright scenario

corepack pnpm --filter @markiro/db build
PASS

DATABASE_URL=<disposable-local-db> INVENTORY_TEST_DATABASE_URL=<same-disposable-local-db> corepack pnpm --filter @markiro/api test
PASS — 195 files passed, 1 skipped; 1981 tests passed, 2 skipped

corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
PASS — all three

corepack pnpm --filter @markiro/station test
PASS — 83 files, 1118 tests

corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
corepack pnpm --filter @markiro/station build
PASS — all three; build retained the existing large-chunk warning

corepack pnpm format:check
git diff --check
PASS — both after formatting the generated JSON and this document
```

The full API gate's one skipped file/two skipped tests are repository-declared skips, reported
separately from the 1981 connected passes. The Station test run emitted jsdom's known canvas
diagnostic without a failed test. `graphify update .` also passed after the sandboxed first attempt
was retried with its required filesystem access (18,267 nodes / 35,947 edges). Local database URLs
and test-only credentials are omitted; no production secret was used or recorded.
