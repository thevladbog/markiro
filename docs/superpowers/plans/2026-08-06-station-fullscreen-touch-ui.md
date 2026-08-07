# Station Fullscreen Touch UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change and `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this plan task by task. Use `superpowers:verification-before-completion` before claiming the station is scroll-free.

**Goal:** Turn the existing station scaffold into a fixed-viewport, gloved-touch workplace that makes the latest scan and current box dominant, uses bounded pagination instead of scrolling, and preserves all existing offline, scan, box, exception, print, and sync behavior.

**Architecture:** Extend the existing design system with explicit floor variants and accessible semantic-solid foregrounds. Add one station-only CSS/layout layer that owns `100dvh`, compact breakpoints, touch feedback, and fixed screen regions. Keep `WorkScreen` as the sequencing coordinator; extract pure visual instruments and bounded navigation around its existing callbacks. Use full-screen state machines for pairing, login, exceptions, confirmations, and setup. Engage existing Tauri lockdown commands only in production.

**Tech stack:** React 19, TypeScript strict, `@markiro/ui`, i18next, Vitest/Testing Library, Vite, Tauri 2/Rust.

## Global constraints

- Required viewports: 1280×800 and 1024×768. Secondary: 1280×1024.
- No document scroll and no nested scroll regions. Growing collections use fixed page sizes and large pagination controls.
- No transform scaling of the application.
- Floor targets are at least 64×64 px; floor text is at least 18 px; keypad keys are 80–96 px.
- Keep bundled IBM Plex fonts and existing tokens. No new font, image CDN, animation library, or runtime network asset.
- No hover-dependent action. Preserve keyboard/focus operation and visible `:focus-visible`.
- Do not change scan classification, queue ordering, duplicate ownership, journal writes, box closure, exception sync, label rendering, or retry behavior while extracting presentation.
- `WorkScreen` callbacks that mutate production state remain serialized through the current queue/ref discipline. Presentational components receive values and callbacks only.
- Login storage/API remains 3–12 digits. Only UI entry shorter than three digits is left-padded.
- Shared `styles.css` may reset generic document defaults, but station-only `overflow: hidden` belongs in `apps/station/src/station.css`.
- Automated DOM tests are not visual proof. Browser and physical hardware results are reported separately.

---

## Task 1: Add floor-sized design-system controls and contrast-safe solid tokens

**Files:**

- Modify: `packages/ui/src/tokens.css`
- Modify: `packages/ui/src/styles.css`
- Modify: `packages/ui/src/components/Button.tsx`
- Modify: `packages/ui/src/components/Input.tsx`
- Modify: `packages/ui/src/components/Select.tsx`
- Modify: `packages/ui/src/components/PinPad.tsx`
- Modify: `packages/ui/src/components/SignalOverlay.tsx`
- Create: `packages/ui/src/components/FullScreenDialog.tsx`
- Create: `packages/ui/src/components/Pager.tsx`
- Modify: `packages/ui/src/components/index.ts`
- Modify: `packages/ui/test/components.test.tsx`
- Modify: `packages/ui/test/feedback.test.tsx`
- Modify: `packages/ui/test/pin-pad.test.tsx`

**Contract produced:** explicit floor variants, full-screen dialog, bounded pager, and semantic solid foregrounds.

- [ ] **Step 1: Write failing component contracts**

Test:

```typescript
<Button size="floor" />
<Input size="floor" />
<Select size="floor" />
<PinPad maxLength={8} size="floor" />
<Pager page={2} pageCount={4} onPageChange={...} />
```

Assert accessible names, disabled behavior, page boundary disabling, input label/error linkage, digit max length, and that `FullScreenDialog` traps/restores focus and has an explicit large Back/Cancel action.

- [ ] **Step 2: Add generic document reset**

In shared styles set `box-sizing: border-box`, remove default body margin, make controls inherit fonts, and ensure `html/body/#root` can receive full-height layouts. Do **not** globally hide overflow.

- [ ] **Step 3: Add floor variants**

Extend existing size unions rather than creating parallel components. Floor Button/Input/Select use `--control-floor`, floor typography tokens, and minimum 64 px targets. Preserve default office rendering exactly.

- [ ] **Step 4: Make PinPad layout valid**

Render a true 3×4 grid with a deliberate empty/correction/zero row rather than mapping ten keys into an accidental final position. Provide Backspace and Clear as labelled controls; no small icon-only target.

- [ ] **Step 5: Add on-solid tokens and update SignalOverlay**

Define foregrounds separately for light/dark semantic solids. Add icon/text pairing and use tokens instead of literal white. Verify contrast numerically in a unit test helper or documented calculation; target AA large text, AAA where possible.

- [ ] **Step 6: Run UI package gates**

```bash
pnpm --filter @markiro/ui exec vitest run test/components.test.tsx test/feedback.test.tsx test/pin-pad.test.tsx
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
```

Review gate: render default office variants and confirm their dimensions/semantics did not change.

---

## Task 2: Establish the fixed station viewport and shell

**Files:**

- Create: `apps/station/src/station.css`
- Modify: `apps/station/src/main.tsx`
- Modify: `apps/station/src/ui/FloorShell.tsx`
- Modify: `apps/station/src/ui/StatusBar.tsx`
- Create: `apps/station/src/ui/FloorFooter.tsx`
- Create: `apps/station/src/ui/StationScreen.tsx`
- Modify: `apps/station/test/status-bar.test.tsx`
- Create: `apps/station/test/floor-shell.test.tsx`

**Contract produced:** one shell with status/header, `min-height: 0` screen slot, optional 72 px footer, no empty task nav, and a compact status mode.

- [ ] **Step 1: Write failing semantic shell tests**

Assert one banner, one active screen region, zero task nav when no tasks exist, optional footer, stable accessible labels, and compact groups that do not duplicate status content.

- [ ] **Step 2: Add station CSS viewport contract**

```css
html,
body,
#root {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}
.station-root {
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}
.station-screen-slot {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
```

Add landscape grid rules and a `max-width: 1100px` compact breakpoint. Every station action gets `touch-action: manipulation`, pressed translation, focus ring, and no disabled transform.

- [ ] **Step 3: Refactor FloorShell**

Replace inline `minHeight: 100vh`. Remove the always-rendered task navigation. Accept optional `footer` and contextual station/operator/shift labels needed by the new status bar.

- [ ] **Step 4: Compress StatusBar deliberately**

Show station, line, operator, shift, network, sync/pending, conflicts, scanner, and printer. Remove placeholders with no live source (for example Agent/teammates) until real data exists. Compact mode groups hardware and sync values without wrapping.

- [ ] **Step 5: Run shell and existing app tests**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/station exec vitest run test/floor-shell.test.tsx test/status-bar.test.tsx test/App.test.tsx
```

Review gate: inspect every remaining `100vh`, `overflow-y`, `overflow: auto`, and unbounded `.map()` in station UI; record later tasks that remove them.

---

## Task 3: Engage Tauri lockdown in production only

**Files:**

- Create: `apps/station/src/lib/lockdown.ts`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src-tauri/tauri.conf.json`
- Modify: `apps/station/src-tauri/src/commands.rs` only if tests reveal a lifecycle gap
- Create: `apps/station/test/lockdown.test.ts`
- Modify: Rust command tests near `apps/station/src-tauri/src/commands.rs`

**Contract produced:** production startup invokes existing lockdown; development stays resizable/windowed; an explicit service action can exit/re-enter lockdown.

- [ ] **Step 1: TDD environment decision and invoke wrapper**

Test that `shouldEnterLockdown({ dev: true })` is false and production is true. Mock Tauri invoke and assert one `enter_lockdown` call, idempotent cleanup, and actionable error logging without rendering secrets.

- [ ] **Step 2: Keep Tauri config development-friendly**

Do not hardcode `fullscreen: true` in the shared window config if it breaks `tauri dev`. Use the command after app boot for production; retain the 1280×800 development default.

- [ ] **Step 3: Wire service exit**

The hidden service menu may call `exit_lockdown`; returning to floor mode calls `enter_lockdown`. Ordinary operators receive no small accidental exit affordance.

- [ ] **Step 4: Run TS and Rust focused tests**

```bash
pnpm --filter @markiro/station exec vitest run test/lockdown.test.ts test/App.test.tsx
cargo test --manifest-path apps/station/src-tauri/Cargo.toml lockdown
```

Review gate: do not claim Windows close blocking until tested on Windows.

---

## Task 4: Rebuild operator sign-in as badge-first, bounded fallback flow

**Files:**

- Modify: `apps/station/src/pages/OperatorLogin.tsx`
- Modify: `apps/station/src/lib/auth.ts`
- Create: `apps/station/src/lib/operator-search.ts`
- Create: `apps/station/src/ui/OperatorNameSearch.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/auth.test.ts`
- Modify: `apps/station/test/operator-login.test.tsx`
- Create: `apps/station/test/operator-search.test.ts`

**Contract produced:** full-screen badge primary state, numeric login/PIN secondary state, maximum-five-result name fallback, and exact minimum-length padding.

- [ ] **Step 1: TDD login normalization boundary**

Add a pure helper:

```typescript
padShortOperatorLogin("1") === "001";
padShortOperatorLogin("12") === "012";
padShortOperatorLogin("123") === "123";
padShortOperatorLogin("000123") === "000123";
```

Reject non-digits and more than 12 digits in the UI. Keep API/storage validation at 3–12 and exact local lookup after padding.

- [ ] **Step 2: TDD badge-first state machine**

On mount, badge scan remains active. A large secondary action enters login, then PIN. Back returns one stage without clearing unrelated roster state. Wrong credentials clear secret entry and use one generic error. Busy state rejects duplicate submits/scans as today.

- [ ] **Step 3: TDD bounded name search**

Normalize case/whitespace for display-name search, require 2–3 entered letters according to locale, return at most five deterministic matches, and never expose PIN/badge hashes. Selecting a name moves to PIN with its stored exact login.

- [ ] **Step 4: Implement fixed-viewport composition**

Use one prompt zone, one input/readout zone, one PinPad zone, and one fixed action row. Errors replace a reserved message slot instead of pushing controls down.

- [ ] **Step 5: Preserve timing equalization**

Keep `DUMMY_PHC` verification for unknown logins. The search fallback does not authenticate and cannot bypass `verifyOperatorPin`.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter @markiro/station exec vitest run test/auth.test.ts test/operator-login.test.tsx test/operator-search.test.ts
```

Review gate: `123` must not match `000123`; only entries shorter than three are padded.

---

## Task 5: Bound shift selection and new-shift states

**Files:**

- Modify: `apps/station/src/pages/ShiftSelection.tsx`
- Modify: `apps/station/src/pages/NewShift.tsx`
- Create: `apps/station/src/ui/ShiftCard.tsx`
- Create: `apps/station/src/lib/pagination.ts`
- Modify: `apps/station/test/shift-selection.test.tsx`
- Modify: `apps/station/test/new-shift.test.tsx`
- Create: `apps/station/test/pagination.test.ts`

**Contract produced:** fixed page size for shifts, no growing card stack, stable reserved error area, and full-slot New Shift states.

- [ ] **Step 1: TDD pagination helper**

The helper clamps page on dataset changes, returns deterministic slices, and exposes page count. Pin separate page sizes if 1280 and compact layouts differ; recommended conservative size is three cards at 1024×768.

- [ ] **Step 2: TDD selection states**

Cover loading, error/retry, empty, one page, multiple pages, active rejoin, planned open, setup, conflicts, and new-shift actions. No test should rely on scroll position.

- [ ] **Step 3: Refactor ShiftSelection**

Use StationScreen with title/header, fixed card grid, Pager, and footer actions. Filter closed shifts before paging. Keep current API/open behavior.

- [ ] **Step 4: Refactor NewShift states**

Input, product found, and product missing are mutually exclusive full-slot panels. The scan/input area and primary action stay in fixed regions; alerts replace reserved text rather than changing total layout height.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @markiro/station exec vitest run test/pagination.test.ts test/shift-selection.test.tsx test/new-shift.test.tsx
```

Review gate: no station list maps an unbounded server array directly into the viewport.

---

## Task 6: Extract the Instrument Split work-screen presentation

**Files:**

- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Create: `apps/station/src/ui/work/ScanResultInstrument.tsx`
- Create: `apps/station/src/ui/work/BoxFillInstrument.tsx`
- Create: `apps/station/src/ui/work/WorkCounters.tsx`
- Create: `apps/station/src/ui/work/RecentOperations.tsx`
- Create: `apps/station/src/ui/work/WorkFooter.tsx`
- Modify: `apps/station/src/lib/journal.ts`
- Modify: `apps/station/test/journal.test.ts`
- Modify: `apps/station/test/work-screen.test.tsx`
- Create: `apps/station/test/work-instruments.test.tsx`

**Contract produced:** dominant latest result and box fill on the left; counters and at most six recent operations on the right; fixed footer; unchanged production callbacks.

- [ ] **Step 1: Pin existing WorkScreen behavior before extraction**

Add or confirm tests for sequential scans, accepted/rejected counts, duplicate signal, last-scan undo eligibility, box auto-close, print queue ordering, clear, reprint, disassemble, exit with pending sync, and source subscription cleanup.

- [ ] **Step 2: Add bounded recent-operation read**

Create a query returning the latest six `scan_events_mirror` rows for the active shift in deterministic newest-first order. Return display-safe fields (verdict, time, product/code suffix as available), not full raw codes. Test malformed timestamps and fewer/more than six rows.

- [ ] **Step 3: Build pure instruments**

Each new component accepts plain props and callbacks. It performs no SQLite/network work and has no scan-source effects. Test long product names, null box, capacity zero/null, over-capacity display, large counts, offline/pending labels, and accessible status text.

- [ ] **Step 4: Recompose WorkScreen**

Keep queue construction, refs, print functions, box state transitions, and exception calls in `WorkScreen`. Replace only the render tree and add a recent-operations refresh after a committed local scan. The refresh cannot delay `onScanRecorded` or the next scan.

- [ ] **Step 5: Move exit/exception actions to fixed footer**

Exceptions opens its dedicated flow. Pause / Finish retains the current semantics: leaving the station screen does not close the server shift. Pending-sync confirmation remains explicit.

- [ ] **Step 6: Run broad work-loop regression tests**

```bash
pnpm --filter @markiro/station exec vitest run test/journal.test.ts test/work-instruments.test.tsx test/work-screen.test.tsx test/scan-queue.test.ts test/close-box.test.ts test/print-verification.test.tsx
```

Review gate: compare callback order in tests before/after; presentation extraction must not add a new race.

---

## Task 7: Make scan signals contrast-safe and behaviorally stable

**Files:**

- Modify: `packages/ui/src/components/SignalOverlay.tsx` if Task 1 left station-specific hooks
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/lib/signal-sound.ts` only if accessible signal mapping requires it
- Modify: `apps/station/test/signal-overlay.test.tsx`
- Modify: `apps/station/test/signal-sound.test.ts`
- Modify: `apps/station/test/work-screen.test.tsx`

**Contract produced:** icon + title + detail, non-color-only tones, current timing, and explicit acknowledgement only for genuinely blocking states.

- [ ] **Step 1: TDD tone semantics and timing**

Pin OK 350 ms, duplicate 900 ms, ordinary error 1200 ms unless product testing deliberately revises them. Fake-timer tests prove a newer signal cannot be cleared by an older timer.

- [ ] **Step 2: Add accessible icon/text mapping**

Use semantic SVG/icons with `aria-hidden`, while the title/detail carry the alert text. Preserve `role="alert"`. No emoji or color-only symbol.

- [ ] **Step 3: Distinguish blocking recovery states**

Printer verification, serial exhaustion, and credential recovery use a persistent full-screen state with a large action. Ordinary validation errors continue to time out so scanning flow is not blocked.

- [ ] **Step 4: Verify contrast and sound mapping**

Ensure visual tone and sound tone cannot diverge. Muted state suppresses sound, not visual status.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @markiro/ui exec vitest run test/feedback.test.tsx
pnpm --filter @markiro/station exec vitest run test/signal-overlay.test.tsx test/signal-sound.test.ts test/work-screen.test.tsx
```

Review gate: manually calculate/check every foreground/background combination used in dark station mode.

---

## Task 8: Rebuild exceptions as Action First with bounded reasons and boxes

**Files:**

- Create: `apps/station/src/pages/ExceptionFlow.tsx`
- Create: `apps/station/src/ui/exceptions/ExceptionActions.tsx`
- Create: `apps/station/src/ui/exceptions/ReasonPicker.tsx`
- Create: `apps/station/src/ui/exceptions/OtherReasonDialog.tsx`
- Modify: `apps/station/src/ui/ShiftBoxesPanel.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/shift-boxes-panel.test.tsx`
- Create: `apps/station/test/exception-flow.test.tsx`

**Contract produced:** large action selection, then target, then bounded preset/Other reason; full-screen confirmations; paginated closed boxes.

- [ ] **Step 1: Pin existing exception business behavior**

Tests must prove Undo has no reason/confirmation, Clear has confirmation and no reason, Reprint has reason and no state mutation, Disassemble has reason plus irreversible confirmation, and all actions still enqueue through current libraries.

- [ ] **Step 2: Define local preset copy**

Use bounded, translated presets without changing the server schema:

- Reprint: damaged label; unreadable label; printer jam/no output; quality-control request; Other.
- Disassemble: wrong product; wrong quantity; damaged package; quality-control rejection; Other.

The selected translated label continues into the existing free-text `reason`. Broader coded/configurable reasons are a separate domain task.

- [ ] **Step 3: Build the action-first state machine**

Stages are action, target, reason, confirm, applying, result. Back moves one stage without executing. Only the current stage renders, so controls never stack vertically.

- [ ] **Step 4: Paginate closed boxes**

Use fixed-height rows/cards and Pager. Preserve most-recent-first order and current terminal/shift scoping. A selected box stays selected only while it remains in the dataset.

- [ ] **Step 5: Use FullScreenDialog for Other and destructive confirm**

Other reason max remains 500 characters. Disassemble names the SSCC and explicitly states it cannot be reused. No small modal or page scroll.

- [ ] **Step 6: Run exception regressions**

```bash
pnpm --filter @markiro/station exec vitest run test/exception-flow.test.tsx test/shift-boxes-panel.test.tsx test/work-screen.test.tsx test/boxes.test.ts test/box-exceptions-mirror.test.ts
```

Review gate: no visual step bypasses an existing audit/reason invariant.

---

## Task 9: Paginate conflicts without interrupting production

**Files:**

- Modify: `apps/station/src/lib/conflicts.ts`
- Modify: `apps/station/src/pages/ConflictList.tsx`
- Modify: `apps/station/test/conflicts.test.ts`
- Modify: `apps/station/test/conflict-list.test.tsx`

**Contract produced:** bounded conflict pages, stable newest-first ordering, distinct read-failure/empty states, and no automatic interruption.

- [ ] **Step 1: Add a paged local read contract**

Prefer SQL `LIMIT/OFFSET` plus a separate count instead of loading an unbounded mirror. Return `{ items, page, pageSize, total }`; clamp invalid pages and preserve malformed-timestamp fallback.

- [ ] **Step 2: Write failing screen tests**

Cover zero, one, multiple pages, next/previous, dataset shrink, read failure, long terminal IDs, and Back. Confirm conflicts are still opened deliberately from a floor action and never as a modal over scanning.

- [ ] **Step 3: Implement fixed-height conflict cards**

Show physical identification, winning terminal/time, and concise recovery meaning. Reserve a message slot so errors do not move the pager/footer.

- [ ] **Step 4: Run focused tests**

```bash
pnpm --filter @markiro/station exec vitest run test/conflicts.test.ts test/conflict-list.test.tsx test/sync.test.ts
```

Review gate: conflict pagination does not modify conflict retention or sync semantics.

---

## Task 10: Rebuild equipment setup as Guided Tabs

**Files:**

- Modify: `apps/station/src/pages/WorkstationSetup.tsx`
- Create: `apps/station/src/ui/setup/SetupTabs.tsx`
- Create: `apps/station/src/ui/setup/ScannerSetupPanel.tsx`
- Create: `apps/station/src/ui/setup/PrinterSetupPanel.tsx`
- Create: `apps/station/src/ui/setup/SoundSetupPanel.tsx`
- Create: `apps/station/src/ui/setup/TouchRange.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/workstation-setup.test.tsx`
- Create: `apps/station/test/setup-tabs.test.tsx`

**Contract produced:** Scanner/Printer/Sound tabs with direct access, Next, one bounded panel, test result area, and fixed footer; available before pairing.

- [ ] **Step 1: Pin hardware ownership and save behavior**

Keep current close-before-open scanner sequencing, serial port/baud semantics, printer transport/language behavior, sound persistence, test print, and Done/Back reconciliation. Add regression tests before extraction.

- [ ] **Step 2: TDD tab semantics**

Use `role="tablist"`, tabs, and tabpanels with arrow-key support. Only one panel is mounted/visible at a time. Direct tab selection and Next produce the same state.

- [ ] **Step 3: Extract panels without moving side effects**

`WorkstationSetup` remains the state/save coordinator. Panels receive values and callbacks. Scanner ownership cannot be split across competing effects.

- [ ] **Step 4: Replace small native affordances**

Wrap radio/checkbox/range controls in 64 px labelled targets. `TouchRange` supports keyboard arrows and exposes current numeric value. Do not substitute custom divs for semantic inputs.

- [ ] **Step 5: Reserve test-result space**

Connected/failed/test output appears in a fixed area and never pushes the footer. Printer test and scanner test remain explicit large actions.

- [ ] **Step 6: Run broad setup/hardware tests**

```bash
pnpm --filter @markiro/station exec vitest run test/setup-tabs.test.tsx test/workstation-setup.test.tsx test/hardware.test.ts test/hardware-config.test.ts test/signal-sound.test.ts
```

Review gate: setup remains reachable before pairing and returns to the exact prior pairing/floor state.

---

## Task 11: Add a development-only screen gallery for repeatable viewport review

**Files:**

- Create: `apps/station/src/dev/StationScreenGallery.tsx`
- Create: `apps/station/src/dev/gallery-fixtures.ts`
- Modify: `apps/station/src/main.tsx`
- Create: `apps/station/test/screen-gallery.test.tsx`

**Contract produced:** `?gallery=1` in development renders deterministic non-production fixtures for every important state; production build cannot activate it.

- [ ] **Step 1: TDD the production guard**

Assert the gallery route is selected only when `import.meta.env.DEV` and the query flag are both true. The production branch always renders `App`.

- [ ] **Step 2: Create deterministic fixtures**

Include pairing waiting/error/success/recovery, badge/login/PIN/name search, shift pages, validation/aggregation work states, OK/duplicate/error signals, empty/full box, exceptions stages, conflicts pages, setup tabs, offline/sync-stuck, print verification, and long RU/EN copy.

Fixtures contain synthetic codes/names and never read local production config or SQLite.

- [ ] **Step 3: Add state/locale controls outside captured frame**

Use query parameters or a small development toolbar that can be hidden for screenshots. The rendered target itself remains the exact station shell at the chosen state.

- [ ] **Step 4: Test fixture completeness**

Maintain an expected-state list so adding a new persistent screen without a gallery fixture fails a focused test.

- [ ] **Step 5: Run gallery test/build**

```bash
pnpm --filter @markiro/station exec vitest run test/screen-gallery.test.tsx
pnpm --filter @markiro/station build
```

Review gate: inspect the production bundle/source path and confirm no gallery switch is reachable outside DEV.

---

## Task 12: Prove the no-scroll contract and run final gates

**Files:**

- Modify: `docs/hardware-acceptance-checklist.md`
- Create: `docs/acceptance/station-touch-workplace.md`
- Modify: tests only where final gaps are found

- [ ] **Step 1: Run all changed-package automated gates**

```bash
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
pnpm --filter @markiro/domain build
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
pnpm format:check
git diff --check
```

- [ ] **Step 2: Audit forbidden layout patterns**

```bash
rg -n "100vh|overflow(-y)?: *(auto|scroll)|minHeight: *\"100vh\"" apps/station/src
```

Every match needs an explicit explanation or removal. Search unbounded lists and small controls as well; do not rely on the absence of CSS keywords alone.

- [ ] **Step 3: Browser-check every gallery state at every viewport**

At 1280×800, 1024×768, and 1280×1024, record for each state:

```javascript
document.documentElement.scrollWidth === window.innerWidth;
document.documentElement.scrollHeight === window.innerHeight;
document.querySelectorAll("[data-scroll-region]").length === 0;
```

Also verify the smallest target via `getBoundingClientRect`, visible focus, no clipped primary action, no hover-only affordance, RU/EN long copy, and pressed feedback.

- [ ] **Step 4: Exercise the real app, not only fixtures**

Run pairing, login, shift selection, a sequence of accepted/duplicate/rejected scans, box auto-close, undo, clear, reprint, disassemble, conflict review, setup, offline queue, and exit with pending sync against a non-production environment. Compare actual screen geometry to gallery results.

- [ ] **Step 5: Run external hardware acceptance separately**

On the target Windows station verify fullscreen/close blocking, scanner wedge and serial modes, printer transports/languages, sound, touch with gloves, network removal/recovery, and restart with pending data. Host-only checks do not satisfy this step.

- [ ] **Step 6: Write the acceptance record**

Record viewport/state results, screenshots, automated commands, physical environment, hardware models, and all unrun checks with reasons. Never summarize a partial browser pass as “the interface has no scroll”.

Final review gate: request a whole-plan review focused on scan-order preservation, fixed-viewport completeness, touch accessibility, and honest external verification.
