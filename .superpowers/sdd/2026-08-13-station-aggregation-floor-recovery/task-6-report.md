# Task 6 Report: Gallery and Fixed-Viewport Acceptance States

## Result

The development gallery now exercises the production aggregation instruments
and every persistent box-print recovery state. The refreshed real-browser
matrix passes all 61 registered states in both locales at 1280×800, 1024×768,
and 1280×1024: 366/366 rows. The review-correction schema-4 rerun also
passes all 6/6 accepted-semantic locale/viewport rows.

The initial Task 6 implementation was committed as
`f1786654 test(station): cover aggregation recovery views`; this report includes
the review-correction follow-up in the current scoped commit.

## Behavior and areas changed

- Registered persistent gallery IDs for missing template, missing printer,
  render failure, transport failure, and explicit skip confirmation.
- Replaced the synthetic aggregation counters/cards with production
  `ScanResultInstrument`, `BoxFillInstrument`, `WorkCounters`,
  `RecentOperations`, and `WorkFooter` components.
- Added a deterministic production-shaped accepted KM presentation with a
  compact check plus one normalized GS1 block containing AI 01/21/91/92/93 and
  long AI 92 data. No separate accepted verdict or GTIN/serial/crypto fact rows,
  raw scanner payload, or GS control character are rendered in the success area.
- Added the required `filled=2`, `capacity=20`, `ordinal=1` box fixture and six
  recent operations. The standalone box states now use the same production
  component and include 20-place empty and grouped 120-place full coverage.
- Rendered all recovery categories with the fixed, check-digit-valid SSCC
  `046012345600000016`. The skip-confirm fixture reaches the production
  component's own confirmation state with one deterministic gallery-only
  gesture; callbacks are no-ops and fixtures do not call SQLite, the network,
  printers, or Tauri APIs.
- Retained Task 3's outlined `next` cell marker and added it to the fixed-
  viewport source contract.
- Regenerated the browser matrix as schema version 4 and captured the long KM,
  20-place grid, and transport-recovery screenshots.

### Review correction RED/GREEN

The first Task 6 evidence was rejected because its 1024×768 screenshot visibly
clipped the accepted marker and parts of AI 92/93 while the matrix inspected
only interactives. It also exposed gallery-only accepted/action copy instead of
the live WorkScreen labels.

RED cycle 1 added structural semantic hooks and exact production-copy checks:
2 component/gallery tests failed because the production instrument had no
structural check/semantic hooks, and 2 locale cases failed because the gallery
could not find live `ПРИНЯТО`/`ACCEPTED` or full action strings. The shared
`buildWorkLabels` boundary then made WorkScreen and gallery consume the same
i18n values, and the production component gained a structural check.

The first real IAB semantic gate then correctly failed both 1024×768 rows: the
old multi-field content extended outside its own `overflow:hidden` verdict
surface. After layout compaction, the user explicitly approved a simpler
binding: compact check plus one normalized GS1 block, with no separate verdict
or fact cards.

RED cycle 2 changed Task 2/6 tests first. The focused run exited 1 with 2
failures because `data-semantic="normalized-code"` did not exist in the old
multi-field UI. Minimal production rendering then passed the focused Task 2/6
and WorkScreen suite: 4 files, 118 tests. The corrected IAB semantic matrix
passed 6/6 rows, including both locales at 1024×768, before the full matrix was
regenerated.

## TDD evidence

### RED

Tests were changed before gallery implementation. The requested wrapper:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/screen-gallery.test.tsx test/fixed-viewport-source.test.tsx
```

produced no output for 60 seconds in this checkout and was terminated rather
than left running. The checked-in Station Vitest binary was then run from the
package directory:

```bash
node_modules/.bin/vitest run \
  test/screen-gallery.test.tsx test/fixed-viewport-source.test.tsx \
  --reporter=verbose
```

Expected RED result: exit 1; `fixed-viewport-source.test.tsx` passed and
`screen-gallery.test.tsx` failed 7 tests while 34 passed. Failures were the five
missing recovery fixtures, the absent production scan instrument in
`work-aggregation`, and the missing persistent IDs. A second focused RED for
the grouped box fixture failed because the old synthetic box rendered zero
production cells instead of 20.

### GREEN

The same focused binary command after implementation passed:

```text
Test Files  2 passed (2)
Tests       42 passed (42)
```

The tests assert the five IDs in the exhaustive inventory, production recovery
copy/actions and valid SSCC, deterministic skip confirmation, long AI 92 data,
accepted local status without `SignalOverlay`, exactly 20 box cells with the
third marked `next`, 2/20 readout, six recent operations, and grouped capacity.

## Browser acceptance

The gallery was served from the isolated current-worktree Station Vite server
and measured in Codex in-app Chromium. Every state/localization combination was
run at every required viewport.

| Viewport  | Rows    | Exact bounds | Scroll | Clipped | Overlaps | Below 64 px | Semantics | Fonts   |
| --------- | ------- | ------------ | ------ | ------- | -------- | ----------- | --------- | ------- |
| 1280×800  | 122/122 | 122/122      | 0      | 0       | 0        | 0           | 2/2       | 122/122 |
| 1024×768  | 122/122 | 122/122      | 0      | 0       | 0        | 0           | 2/2       | 122/122 |
| 1280×1024 | 122/122 | 122/122      | 0      | 0       | 0        | 0           | 2/2       | 122/122 |
| **Total** | 366/366 | 366/366      | 0      | 0       | 0        | 0           | 6/6       | 366/366 |

Evidence:

- `docs/acceptance/station-touch-browser-matrix.json`
- `docs/acceptance/screenshots/station-work-aggregation-long-km-1280x800-ru.jpg`
- `docs/acceptance/screenshots/station-work-aggregation-20-grid-1024x768-ru.jpg`
- `docs/acceptance/screenshots/station-box-print-transport-failed-1024x768-ru.jpg`

The screenshots were visually inspected after the corrected capture. The
1024×768 aggregation image shows the compact check, complete wrapped normalized
code through `(93)XYZ1`, 2/20 ten-column grid, and exact production actions
`Отменить последний скан` and `Очистить короб`. The transport-recovery capture
retains fully visible 64 px actions and the complete SSCC.

One `pairing-error` / English / 1280×800 navigation transiently returned a blank
page during the full run. That exact row was rerun immediately and passed with
the requested state, locale, dimensions, and font evidence; no product failure
was suppressed.

## Automated gates

- Focused corrected Task 2/6/WorkScreen suite: 4 files, 118 tests passed.
- Full Station suite: 64 files, 741 tests passed. Existing intentional
  error-path logs, React `act(...)` notices, and jsdom's missing-canvas notice
  were emitted; there were no failures or skips.
- Two earlier default-concurrency broad attempts during and immediately after
  browser load exposed time-sensitive App/gallery failures (eight, then one).
  The remaining App file subsequently passed 63/63 in isolation, and the final
  bounded-worker full suite passed 741/741.
- Station typecheck: passed with no diagnostics.
- Station lint: passed with no diagnostics.
- Station production build: passed; 399 modules transformed.
- Selected-file Prettier check: passed.
- Matrix integrity: schema 4, 366 rows, 366 passed, 61 unique states, six
  locale/viewport groups, zero failed rows, and 6/6 required semantic rows.
- `git diff --check`: passed.

## Self-review

- Gallery values are deterministic and internally consistent: each semantic
  identity's normalized line uses the same serial and crypto segments.
- The gallery consumes production visual components but does not import or call
  persistence, hardware, printer, network, or Tauri boundaries.
- Recovery setup availability follows production behavior: only missing-printer
  and transport failures offer setup; all categories keep retry and explicit
  continue-without-label.
- The fixed SSCC is complete and valid. No recovery fixture allocates a serial
  or changes Task 1's allocation policy.
- Task 2's presentation changed only at the approved rendering boundary: the
  safe normalized model, journal, scan classification, signals, and sound are
  unchanged. Task 3 fill/ordinal logic, Task 4 persistence, and Task 5 recovery
  transitions are unchanged.
- Generated screenshots have `.jpg` extensions matching their actual JPEG
  content and exact CSS viewport pixel dimensions.

## Manual and external gaps

The browser matrix is not packaged Windows/Tauri or physical factory
acceptance. No real scanner, printer, ZPL/TSPL output, out-of-paper/disconnect
recovery, scan-back verification, speaker, gloved touch, Windows fullscreen,
or restart with a pending print job was exercised. Those gates remain external
and are not claimed by this task.
