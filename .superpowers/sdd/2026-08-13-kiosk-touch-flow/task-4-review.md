# Touch flow Task 4 review

## Verdict

**CHANGES REQUESTED.** Commit `840d85fb` establishes the intended paged cart primitives and preserves the mixed-cart scanner/submission path, but two Important fixed-viewport behaviors remain incomplete.

## Important findings

### I1 — A newly scanned line can remain hidden on another page

`Cart` keeps `page` independently from `state.lines` and passes it unchanged to `PagedLines` (`apps/kiosk/src/screens/Cart.tsx:318-320,414-418`). `PagedLines` clamps only when the current page becomes invalid (`apps/kiosk/src/ui/PagedLines.tsx:21-26`); adding a line normally increases or preserves the page count, so it does not move to the page containing the append.

Example: with 11 portrait lines, move to page 2 (`6-10`) and scan line 12. The reducer appends line 12 on page 3, while page 2 remains valid. The new item is invisible and there is no neutral highlight. This contradicts the accepted overflow contract: an added scan moves to the new line's page and briefly highlights it.

Required correction: on every accepted append, select the page containing the new final line (`Math.floor((lines.length - 1) / pageSize)`) without changing page for rejected scans. Keep the cart order stable and preserve valid clamping on remove/rotation. Add regressions for a successful KM and asynchronously resolved box from a non-final page, plus a refusal that must not move the page.

### I2 — Exact-minimum row capacity is not reserved when the persistent status strip wraps

The cart itself budgets 65 px header, 158 px portrait feedback, 116 px checkout, 40 px basket header, 48 px pager and five rows with `min-height:48px` (`apps/kiosk/src/kiosk.css:102-104,321-348,553-647`). However, the persistent `StatusStrip` is outside the cart in `KioskLayout` and uses `flexWrap:"wrap"`, 40 px chips and 10 px vertical padding (`apps/kiosk/src/ui/StatusStrip.tsx:90-109`). At 480 px width, offline + stale + quarantine states can wrap to two or three rows and reduce the cart slot well below the 800 px surface budget.

Even one 61 px status row leaves only 739 px for the cart: `65 + 158 + 116 + 40 + 48 + 5×48 = 667px` before borders and the scan/basket paddings. A wrapped status row removes another 52 px and can force the `minmax(0,1fr)` row tracks below their 48 px touch floor or clip content behind `overflow:hidden`. The tests only assert DOM row counts and CSS source strings; they do not exercise the real shell/status combination or geometry, so they cannot prove that all five/three targets and CTA are visible at the supported minima.

Required correction: make the status surface a fixed single-row budget at supported minima, with bounded visual ellipsis/overflow and full accessible labels, never document or horizontal scrolling. Recalculate the portrait and landscape cart tracks against that real reserved height. Add a shell-level worst-status test and retain later browser acceptance using `scrollHeight/clientHeight` and control rectangles at both exact minima.

## Reviewed behavior without findings

- `PagedLines` preserves order, clamps after remove/page-size change and supplies 48 px previous/next controls with an announced `X / Y` counter.
- Rows are touch buttons with full accessible names; long names/code tails visually ellipsize and full details are present in the modal.
- DataMatrix and box type labels are explicit and do not use CHZ/SSCC as row type copy.
- The shared modal provides dialog semantics, focus trap, Escape/backdrop close and focus restoration. Box details contain product/count/SSCC only; member keys and partial quantity controls are absent. Removal is whole-line and explicitly confirmed.
- `showPrices=false` mounts neither row nor total prices; unlimited copy remains explicit; the Continue CTA is neutral rather than semantic green.
- Existing scanner subscription/async SSCC ordering, reducer limits/overlap, restored draft and submit bridge remained green in the complete kiosk suite.
- RU and EN key sets remain identical.

## Verification

- Focused cart/layout/i18n tests: **51/51 passed**.
- Kiosk TypeScript check: passed.
- `git diff --check 840d85fb^..840d85fb`: passed.
- Implementer evidence in `task-4-report.md`: complete kiosk suite 556/556, ESLint and PWA build passed.
- No browser, tablet, physical scanner or installed-PWA acceptance was performed. Geometry at 480×800 and 800×480 therefore remains unverified, in addition to the source-level status-strip finding above.
