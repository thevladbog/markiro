# Touch flow Task 3 implementation report

## Outcome

The kiosk cart now has one canonical mixed-line model for individual KM bottles and atomic SSCC boxes. Shared domain classification recognizes bare, AIM-framed and AI `00` SSCC scans while preserving the exact raw KM string. A box is resolved only from the active local Task 6 registry before it reaches the pure reducer; no cart scan performs an online lookup.

## Domain and compatibility choices

- `CartState.lines` contains discriminated `LooseKmLine | BoxLine` values. A compatibility `CartItem` type remains as the loose-line name for old screen fixtures, but no second `items` state is maintained.
- Accepted content keys from both loose lines and boxes form one overlap set. The first accepted line wins: a later member KM, overlapping box or duplicate SSCC leaves the cart unchanged with an explicit notice.
- Limits, totals, queued estimates and offline outcome counts are bottle-based. A 12-bottle box consumes 12 remaining units and is rejected or removed only as a whole. Unlimited policy remains `null`, not a numeric sentinel.
- Box `contentKeys` and `boxId` stay local. Confirmed and queued wire bodies contain loose `items[].rawKm`, optional `boxes[].sscc`, and the separate `estimatedBottleCount`; no box member key is serialized. Existing item-only queued bodies and day-count fallback remain unchanged.
- Registry `warn` freshness may resolve a known box for offline custody, matching the accepted stale-snapshot policy. `blocked`, absent and unknown registries produce distinct refusals without changing the cart. Pending SSCC resolutions are serialized with later scans so overlap is deterministic under IndexedDB latency.
- The existing Cart and Done surfaces were migrated only enough to preserve current behavior: mixed totals, whole-box removal, explicit box-registry feedback and canonical submit state. The pure 5-row portrait / 3-row landscape pager is ready for Task 4; this task does not introduce the new fixed-viewport cart design.
- Scanner Setup deliberately keeps its current generic non-KM verdict for SSCC until its later visual scope; badge/KM setup behavior and scanner lifecycle are unchanged.

## TDD evidence

- Initial focused RED kept 48 legacy assertions green and failed 11 new classifier/cart/flow assertions; the pagination suite could not load because the module did not exist.
- The local resolver RED could not load because `session/box-resolution.ts` did not exist.
- The final screen RED had two expected failures: a resolved 12-bottle box displayed `89,90 ₽` instead of `1 078,80 ₽`, and an unavailable registry produced no visible alert.
- Focused GREEN across classifier, mixed reducer, pagination, resolver, flow, store/day-count and Cart integration passed 163/163.
- Full kiosk suite passed 544/544. Typecheck, full ESLint, Vite PWA production build, changed-file Prettier and `git diff --check` passed.

## External verification not performed

No browser viewport, physical HID/GS1-128 scanner, installed-PWA restart or real offline rotation test was performed in this task. Those remain separate acceptance gates for the later visual flow and hardware pass.
