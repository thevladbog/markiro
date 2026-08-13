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
