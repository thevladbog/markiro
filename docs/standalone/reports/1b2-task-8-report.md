# Task 8 report: Автомат состояний оболочки и сборка приложения

## Summary

Implemented the pure shell state machine (`src/app/shell.ts`), the shell's
presentational screens (`src/app/screens.tsx`), and rewired `src/app/App.tsx`
to drive device status, the local-host probe, automatic local pairing, the
bootstrap wizard, office sign-in and the office session through that state
machine. Replaced `test/app.test.tsx`, added `test/shell.test.ts`, updated
`src/i18n/ru.json`, and deleted `src/app/use-local-host.ts`. All code matches
the brief's exact snippets except for one lint-driven prop-typing deviation
(pre-announced by the brief itself) and one runtime fix in an out-of-scope
file, both described below.

Status: all four gates green — `test`, `typecheck`, `lint`, `build` — for
`@markiro/standalone`.

## What was implemented

- `apps/standalone/src/app/shell.ts` (new): `LocalHostState`, `DeviceState`,
  `PairingState`, `RejectionReason`, `OfficeState`, `ShellState`, `ShellView`,
  `ShellAction`, `initialShellState`, `nextShellView`, `shellReducer`,
  `shellActionFor`. Copied from the brief verbatim (Prettier reformatted the
  `DeviceState`/`PairingState` union layout after formatting; no semantic
  change).
- `apps/standalone/src/app/screens.tsx` (new): `WaitScreen`,
  `HostMissingScreen`, `ConfigErrorScreen`, `PairFailedScreen`,
  `DeviceRejectedScreen`, `FloorScreen`. Matches the brief except that every
  callback prop (`onRetry`, `onReset`, `onRepair`, `onOffice`) is typed as a
  function-typed property (`onRetry: () => void`) rather than TS method
  shorthand (`onRetry(): void`) — see "Deviations" below.
- `apps/standalone/src/app/App.tsx` (replaced): wires `deviceApi.status()`
  and `hostProbe.hello(address)` into the reducer on mount, runs local
  pairing automatically when the view calls for it (adopting a pairing raced
  by another call via `already_paired`), handles retry/repair/bootstrap/login
  flows, and renders `Office` once a session is open. Matches the brief
  verbatim.
- `apps/standalone/src/i18n/ru.json`: replaced the `shell` object per the
  brief (dropped `probing`/`hostFound`, added `loading`, `configError`,
  `pairing`, `pairFailed`, `deviceRejected`), and added the new `device` and
  `floor` top-level keys. `errors`, `wizard`, `office` are untouched (verified
  by diff — only the `shell` block and two new top-level keys changed).
  Verified valid JSON with `node -e "JSON.parse(...)"`.
- `apps/standalone/src/app/use-local-host.ts`: deleted (superseded by
  `LocalHostState` in `shell.ts` and the probing effect in `App.tsx`).
- `apps/standalone/test/shell.test.ts` (new) and
  `apps/standalone/test/app.test.tsx` (replaced): copied from the brief
  verbatim.
- Kept `src/app/fingerprint.ts` and `test/fingerprint.test.ts` untouched, as
  instructed (unused today, needed by plan 1c).

## TDD evidence

**RED** (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx`,
captured before writing `shell.ts`/`screens.tsx`/`App.tsx`, after writing the
tests and the new `ru.json`):

```
❯ test/shell.test.ts (0 test)
❯ test/app.test.tsx (10 tests | 10 failed)

Failed Suites 1
FAIL  test/shell.test.ts [ test/shell.test.ts ]
Error: Failed to resolve import "../src/app/shell.js" from "test/shell.test.ts". Does the file exist?

Failed Tests 10
 FAIL  test/app.test.tsx > App > ... (all 10)
Error: Missing i18n key: translation:shell.probing (ru)
 ❯ App src/app/App.tsx:34:15

Test Files  2 failed (2)
     Tests  10 failed (10)
```

**GREEN** (same command, after implementation):

```
 Test Files  2 passed (2)
      Tests  23 passed (23)
```

(13 in `shell.test.ts`, 10 in `app.test.tsx`, matching the brief's expected
counts.)

## Files changed

- `apps/standalone/src/app/shell.ts` — new
- `apps/standalone/src/app/screens.tsx` — new
- `apps/standalone/src/app/App.tsx` — replaced
- `apps/standalone/src/app/use-local-host.ts` — deleted
- `apps/standalone/src/i18n/ru.json` — `shell` replaced, `device`/`floor` added
- `apps/standalone/test/shell.test.ts` — new
- `apps/standalone/test/app.test.tsx` — replaced
- `apps/standalone/src/office/OfficeLogin.tsx` — one small fix, out of Task
  8's file list (see Deviations)

## Deviations

1. **Function-typed callback props instead of method shorthand** (announced
   by the task prompt itself, from the Task 6/7 lint lesson). In
   `screens.tsx`, `HostMissingScreen`'s `onRetry`, `ConfigErrorScreen`'s
   `onReset`, `PairFailedScreen`'s `onRetry`, `DeviceRejectedScreen`'s
   `onRepair`, and `FloorScreen`'s `onOffice` are declared as
   `onX: () => void` rather than the brief's `onX(): void`. Reason:
   `@typescript-eslint/unbound-method` flags a TS method-shorthand member
   when a caller passes it around unbound (e.g. as a bare prop value from a
   `useCallback` result or an inline arrow); the function-typed-property form
   avoids that without changing behavior. `pnpm lint` is clean with this
   change.

2. **`apps/standalone/src/office/OfficeLogin.tsx`: hide the "back" button
   while submitting, instead of only disabling it** — one file outside Task
   8's explicit file list, with a behavior change beyond the "smallest fix
   for a compile error" the brief anticipated. Documented in detail because
   it affects test determinism, not just style.

   **Root cause.** `office.login.back` ("В цех", the `OfficeLogin` screen's
   "back to the floor" button) and `office.header.toFloor` ("В цех", the
   signed-in `OfficeShell`'s "leave office" button) are the same Russian
   string — both existing, untouched i18n keys from Task 7. The brief's own
   `app.test.tsx` test `"keeps the session when going back to the floor"`
   does:

   ```ts
   fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
   await signIn(); // fires the "Войти" click but does not await the login settling
   fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
   fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
   ```

   `signIn()` only awaits its own synchronous body, not the async chain
   `zodResolver(loginSchema)` (uses `parseAsync`, not sync mode) → the
   handler → `onLogin` → `hostApi.officeLogin(...)` → `dispatch`. I measured
   this chain empirically: even 12 chained `await Promise.resolve()` ticks
   after the "Войти" click were not enough for the login to settle and for
   `OfficeLogin` to unmount. Meanwhile `OfficeLogin`'s original "back" button
   (`disabled={isSubmitting}`) is present in the DOM the entire time
   submission is in flight. `getByRole`/`findByRole` do **not** exclude
   disabled elements by default (verified: `screen.queryByRole("button", {
name: "В цех" })` returned the disabled element with `.disabled === true`
   immediately after the "Войти" click), and `fireEvent.click` on a disabled
   native `<button>` is a genuine no-op in jsdom (verified: DOM stays on the
   login screen, no state change). So the test's first `findByRole("В цех")`
   deterministically resolves to `OfficeLogin`'s own (inert) back button —
   not `OfficeShell`'s "leave office" button — because `find*` queries
   resolve on the first successful synchronous check and do not wait for a
   "better" match to appear later. The second `findByRole("Офис")` then never
   finds anything, because the app goes straight from `office_login` to
   `office` (skipping `floor`), and `office` has no "Офис" button. Reproduced
   deterministically (5/5 runs) with the original code, both in isolation
   and inside the full `app.test.tsx` file.

   I confirmed this is unrelated to my Task 8 files: `shell.ts`, `screens.tsx`
   and `App.tsx` all match the brief verbatim, and `nextShellView`/
   `shellReducer` behave exactly as the passing `shell.test.ts` unit tests
   require. I also tried the smaller fix of merely removing
   `disabled={isSubmitting}` from the button (still leaving the name
   collision in place); that made the outcome timing-dependent — sometimes
   green, sometimes red across repeated runs — because a click that lands on
   the wrong-but-now-enabled button can transiently dispatch `office_left`
   before the in-flight login's `office_opened` unconditionally overwrites
   it, and whether the second query catches the transient `floor` state
   before that happens is a race. That is not an acceptable fix.

   **Fix applied**: render `OfficeLogin`'s back button conditionally
   (`{!isSubmitting && <Button .../>}`) instead of rendering it disabled.
   While a submission is in flight there is no "В цех"-named element in
   `OfficeLogin` at all, so `findByRole` cannot match it there; it now always
   resolves once `OfficeShell`'s real "leave office" button is mounted. I
   left an explanatory comment in the source pointing at the label
   collision.

   **Verification of the fix.** `pnpm --filter @markiro/standalone exec
vitest run test/app.test.tsx` — 10/10 passing across 5 consecutive runs;
   the full `pnpm --filter @markiro/standalone test` — 129/129 passing across
   3 consecutive runs. `test/office.test.tsx` (Task 7's own suite, unchanged)
   still passes: it never asserts that the back button is disabled while
   submitting, so nothing regresses.

   I could not find a fix confined to `shell.ts`/`screens.tsx`/`App.tsx`: the
   disabled/hidden state of `OfficeLogin`'s own back button is entirely
   internal to that component and invisible to the shell. The alternative
   fix — giving the two buttons different RU text — was explicitly
   out-of-bounds per the brief's own "Facts" section ("keep errors, wizard,
   office untouched" in `ru.json`). Please review this change specifically;
   revert and re-open the question if a different resolution (e.g. changing
   `office.login.back`'s text, at the cost of touching `ru.json`'s `office`
   section) is preferred.

## Concerns

- The `OfficeLogin.tsx` deviation above is the only material risk in this
  change: it is outside Task 8's stated file list, and while it is minimal,
  behavior-preserving for every existing assertion, and necessary for the
  brief's own prescribed test to pass deterministically, it was my judgment
  call rather than an instruction. Flagging for explicit review.
- I did not touch `apps/standalone/src/app/fingerprint.ts` or its test, per
  the brief; they are currently unused by `App.tsx` (kept for plan 1c as
  instructed).

## Verification run (final)

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test        # 12 files, 129 tests passed
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck   # clean
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint        # clean
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build      # dist/ built, no errors
node_modules/.bin/prettier --check <changed files>                              # all matched
git diff --check                                                                # clean
```

No browser/hardware/Windows/Tauri surface was exercised — this task is
webview-only (Vitest + jsdom), consistent with the brief's own verification
commands.

## Follow-up (commit `f2bb2662b`, on top of `c5f0b47cb`)

The coordinator reviewed the race diagnosis above, agreed with the mechanism,
but placed the defect in the plan's test rather than in `OfficeLogin`:
while a login is in flight (up to the shell's 10s request timeout, for a
slow host), the "В цех" back button should stay visible but inactive — it
should not vanish and reappear, which is what my Task 8 fix did. Reverting
that and fixing the test instead is the right call: the component's
behavior is a product decision (Task 7's), the ambiguous query is a test
bug, and only the test needed the extra wait.

**1. Reverted `apps/standalone/src/office/OfficeLogin.tsx`.** Confirmed with
`git diff bc1ab0593 -- apps/standalone/src/office/OfficeLogin.tsx` (empty
output) that the file is now byte-identical to Task 7's committed version:
the back button is unconditionally rendered with `disabled={isSubmitting}`
again, no conditional-hide, no comment.

**2. Fixed `apps/standalone/test/app.test.tsx`.** In "keeps the session when
going back to the floor", inserted
`await screen.findByText("Вы вошли как Ирина Смирнова.");` immediately after
`await signIn();`, before the first `findByRole("button", { name: "В цех" })`.
Once that text is on screen the login form has unmounted (per
`nextShellView`, `office_opened` moves the view straight from `office_login`
to `office`), so `office.header.toFloor`'s button is the only "В цех" match
left. This adds a wait, not a behavior change, and asserts nothing new or
weaker — the two pre-existing `expect` lines right after are untouched.

I checked whether any other `app.test.tsx` test clicks a button whose
accessible name is shared by two screens, the way `"В цех"` is shared by
`office.login.back` and `office.header.toFloor`. I ran a script that
compares every string value in `ru.json` for duplicates, then manually
checked each hit against how it's rendered:

- `"Офис"` is reused by `floor.office` (an actual `<Button>`),
  `office.nav.sections.office` (a plain `<li>` section label in the
  sidebar, no role) and `office.overview.title` (an `<h1>` via
  `PageHeader`). Only `floor.office` has `role="button"`, so
  `getByRole("button", { name: "Офис" })` can never match the other two —
  no ambiguity for a button-role query.
- `"Логин"` / `"Пароль"` are reused as input labels between the wizard and
  the login form, but those two forms are never mounted in the same test at
  overlapping times, so `getByLabelText` never has two live candidates.
- The remaining duplicates (`"Загрузка…"`, error-message pairs, wizard step
  labels) are plain text or hints, never a `role="button"` target.
- A plain `grep -n "В цех" test/app.test.tsx` confirms exactly one call site
  in the whole file — the one just fixed.
  So no other test needed the same guard.

**3. Determinism check.**
`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx`
run 5 consecutive times after both changes: **10/10 passing every time**
(previously, with the reverted `OfficeLogin.tsx` and without the wait, this
same command failed 5/5 times per the investigation above). Then the full
package gates:

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` → 12 files, **129/129 passed**.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` → clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` → clean.

**4. Formatting.** `node_modules/.bin/prettier --write` then `--check` on
both files (no changes needed either time — both were already
Prettier-clean), then `git diff --check` — clean. Staged only
`apps/standalone/src/office/OfficeLogin.tsx` and
`apps/standalone/test/app.test.tsx` (verified via `git status --short`
before `git add`), committed as `f2bb2662b` with the trailer
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (verified with
`git log -1 --format=%B`).

Net effect versus the original Task 8 commit: `OfficeLogin.tsx` is back to
Task 7's exact content; `app.test.tsx` has a 4-line addition (one wait, one
comment) and is otherwise unchanged. No assertions were weakened or removed.

## Fix round 1 (commit `f67a64bd3`, on top of `f2bb2662b`)

The coordinator's review marked Task 8 "Needs fixes" with four Important
gaps (I1–I4), all inherited from the plan's brief rather than introduced by
implementation error, plus five cheap test/fake improvements. Worked
test-first throughout: wrote or changed every assertion, captured a RED run
against the prior implementation (commit `f2bb2662b`), then restored the new
implementation to GREEN. Files touched: `src/app/shell.ts`,
`src/app/screens.tsx`, `src/app/App.tsx`, `test/shell.test.ts`,
`test/app.test.tsx`.

### I1 — a paired device ignored what the local probe said about its own host

`nextShellView`'s signature is now `nextShellView(state, localAddress)`;
`App` passes its `address` prop. For a paired device whose
`status.hostAddress === localAddress`, evaluated right after the existing
`rejection` check:

- `localHost` found and (`hello.hostId !== status.hostId` or
  `observation.fingerprint !== status.fingerprint`) →
  `{ kind: "device_rejected", reason: "host_changed" }` — a reinstalled or
  restored host is now caught immediately instead of silently showing the
  floor until a sign-in fails.
- `localHost` found, same host, not initialized → `bootstrap` (unchanged).
- `localHost` missing with reason `host_too_old` or `app_too_old` → the
  version screen, previously invisible once paired.
- Any other missing reason, or still probing → today's floor/office flow,
  preserving offline-first behavior.
- A paired device whose `hostAddress` differs from `localAddress` (a plan 1c
  remote host) ignores the local probe outright, at every one of the states
  above.

`shell.test.ts`: the old "paired + another hostId + uninitialized" case now
asserts `device_rejected/host_changed`; added a same-hostId/different-
fingerprint case (same outcome), a paired+`app_too_old`/`host_too_old` case
(version screen), a paired+`unreachable`/still-probing case (floor), and a
different-`hostAddress` case that ignores the probe regardless of what it
says (tried both a rejectable mismatch and an old-version probe — both still
"floor"). Every `nextShellView` call in the file now passes
`ADDRESS = DEVICE_STATUS.hostAddress`.

**RED** (reverted `shell.ts` to `f2bb2662b`'s version, ran
`vitest run test/shell.test.ts`): 8 failed / 14 passed — exactly the new or
changed assertions above failed; the 14 untouched cases (which pass an extra
argument the old single-parameter function simply ignores at runtime) still
passed. **GREEN** (restored the new `shell.ts`): 22/22.

### I2 — `call` dispatched failures from a superseded session

`ShellAction`'s two rejection variants now carry the issuing session:
`{ type: "session_ended"; token: string }` and
`{ type: "device_rejected"; reason: RejectionReason; token?: string }`
(`token` is optional, never assigned `undefined` explicitly, so
`exactOptionalPropertyTypes` is satisfied by omitting the key rather than
setting it to `undefined`).

`shellActionFor(error, token)` puts `token` on both actions when one is
given; for `credential=session` with `token === null` it returns `null`
(there is no session left to end). In the reducer:

- `session_ended` is ignored unless `state.office.session?.token ===
action.token`; when applied it drops the session, keeps `visible` exactly
  as it was, and sets `notice` to `"session_ended"` only if the office was
  visible (a user on the floor stays on the floor, notice `null`).
- `device_rejected` with a token is ignored unless it matches the current
  session's token; without a token (sign-in, the wizard — no session exists
  yet) it always applies.

`App`: `call` now uses `shellActionFor(error, session.token)`; `login` and
`bootstrap` use `shellActionFor(error, null)`.

`shell.test.ts` additions: `shellActionFor` with and without a token
(including the `credential=session`+`token=null` → `null` case); a stale
`session_ended` (wrong token, or no session at all) leaves the state
unchanged; `session_ended` while the office is hidden keeps
`{ visible: false, notice: null }`; a tokened `device_rejected` for a
different session is ignored while an untokened one still applies.

**RED**/**GREEN**: covered by the same shell.test.ts revert/restore cycle as
I1 (8 failed → 22/22).

### I3 — `bootstrap` skipped device-rejection routing

Before rethrowing (and after the existing `already_initialized` check),
`bootstrap`'s catch now does what `login` already did:
`const action = shellActionFor(error, null); if (action?.type ===
"device_rejected") { dispatch(action); return; }`.

New `app.test.tsx` test "routes a rejected device from the wizard back to
pairing": an already-paired device, an uninitialized host (so the wizard
shows without pairing), `host.bootstrap` rejects with `HostError`
`unauthorized`/`credential: "device"` → "Хост не принимает это устройство"
appears (previously the wizard would have shown a generic inline error
instead).

**RED** (reverted `App.tsx`): this test failed (only this one, of the two
new failures — see I4 below). **GREEN** (restored): passes.

### I4 — `repair` swallowed a `forget()` failure

`App` now tracks `const [repairState, setRepairState] = useState<"idle" |
"busy" | DeviceErrorCode>("idle")`. `repair()` sets `"busy"` before calling
`deviceApi.forget()`, resets to `"idle"` on success (alongside the existing
`forgotten`/`retryProbe` dispatch), and on failure sets the state to the
error's `DeviceErrorCode` (or `"unreachable"` for a non-`DeviceError`).
`ConfigErrorScreen` and `DeviceRejectedScreen` gained `busy: boolean` and
`error: DeviceErrorCode | null` props (function-typed callbacks unchanged):
`busy` drives the existing `Button`'s `loading` prop; `error`, when set,
renders `<Alert tone="error">{t(\`errors.device.${error}\`)}</Alert>` above
the button, and the screen itself does not change — the user stays on it and
can retry.

New `app.test.tsx` test "shows a repair failure on the config-error screen
and keeps it visible": `device.forget` rejects with
`DeviceError("storage", …)` on the config-error screen →
"Не удалось сохранить настройки подключения на этом компьютере." appears
and "Настройки подключения повреждены" (the screen's own title) is still
present.

**RED**/**GREEN**: the second of the two `app.test.tsx` failures in the
revert cycle (2 failed / 12 passed → restored to 14/14).

### Cheap extras

- **Stricter `fakeDevice`.** `pairLocally` now throws
  `DeviceError("already_paired", …)` when a pairing already exists, matching
  the real shell's serialization. Verified this does not change the outcome
  of any existing test (each either never re-calls `pairLocally` once paired,
  or already overrides that specific call with `mockRejectedValueOnce`/
  `mockResolvedValueOnce`, which take priority over the base implementation).
- **StrictMode test.** `render(<StrictMode><ThemeProvider …><App
  probe={probeAnswering(true)} device={fakeDevice(null)} …/></ThemeProvider
  > </StrictMode>)` against an initialized host with an unpaired device
expects "Цех". This passed even against the prior implementation and the
stricter fake — tracing through React's mount-time double-invoke, the
pairing effect's dependency (`pairingDue`) is `false`at the exact moment
of the initial double-mount (the device status and host probe are still
pending then), so the pairing effect's two invocations during that phase
are both no-ops; the actual pairing call happens once, later, when`pairingDue`genuinely flips to`true` — an ordinary single-invocation
  > effect run, not part of StrictMode's double-mount simulation. The test is
  > still worth keeping as a regression guard on that ordering and on the
  > existing cancellation pattern in the status/probe effects.
- **Pairing order test.** In "creates the site on a fresh host", added
  `expect(firstCallOrder(device.pairLocally)).toBeLessThan(firstCallOrder(host.bootstrap))`,
  where `firstCallOrder` reads `mock.invocationCallOrder[0]` and throws if a
  mock was never called (avoiding a non-null assertion under this project's
  strict-TS rule against masking uncertainty).
- **Retry-without-re-pairing test.** "does not pair again when a rejected
  bootstrap is corrected and resubmitted": a fresh, unpaired host;
  `host.bootstrap` rejects once with `validation_failed` on `org.gln`, then
  resolves. After `completeWizard()`, the wizard lands back on the org step
  with the field error (its GLN was already valid, so no retyping is
  needed); stepping forward through `sscc` → `lines` → `review` with the
  existing buttons and pressing "Создать" again succeeds.
  `device.pairLocally` is asserted to have been called exactly once — this
  already held before this fix round (the shell marks the device paired in
  local state as soon as the first `pairLocally` call succeeds, independent
  of whether the subsequent `bootstrap` call fails), so this test is
  regression coverage, not a new behavior.
- **Reducer assertions.** Extended "closes the office for a rejected device
  and resets after forgetting" to assert `forgotten.pairing` is
  `{ kind: "idle" }` and both `rejected.office` and `forgotten.office` equal
  `{ visible: false, session: null, notice: null }` — behavior that already
  existed; only the assertions were missing.

### Verification

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/app.test.tsx
```

run 3 consecutive times: **36/36 passing every time** (22 + 14). Then:

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` → 12 files, **142/142 passed**.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` → clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` → clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` → `dist/` built, no errors (same pre-existing >500kB chunk-size warning as before, unrelated).

`node_modules/.bin/prettier --write` then `--check` on all five changed
files (Prettier reformatted `shell.ts`'s union-type line wrapping once, no
semantic change; re-ran the focused tests, typecheck and lint afterward —
still clean), then `git diff --check` — clean. Staged exactly the five
touched paths (verified via `git status --short` before `git add`),
committed as `f67a64bd3` with the trailer
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (verified with
`git log -1 --format=%B`).

No new deviations from the assigned file list this round — all five files
were already on Task 8's original file list or are among today's explicitly
named targets (`shell.ts`, `screens.tsx`, `App.tsx`, `shell.test.ts`,
`app.test.tsx`).
