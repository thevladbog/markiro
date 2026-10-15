# Task 7 report: Вход в офис и рамка офиса

## Summary

Implemented the office sign-in form and office shell as standalone components,
per `.superpowers/sdd/1b2-task-7-brief.md`, Step 1–6. All code matches the
brief verbatim except for the one intentional deviation called out below
(function-typed callback properties instead of TS method shorthand, to avoid
`@typescript-eslint/unbound-method`, per the note carried over from Task 6).

Task 8 (not part of this task) wires `Office`/`OfficeLogin` into `App.tsx` and
handles the `session_ended` transition from a live host call.

## What was implemented

- `apps/standalone/src/office/office-session.tsx` — `OfficeSessionValue`
  (`user`, `call<T>`, `leave`, `logout`), `OfficeSessionProvider`,
  `useOfficeSession()`. The token itself is never stored in this context; it
  only flows through the `call` callback's parameter, per the plan's
  in-memory-only token constraint.
- `apps/standalone/src/office/nav.ts` — `OfficeNavItem` and `OFFICE_NAV`
  (currently one entry, "Обзор", visible to both `admin` and `technologist`;
  plan 1b3 adds more sections).
- `apps/standalone/src/office/OfficeLogin.tsx` — login form: zod schema
  (`office.login.required` on empty login/password after trim), calls
  `onLogin({ login, password })`, shows `errorMessageKey(error)` translated on
  a rejected `onLogin`, shows the `session_ended` notice as an info `Alert`,
  and a "В цех" button that calls `onBack` unconditionally.
- `apps/standalone/src/office/OfficeShell.tsx` — sidebar (via `@markiro/ui`
  `Sidebar`, `NavLink` render prop) + header showing the signed-in user's name
  and translated role, a theme toggle (`IconButton`, `useTheme`/`setTheme`),
  "В цех" (`session.leave`) and "Выйти" (`session.logout`), and an `<Outlet />`
  for the routed page.
- `apps/standalone/src/office/OfficeOverview.tsx` — greeting + role text via
  `PageHeader`/`Card`.
- `apps/standalone/src/office/routes.tsx` — `officeRoutes: RouteObject[]`:
  `/` → `OfficeShell` → index `OfficeOverview`.
- `apps/standalone/src/office/Office.tsx` — `Office({ session })`: builds one
  `createMemoryRouter(officeRoutes)` (lazily, via `useState` initializer) inside
  `OfficeSessionProvider`.
- `apps/standalone/src/i18n/ru.json` — added the top-level `office` key
  (login/nav/header/overview/roles) exactly as specified, inserted between the
  existing `wizard` and `errors` blocks.
- `apps/standalone/src/app/shell.css` — appended `.office-shell`,
  `.office-shell__main`, `.office-header`, `.office-header__user`,
  `.office-header__name`, `.office-header__role`, `.office-header__actions`,
  `.office-shell__content`, verbatim from the brief.
- `apps/standalone/test/office.test.tsx` — the brief's test file verbatim (10
  tests: 6 for `OfficeLogin`, including the 3 `it.each` failure cases, and 4
  for `Office`).

## TDD evidence

**RED** (before creating `src/office/*`), focused run:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx
 FAIL  test/office.test.tsx [ test/office.test.tsx ]
Error: Failed to resolve import "../src/office/Office.js" from "test/office.test.tsx". Does the file exist?
...
 Test Files  1 failed (1)
      Tests  no tests
```

**GREEN** (after implementing all 7 files), focused run:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/office.test.tsx
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

10/10 passed on the first implementation attempt (no iteration needed) —
matches the brief's expected count exactly.

## Final verification (package gates)

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
 Test Files  11 passed (11)
      Tests  109 passed (109)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
$ tsc -p tsconfig.json --noEmit
(clean, exit 0)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
$ eslint . --ignore-pattern 'target/**' --ignore-pattern 'src-tauri/gen/**' --ignore-pattern '.markiro-host/**'
(clean, exit 0)
```

Also verified before committing:

- `node_modules/.bin/prettier --write` on all 10 changed/created files → all
  reported "unchanged" (already Prettier-clean as written).
- `node_modules/.bin/prettier --check` on the same files → pass.
- `git diff --check` → clean (no whitespace errors).
- `git status --short` before staging showed exactly the 4 paths the brief's
  `git add` line names (`src/office/` untracked, `ru.json` and `shell.css`
  modified, `test/office.test.tsx` untracked) — nothing else picked up.

## Files changed

- Created: `apps/standalone/src/office/office-session.tsx`,
  `apps/standalone/src/office/nav.ts`, `apps/standalone/src/office/OfficeLogin.tsx`,
  `apps/standalone/src/office/OfficeShell.tsx`,
  `apps/standalone/src/office/OfficeOverview.tsx`,
  `apps/standalone/src/office/routes.tsx`, `apps/standalone/src/office/Office.tsx`,
  `apps/standalone/test/office.test.tsx`
- Modified: `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`

Commit: `bc1ab0593e80a47660ab0d1812b1db7ac25de06d` —
"feat(standalone): вход в офис и рамка офиса", trailer verified via
`git log -1 --format=%B` to be exactly
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the brief

Exactly one, explicitly called for by this task's instructions (carried over
from the Task 6 finding about `@typescript-eslint/unbound-method`, which the
repo enables via `tseslint.configs.recommendedTypeChecked`):

- `OfficeSessionValue` (`office-session.tsx`) declares `call`, `leave`, and
  `logout` as function-typed properties (`leave: () => void;`,
  `logout: () => Promise<void>;`, `call: <T>(operation: (token: string) => Promise<T>) => Promise<T>;`)
  instead of the brief's TS method shorthand (`leave(): void;` etc.).
- `OfficeLoginProps` (`OfficeLogin.tsx`) declares `onLogin` and `onBack` the
  same way (`onLogin: (request: OfficeLoginRequest) => Promise<void>;`,
  `onBack: () => void;`).

Reason: `OfficeShell.tsx` passes `session.leave` directly as
`onClick={session.leave}`, and `OfficeLogin.tsx` passes `onBack` directly as
`onClick={onBack}`. A method-shorthand interface member passed unbound like
this trips `@typescript-eslint/unbound-method`; a function-typed property does
not, since TypeScript does not treat it as a "method" with an implied `this`.
All doc comments from the brief were preserved. No tested behavior or
assertion changed — the test file's `sessionFor()` helper already builds its
mock session using the same function-typed-property shape
(`call: <T,>(...) => ...`, `leave: vi.fn()`, `logout: vi.fn(async () => {})`),
so this was required for the test file itself to type-check, not just for
lint.

No other deviations: `Sidebar`, `useTheme`/`setTheme`, `PageHeader`,
`IconButton`, `Button`, `Card`, `Alert`, `Input`, `cn`, `NavLink`/`Outlet`/
`RouteObject`/`createMemoryRouter`/`RouterProvider` all matched their actual
`@markiro/ui`/`react-router` signatures exactly as the controller described,
and the brief's code compiled and passed as written (once the interfaces above
were adjusted).

## Concerns

- None blocking. All three gates (test/typecheck/lint) passed cleanly on the
  first attempt with the sole documented deviation.
- Scope note (not a defect): `OFFICE_NAV` currently exposes only "Обзор" for
  both roles, and `Office.tsx`/`OfficeShell.tsx` have no behavior yet for what
  happens after `session.logout()` resolves or after `session.leave()` is
  called — by design, per the brief, since Task 8 owns wiring `Office`/
  `OfficeLogin` into `App.tsx`'s screen state machine (leaving the office,
  showing the `session_ended` notice, etc.). This task only had to produce the
  two components and the session contract standalone, which the test file
  confirms via injected fakes.
- No browser/visual check was performed or claimed — verification here is
  automated (Vitest + jsdom + Testing Library) only, per the task's own
  "Focused runs" / "final" instructions. That matches this task's scope; it
  does not touch Rust, Windows, or any hardware/browser surface.
