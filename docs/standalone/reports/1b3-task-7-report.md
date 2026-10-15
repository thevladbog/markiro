# Task 7 report — «Пользователи офиса»

Worktree: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`
Branch: `claude/autonomous-desktop-station-9e6f13`
Base: `b9a4b5bbd`
Commit produced: `24de1bcb8` — `feat(standalone): пользователи офиса — список, добавление, роль, доступ и пароль`

## What changed

Added the office page «Пользователи» (spec §4.8), administrators only:

- `apps/standalone/src/office/RequireRole.tsx` (new) — route guard by role;
  shows «Нет доступа» (`office.noAccess.*`) for a disallowed role, including a
  role that changes mid-session.
- `apps/standalone/src/office/users/` (new directory):
  - `user-forms.ts` — `newUserSchema`, `userEditSchema`, `passwordSetFormSchema`
    (Zod, reusing `loginRule`/`personNameRule`/`passwordRule` from task 4 and
    `officeRoleSchema` from `host/protocol.ts`).
  - `RoleRadios.tsx` — role picker on `@markiro/ui`'s `RadioGroup`.
  - `CreateUserDialog.tsx`, `EditUserDialog.tsx`, `SetPasswordDialog.tsx` —
    dialogs following the `CounterDialog`/`ChangePasswordDialog` pattern
    (`useOfficeMutation`, `writeFailure`, `StaleAlert`, `useId` form id).
  - `OfficeUsersPage.tsx` — lists users via `useOfficeQuery`, marks the
    signed-in row («это вы»), and wires the three dialogs.
- `apps/standalone/src/office/nav.ts` — new `/users` item, `roles: ["admin"]`,
  under a new «Доступ» section.
- `apps/standalone/src/office/routes.tsx` — `/users` route wrapped in
  `<RequireRole roles={["admin"]}>`.
- `apps/standalone/src/i18n/ru.json` — `office.nav.sections.access`,
  `office.nav.users`, `office.users.*`, `office.noAccess.*`. (`errors.api.last_admin`
  already existed with the exact wording the test expects, so it was not touched.)
- `apps/standalone/test/support/office.tsx` — added `OfficeUserRecord` to the
  type import and the `OFFICE_USERS` fixture (admin = `SESSION.user`, plus
  `TECHNOLOGIST`), placed after `TECHNOLOGIST` as specified.
- `apps/standalone/test/users-page.test.tsx` (new) — the brief's test file,
  copied verbatim.
- `apps/standalone/AGENTS.md` — one bullet under "Office pages" (verbatim from
  the brief).
- `apps/standalone/README.md` — one paragraph appended to Development step 2
  (verbatim from the brief, same 3-space indent as the rest of that item).
- `apps/standalone/test/setup.ts` — **not in the brief's file list**; see
  Deviations below. Added a guarded `ResizeObserver` + pointer-capture polyfill,
  mirroring `apps/admin/test/setup.ts`.

## TDD evidence

**Red** — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/users-page.test.tsx` before `RequireRole.tsx` existed:

```
FAIL  test/users-page.test.tsx [ test/users-page.test.tsx ]
Error: Failed to resolve import "../src/office/RequireRole.js" from "test/users-page.test.tsx". Does the file exist?
...
Test Files  1 failed (1)
     Tests  no tests
```

**Green** — after implementing Steps 2–6 and fixing the `ResizeObserver` gap (see Deviations):

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/users-page.test.tsx

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

All 12 cases in the brief's test file pass: menu visibility, `RequireRole`
denial, role change mid-session, listing with the "own row" marker, add user,
login-taken conflict, password-mismatch client-side check, edit another
user's role/access, edit own row (name only, `refreshUser` called once vs.
never for another user), `last_admin` message, `stale_revision` reload flow,
and setting another user's password.

## Verification commands and results

| Command                                                                                                                              | Result                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/users-page.test.tsx` (red, before Step 2) | FAIL — missing `RequireRole.tsx`, as expected                                 |
| same command (green, after Step 6 + setup.ts fix)                                                                                    | PASS — 12/12                                                                  |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                          | PASS — 19 files, 226 tests                                                    |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                     | PASS, no errors                                                               |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                          | PASS, no errors                                                               |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                         | PASS (pre-existing >500kB chunk-size advisory only, unrelated to this change) |
| `node_modules/.bin/prettier --write <changed files>`                                                                                 | all reported "unchanged"                                                      |
| `node_modules/.bin/prettier --check <changed files>`                                                                                 | "All matched files use Prettier code style!"                                  |
| `git diff --check`                                                                                                                   | clean, no output                                                              |
| `node -e "JSON.parse(readFileSync('apps/standalone/src/i18n/ru.json'))"`                                                             | OK, valid JSON                                                                |
| Re-ran test/typecheck/lint/build a second time after doc edits (Step 7), before commit                                               | all PASS again                                                                |

Not run (out of this task's scope, per the brief): the plan's «Итоговая
проверка плана» section (Cargo tests, `cargo fmt --check`, `node --test
tools/ci/test/affected.test.mjs`, repo-wide prettier) — that section is stated
to be the controller's job.

## Deviations from the brief

1. **`apps/standalone/test/setup.ts` needed a fix not listed in the brief's
   files.** Running the brief's test file verbatim against the brief's code
   verbatim failed 7 of 12 tests with `ReferenceError: ResizeObserver is not
defined`, thrown from `@radix-ui/react-use-size` inside
   `<ForwardRef(CheckboxBubbleInput)>` / the radio equivalent. Both
   `@markiro/ui`'s `RadioGroup` and `Checkbox` are Radix-based, and Radix
   renders a hidden native `<input>` "bubble" alongside the visible control
   whenever it sits inside a `<form>` — for native form participation — and
   that bubble sizes itself via `useSize`, which calls the browser
   `ResizeObserver` API. This is unconditional on mount (not only on click),
   so every test that opened `CreateUserDialog` or `EditUserDialog` (both
   wrap `RoleRadios`/`Checkbox` in a `<form>`) crashed via React Router's
   error boundary, independent of the click-toggle question the brief flagged.
   `apps/admin/test/setup.ts` already carries the identical polyfill (a
   `ResizeObserver` mock plus `hasPointerCapture`/`setPointerCapture`/
   `releasePointerCapture`/`scrollIntoView` stubs on `HTMLElement.prototype`),
   so this is a pre-existing, established fix for the same Radix-in-jsdom gap,
   not a new pattern. I mirrored it into `apps/standalone/test/setup.ts`,
   guarded by `typeof HTMLElement !== "undefined"` because
   `test/phc-contract.test.ts` in this package declares `@vitest-environment
node` and has no `HTMLElement` global at all — an unconditional copy of
   admin's version broke that suite (`ReferenceError: HTMLElement is not
defined`) until I added the guard. No `@markiro/ui` component was changed.
   I judged this to be a test-environment gap, not a code or test-expectation
   bug, per the brief's "Test fails for another reason" resolution rule, and
   staged it alongside the brief's own file list in the commit since the
   brief's own test cannot pass without it.
2. **Radio/checkbox clicks needed no adaptation.** The brief anticipated
   `fireEvent.click` might not toggle Radix's radio/checkbox in jsdom and
   pointed at `packages/ui/test` for the fallback pattern (`userEvent.click`).
   I inspected `@radix-ui/react-radio-group`/`@radix-ui/react-checkbox`
   (`node_modules/.pnpm/.../dist/index.mjs`): both render `Primitive.button`
   with a real `disabled` attribute and a plain `onClick` handler (no
   pointer-capture choreography), so `fireEvent.click` on the `role="radio"`/
   `role="checkbox"` element works once `ResizeObserver` exists. The brief's
   test file's `fireEvent.click` calls needed no changes.
3. **`RequireRole`'s return type.** I used `<>{children}</>` instead of a bare
   `return children;`. I verified after the fact (temporary edit, reverted)
   that the bare form also type-checks cleanly under this repo's React 19
   types (`tsc -p tsconfig.json --noEmit` passed both ways), so the wrap
   wasn't strictly required — but since it's behaviorally identical and the
   brief explicitly sanctions the wrap as a fallback, I kept it rather than
   pushing a second commit to unwrap it.
4. No `@markiro/ui` markup needed adapting (`Table`, `StatusChip`, `Badge`,
   `EmptyState`, `RadioGroup`, `Checkbox`, `Modal` all matched what the brief's
   tests assumed once the environment gap above was fixed).
5. `errors.api.last_admin` in `ru.json` already held the exact string the
   brief's test expects ("Нельзя выключить или понизить последнего
   администратора."), so it needed no edit — only `office.users.*` and
   `office.noAccess.*` were added.

## Concerns

- `apps/standalone/test/setup.ts` is now a shared file every suite in this
  package loads; the added polyfill only activates for jsdom-environment
  files (guarded), so the Node-environment `phc-contract.test.ts` is
  unaffected — confirmed by the full-package test run (19/19 files, 226/226
  tests green) both before and after the guard was added.
- Per the task framing, I did not run the plan's «Итоговая проверка плана»
  (Cargo tests, Windows/DPAPI, `tauri dev`, `tools/ci/test/affected.test.mjs`,
  repo-wide `format:check`) — that section is explicitly the controller's job,
  not this task's.
- No manual/browser/Tauri verification was performed or claimed; this task is
  webview-only and was verified through the package's automated Vitest,
  typecheck, lint and build gates.
