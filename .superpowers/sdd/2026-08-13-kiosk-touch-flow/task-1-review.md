# Touch flow Task 1 review

## Verdict

**CHANGES REQUESTED — 1 Important.**

Commit reviewed: `dafaf109` against parent `3d35ea38` and the Task 1 touch-flow
contracts. The reducer removes the old parallel React `session` / `submitted`
state and preserves the outer loading, scanner-setup, pairing and blocked gates,
but the temporary legacy `Cart` bridge is not yet governed by the reducer as one
authoritative order draft.

## Important finding

### I1 — A retry can bypass cart/operation/reason invariants, and submission reads a second operation source

`cartChanged` is accepted from every active screen except `outcome`
(`apps/kiosk/src/session/flow.ts:96-103`). The bridge reduces from the current
`flow` (`apps/kiosk/src/ui/KioskShell.tsx:975-992`). After a storage/enqueue
failure, `submitCart` deliberately catches and leaves the flow at
`confirmation` (`apps/kiosk/src/ui/KioskShell.tsx:824-830`), while
`nextKioskView` still renders the editable legacy `Cart`. On the next tap,
`cartChanged` mutates that confirmation and `continue` is a no-op, so
`next.screen === "confirmation"` succeeds without rechecking that the cart is
non-empty or that a writeoff has a reason. An edited empty cart or an edited
writeoff without `writeoffReasonId` can therefore reach the side effect on a
retry.

The submitted payload compounds the problem: `submitCart` receives both the
reducer result and the raw legacy `CartState`, but builds `reason`,
`writeoffReasonId`, items, count and outcome from the raw state
(`apps/kiosk/src/ui/KioskShell.tsx:749-764,804,822,1003`). For an employee with
`canWriteoff=false`, the reducer correctly canonicalizes the transition to a buy
confirmation, yet a stale/raw `reason="writeoff"` is still read by `submitCart`
and is refused at line 756 instead of being filed as the reducer's buy order.

There are also two mutable copies of operation state inside one session:
`session.reason` / `session.writeoffReasonId` and the same fields in
`session.cart`. `chooseOperation` and `chooseWriteoffReason` update only the
former (`apps/kiosk/src/session/flow.ts:121-136`), while `Done` and the existing
wire path consume the latter/raw cart. A pure reducer sequence can consequently
describe different operations depending on which field a consumer reads.

Impact: the first failed durable write does preserve the visible cart, but the
retry no longer has the same validation guarantee as the first attempt; and a
non-writeoff employee can see a reducer-approved buy confirmation which the
side effect silently does not enqueue. This violates the Task 1 requirement
that the reducer be the one source of truth and that the compatibility bridge
not bypass its invariants.

Required correction: retain one canonical order draft (items, operation and
writeoff reason) in the reducer state, make the side effect consume that
canonical confirmed draft only, and make a legacy retry replay validation from
the cart source state or use one atomic validated transition rather than
accepting `cartChanged` on an existing confirmation. Do not derive the side
effect from a second raw `CartState` after the reducer has canonicalized it.

Required regression tests:

1. Make the first submit fail at `writeConfig` or `enqueueOrder`, edit the still
   visible cart to empty, then retry; assert no sequence advance and no queue
   record. Repeat with writeoff plus a missing reason.
2. Feed a stale legacy `CartState` with `reason="writeoff"` to an employee whose
   effective policy has `canWriteoff=false`; assert the exact queued wire body is
   canonical buy (`reason="buy"`, `writeoffReasonId=null`) and is built from the
   reducer-confirmed draft.
3. Exercise `chooseOperation("writeoff")` and `chooseWriteoffReason` directly;
   assert every public representation consumed by confirmation, wire payload and
   outcome agrees, or remove the duplicate representation.

## Other reviewed contracts

- `canWriteoff=false` does skip operation/reason to buy confirmation in the pure
  reducer; writeoff requires a non-empty reason on the first reducer pass.
- `back` keeps the same cart reference. The current failure path keeps the same
  `Cart` instance (`key={session.id}`), so the first enqueue failure itself does
  not lose scanned items.
- `finish`, confirmed cancel/logout, idle reset and `unpaired` remove the active
  session. Current production callers are source-bounded: `finish` is emitted by
  `Done`, logout by an active `Cart`; cancel and idle reset have no Task 1 caller
  yet. Invalid reset events are globally accepted by the pure reducer, so the
  later UI tasks should either source-restrict them in the reducer or add caller
  boundary tests before wiring asynchronous/modal callbacks.
- A late `submitted` action is accepted only from `confirmation`; after
  revocation has dispatched `unpaired`, it cannot restore the outcome/session.
- `nextKioskView` retains the intended precedence: loading, scanner setup,
  pairing, stale-data block, then flow outcome/cart/idle.

## Verification

- `git diff --check 3d35ea38..dafaf109` — passed.
- Focused kiosk tests, run from `apps/kiosk` with the installed Vitest binary:
  `flow.test.ts`, `app.test.tsx`, `app-view.test.ts` — **68/68 passed**.
- Kiosk TypeScript check, run with the installed `tsc -p tsconfig.json --noEmit`
  — passed.
- The equivalent `pnpm --filter @markiro/kiosk ...` entry point could not start
  because this checkout's pnpm 11 rejected the existing lockfile
  `packageManager` resolution. No lockfile or production file was changed to
  work around that environment issue.
- No browser/tablet/physical-scanner or live-service check was performed. This
  review changes documentation only.
