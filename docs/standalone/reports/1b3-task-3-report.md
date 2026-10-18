# 1b3 Task 3 report — office data layer

Commit: `2f450cf4` on `claude/autonomous-desktop-station-9e6f13`
(`feat(standalone): слой данных офиса — HostApi, react-query и call на сессию`)

## What changed

- **`apps/standalone/package.json`, `pnpm-lock.yaml`**: added
  `@tanstack/react-query@5.101.4` (exact) to `@markiro/standalone`.
- **`src/host/api.ts`**: `HostApi` grew office endpoints as function-typed
  properties — `officeMe`, `getOrg`, `updateOrg`, `getSscc`,
  `updateSsccCounter`, `updateBlockSizes`, `listUsers`, `createUser`,
  `updateUser`, `setUserPassword` — plus the `SsccCounterKey` type. A shared
  `NO_CONTENT = z.null()` schema replaces the three separate `z.null()`
  literals.
- **`src/office/office-query.ts`** (new): `officeKeys`,
  `createOfficeQueryClient` (`retry: false`, `refetchOnWindowFocus: false`
  for queries and mutations), `useOfficeQuery`, `useOfficeMutation` — both
  route through `useOfficeSession().call`.
- **`src/office/Office.tsx`**: creates one `QueryClient` per mount
  (`useState(createOfficeQueryClient)`) and wraps the router in
  `QueryClientProvider`.
- **`src/office/office-session.tsx`**: `OfficeSessionValue` gained `api:
HostApi` and `refreshUser: () => Promise<void>`; `changePassword` removed.
- **`src/app/shell.ts`**: new `ShellAction` case `office_user_refreshed`
  (`{ token, user }`), applied only when the token matches the currently
  open session; `office_requested`'s `notice` is now
  `Exclude<OfficeLoginNotice, "session_ended">` (controller fix #4 — nothing
  outside the reducer's own `session_ended` branch may request that notice).
- **`src/app/App.tsx`**: the office-session `useMemo` now builds `refreshUser`
  (calls `hostApi.officeMe`, dispatches `office_user_refreshed`, routes any
  failure through `shellActionFor` like `call` does) and threads a shared
  `route` helper used by both `call` and `refreshUser`. `call` now re-reads
  the user in the background on a `forbidden` answer. `Office` is mounted
  with `key={session.token}` so a new session always gets a fresh query
  cache.
- **`src/office/ChangePasswordDialog.tsx`**: uses
  `useOfficeMutation((api, token, request: PasswordChange) =>
api.officeChangePassword(token, request))` instead of
  `useOfficeSession().changePassword`.
- **`src/office/OfficeShell.tsx`**: the "password changed" notice is now
  keyed by `useLocation().pathname` (`passwordChangedAt`) instead of a plain
  boolean, so it only shows on the page where the password was actually
  changed, not on every office page.
- **`test/support/office.tsx`** (new): `FakeHostApi`, `fakeHostApi`,
  `FakeOfficeSession`, `fakeOfficeSession`, `renderOffice`, `TECHNOLOGIST` —
  shared office test fixtures, used by `office.test.tsx`, `office-query.test.tsx`
  and `app.test.tsx`.
- **`test/api.test.ts`** (new): table-driven coverage of every `HostApi`
  office endpoint (route, method, body, token) plus answer-parsing checks.
- **`test/office-query.test.tsx`** (new): `useOfficeQuery` reads through
  `session.call`/`session.api`, does not retry a failed read, and
  `useOfficeMutation` writes through `session.call`.
- **`test/office.test.tsx`**: switched from the local `sessionFor`/`renderOffice`
  helpers to `fakeOfficeSession`/`renderOffice` from `test/support/office.js`;
  `ChangePasswordDialog` tests assert against `session.api.officeChangePassword`;
  added the five branch tests requested by the 1b2 review (password length,
  server-side length refusal placement, generic failure banner, reset after
  cancel, cannot-close-while-sending) and the aria-hidden glyph assertion on
  the theme toggle (controller fix #3).
- **`test/app.test.tsx`**: `fakeHost()` now builds on `fakeHostApi(...)`;
  added `"re-reads the signed-in user when the host answers forbidden"`; the
  "returns to the floor even when the host cannot be told about leaving"
  test now also asserts `officeLogout` was called with the token, with the
  explanatory comment about the unhandled-rejection guard (controller fix #1).
- **`test/shell.test.ts`**: added `"takes a re-read user only for its own
session"`; extended `"ignores a tokened device_rejected for a different
session…"` with the late-tokened-rejection-after-`office_closed` and
  late-`session_ended`-while-signing-in-again assertions (controller fix #2).
- **`AGENTS.md`**: added the "Office pages" section (verbatim from the
  brief) after "Device key and office session".

## Lockfile diff summary

`git diff --stat apps/standalone/package.json pnpm-lock.yaml`:

```
apps/standalone/package.json | 1 +
pnpm-lock.yaml               | 3 +++
2 files changed, 4 insertions(+)
```

`package.json` gained exactly one line:
`"@tanstack/react-query": "5.101.4",`

`pnpm-lock.yaml` gained exactly three lines, all inside the
`apps/standalone` importer block:

```yaml
"@tanstack/react-query":
  specifier: 5.101.4
  version: 5.101.4(react@19.2.8)
```

No other importer changed and no new package entries were added — the
resolved package `@tanstack/react-query@5.101.4(react@19.2.8)` already
existed from `apps/admin`/`apps/station`. `pnpm add` was run outside the
sandbox as instructed (`dangerouslyDisableSandbox`), exactly the brief's
command.

## TDD evidence

**`test/api.test.ts`** — red (before `src/host/api.ts` had the office
methods):

```
FAIL  test/api.test.ts > HostApi office endpoints > officeMe sends the office token to the right route
TypeError: api.officeMe is not a function
...
Test Files  1 failed (1)
     Tests  12 failed (12)
```

Green (after replacing `src/host/api.ts`):

```
Test Files  1 passed (1)
     Tests  12 passed (12)
```

**`test/office-query.test.tsx`** — red (before `src/office/office-query.ts`
existed):

```
Error: Failed to resolve import "../src/office/office-query.js" from
"test/office-query.test.tsx". Does the file exist?
Test Files  1 failed (1)
     Tests  no tests
```

Green (after creating `office-query.ts` and updating `Office.tsx` /
`office-session.tsx`):

```
Test Files  1 passed (1)
     Tests  3 passed (3)
```

No console/stderr noise was observed in either the standalone
`office-query.test.tsx` run or the full package run for the "does not retry
a failed read" test — the log capture for both is empty of any
warning/error line, so nothing needed suppressing.

## Verification commands and results

All run from `apps/standalone` via
`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone …`
inside the sandbox (only `pnpm add` in Step 1 ran outside it):

| Command                                                                                                                 | Result                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec vitest run test/api.test.ts` (red)                                                                                | FAIL, 12 failed — `is not a function`                                                                                                                           |
| `exec vitest run test/api.test.ts` (green)                                                                              | PASS, 12 passed                                                                                                                                                 |
| `exec vitest run test/office-query.test.tsx` (red)                                                                      | FAIL — unresolved import                                                                                                                                        |
| `exec vitest run test/office-query.test.tsx` (green)                                                                    | PASS, 3 passed                                                                                                                                                  |
| `exec vitest run test/shell.test.ts`                                                                                    | PASS, 23 passed                                                                                                                                                 |
| `exec vitest run test/office.test.tsx`                                                                                  | PASS, 19 passed                                                                                                                                                 |
| `exec vitest run test/app.test.tsx`                                                                                     | PASS, 21 passed                                                                                                                                                 |
| `exec vitest run test/office.test.tsx test/app.test.tsx test/shell.test.ts test/office-query.test.tsx test/api.test.ts` | PASS, 78 passed (5 files)                                                                                                                                       |
| `test` (full package)                                                                                                   | PASS, 177 passed (14 files)                                                                                                                                     |
| `typecheck`                                                                                                             | PASS (after the `RenderResult` fix below; failed once before it)                                                                                                |
| `lint`                                                                                                                  | PASS, no errors                                                                                                                                                 |
| `build`                                                                                                                 | PASS (`vite build`, pre-existing >500kB chunk-size warning only)                                                                                                |
| `grep -rn "changePassword" apps/standalone/src apps/standalone/test`                                                    | 0 matches (case-sensitive; every occurrence is `officeChangePassword`/`ChangePasswordDialog`/`onChanged`, none contains the literal substring `changePassword`) |
| `node_modules/.bin/prettier --write <17 changed files>`                                                                 | reformatted `test/shell.test.ts` only (line-wrap of two added expressions); all others already matched style                                                    |
| `node_modules/.bin/prettier --check <17 changed files>`                                                                 | PASS, "All matched files use Prettier code style!"                                                                                                              |
| `git diff --check`                                                                                                      | PASS, no output                                                                                                                                                 |
| final re-run of `test`, `typecheck`, `lint`, `build` after the prettier reformat                                        | all PASS again (177 tests, clean typecheck/lint, successful build)                                                                                              |

## Deviation from the brief

`test/support/office.tsx`'s `renderOffice`, exactly as given in the brief
(no explicit return type), fails `typecheck` under this repo's TypeScript
6.0.3 / `declaration: true` base config with:

```
test/support/office.tsx(62,17): error TS2883: The inferred type of
'renderOffice' cannot be named without a reference to
'.../@testing-library+dom@10.4.1/node_modules/@testing-library/dom/types/queries'
from '.../queries.js'. This is likely not portable. A type annotation is
necessary.
```

This is a genuine gap in the brief's snippet, not a case of the test's
expectations being wrong — the fix doesn't change behavior or weaken any
assertion, it only adds a return-type annotation. `apps/saas-admin/test/render.tsx`
already has the identical problem and the identical fix (`import { render,
type RenderResult } from "@testing-library/react";` then annotate the
function `: RenderResult`), so this is an established repo pattern, not an
invention. Applied the same fix: added `type RenderResult` to the
`@testing-library/react` import and annotated `renderOffice(session:
OfficeSessionValue): RenderResult`. No other file needed a similar change.

Everything else in the brief (API shape, hook shapes, test bodies, the four
controller-review fixes) was implemented byte-for-byte as specified.

## Concerns

- None outstanding. No console/stderr noise appeared in any test run, so
  the "configure nothing globally, just report it" contingency for the
  react-query error-logging concern did not come up.
- The `vite build` chunk-size warning ("Some chunks are larger than 500 kB")
  is pre-existing (the app has no code-splitting yet) and unrelated to this
  task's diff; not treated as a failure.
- `test/support/office.tsx`'s `closeLabel` for `ChangePasswordDialog` was
  left as `t("office.password.close")` (unchanged) rather than switched to
  `office.common.close`: the global constraints note that "dialogs of this
  plan" pass `closeLabel={t("office.common.close")}`, but the brief's exact
  Step 7.4 edits for `ChangePasswordDialog.tsx` do not touch that prop or
  add an `office.common.close` key, and this dialog already existed before
  plan 1b3. Read this as scoped to dialogs introduced later in the plan
  (SSCC/users pages), not a silent rename requested of this task; flagging
  in case that reading is wrong.

## Fix round 1

Commit: `f9be4c1e` on `claude/autonomous-desktop-station-9e6f13`
(`fix(standalone): review fix round 1 — react-query always online, refresh
routing tests, notice per navigation`)

### What changed

1. **Important — `src/office/office-query.ts`, `createOfficeQueryClient`.**
   Added `networkMode: "always"` to both `queries` and `mutations`, and
   `refetchOnReconnect: false` to `queries`. Extended the doc comment: calls
   go over Tauri IPC to a host on the same PC, not the network, so the
   webview's online state says nothing about whether the host answers —
   without this, an OS `offline` event paused every office read/write
   silently (no error, no retry button; the password dialog's `isSubmitting`
   guard would also stay stuck on) until the link came back, at which point
   the paused work ran on its own.
2. **Minor — `test/office.test.tsx`, `"switches the theme"`.** Reverted the
   toggle lookup to `await screen.findByRole(...)` (was a synchronous
   `getByRole` after amendment 3), so the test does not depend on the
   router's first render being synchronous.
3. **Minor — `test/app.test.tsx`.**
   - `"routes a password change through the token-scoped call, ending the
session"` now also asserts `expect(host.officeMe).not.toHaveBeenCalled();`
     — a `session`-credentialed rejection must not trigger the `forbidden`
     refresh path.
   - Added `"routes a failed refresh after forbidden like any other call"`:
     `officeChangePassword` rejects `forbidden`, the background
     `refreshUser`'s own `officeMe` call then rejects `unauthorized` /
     `details: { credential: "session" }`, and the app still ends on «Вход в
     офис» with «Сессия офиса закончилась. Войдите снова.» — proving a
     failed refresh is routed through `shellActionFor` exactly like any
     other call, not swallowed silently.
4. **Minor — `src/office/OfficeShell.tsx`.** The password-changed notice is
   now keyed by `location.key` (unique per memory-router history entry)
   instead of `location.pathname`, so it goes away on the next navigation
   rather than reappearing whenever the user returns to the same route
   later in the session. Comment updated to match. No new test: there is
   still only one office route in this task; task 5 adds the navigation
   case.

### TDD evidence for item 1

Red (`test/office-query.test.tsx`, before the `office-query.ts` fix), new
test `"keeps reading over IPC while the webview reports itself offline"`:

```
FAIL  test/office-query.test.tsx > useOfficeQuery > keeps reading over IPC while the webview reports itself offline
AssertionError: expected undefined to deeply equal { Object (name, inn, ...) }
- Expected: { gln: "4600682000013", ... }
+ Received: undefined
Test Files  1 failed (1)
     Tests  1 failed | 3 passed (4)
```

The query stayed paused (`data` never left `undefined`) because
`onlineManager.setOnline(false)` combined with the default
`networkMode: "online"` pauses `queryFn` entirely — `waitFor` timed out
after ~1s. The other 3 pre-existing tests in the file still passed,
confirming the `try/finally` around `onlineManager.setOnline(true)` reset
online state even though this test failed.

Green (after adding `networkMode: "always"` and `refetchOnReconnect: false`
to `createOfficeQueryClient`):

```
Test Files  1 passed (1)
     Tests  4 passed (4)
```

### Verification commands and results

| Command                                                                                                | Result                                                                                       |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `exec vitest run test/office-query.test.tsx` (red, new offline test only)                              | FAIL, 1 failed / 3 passed                                                                    |
| `exec vitest run test/office-query.test.tsx` (green)                                                   | PASS, 4 passed                                                                               |
| `exec vitest run test/office-query.test.tsx test/office.test.tsx test/app.test.tsx test/shell.test.ts` | PASS, 68 passed (4 files)                                                                    |
| `test` (full package)                                                                                  | PASS, 179 passed (14 files)                                                                  |
| `typecheck`                                                                                            | PASS (confirms `location.key: string` matches `passwordChangedAt: string \| null`)           |
| `lint`                                                                                                 | PASS, no errors                                                                              |
| `build`                                                                                                | PASS (`vite build`, same pre-existing >500kB chunk-size warning, unrelated)                  |
| `node_modules/.bin/prettier --write` on the 5 changed files                                            | all reported `(unchanged)`                                                                   |
| `node_modules/.bin/prettier --check` on the 5 changed files                                            | PASS, "All matched files use Prettier code style!"                                           |
| `git diff --check`                                                                                     | PASS, no output                                                                              |
| `git log -1 --format=%B`                                                                               | confirms subject and exact `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer |

No console/stderr noise appeared in any of these runs, including the new
offline test (both its red and green runs).

### Concerns

None outstanding from this round.
