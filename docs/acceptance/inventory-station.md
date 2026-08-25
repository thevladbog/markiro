# Station inventory automated acceptance

## Result

**PASS — automated evidence.** The deterministic Station gallery passed all 96 rows: 16 inventory
fixtures × 2 locales (`ru`, `en`) × 3 exact viewports (`1024×768`, `1280×800`, `1280×1024`). The
connected real-PostgreSQL API fixture passed all 16 inventory-sync cases across two device
identities, and the cabinet inventory-detail boundary returned its tenant-scoped blocker
projection. The evidence was generated from immutable code commit
`8995dc14045d28230c07364a9dde53c8a33aef39` on branch `codex/inventory-station-v1`.

**NOT RUN — physical acceptance.** No packaged Windows/Tauri build, HID or serial scanner, two
physical terminals, offline factory network, restart of an installed app, physical printer/driver,
label stock/readability, touchscreen/gloves, or customer operator was exercised. Those items remain
unchecked in `docs/hardware-acceptance-checklist.md`.

## Environment

- macOS host; Node `v24.18.0`; pnpm `11.22.0`.
- Chromium `151.0.7922.34`, isolated local Station Vite server on `127.0.0.1:43179`.
- Disposable PostgreSQL 16 containers and databases were recreated between the focused, database,
  and full API gates; migrations were applied through the repository migration journal. No shared
  database was used, and the final task-scoped container was removed.
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
complete 16-test sequence because its progress cursor intentionally observes facts produced by
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
- forged `known_box` expansion and missing eligible `add-item` membership are terminally rejected
  in repack mode, while repack mutations are terminally rejected in check mode;
- mismatched and out-of-range repack date mutations are terminally rejected without changing the
  box date, while an in-range date equal to the event date remains accepted;
- an invalidated, unprinted box can be recovered only by its owning device through the journaled
  `claim-lost` correction; active losing membership is removed, the box is reopened, and one exact
  `inventory.station.repack_conflict_resolved` audit record is retained across retry;
- rejected events are immutable server evidence, replay with the same batch or digest is stable,
  and the Station removes only the rejected outbox row while preserving its raw diagnostic mirror;
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

packages/domain/node_modules/.bin/vitest run test/inventory-station-sync.test.ts
PASS — 16/16

packages/db/node_modules/.bin/vitest run test/sqlite-schema.test.ts
PASS — 57/57

INVENTORY_TEST_DATABASE_URL=<disposable-local-db> apps/api/node_modules/.bin/vitest run \
  test/station-inventory-sync.e2e.test.ts
PASS — 16/16

apps/api/node_modules/.bin/vitest run \
  test/cors-station-surface.test.ts test/station-inventory-openapi.test.ts
PASS — 64 CORS assertions; OpenAPI's 4 environment-gated assertions passed in the full API run

node --test tools/station-release/test/verify-api-cors.test.mjs
PASS — 158/158

INVENTORY_ACCEPTANCE_ARTIFACTS=1 \
INVENTORY_ACCEPTANCE_COMMIT=8995dc14045d28230c07364a9dde53c8a33aef39 \
tools/production-browser/node_modules/.bin/playwright test \
  --config tools/production-browser/station-inventory.playwright.config.ts
PASS — 96/96 matrix rows, 1/1 Playwright scenario

packages/domain/node_modules/.bin/vitest run
PASS — 28 files, 396 tests

packages/domain/node_modules/.bin/tsc -p tsconfig.json --noEmit
packages/domain/node_modules/.bin/tsc -p tsconfig.test.json
node_modules/.bin/eslint packages/domain
packages/domain/node_modules/.bin/tsc -p tsconfig.json
PASS — all Domain typecheck, lint, and build gates

DATABASE_URL=<disposable-local-db> packages/db/node_modules/.bin/vitest run
PASS — 39 files, 249 tests

packages/db/node_modules/.bin/tsc -p tsconfig.json --noEmit
packages/db/node_modules/.bin/tsc -p tsconfig.test.json
node_modules/.bin/eslint packages/db
packages/db/node_modules/.bin/tsc -p tsconfig.json
PASS — all database typecheck, lint, and build gates

DATABASE_URL=<disposable-local-db> INVENTORY_TEST_DATABASE_URL=<same-disposable-local-db> \
  apps/api/node_modules/.bin/vitest run
PASS — 195 files passed, 1 skipped; 1991 tests passed, 2 skipped

apps/api/node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/eslint apps/api
apps/api/node_modules/.bin/nest build
PASS — all three

apps/station/node_modules/.bin/vitest run
PASS — 83 files, 1122 tests

apps/station/node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/eslint apps/station
apps/station/node_modules/.bin/vite build
PASS — all three; build retained the existing large-chunk warning

tools/production-browser/node_modules/.bin/tsc -p tools/production-browser/tsconfig.json --noEmit
PASS

node_modules/.bin/prettier --check .
git diff --check
PASS — both after formatting the generated JSON and this document
```

The full API gate's one skipped file/two skipped tests are the repository-declared local Mailpit/
MinIO lifecycle suite and real-command local-infrastructure smoke. They are reported separately from
the 1991 connected passes. The API run emitted its existing Vite native-config warning and expected
injected-failure logs; the Station run emitted jsdom's known canvas diagnostic; none failed a test.
`graphify update .` passed after the sandboxed first attempt was retried with its required filesystem
access (18,273 nodes / 35,971 edges), with 32 pre-existing partial Astro syntax extractions and a
stale community-label notice. Local database URLs and test-only credentials are omitted; no
production secret was used or recorded.
