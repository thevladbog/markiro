# Touch flow Task 7 independent review

## Final re-review verdict

**APPROVED** — 0 Critical, 0 Important, 0 Minor.

Fix commit reviewed: `d8441258 fix(kiosk): close touch viewport browser gaps`.
The re-review was bounded to the three findings below plus Task 8 report honesty. No
production files were changed by review.

## Disposition of prior Important findings

### I1 — Resolved: outcome details are bounded without scroll or clipping

`Done` now renders no more than two safe concrete rejection lines and an additional-count
summary, while preserving bottle-aware total rejection copy. The conflict panel uses bounded
`overflow: hidden`, not a nested scrolling affordance. The committed fixture exercises a
fully rejected result with one loose and one box reason and a partial result with a box
reason.

The reproducible Chromium gate passed both cases at exactly 480×800 and 800×480. For each
case it independently asserted no document or active-screen scroll, no scrollable descendant,
and no clipped conflict panel (`scrollHeight <= clientHeight`). Result: 19/19 browser
scenarios passed, including rejected and partial in both orientations.

### I2 — Resolved: Pairing scan CTA computes to the shared 64 px floor

Pairing now passes `size="floor"` to the shared Button. The real production `App` test measured
the resulting computed `min-height` as 64 px at both exact minima, and the generic bounding-box
invariant found no interactive control below 48 px or outside the viewport. This closes the
previous inline-style precedence failure rather than merely adding another CSS declaration.

### I3 — Resolved: committed real-browser gate is reproducible and scoped honestly

`tools/production-browser` now exposes `test:kiosk` with a committed Playwright config,
self-managed Vite web server and 19-test Chromium matrix. An independent clean invocation of
`corepack pnpm run test:kiosk` passed all 19 scenarios. Two scenarios drive the real production
`App` through Pairing, durable pairing storage and branded Login at 480×800 and 800×480. The
remaining deterministic post-login states use the explicitly described visual fixture rather
than claiming to exercise production routing.

The gate also covers both exact minima, below-minimum diagnostics, 5/3 cart rows, descendant
overflow/clipping, computed 48 px floors, viewport bounds, visible focus and reduced motion.
A fresh production Vite/PWA build completed with 305 modules and 89 precache entries; neither
test files nor a `touch-flow` reference appeared in `dist`. The fixture therefore does not
become a production PWA entry or precached route.

## Task 8 report honesty

The final report is explicit that database/API coverage is incomplete in this checkout:
`DATABASE_URL` is absent, 51 PostgreSQL-backed DB tests are reported skipped, and the API
aggregate is stated as not fully green with environment/socket failures, skips and a CLI
timeout. It does not turn those infrastructure gaps into product passes, says the shared DB
was not migrated or mutated, and keeps physical tablet/scanner/PWA/object-storage/burn-in
acceptance unchecked. This matches the independently observed absent DB environment. The
review did not rerun infrastructure-dependent API/DB suites.

## Final re-review verification

- Focused kiosk: 4 files / 56 tests passed.
- Kiosk TypeScript: `tsc -p apps/kiosk/tsconfig.json --noEmit` passed.
- Production-browser TypeScript: `pnpm run typecheck` passed.
- Committed browser gate: `corepack pnpm run test:kiosk` passed 19/19 in Chromium.
- Production Vite/PWA build passed; 305 modules and 89 precache entries; test fixture absent
  from `dist`.
- `git diff --check d8441258^ d8441258` passed.

No physical tablet, HID/Web Serial scanner, installed-PWA restart or real private-logo test
was performed. Those remain external acceptance items, as the Task 8 report states.

---

## Original review of `f630e3fc`

Original verdict: **CHANGES REQUESTED** — 0 Critical, 3 Important, 0 Minor. The sections
below preserve the evidence that led to `d8441258`.

## Important findings

### I1 — Outcome conflicts still introduce an internal scroll region

Task 7 requires every state to stay non-scrolling at the exact minimum viewports. The
outcome screen instead gives its conflict panel `overflow-y: auto` and a bounded maximum
height (`apps/kiosk/src/kiosk.css:154-157`; low landscape overrides the panel to 116 px at
`apps/kiosk/src/kiosk.css:1385-1390`). The panel contains the complete loose/box conflict
list rendered by `Done` (`apps/kiosk/src/screens/Done.tsx:357-408`).

Independent Chromium reproduction against the committed Vite fixture:

- open `test/touch-flow.html?screen=partial` at exactly 480×800;
- `.kiosk-done__conflicts` measured `scrollHeight=236`, `clientHeight=156`, with computed
  `overflow-y: auto`;
- the fixture's one box conflict is therefore partly hidden behind internal scrolling;
- at 800×480 the rejected panel was also technically scrollable (`116 / 114`).

The document and `.kiosk-screen` equality checks still pass because they do not inspect
descendant overflow. This is a direct no-scroll acceptance violation, not only a test gap.
Replace the conflict region with a bounded/paged presentation (or another explicitly
approved no-scroll summary), and add a real-browser invariant over every visible descendant
that fails when `scrollHeight > clientHeight` on an element with scrollable overflow.

### I2 — The real Pairing scan CTA is 40 px high at both supported minima

The Pairing screen renders the optional scan action with the default `Button` size
(`apps/kiosk/src/screens/Pairing.tsx:428-438`). `Button` therefore writes the default 40 px
minimum inline (`packages/ui/src/components/Button.tsx:46-80`). The intended kiosk rules set
56/64/88 px only from stylesheet selectors (`apps/kiosk/src/kiosk.css:865-869`,
`apps/kiosk/src/kiosk.css:1263-1268`, `apps/kiosk/src/kiosk.css:1345-1348`), which cannot
override the inline `min-height` at equal importance.

Independent Chromium reproduction against the real production entry `/`:

- 480×800: button `Сканировать код` measured 385.4×40 px;
- 800×480: the same button measured 320×40 px.

The control is semantic and remains inside the viewport, but its actual touch target is
below the accepted 48 px floor. Pass the kiosk/floor `Button` size or otherwise make the
computed minimum authoritative, then assert its real bounding box at both exact minima.

### I3 — The committed browser fixture cannot substantiate the stated acceptance

Task 7 explicitly requires browser acceptance for every state, including pairing and login,
at both exact minima (`docs/superpowers/plans/2026-08-13-kiosk-touch-flow.md:631-635` and
`docs/superpowers/plans/2026-08-13-kiosk-touch-flow.md:692-716`). The committed fixture only
directly composes Cart, OperationChoice, WriteoffReason, Confirmation and Done
(`apps/kiosk/test/touch-flow-browser.tsx:9-16`, `apps/kiosk/test/touch-flow-browser.tsx:135-198`).
It does not exercise Pairing, Login, `App`, `KioskShell`, the flow reducer, scanner state, or
the claimed integrated route. In particular, the implementation report says the fixture
uses the production reducers (`task-7-report.md:7`) although no reducer is imported or run.

There is also no committed Playwright/browser test or package script: `touch-flow.test.tsx`
uses jsdom and source-text regex assertions (`apps/kiosk/test/touch-flow.test.tsx:1-78`), while
the package exposes only Vitest (`apps/kiosk/package.json:6-11`). The two concrete geometry
violations above consequently coexist with green focused tests and contradict the report's
claim that every measured control was at least 48 px and every state had no scroll
(`task-7-report.md:16-27`).

Commit a reproducible real-browser suite that covers the real Pairing/Login entry plus every
post-login state at 480×800 and 800×480, reduced motion, below-minimum diagnostics, descendant
scroll/overlap, viewport bounds, focus visibility/order and computed 48 px touch floors. If a
fixture remains necessary for terminal outcomes, state precisely which production path it
replaces and exercise the actual shell/reducer for the integrated path.

## Verified without findings

- `supportsKioskViewport` accepts exactly 480×800 and 800×480 and rejects 479×799 and
  799×479; the below-minimum diagnostic is bounded and semantic.
- In the committed post-cart fixture, Cart rendered exactly 5 portrait rows and 3 landscape
  rows; Confirmation rendered 5/3, and WriteoffReason rendered all six choices. Document and
  active-screen bounds matched at both exact minima, apart from the descendant outcome scroll
  described in I1.
- No overlap or out-of-viewport control was observed in the sampled fixture states or real
  Pairing entry.
- `prefers-reduced-motion: reduce` computed no line animation and zero-duration control
  transition. Outcome/diagnostic status is expressed with text and semantic roles, not color
  alone; focus styles are present. No additional semantic/a11y blocker was found beyond I2
  and the incomplete automated coverage in I3.
- A production Vite/PWA build completed and the built `dist` contained no reference to
  `touch-flow`; `index.html` and the production entry were not changed by the fixture.

## Verification evidence

- Focused Vitest: 6 files, 12 tests passed, 0 failed:
  `test/kiosk-layout.test.tsx`, `test/touch-flow.test.tsx`, `test/i18n.test.tsx` (and imported
  suites).
- TypeScript: `tsc -p apps/kiosk/tsconfig.json --noEmit --pretty false` — passed.
- Production build: `vite build` — passed, 305 modules, 89 PWA precache entries; fixture absent
  from `dist`.
- Diff hygiene: `git diff --check f630e3fc^ f630e3fc` — passed.
- Independent Chromium 151 geometry inspection: exact 480×800, exact 800×480, 479×799,
  799×479, and reduced-motion emulation. Findings and measurements are recorded above.

## Limits

- No physical tablet, HID/Web Serial scanner, or installed-PWA hardware run was performed.
- This review did not edit or re-run the ephemeral fixture API claimed by the implementation
  report; the committed repository does not contain a reproducible browser runner for it.
