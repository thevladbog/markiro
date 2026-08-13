# Station Touch Workplace Acceptance Record

- Date: 2026-08-06
- Branch: `codex/station-touch-pairing`
- Task 12 baseline: `f0bf200b047d55fcbe48d86406339de196eff5d1`
- Browser-bootstrap fixes present during acceptance:
  `dc5ce9c276f3b242894efd8762ccd4323ffd9bea` and
  `3ce18d4bfc4609f2a4c2e42fadaf95594f1ac493`
- Aggregation/print-recovery gallery follow-up: 2026-08-13 on
  `codex/station-aggregation-recovery-design`, baseline `0a32f0b4`.

## Decision status

This record keeps automated, browser, real-application, and physical-hardware
evidence separate. The complete controlled gallery matrix passed at every
required viewport and locale. This is not a blanket claim about the packaged
Windows application or factory hardware: neither was available in this
environment.

## Environment

- Host: macOS 26.5.2 (Darwin 25.5.0), arm64.
- Node.js: 24.18.0.
- pnpm: 11.10.0 through Corepack, matching `packageManager`.
- Rust/Cargo: 1.93.0.
- Browser gallery: in-app Chromium through local Vite, using current-worktree
  UI and DB source aliases. The exact Chromium version was not recorded.
- Physical station, display, touch controller, gloves, scanner, printer, and
  Windows build: not available for this run.

## Automated gates

| Gate                                                               | Result in this run             | Notes                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm --filter @markiro/ui test`                          | PASS, 75/75                    | Four test files.                                                                                                                                                                                                                                                        |
| `corepack pnpm --filter @markiro/ui typecheck`                     | PASS                           | No diagnostics.                                                                                                                                                                                                                                                         |
| `corepack pnpm --filter @markiro/ui lint`                          | PASS                           | No diagnostics.                                                                                                                                                                                                                                                         |
| `corepack pnpm --filter @markiro/ui build`                         | PASS                           | TypeScript build completed.                                                                                                                                                                                                                                             |
| `corepack pnpm --filter @markiro/domain build`                     | PASS                           | TypeScript build completed.                                                                                                                                                                                                                                             |
| `corepack pnpm --filter @markiro/station test`                     | EXPECTED ENVIRONMENT FAILURE   | The inherited `apps/station/node_modules` overlay lacks current DB/UI exports: 42/82 suites passed, 40 failed; 146/163 executed tests passed and 17 failed. Most suites could not import `@markiro/db/station-sqlite`; remaining failures use the pre-floor UI runtime. |
| mapped station Vitest using current worktree UI/DB source          | PASS, 579/579                  | 51 files. The only extra output was jsdom's existing missing-canvas notice.                                                                                                                                                                                             |
| `corepack pnpm --filter @markiro/station typecheck`                | EXPECTED ENVIRONMENT FAILURE   | First diagnostic: `src/App.tsx(3,43): Cannot find module '@markiro/db/station-sqlite'`; stale declarations also reject floor controls and lack `Pager`/`FullScreenDialog`.                                                                                              |
| mapped station typecheck using current worktree UI/DB declarations | PASS                           | Uses committed `docs/acceptance/station-touch-tsconfig.json`; no diagnostics.                                                                                                                                                                                           |
| `corepack pnpm --filter @markiro/station build`                    | EXPECTED ENVIRONMENT FAILURE   | Vite transforms 289 modules, then the stale installed DB package rejects the new `./station-sqlite` export.                                                                                                                                                             |
| mapped Vite build using current worktree UI/DB                     | PASS                           | 294 modules. The prior Postgres/browser externalization warnings disappeared; the output has no `postgres-bytea`, `pg-connection-string`, or node-postgres graph.                                                                                                       |
| `corepack pnpm --filter @markiro/station lint`                     | EXPECTED ENVIRONMENT FAILURE   | Type-aware lint reports 46 unresolved-type errors because the stale installed DB package lacks `@markiro/db/station-sqlite`; no product lint rule is suppressed.                                                                                                        |
| mapped station lint using current worktree DB declarations         | PASS                           | Committed acceptance config changes only TypeScript resolution to current-worktree declarations; no diagnostics.                                                                                                                                                        |
| `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`     | PASS, 28/28                    | Host Rust tests only; not Windows fullscreen or hardware proof.                                                                                                                                                                                                         |
| `corepack pnpm --filter @markiro/db test`                          | PASS with infrastructure skips | 45 passed; 28 Postgres-backed tests skipped because the test database was not configured.                                                                                                                                                                               |
| `corepack pnpm --filter @markiro/db typecheck`                     | PASS                           | No diagnostics.                                                                                                                                                                                                                                                         |
| `corepack pnpm --filter @markiro/db lint`                          | PASS                           | No diagnostics.                                                                                                                                                                                                                                                         |
| `corepack pnpm --filter @markiro/db build`                         | PASS                           | Built the narrow station entry before station gates.                                                                                                                                                                                                                    |
| `corepack pnpm format:check`                                       | PASS                           | All repository files match Prettier; two earlier tracked branch documents received the approved mechanical-only format pass.                                                                                                                                            |
| `git diff --check`                                                 | PASS                           | No whitespace errors after the final report and acceptance edits.                                                                                                                                                                                                       |

### 2026-08-13 aggregation gallery follow-up

- Focused corrected Task 2/6/WorkScreen suite: 4 files, 118 tests passed.
- Full Station suite: 64 files, 741 tests passed. Existing intentional error-path
  logs, React `act(...)` notices, and jsdom's missing-canvas notice were emitted;
  there were no test failures or skips.
- Station typecheck and lint passed without diagnostics.
- Station production build passed with 399 modules transformed.
- Browser gallery: 366/366 state/locale/viewport rows passed. This is browser
  evidence only; no packaged Windows, touch, scanner, or printer claim is added.
- Review-correction rerun: schema 4 additionally checks the required accepted
  semantic content. All six aggregation locale/viewport rows show one compact
  check plus the exact normalized GS1 block with no missing, mismatched, or
  clipped content.

No `node_modules` link or dependency output was changed to conceal the stale
overlay. The mapped commands exercise the committed UI source/build from this
worktree; the standard failures remain recorded because they are the commands
the plan required.

### Reproducing the mapped gates

The inherited dependency overlay was created by an older pnpm layout. Every
JavaScript gate above was run through Corepack/pnpm 11.10.0 with
`pnpm_config_verify_deps_before_run=false`. This disables pnpm's pre-command
prompt to purge that overlay; it does not install packages or change module
resolution. No `node_modules` path was modified.

After building `@markiro/ui` and `@markiro/db`, the mapped station gates are:

```bash
pnpm_config_verify_deps_before_run=false corepack pnpm --filter @markiro/station exec vitest run --config ../../docs/acceptance/station-touch-vitest.config.mjs
pnpm_config_verify_deps_before_run=false corepack pnpm --filter @markiro/station exec tsc -p ../../docs/acceptance/station-touch-tsconfig.json --noEmit
pnpm_config_verify_deps_before_run=false corepack pnpm exec eslint apps/station --ignore-pattern 'apps/station/src-tauri/target/**' --ignore-pattern 'apps/station/src-tauri/gen/**' --config docs/acceptance/station-touch-eslint.config.mjs
pnpm_config_verify_deps_before_run=false corepack pnpm --filter @markiro/station exec vite build --config ../../docs/acceptance/station-touch-vite.config.mjs
```

The committed Vitest and Vite configs alias `@markiro/ui` and the narrow
station DB entry to this worktree. The TypeScript and ESLint configs use the
freshly built current-worktree declarations. The mapped Vite output goes only
to `/tmp/markiro-station-touch-acceptance-dist`; no development config is added
to the station application.

## Source audit

Audit scope: `apps/station/src` plus station-consumed floor primitives in
`packages/ui/src`.

| Risk                                  | Result and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `100vh`, `minHeight: "100vh"`         | Five residual boot/recovery/enrollment uses were found. A TDD source guard failed first; they now use `.station-centered-screen` at `height: 100%`, `min-height: 0`, and `overflow: hidden`. Final search has zero station-source matches.                                                                                                                                                                                                                                                                                                                                                 |
| `overflow: auto` / `overflow: scroll` | Zero station-source matches. The shared office-only Drawer retains `overflow: auto`; the station does not import Drawer. No `[data-scroll-region]` is produced by station source.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Growing rendered collections          | Shift cards are paged at 3; operator name matches are capped at 5; closed-box targets are sliced to 4 per page; conflicts use SQL `LIMIT/OFFSET` at 2; recent operations use SQL and render caps of 6; exception presets are fixed at four plus Other. Gallery lists are fixed fixture arrays of at most three visible cards/actions.                                                                                                                                                                                                                                                      |
| Non-rendered `.map()` calls           | Outbox, exception, closure and sync mappings operate on caller-supplied batch limits; code/operator mirror maps build local lookup caches and are not rendered directly. The complete closed-box mirror read is rendered only through the four-row pager. Scanner ports enter a native floor-sized Select rather than stacking controls in the page. The optional shell task map is a caller-owned fixed command definition; production currently supplies no task list.                                                                                                                   |
| Sub-64 floor actions                  | Enrollment pairing/service controls and PrintVerification exits were found using office/default sizing. TDD checks failed first; those controls now use explicit floor variants. All shared Button actions in station source now request `size="floor"`; setup tab/radio/range hit areas are 64 px. The visible radio/checkbox label is the 64 px hit target even though its native indicator is 28 px.                                                                                                                                                                                    |
| Sub-18 floor text                     | Floor tokens start at 18 px. PrintVerification exits now use floor typography. Shared Alert internals had 14–16 px inline defaults, so station-only CSS raises their title/body/glyph to 18/26 without changing office consumers. Compact non-action metadata is not implemented with `StatusChip`; the station status bar itself uses floor typography.                                                                                                                                                                                                                                   |
| Default typography                    | A final real-font browser pass found that non-component station copy inherited the browser's serif default even though bundled IBM Plex files had loaded. RED source/render coverage now connects the rendered `.station-root` boundary to station CSS and supplies the real design token; `#root` and `.station-root` explicitly use `var(--font-ui)`. Boot, enrollment, gallery, and live shell copy therefore inherit bundled IBM Plex Sans, while explicit mono counter/code rules remain unchanged.                                                                                   |
| Hover-only affordances                | No station `:hover` rule or mouse-enter/leave handler exists. `title` attributes on scan result text duplicate already-visible content and are not the only disclosure path. Focus-visible and active feedback are defined for station actions.                                                                                                                                                                                                                                                                                                                                            |
| Runtime asset/network dependency      | No image/CDN/runtime asset URL exists in station UI source. IBM Plex fonts remain bundled through `@fontsource`. The two `fetch` call sites are the authenticated station API client for business data, not visual assets. Browser acceptance also exposed a dependency leak: station imported SQLite migrations through root `@markiro/db`, which evaluated Postgres code and crashed without Node `Buffer`. Station now imports direct `@markiro/db/station-sqlite`; tests evaluate the entry and station mirror with `Buffer` absent, and the mapped bundle contains no Postgres graph. |
| Scaling and transforms                | No `scale()` or CSS `zoom` exists. The only app-control transform is the deliberate 1 px active press translation, disabled controls explicitly receive no transform. Spinner rotation does not scale the application.                                                                                                                                                                                                                                                                                                                                                                     |
| Clipping                              | Fixed screen/header/content/footer, dialogs, result slots, and bounded card grids intentionally use `overflow: hidden`. Ellipsis/line-clamp appears only where a visible bounded value has an accessible label or duplicated visible text. The schema-4 366-case browser matrix found no clipped or overlapping visible interactive; its semantic gate also found no missing, mismatched, or clipped required accepted-scan content at any required viewport.                                                                                                                              |

## TDD fixes discovered during acceptance

1. Fixed-viewport source guard: RED on residual `100vh`; GREEN after the
   shared 100%-height centered screen class.
2. Pairing/service touch controls: RED saw `var(--control-md)`; GREEN after
   floor Input/Button variants were applied throughout Enrollment.
3. Print-verification exits: RED saw `mk-btn--md`; GREEN after floor targets
   and 18 px control text.
4. Station Alert readability: source contract now pins the station-only 18/26
   override for shared Alert copy.
5. Browser-safe SQLite dependency: RED showed the missing narrow package entry
   and package export; GREEN evaluates the DB entry and station mirror with no
   `Buffer` global, while the mapped production build falls from 1,165 to 294
   modules and contains no Postgres client graph.
6. Bundled station typography: RED found the sans-family rule absent and the
   rendered station root on the user-agent default; GREEN source/render coverage
   pins the station root to `var(--font-ui)` while leaving explicit mono copy
   unchanged.

Focused GREEN evidence before the final broad rerun: viewport/typography/pressed
source plus rendered shell 10/10; Enrollment floor-control case 1/1;
PrintVerification floor-control case 1/1. The final broad mapped suite is
579/579.

## Browser gallery matrix

The corrected 2026-08-13 controlled gallery rerun covered all 61 registered
fixtures in Russian and English at all three required viewports: 366
combinations. The coverage includes the production `ScanResultInstrument`,
20-place and grouped `BoxFillInstrument` states, six recent operations, all
four persistent `BoxPrintRecovery` categories, and the explicit
skip-confirmation state.

| Viewport  | Fixtures/locales | Exact bounds | Scroll | Clipped actions | Overlaps | Below 64 px | Required semantics | Result       |
| --------- | ---------------- | ------------ | ------ | --------------- | -------- | ----------- | ------------------ | ------------ |
| 1280×800  | 122/122          | 122/122      | 0      | 0               | 0        | 0           | 2/2                | PASS 122/122 |
| 1024×768  | 122/122          | 122/122      | 0      | 0               | 0        | 0           | 2/2                | PASS 122/122 |
| 1280×1024 | 122/122          | 122/122      | 0      | 0               | 0        | 0           | 2/2                | PASS 122/122 |
| **Total** | **366/366**      | **366/366**  | **0**  | **0**           | **0**    | **0**       | **6/6**            | **PASS**     |

For every combination, document width and height exactly matched the viewport.
The browser found no document scroll, actually scrollable nested region,
clipped or overlapping visible interactive, or enabled action below 64 px.
For `work-aggregation`, it also required exactly one visible compact
`accepted-marker` and one exact `normalized-code`, checked each against the
viewport and every clipping ancestor, and rejected the removed verdict and
GTIN/serial/crypto fact hooks/copy. All six semantic rows passed with zero
missing, wrong, clipped, or internally scrollable values.

One `pairing-error` / English / 1280×800 navigation transiently returned a blank
page during the full run. The exact row was rerun immediately and passed with
the requested state, locale, dimensions, and font evidence; the retained
366-row matrix therefore contains the verified product result rather than the
navigation transient.

The browser waited for `document.fonts.ready`, then checked a visible element's
exact computed font shorthand and rendered text with `document.fonts.check`.
All 366 rows loaded a matching IBM Plex Sans face; mono code values retained the
separate bundled mono family.

The 1024×768 name-search fixture displayed five 64 px result buttons; the last
button ended at y=613 while the document remained exactly 1024×768. In the
setup-scanner fixture, the clicked tab had a visible 2 px solid
`rgb(109, 178, 255)` outline and a fully visible 322.7×64 px bounding box.

Held pressed feedback is not claimed as browser-visual evidence. The in-app
browser API exposes click, drag, and move but no separate pointer-down/up
primitive; concurrent drag sampling was serialized and never observed the held
state. Automated source coverage pins the enabled
`:active:not(:disabled):not([aria-disabled="true"])` transform to
`translateY(1px)` and disabled actions to `transform: none`. A real touchscreen
press remains part of external physical acceptance.

Representative captures:

- [Long accepted KM at 1280×800](screenshots/station-work-aggregation-long-km-1280x800-ru.jpg)
- [20-place grid at 1024×768](screenshots/station-work-aggregation-20-grid-1024x768-ru.jpg)
- [Transport recovery at 1024×768](screenshots/station-box-print-transport-failed-1024x768-ru.jpg)
- [Russian name search at 1024×768](screenshots/station-login-name-search-1024x768-ru.jpg)
- [Russian exception confirmation at CSS 1280×1024, DPR 2](screenshots/station-exception-confirm-1280x1024-at-2x.jpg)
- [English long-copy state at 1024×768](screenshots/station-long-copy-1024x768-en.jpg)

The DPR-aware exception capture is 2560×2048 pixels and contains the full
1280×1024 CSS viewport, including its footer. Raw browser metrics were
inner/document/visual 1280×1024, DPR 2, visual scale 1, CSS zoom 1; the confirm
action remained within bounds at right 1248 and bottom 1004.5 CSS pixels.

The complete 485,002-byte
[machine-readable browser matrix](station-touch-browser-matrix.json) uses schema
version 4 and retains all 366 raw state/locale/viewport rows. Each row records
requested and actual window/document/visual viewport geometry, DPR, zoom,
computed and loaded font evidence, interactive count and minimum target,
clipped/overlapping interactives, actual scroll regions, sub-64 actions, and
required semantic observations and pass status; its summary is 366 passed,
zero failed, and 6/6 required semantic rows passed.
Browser environment: in-app Chromium through local Vite with current UI/DB
source aliases; exact Chromium version not recorded.

## Real application acceptance

The ordinary application booted in the same browser environment and rendered
`Загрузка станции…` at an exact 1280×800 document size with no scroll and no
`Buffer`/Postgres dependency error. Continuing the flow was blocked because a
plain browser does not provide Tauri `invoke`, event, or SQL-plugin runtime;
the expected `invoke`/`transformCallback` errors were logged. No credentials or
production data were used. Therefore gallery and boot coverage are not being
reported as real-flow acceptance.

| Flow                                                | Result  | Reason / evidence needed                                                        |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| Pairing and credential recovery                     | NOT RUN | Requires disposable pairing code and non-production station identity.           |
| Numeric login/PIN, badge, and bounded name fallback | NOT RUN | Requires a synthetic synced roster and scanner input.                           |
| Shift selection/new shift                           | NOT RUN | Requires non-production shift/reference payloads.                               |
| Accepted/duplicate/rejected scans                   | NOT RUN | Requires scanner-equivalent payloads and a disposable local mirror.             |
| Box auto-close, undo, clear, reprint, disassemble   | NOT RUN | Requires aggregation shift, serial pool, template, and disposable printer path. |
| Conflict review                                     | NOT RUN | Requires synthetic local conflicts.                                             |
| Equipment setup                                     | NOT RUN | Requires safe scanner/printer endpoints.                                        |
| Offline queue, pending exit, reconnect drain        | NOT RUN | Requires controlled network removal and disposable server state.                |

Automated tests cover these state machines and invariants, but are not listed as
manual confirmation in this table.

## Windows, touch, and hardware acceptance

All items below remain external and are mirrored in
`docs/hardware-acceptance-checklist.md`:

- packaged Windows production fullscreen, close blocking, service exit and
  re-entry: NOT RUN;
- serial scanner, HID wedge, prefix/terminator and reconnect races: NOT RUN;
- TCP/serial printers, ZPL/TSPL and print-verification scan-back: NOT RUN;
- audible verdicts and mute/volume on the target speakers: NOT RUN;
- gloved touch through the production protective film: NOT RUN;
- physical network removal/recovery: NOT RUN;
- packaged-app restart with pending scans, boxes, exceptions and print
  outcomes: NOT RUN.

Host Rust and browser results cannot close any of these items.
