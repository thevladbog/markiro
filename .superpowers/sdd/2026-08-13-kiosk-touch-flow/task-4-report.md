# Touch flow Task 4 implementation report

## Outcome

The scan/cart surface is now a dark, fixed-viewport, touch-first screen over the canonical mixed-line cart. Portrait renders at most five lines per page; landscape renders at most three in an approved 45/55 scan-and-basket grid. The employee, scan feedback, totals, limit state, pager and neutral Continue action remain in the bounded shell without a document or cart-list scrollbar.

## Interaction and accessibility

- Each line is one >=48 px button. Individual KMs have a DataMatrix icon and boxes have a box icon; their accessible labels are `DataMatrix` and localized `Короб`/`Box`, with no CHZ/SSCC protocol label used as row type copy.
- Long product names and code tails use visual ellipsis while the full name is retained in the row accessible name/title and the full serial/SSCC is available in the detail dialog.
- The pager has 48 px Previous/Next controls, an announced `current / total` counter, and clamps after page-size, add, or remove changes through the shared pagination contract.
- Opening a line uses the shared accessible Modal focus trap/Escape/backdrop behavior. Removal requires a second explicit confirmation. A box shows only its product, SSCC and bottle count; it never exposes member KMs or partial quantity controls and is removed only as one whole line.
- Hidden-price policy mounts no row or total price. Unlimited employees retain explicit Unlimited/Без ограничений copy. Primary Continue remains neutral light-on-dark; semantic green is not used for cart actions.

## Compatibility boundaries

- Scanner subscription, async local SSCC resolution ordering, reducer admission/limit/overlap rules, restored mixed drafts, notice timers and submit failure recovery are unchanged.
- The existing combined buy/writeoff controls remain a compact compatibility bridge on this screen. Task 5 will replace them with the separate operation, reason and confirmation screens; this task does not pre-implement those routes.
- The existing submit label became localized `Продолжить`/`Continue`, matching the approved pre-operation transition. No browser viewport, installed-PWA, physical scanner or hardware acceptance is claimed here.

## TDD and verification

- RED: focused cart/layout/i18n run had 11 expected failures and 40 passes. Missing contracts covered paged row buttons, 5/3 capacity, pager, type icons, whole-box dialog and fixed CSS overflow; legacy submit tests also pinned the newly approved CTA copy.
- GREEN: focused cart/layout/i18n 51/51.
- Complete kiosk suite: 25 files / 556 tests passed.
- Kiosk typecheck and full `src test` ESLint passed.
- Vite PWA production build passed and generated the service worker/precache bundle.
- Changed-file Prettier check and `git diff --check` passed.

## External checks not performed

No browser screenshot/viewport measurement, tablet rotation, physical HID/Web Serial scan, installed PWA restart or hardware acceptance was performed. Those remain explicit later visual/hardware gates.

## Review fix

- Accepted KM and async box appends now open the page containing the new final line, briefly outline it with a reduced-motion-safe neutral treatment, and announce it through a live status. Duplicate/refused scans and removal do not move a still-valid page.
- `StatusStrip` now has a fixed 61 px single-row shell budget. It retains every semantic chip and one full accessible combined label while visual chip copy shrinks/ellipsizes instead of wrapping or scrolling.
- Fix RED: 3 failures / 50 passes. Focused GREEN: 54/54; complete kiosk 559/559; typecheck, full ESLint, PWA build, Prettier and diff-check passed.
