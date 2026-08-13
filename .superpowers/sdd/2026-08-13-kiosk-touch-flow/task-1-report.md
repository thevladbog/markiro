# Touch flow Task 1 implementation report

## Outcome

The kiosk now has one explicit pure session state machine for pairing, login, cart, operation, writeoff reason, confirmation, and outcome. `KioskShell` uses that reducer as the source of truth for the active employee/cart and submitted outcome; the previous parallel `session` and `submitted` React states were removed.

## Compatibility choices

- Scanner subscriptions, classification, cart rules, offline queue/drain, badge digest custody, registry refresh and Task 6 installation/credential CAS are unchanged.
- Scanner setup, loading, and stale-cache blocked screens remain outer gates in `nextKioskView`; they can temporarily cover a flow state without destroying its cart.
- Task 1 does not create future visual screens. The current combined `Cart` UI still owns operation/reason controls until their planned screen tasks. On submit, its state is passed through the actual reducer transitions (`cartChanged → continue → operation/reason → confirmation`) before the existing submit side effect runs. Invalid writeoff/reason transitions therefore do not submit.
- `Done` renders the reducer's `outcome` state. Accepted, queued, rejected, and partial outcome data are modeled explicitly, while the existing `CreateOrderResultDto | null` is retained in that state so the current Done component remains byte-compatible until its redesign task.
- Back transitions are pure and preserve the same cart reference. Confirmed cancel/logout, finish, idle reset, and unpair clear the active session. The existing combined cart exposes logout and finish today; visual cancel/back/idle controls will dispatch the already-modeled actions in later tasks.

## TDD and verification

- RED: `flow.test.ts` failed at the missing `session/flow.ts` module. The routing migration then produced 5 expected `app-view` failures until `nextKioskView` consumed `flowScreen`.
- Focused GREEN: flow, app-view, and full app tests passed 68/68 with kiosk typecheck.
- Full kiosk: 22 files / 500 tests passed.
- Kiosk typecheck, full ESLint, Vite PWA production build, changed-file Prettier, and `git diff --check` passed.
- No visual redesign, browser viewport acceptance, physical scanner, tablet, or live-service test was performed in Task 1.

## Review fix: canonical confirmed draft

Review found that a failed enqueue left the reducer on confirmation while the editable legacy Cart remained visible, allowing a retry to bypass validation and letting the side effect read a second raw reason source.

- The session now stores operation and sub-reason only inside its canonical cart.
- `legacySubmit` atomically canonicalizes and validates a legacy cart only from the cart screen. Empty carts and writeoffs without a reason remain in cart; employees without writeoff permission get an exact buy draft.
- The wire builder accepts only the reducer-returned confirmation state. Enqueue, count and outcome consume that same canonical cart.
- A durable-write failure dispatches `submitFailed`, returning to cart without losing the draft. Editing and retrying therefore replays the same validation.
- Confirmed drafts reject `cartChanged`; reset actions are bounded to their valid source states.

Fix RED was 5 failed / 10 passed. Focused GREEN was 73/73; full kiosk was 22 files / 505 tests. Typecheck, full ESLint, Vite PWA build, Prettier, and diff-check passed.
