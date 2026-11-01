# Office search and scanners implementation plan

**Goal:** Add read-only system search and office scanner setup, and keep pallet status compact.

**Spec:** ../specs/2026-11-01-office-search-scanners-design.md

**Architecture:** Reuse the current Office session, hardware sources and workstation settings.
An additive host read endpoint accepts normalized criteria; UI results route to existing cards.

## Work

- [x] Host/proto: failing auth/search tests, bounded search endpoint, Rust/Zod fixtures,
      HostApi.searchOffice(token, request), migration indexes where required; run focused Cargo tests.
- [x] Scanner provisioning: optional Office scanner provider, App wiring, exclusive settings
      ownership through existing WorkstationSetup; provider and office-PC integration tests.
- [x] UI: query classification, safe global scan subscription, sidebar search modal/result navigation,
      inline results, translated text, product deep links and compact PackStateChip geometry.
- [x] Integrate and run package test/typecheck/lint/build, relevant Cargo/fixture tests,
      browser desktop/mobile checks and final diff review.

## Constraints

No raw marking codes in URLs/logs; no new cloud or hardware runtime dependency;
no production writes from scans; keep offline and cloud provenance semantics.
No commit, push, release or deployment is authorized by this implementation request.

## Decisions

- Text search covers metadata; exact barcode lookups use indexed identities.
- Saved-file search navigates to its owning card, preserving saved bytes.
- USB keyboard mode cannot report a physical connection; COM can.

## Verification notes

- Focused tests cover normalized/hash-only queries, Rust/Zod parity, auth and
  read-only semantics, late responses, keyboard/COM ownership, form/dialog
  suppression, dirty-state recovery, product links and asynchronous file anchors.
- Chromium checks exercise the real status/search components at 390, 800 and
  1440 px in both themes. Screenshots were inspected.
- Full application run: 399 files / 8841 tests passed; 4 browser-only tests skipped
  without PLAYWRIGHT_CORE. The new browser test passed separately. Subsequent
  focused regressions passed: products 34/34 and saved-file/card checks 15/15.
- Cargo workspace with --no-fail-fast: 2829 passed, 12 ignored. Ignored cases
  require dedicated PostgreSQL, live Yandex credentials, manual large-data/load
  runs or a trusted environment for spawned hosts.
- Final standalone typecheck, lint and build passed. Repository format:check,
  focused formatting after the final navigation refinements, Cargo fmt --all
  --check and git diff --check passed.
- No physical USB/COM, Windows service, live host, or large-dataset acceptance
  was performed. Text substring searches scan metadata; exact identities use indexes.

## Copy review

Applied the requested humanizer review to search, scanner setup/self-test and
pallet-card labels. Updated 59 Russian strings while preserving interpolation
variables and technical instructions. Updated visible-text assertions.
Focused verification: 168 tests passed across 11 files; standalone typecheck,
lint and build passed. Chromium search/status checks passed at all three widths
in both themes; inspected the refreshed narrow-window screenshot. Full Rust and
application suites were not repeated for this text-only follow-up.

## Persistent header search

The user clarified that search must be a permanent header field on every Office
page. The shared header renders the field; Ctrl/Cmd+K focuses it, Enter submits,
and results expand underneath without a modal or backdrop. Escape, outside
presses and navigation dismiss results. Arrow keys reach the result buttons.
The scanner listener stays mounted; form/dialog and dirty guards still apply.
Late scan success and error responses are discarded when another form/dialog
opens. The global submit label distinguishes it from each page's local search.

Focused tests and the browser matrix pass. Chromium exercises 390, 800, 1280,
1440 and 1920 px in light/dark themes, field bounds, popup bounds and scrolling.
Final standalone typecheck, lint and build pass. Full Vitest run: 8846 passed,
4 skipped, and one outdated static assertion required flex-wrap on the header.
Replaced that implementation-specific assertion with real header bounds checks
in Chromium. Focused rerun: 4 files / 49 tests passed, including the layout suite;
the final browser matrix passed. No production source changed after the full run.
Host/Cargo and physical-device checks were not repeated for this UI-only change.

## Profile menu exit

Moved «Выйти в цех» from the header button row into the dropdown opened by the
profile name/avatar. The item is omitted on Office-only PCs. It uses the same
exit callback and unsaved-change guard.

Verification: 222 tests passed across App, Office and UserMenu; the final focused
Office/UserMenu rerun passed 43 tests. Typecheck, lint, build, changed-file
formatting and diff checks passed. Chromium verified the closed header and open
profile menu at five widths in both themes; screenshots were inspected. Rust
and physical-device checks were not repeated for this UI-only relocation.

## Full-screen review capture

Added a browser-only Office review harness with schema-validated synthetic
fixtures and simulated scanner adapters. Captured 14 complete 1440×1100 frames
covering Office pages, header search/profile, COM selection and scanner self-test.
No working database or physical scanner is used.

The full scanner view exposed its collapsed height inside Modal: the station
widget uses size containment and needs bounded available space. Gave the Office
scanner dialog an explicit viewport-bounded height and a shrinking flex body.
The capture checks that the widget has usable height and exercises the test-code
button and simulated scan verdict. Ten focused scanner tests, typecheck, lint,
build, formatting and diff checks pass. Physical/Windows validation was not run.

## Sidebar search and compact healthy status

The latest user direction supersedes the permanent header field: search is the
first sidebar action, separated from navigation by a small gap. Collapsed menus
show its icon; activation or Ctrl/Cmd+K opens the shared modal. Healthy host and
sync states use accessible green dots; warning and error states retain labels.

Final validation: standalone Vitest 400 files / 8,860 tests passed, four browser
tests skipped in that run. The Office browser-fit test ran separately and passed
all ten viewport/theme combinations. Typecheck, lint, build, repository formatting
and diff checks passed. Sixteen full-page review screenshots were captured with
typed demo fixtures; physical USB/COM hardware and Windows were not exercised.

## Search wording and menu spacing

The copy pass is limited to search: its action is «Найти», and its messages omit
the product edition name. Other translations match the snapshot taken before
this pass. Product branding and window titles retain their existing names.
Sidebar items have 4 px gaps; section headings have 16 px above and 12 px below.
Targeted search/scanner/layout tests (79), branding/import/overview tests (120),
and the restored disaggregation tests (44) passed. Chromium checked menu spacing
and search behavior at five widths in both themes.
