# Touch flow Task 3 review

## Verdict

**Approved after fixes.** No Critical findings; all three Important findings were
resolved in the Task 3 follow-up.

## Disposition

- `Done` now derives its result state from the same canonical outcome helper as
  the shell, includes loose and box conflicts, and calculates a displayed total
  only from server-confirmed loose items and accepted boxes. The calculation
  uses each accepted box's server bottle count and its scan-time unit price; if
  the response cannot reconcile to the authoritative accepted bottle count, the
  total is intentionally unknown rather than overstated. Box members remain
  private.
- `Cart` is seeded from `flow.session.cart` when remounted after a local
  persistence failure. The exact mixed lines and reason survive, and retry
  creates the same loose-item and box wire body without resetting the scanner or
  employee session.
- Every queued box resolution now recovers its promise tail after a resolver
  failure, reports a bounded registry-unavailable notice, and continues to
  serialize later KM and SSCC scans. Unmount still prevents a stale dispatch.

## Findings

### Important — a box-only partial response is rendered as a successful full order

`Done` derives partial state exclusively from `result.conflicts` and ignores
`result.boxConflicts` (`apps/kiosk/src/screens/Done.tsx:174-205, 215-231,
306-351`). If the server accepts a loose KM but rejects a box, `orderNo` is
non-empty and `conflicts` can be empty. The screen then renders the green success
tick/title, no refusal alert, and the total of the complete local cart, including
the rejected box. This contradicts the server-authoritative partial outcome and
can overstate what the employee should pay. Treat either conflict collection as
partial, do not calculate a confident total for it, and render the box refusal
with text/icon (without exposing member KMs). Add a box-only partial screen test.

### Important — a failed local submit returns to an empty cart

The shell copies the component-local cart into flow state and immediately moves
from `cart` to `confirmation` before persistence (`apps/kiosk/src/ui/KioskShell.tsx:1059-1070`).
If `writeConfig` or `enqueueOrder` fails, `submitFailed` correctly keeps that cart
in `flow.session` (`apps/kiosk/src/session/flow.ts:120-138`), but the remounted
`Cart` always initializes its reducer from the module-level empty
`initialCartState`; it receives no saved cart prop. The worker therefore returns
to a blank cart despite the reducer preserving the canonical draft, and must
rescan everything after a local storage error. Seed/synchronize the Cart reducer
from the active session cart (without overwriting live edits on ordinary
bootstrap refreshes), and cover the shell-level persistence-failure retry path.

### Important — one resolver rejection poisons the serialized scan chain

The SSCC path awaits `resolveBox` without a `try/catch`, then stores the rejected
promise returned by `work.finally(...)` as `scanChain` (`apps/kiosk/src/screens/Cart.tsx:223-252`).
IndexedDB/meta/lookup failures can reject the shell resolver. That creates an
unhandled rejection, shows no actionable registry notice, and every later scan
is attached through `.then(apply)` to the already-rejected chain, so subsequent
SSCC and KM scans are skipped for the rest of the mounted session. Convert a
resolver/storage failure to an explicit bounded refusal, and make the chain
recover to a fulfilled tail before accepting the next scan. Add a test where the
first resolver rejects and a later KM/SSCC is still processed in order.

## Checks performed

- Follow-up focused screen/integration suites: 4 files, 142 tests passed.
- Full kiosk suite: 25 files, 549 tests passed.
- Kiosk TypeScript `--noEmit`: passed.
- Full kiosk ESLint: passed.
- Vite PWA production build: passed.
- Changed-file Prettier and `git diff --check`: passed.

## Notes

The shared SSCC wrappers, first-wins mixed overlap rules, atomic bottle limits,
box price multiplication, wire omission of `contentKeys`, bottle estimate, and
5/3 pagination helper are otherwise consistent with Task 3 and the accepted
handoff. Browser viewport and physical scanner/PWA acceptance remain later gates.
