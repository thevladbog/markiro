# 1b3 Task 5 report — «Профиль организации»

Commit: `e1062cbbb` on `claude/autonomous-desktop-station-9e6f13` (parent `b8dd09944`).

## What changed

New files:

- `apps/standalone/src/office/form-errors.ts` — `WriteFailure<F>` and
  `writeFailure()`, sorting a failed office write into a field error, a
  stale-revision notice, or a coded alert.
- `apps/standalone/src/office/page-state.tsx` — `PageLoading`, `LoadError`,
  `StaleAlert`: the shared loading/error/stale-write pieces every office page
  will reuse.
- `apps/standalone/src/office/org/OrgProfilePage.tsx` — the organization
  profile page: a read-only `DefinitionGrid` view for a technologist, an
  editable form (Input × 4 + Combobox for the time zone) for an admin, with
  the SSCC-prefix-change warning, save/stale/error handling, and a query-cache
  write-through on success (`queryClient.setQueryData`).
- `apps/standalone/test/form-errors.test.ts`, `apps/standalone/test/org-page.test.tsx`
  — verbatim from the brief.

Modified files:

- `apps/standalone/src/office/nav.ts` — added the `/org` entry under a new
  «Организация» section; updated the doc comment.
- `apps/standalone/src/office/routes.tsx` — added the `org` child route;
  updated the doc comment.
- `apps/standalone/src/office/OfficeShell.tsx` — focus management: a
  `mainRef`/`shownPath` ref pair and an effect that moves focus to
  `<main tabIndex={-1}>` after a menu navigation (not on first render).
- `apps/standalone/src/app/shell.css` — `.office-shell__content:focus { outline: none; }`
  and `.office-note { margin: 0; color: var(--fg-2); }`.
- `apps/standalone/src/i18n/ru.json` — `office.nav.sections.organization`,
  `office.nav.orgProfile`, `office.common.*` (loading/retry/reload/save/
  cancel/close/saved/none/readOnly), `office.org.*` (title/prefixChange).
- `apps/standalone/test/support/office.tsx` — added `ORG_PROFILE: OrgProfile`
  fixture (`OrgProfile` added to the type import).
- `apps/standalone/test/office.test.tsx` — two new tests in `describe("Office")`
  (nav offers the profile to both roles; focus moves to the page after a menu
  navigation) and one new test in `describe("ChangePasswordDialog")`
  ("keeps the password notice on the page it was changed on"), written
  **with** the mandatory amendment already folded in: it also navigates back
  to «Обзор» and re-checks the notice is gone there too.
- `apps/standalone/test/app.test.tsx` — added `waitFor` to the
  `@testing-library/react` import, `ORG_PROFILE` to the office-support import,
  and the "ignores a late answer from a session the user already left" test.
- `apps/standalone/AGENTS.md` — replaced the "Office pages" section's second
  bullet with the `networkMode: "always"` / no-refetch-on-reconnect wording
  (mandatory amendment 2).
- `apps/standalone/test/rules.test.ts` — added the astral-character
  (`"😀".repeat(...)`) password/name cases after the Cyrillic-password
  assertion (mandatory amendment 3).

All three "Поправки контроллера" amendments from the end of the brief are
applied: the notice test extended back to «Обзор», the `AGENTS.md` bullet
replaced verbatim, and the astral-character cases added to `test/rules.test.ts`.

## TDD evidence

### `form-errors.test.ts` (Step 1 → 2)

Red (before `src/office/form-errors.ts` existed):

```
FAIL  test/form-errors.test.ts [ test/form-errors.test.ts ]
Error: Failed to resolve import "../src/office/form-errors.js" from "test/form-errors.test.ts".
```

Green (after creating `form-errors.ts` and `page-state.tsx`):

```
Test Files  1 passed (1)
     Tests  3 passed (3)
```

### `org-page.test.tsx` (Step 3 → 4)

Red (before the page/menu/route existed — `renderOffice` had no «Профиль» link):

```
TestingLibraryElementError: Unable to find an accessible element with the role "link" and name `Профиль`
...
Test Files  1 failed (1)
     Tests  7 failed (7)
```

Green (after `OrgProfilePage.tsx`, `nav.ts`, `routes.tsx`, `ru.json`, `shell.css`):

```
Test Files  1 passed (1)
     Tests  7 passed (7)
```

No adaptation to the brief's test code was needed — `DefinitionGrid`, `Card`,
`Combobox`, `Spinner` and `PageHeader` (which renders an `<h1>`, matched by
`getByRole("heading", ...)`) all rendered exactly as the brief's test assumed.

### Focus test (Step 5)

Red (before the `OfficeShell.tsx` ref/effect change — full `office.test.tsx`
run with the two new `describe("Office")` tests and the amended
`ChangePasswordDialog` test already added):

```
Tests  1 failed | 21 passed (22)
 ❯ test/office.test.tsx:127:36
   expect(document.activeElement).toBe(screen.getByRole("main"));
```

Only the focus assertion failed; the "offers the organization profile to both
roles" test and the amended notice test (including the new «Обзор» check)
already passed against the existing code, confirming the per-`location.key`
notice logic from task 3's review round needed no further change here.

Green (after adding `mainRef`/`shownPath`/the effect and
`<main ref={mainRef} tabIndex={-1} ...>`):

```
Test Files  1 passed (1)
     Tests  22 passed (22)
```

jsdom moved focus to the `tabIndex={-1}` `<main>` without any special
handling — it is attached to `document.body` by Testing Library's `render`,
so it was focusable normally. No workaround was needed; the ambiguity note's
contingency (jsdom refusing focus on a detached/hidden element) did not apply
here.

### Stale-answer App test (Step 6)

Added the test to `test/app.test.tsx` per the brief (plus the `waitFor` and
`ORG_PROFILE` import additions) and ran it:

```
Test Files  1 passed (1)
     Tests  23 passed (23)
```

The test passed on the first run — **no code fix was needed**. I traced why
before concluding that: `App.tsx`'s `officeSession` `useMemo` is keyed on
`[session, hostApi]`, and `session` comes from `state.office.session`
(replaced wholesale, never mutated) via `nextShellView`; every distinct
office session therefore gets its own `officeSession` object with `call` and
`route` closed over that session's own `token`. `shellReducer`'s
`session_ended` (and `device_rejected`) branches already re-check
`state.office.session.token === action.token` before acting (this scoping
was introduced by the prior "review fix round 1" commit, `f9be4c1ed`, per the
`git log`). So when session A's paused `getOrg` call finally rejects with
`credential: "session"` well after the user left A and signed in again as
session B, `route` dispatches `{ type: "session_ended", token: A }`, and the
reducer's guard sees `state.office.session.token === B ≠ A` and leaves state
untouched — session B stays on the org page. This is exactly what the new
end-to-end test (going through a real page's `useOfficeQuery`, unlike the
existing `ChangePasswordDialog`-based App tests) verifies. Per the brief's
own framing this was a contingency ("if it fails, it's a real bug"), not a
certainty, and it did not trigger.

## Verification commands and results

All run from `apps/standalone` via
`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone ...`
unless noted.

| Command                                                 | Result                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `exec vitest run test/form-errors.test.ts` (red)        | 1 failed (import error), as expected                                                                                              |
| `exec vitest run test/form-errors.test.ts` (green)      | 3 passed                                                                                                                          |
| `exec vitest run test/org-page.test.tsx` (red)          | 7 failed (no «Профиль» link), as expected                                                                                         |
| `exec vitest run test/org-page.test.tsx` (green)        | 7 passed                                                                                                                          |
| `exec vitest run test/office.test.tsx` (red)            | 1 failed / 21 passed (only the focus test), as expected                                                                           |
| `exec vitest run test/office.test.tsx` (green)          | 22 passed                                                                                                                         |
| `exec vitest run test/app.test.tsx`                     | 23 passed (first run, no fix needed)                                                                                              |
| `test` (full package)                                   | 17 files, 205 tests passed                                                                                                        |
| `typecheck`                                             | passed, no errors                                                                                                                 |
| `lint`                                                  | passed, no errors (incl. `@typescript-eslint/unbound-method`, floating-promise, no-empty-arrow rules)                             |
| `build`                                                 | succeeded (`dist/` built; only the pre-existing >500 kB single-chunk advisory, not an error)                                      |
| `node_modules/.bin/prettier --write <15 changed files>` | all reported "(unchanged)"                                                                                                        |
| `node_modules/.bin/prettier --check <15 changed files>` | "All matched files use Prettier code style!"                                                                                      |
| `git diff --check`                                      | clean, no output                                                                                                                  |
| `git log -1 --format=%B`                                | `feat(standalone): страница профиля организации в офисе` + blank line + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` |

`packages/domain/dist` and `packages/ui/dist` already existed in this
worktree (built by prior tasks), so no dependency rebuild was required before
running the standalone package's own gates.

## Deviations from the brief

None. Every file was created/edited exactly as specified, including the
three mandatory "Поправки контроллера" amendments. No brief test needed
adaptation for `@markiro/ui` jsdom quirks (Resolution-of-ambiguity item 1 did
not trigger), the App test needed no code fix (item 2's contingency did not
trigger), and jsdom moved focus to the `tabIndex={-1}` container without
issue (item 3's contingency did not trigger).

## Concerns

- None functional. The only build output is Vite's pre-existing "chunk larger
  than 500 kB" advisory (not a new regression from this task, not an error);
  raising it is out of this task's scope (no splitting was requested and the
  brief's file list does not touch build config).
- This task is webview-only, as scoped: no Rust, no `apps/station`, no
  `apps/standalone/host` or `src-tauri` changes were made or needed. Only
  jsdom/Vitest verification was performed; no manual/browser/hardware check
  applies to this task's surface (there is nothing here that a headless
  DOM test cannot exercise — no Tauri IPC, no printer/scanner, no Windows-only
  path).
