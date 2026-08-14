# Touch flow Task 5 review

## Verdict

**APPROVED after final re-review.** Commit `628d5249` correctly separates cart, operation, reason and confirmation routing and preserves the canonical mixed cart. Follow-up commit `3650571c` closes the Important submission race and the Minor custom-radio accessibility issue below; no open Task 5 findings remain.

## Important finding

### I1 — Back/cancel remain active after confirmation starts, so a submitted cart can be shown and filed again

`Confirmation` owns a synchronous `locked` ref and `pending` state, but `pending` disables only the primary confirmation button (`apps/kiosk/src/screens/Confirmation.tsx:54-63,143-150`). The header Back button and `CancelOperation` remain live (`apps/kiosk/src/screens/Confirmation.tsx:68-77`). Their shell callbacks dispatch normal `back` / `cancelConfirmed` actions (`apps/kiosk/src/ui/KioskShell.tsx:1082-1084`), and the reducer accepts both while the asynchronous submit is still awaiting durable queue/network settlement (`apps/kiosk/src/session/flow.ts:279-301,304-307`).

Therefore a worker can press Confirm and immediately press Back or confirm Cancel. `submitCart` still advances the sequence and enqueues/sends the order, but its eventual `submitted` action is ignored because the reducer is no longer on `confirmation`. Back leaves the unchanged cart visible; after settlement the worker can continue and confirm it again under a new device sequence. Cancel has the same hidden-order problem after returning to login. This violates the one-submit/canonical-screen guarantee even though double taps on the primary button itself are correctly locked.

Required correction: make submission an authoritative reducer state/flag entered synchronously before async work. While it is active, `back`, `cancelConfirmed`, reason invalidation and any other navigation away from that confirmation must be no-ops, and Back/Cancel must render disabled. `submitted` and `submitFailed` are the only exits. Keep the component-local ref so two clicks in one render tick are still blocked. Add integration coverage for Confirm→Back and Confirm→Cancel while enqueue/POST is held, proving one queued/order record and no stale cart or login transition before settlement; also cover device revocation/source changes so a stale screen callback cannot resurrect a session.

Resolution: `submissionStarted` now moves confirmation into an explicit pending reducer state before the asynchronous store/network path starts. Navigation, cancellation, logout, idle reset, reason changes and repeated starts are rejected while pending; only pending success/failure can settle, while unpairing still overrides the session. The shell submits the pinned state returned by that transition. Back, Cancel (including the modal confirmation), and the primary action render disabled, while the local ref keeps same-tick taps closed. A deferred App test proves one queue/body and an unchanged confirmation until settlement.

## Minor finding

### M1 — Writeoff reasons expose standalone custom radios without radio-group keyboard semantics

Each reason is a button overwritten with `role="radio"`, but the containing section is not a `radiogroup` and there is no arrow-key selection/focus behavior (`apps/kiosk/src/screens/WriteoffReason.tsx:35-59`). Tab plus activation remains possible and focus styling is visible, but assistive technology receives unrelated radios rather than one labelled choice set, and the standard radio keyboard model is absent.

Required correction: give the bounded reason set a labelled `radiogroup` and implement the expected roving/arrow-key behavior, or use native same-name radio inputs styled as the existing >=48 px cards. Retain paging and selected-reason focus when changing pages.

Resolution: the six-item bounded section is now a labelled `radiogroup`; cards retain `radio` state with roving tab focus. Arrow Left/Up and Right/Down wrap through active reasons, update selection, switch the controlled page when required and restore focus to the selected card.

## Reviewed behavior without findings

- `nextKioskView` routes operation, reason and confirmation separately. The scanner Cart unmounts before those screens, so no product-scan listener remains in the post-cart flow.
- `canWriteoff=false` skips operation/reason and canonicalizes purchase confirmation. Operation is reachable only from a writeoff-capable session; no active reasons disables its writeoff card.
- Reasons are taken from the current bootstrap, paged six at a time, and selection is required. Snapshot removal invalidates a selected id through the reducer, and the final shell callback rechecks the current id set before filing.
- Back transitions preserve the same canonical cart. Cancel and “Не я” require explicit modal confirmation before clearing the session.
- Confirmation prints the operation label once, correct positions/bottle and loose/box composition, never exposes box members, and only prints a total when prices are enabled and every line is priced.
- Russian confirm copy is `Подтвердить N бутылку/бутылки/бутылок`; no confirmation action uses `Отправить`. RU/EN key sets remain locked together.
- Confirmation paging uses five portrait / three landscape lines with hidden overflow. Reasons use a bounded 6-card grid. Screen/header/footer, pager and controls retain fixed-shell overflow and >=48 px target contracts. Browser geometry remains a later Task 7 gate.
- The primary confirmation button has a synchronous component ref lock plus the shell submit ref; local storage failure returns the reducer to Cart with its mixed draft preserved.
- Shared Modal supplies dialog semantics, focus trap, Escape/backdrop handling and focus restoration for cancel/logout confirmations.

## Verification

- Focused Task 5 + App/Cart/i18n integration: **19/19 files, 136/136 tests passed**.
- Kiosk TypeScript check: passed.
- `git diff --check 628d5249^..628d5249`: passed.
- Implementer evidence reports complete kiosk suite 103/103 files, 572/572 tests, ESLint, PWA build and Prettier passing.
- No browser, tablet, physical scanner or installed-PWA acceptance was performed or inferred.

## Fix verification

- RED: 4 focused failures / 25 passes reproduced missing reducer lock, non-pending settlement, pending navigation controls, and radiogroup keyboard behavior.
- Focused GREEN: 3 files / 29 tests passed.
- Deferred App integration: passed with one durable queue entry and one order POST while Back, Cancel and repeated confirmation were attempted before settlement.
- Complete kiosk suite: 103/103 files, 572/572 tests passed; direct kiosk TypeScript check passed.
- Browser/device acceptance remains unperformed and is not inferred.

## Final re-review of `3650571c`

- The reducer owns the authoritative `submitting` flag. Only a non-pending confirmation accepts `submissionStarted`; pending confirmation rejects Back, cancel, logout, idle reset, reason invalidation and repeat-start actions. `submitted` and `submitFailed` settle only a pending confirmation, while `unpaired` is intentionally handled first and returns pairing.
- The shell derives `pendingFlow` synchronously from the exact rendered confirmation, dispatches the same state transition before asynchronous work, and passes that pinned session to `submitCart`/`createConfirmedOrderBody`. Its process-local ref and the component-local ref remain additional same-tick guards.
- Confirmation disables its Back, Cancel and primary controls from either authoritative or local pending state. The cancel modal's destructive confirmation is also disabled when that prop is active.
- The deferred App scenario observes one durable queue entry and one order request, rejects Back/Cancel/repeat-confirm attempts, stays on Confirmation until settlement, and then reaches the expected success outcome. Reducer coverage pins exact-cart failure return and unpair override.
- Writeoff reasons form one labelled `radiogroup`; radio cards use roving tab stops, all four arrow keys select active reasons, controlled paging follows selection, and cross-page arrow movement restores focus.
- Fresh re-review gates: focused reducer/Confirmation/WriteoffReason **29/29 passed**; deferred App integration **1/1 passed**; kiosk TypeScript and commit diff-check passed. Existing React `act(...)` and intentionally rejected registry-request stderr remained warnings, not test failures.
- No browser, tablet, physical scanner or installed-PWA acceptance was performed or inferred.
