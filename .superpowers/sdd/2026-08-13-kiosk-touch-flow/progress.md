# Kiosk touch flow SDD ledger

Identity: plan `docs/superpowers/plans/2026-08-13-kiosk-touch-flow.md`, accepted spec `docs/superpowers/specs/2026-08-13-kiosk-self-service-redesign-design.md`.

## Task log

### Task 1: explicit session state machine

- Status: implemented, awaiting review.
- RED: missing `session/flow.ts`; routing RED: 5 expected `app-view` failures.
- GREEN: focused flow/app-view/app 68/68; full kiosk 500/500; typecheck, ESLint, production build, Prettier, and diff-check passed.
- Decision: the reducer is the only active employee/cart/outcome source of truth in `KioskShell`. Existing Cart maps its combined controls through real reducer transitions until later tasks render separate operation/reason/confirmation screens; outer scanner/loading/blocked gates do not duplicate or erase the session state.
- Review: CHANGES REQUESTED for a retry/dual-reason bridge bypass. Fix RED 5 failed/10 passed; focused GREEN 73/73; full kiosk 505/505. One canonical cart now owns operation fields, atomic `legacySubmit` validates/canonicalizes only from cart, wire construction requires confirmation, and `submitFailed` forces retries back through validation.

### Task 2: pairing and branded login

- Status: implemented, awaiting review.
- RED: 39 existing focused passes; four expected gaps covering branding module/cache, pairing identity/cells/correction keys, and login layout/motion.
- GREEN: focused pairing/idle/branding/i18n 47/47; full kiosk suite exit 0 (summary truncated by existing warning volume); typecheck, ESLint, PWA build, Prettier, diff-check and scan-zone source check passed.
- Decision: preserve the current secure pairing/storage/scanner lifecycle and layer the approved visual treatment over it. Branding is a best-effort private same-origin WebP cache, bound to `serverUrl + kioskId + credentialGeneration`; Markiro and the current organization name remain available without the tenant asset.
- Review: CHANGES REQUESTED for exact scanner credential parsing, atomic credential-generation ownership, strict private route/stream bounds, and durable invalid-asset fallback. Fix RED reproduced all boundaries; focused GREEN 56/56 and full kiosk exit 0. Scanner now trims only terminal whitespace; branding mutation and activation are owner/request CAS-gated, route is exact revision UUID, response streaming is bounded, and render failure revokes plus invalidates the blob.
- Re-review: RESOLVED. Pairing now accepts only exact raw eight digits with no trimming. Cached/displayed branding carries owner+revision, and image-error invalidation atomically requires both current config ownership and the exact stored owner/revision before delete. RED 54/56; focused GREEN 58/58; app 47/47; full kiosk 523/523; typecheck, ESLint, PWA build, Prettier and diff-check passed.

### Task 3: mixed atomic KM/SSCC cart model

- Status: implemented, awaiting review.
- RED: the first focused run retained 48 legacy passes and exposed 11 missing mixed-cart/classifier behaviors plus the absent pagination suite; the local registry resolver suite was also absent. A final screen RED reproduced the box row showing one unit price and a silent unavailable-registry refusal.
- GREEN: focused mixed cart/classifier/pagination/resolver/flow/store/day-count/screen tests 163/163; full kiosk 544/544; typecheck, ESLint, PWA build, changed-file Prettier and diff-check passed.
- Decision: `CartState.lines` is the canonical session model. SSCC resolution is a local-only async boundary before the pure reducer, uses the active Task 6 registry and trusted freshness verdict, and serializes pending SSCC scans so first-scan overlap semantics do not depend on IndexedDB timing. Box member keys remain local overlap evidence; the queue receives only loose raw KMs, canonical SSCCs and the bottle estimate. Pure pagination is delivered for Task 4 to render without introducing that visual flow early.

### Task 4: fixed-viewport paged touch cart

- Status: implemented, awaiting review.
- RED: focused cart/layout/i18n had 11 expected failures with 40 existing passes for the missing 5/3 pager, row icons, dialog/atomic box removal and fixed overflow contracts.
- GREEN: focused 51/51; full kiosk 556/556; typecheck, full `src test` ESLint, Vite PWA build, changed-file Prettier and diff-check passed.
- Decision: `PagedLines` is a controlled view over the existing pure pagination rules and clamps on item/page-size changes. Rows open a shared accessible modal and removal remains a reducer action only after a second confirmation. Boxes never expose members or partial quantities. The compact legacy operation controls stay only until Task 5 supplies the separate screens; scanner and canonical cart custody remain unchanged.
- External: no browser/tablet/physical-scanner acceptance performed in this task.
- Review fix: both Important findings addressed. Accepted appends navigate to and announce a briefly highlighted final line without moving on refusal/removal. The status strip is a fixed 61 px single row with bounded visual ellipsis and full accessible labels. Fix RED 3 failed/50 passed; focused 54/54; full kiosk 559/559; typecheck, ESLint, PWA build, Prettier and diff-check passed.

### Task 5: operation, reason and confirmation screens

- Status: implemented, awaiting review.
- RED: five focused files failed for the three absent screens, collapsed app routing and absent active-reason invalidation; 24 existing assertions passed.
- GREEN: focused 39/39; integrated Task 5/App/Cart/i18n 135/135; full kiosk 572/572; typecheck, full ESLint, PWA build, Prettier and diff-check passed.
- Decision: cart owns scanning only and hands the canonical draft to the reducer before `continue`. Writeoff selection is available only with permission and active reasons; reason refresh is fail-closed in both reducer routing and the final submit callback. Confirmation owns a synchronous pointer lock while the shell retains its durable-submit guard. Cancel and “Не я” require explicit confirmation before clearing the session.
- External: no browser/tablet/physical-scanner acceptance performed; outcome persistence remains Task 6.
- Review fix: APPROVED. Submission is an explicit reducer-owned pending state entered synchronously before durable work; navigation/reset/repeat actions are blocked until pending success/failure while unpair still overrides it. Confirmation disables Back/Cancel/primary, and the reason cards implement a labelled radiogroup with arrow-key paging/focus. Fix RED 4 failed/25 passed; focused GREEN 29/29; deferred App integration green; full kiosk 572/572 and direct typecheck passed.

### Task 6: honest durable outcomes

- Status: implemented; review findings resolved, awaiting re-review.
- RED: missing outcome store/migration and result semantics, absent sync persistence, and restart badge routing reproduced; existing focused assertions remained green.
- GREEN: focused Task 6/App 239/239; full kiosk 583/583; direct typecheck passed.
- Decision: only a server result can produce green. Unknown delivery remains amber; terminal and partial results are red. Sanitized outcomes are idempotently stored before journal/dequeue under server URL + kiosk + credential generation + device sequence, bounded to 100 rows per owner generation. The same employee sees the oldest unviewed result after restart and explicit finish atomically acknowledges it.
- External: no browser/tablet/physical-scanner or installed-PWA acceptance performed; Task 7 remains open.
- Review fix: replay preserves stable ordering and acknowledgement in one
  transaction; failed acknowledgement re-arms the Done action and timer; the
  store rejects non-canonical owner/key/date/SSCC/reason and bounded-text rows.
  RED reproduced five original failures plus UTF-8 overflow; focused integrated
  verification passed 231/231 and direct typecheck passed.
- Final re-review fix: acknowledgement now requires one canonical UUID-owned
  row and canonical ISO time; failure after unmount cannot re-arm the old
  screen; the displayed outcome supplies its immutable owner. Link recovery is
  published only after local outcome/journal persistence and dequeue commit.
  Final full kiosk suite: 105 files / 589 tests.
