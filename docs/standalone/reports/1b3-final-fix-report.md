# Plan 1b3 — final fix wave: report

Scope: `apps/standalone` (`src`, `test`, `src-tauri/tests/ipc.rs`, `AGENTS.md`) and
`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, per
`.superpowers/sdd/1b3-final-fix-brief.md` and `.superpowers/sdd/1b3-constraints.md`.

Commit: `31ef35529` on `claude/autonomous-desktop-station-9e6f13`
(`fix(standalone): итоговое ревью 1b3 — спека и правила офиса, один список
пользователей, подсказки и тексты`).

## What changed, per item

**A. Spec §5.5/§7 — screens go through `session.call`/`HostApi`.**
`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`:

- §5.5 bullet now reads "каждый экран обращается к хосту только через
  `session.call` с методами `session.api` (`HostApi`, `src/host/api.ts`) —
  хуки `useOfficeQuery` и `useOfficeMutation` (`src/office/office-query.ts`),
  а не через `apiFetch`", replacing the retired `HostClient` description. Rest
  of the bullet (cloud concepts, domain validation) unchanged.
- §7 TypeScript item: "офисные формы с поддельным `HostClient`" became
  "офисные формы с поддельным `HostApi` (`fakeHostApi` в
  `test/support/office.tsx`)", keeping the trailing "(проверки полей, коды
  ошибок хоста → тексты, скрытие пунктов по роли)" as instructed.
- Manually re-wrapped both edited paragraphs to the doc's existing ~80–86
  character line width (prettier's `proseWrap` is `"preserve"` here, so it
  does not reflow prose itself — confirmed via `.prettierrc.json`).

**B. Users page never seeds a partial list.**
`src/office/users/OfficeUsersPage.tsx`, `store`: now reads the cached list
with `getQueryClient.getQueryData`; if present, updates it with `withUser`;
if absent (failed or not-yet-loaded), calls
`queryClient.invalidateQueries({ queryKey: officeKeys.users })` instead of
seeding a one-row "complete" list. Test added to
`test/users-page.test.tsx` ("re-reads the whole list after adding a user
onto a list that failed to load"). Red → green below.

**C. Users table empty state + `@markiro/ui` defaults documented.**
`OfficeUsersPage.tsx`'s `Table` now gets `empty={t("office.users.empty")}`;
added `"empty": "Пользователей пока нет."` under `office.users` in `ru.json`.
AGENTS.md "Office pages" gained the bullet about `@markiro/ui`'s English
defaults for `Table`/`Modal`.

**D. One success-notice rule.**

- `OrgProfilePage.tsx`: `OrgProfileForm` gained `onSubmitStart: () => void`,
  called first in `submit` before `setFailure(null)`. The page passes
  `onSubmitStart={() => setSavedRev(null)}`.
- `sscc/BlockSizesForm.tsx`: same `onSubmitStart` prop and call order.
  `SsccPage.tsx` passes `onSubmitStart={() => setSaved(null)}`.
- `SsccPage.tsx`: the counter dialog now renders only for administrators:
  `{admin && editing && (<CounterDialog … />)}`.
- Users page already cleared its notice on dialog open; left unchanged.
- Tests added to `test/org-page.test.tsx` and `test/sscc-page.test.tsx`
  ("clears the success notice when the next save starts" /
  "...block-size success notice..."). Red → green below.
- AGENTS.md "Office pages" gained the success-notice bullet.

**E. `ChangePasswordDialog` on the shared rules.**
`src/office/ChangePasswordDialog.tsx`: removed the local `characters()` and
its inline 8–128 refine; `newPassword` now uses `passwordRule` from
`../lib/rules.js`. The confirm-mismatch error uses `"rules.passwordConfirm"`;
the host `newPassword` refusal maps to `"rules.password"`. `Modal` uses
`closeLabel={t("office.common.close")}` and the cancel button uses
`t("office.common.cancel")`. Removed `office.password.length`,
`.mismatch`, `.close`, `.cancel` from `ru.json` after grepping `src`/`test`
for each — none were used elsewhere. Kept `required`, `wrongCurrent`,
`done`, `hint`, `title`, `open`, `submit`, `current`, `new`, `confirm`. Texts
are identical to what was removed, so `test/app.test.tsx`'s change-password
tests (23 tests) pass unchanged — verified.

**F. Wizard uses `THIRTEEN_DIGITS`.**
`src/wizard/BootstrapWizard.tsx`: imports `THIRTEEN_DIGITS` alongside
`issuerPrefix` from `../lib/rules.js`; the literal `/^\d{13}$/.test(gln)`
became `THIRTEEN_DIGITS.test(gln)`. Pure refactor, same regex.

**G. AGENTS.md "Office pages" wording.**

- "Every write sends…" → "Every update of a revisioned record sends the
  loaded record's `expectedRev`. Creates and password routes carry none."
- Roles bullet's own-row sentence replaced with the UI-rule wording from the
  brief (host guards the last active administrator; own password via
  «Сменить пароль»).
- Added: "An ended session unmounts the office: unsaved edits are lost, and
  the next sign-in starts at «Обзор»."

**H. Comments that stop being true in 1c.**
`src/office/office-query.ts` doc comment and the offline test's comment in
`test/office-query.test.tsx` no longer say "a host on the same PC, not the
network"; both now say calls go over IPC to the host and the webview's
online flag says nothing about whether the host answers, matching
AGENTS.md's existing wording.

**I. Users re-sort mirrors the host's order.**
`OfficeUsersPage.tsx`: added `byLogin(a, b)` (ASCII-lowercase then plain
`<`/`>` compare) and switched `withUser` to `.sort(byLogin)` instead of
`localeCompare(..., { sensitivity: "base" })`. Test added to
`test/users-page.test.tsx` ("sorts a new user the way the host does: ASCII
case folded, then by byte"), asserting `a-b`, `a_b`, `ab` order via
`within(table).getAllByRole("row")` / `getAllByRole("cell")`, per the
resolution note. Red → green below.

**J. `device_forget` through the mock dispatcher.**
`src-tauri/tests/ipc.rs`, in `a_paired_device_reaches_the_host_through_the_ipc_shapes`,
added the two `assert_eq!` calls from the brief after the logout check and
before `drop(webview)`. Ran outside the sandbox (binds 127.0.0.1) — see
verification below. The brief's snippet was not rustfmt-clean; ran
`cargo fmt --all` to reformat the two `assert_eq!` calls onto multiple lines
(no semantic change), then confirmed `--check` passes.

**K. Offline test covers mutations.**
`test/office-query.test.tsx`, the offline `it` (renamed "keeps reading and
writing over IPC while the webview reports itself offline"): inside the same
`try/finally`, now also renders `useOfficeMutation` over a resolving
`updateOrg`, calls `mutateAsync` while offline, and asserts it resolves and
`updateOrg` was called. Verified per the brief: temporarily removed
`networkMode: "always"` from the `mutations` defaults in
`src/office/office-query.ts`, watched the test time out (red), restored the
line, watched it pass (green). See evidence below.

**L. Own-row checkbox has its own hint.**
`src/office/users/EditUserDialog.tsx`: `RoleRadios` now gets
`hint={own ? t("office.users.ownRoleHint") : null}`; the `Checkbox` gets
`{...(own ? { hint: t("office.users.ownAccessHint") } : {})}` (required by
`exactOptionalPropertyTypes`, since `Checkbox.hint` is `string | undefined`
and cannot be assigned an explicit `undefined`). `ru.json`'s
`office.users.ownHint` was replaced by `ownRoleHint` and `ownAccessHint`
with the exact texts from the brief. Updated the existing users-page test
that asserted the old combined sentence to assert both new sentences. Red →
green below.

**M. One stale fallback, not a repeated literal.**
`src/office/form-errors.ts`: added `failureMessage(failure)`, returning the
alert's own message or `"errors.api.stale_revision"` otherwise. Used in
`users/CreateUserDialog.tsx` and `users/SetPasswordDialog.tsx` in place of
the inline ternary. Added two cases to `test/form-errors.test.ts`.

## Red → green evidence

**B (users list not seeded partial):** with the pre-fix `store` (unconditional
`setQueryData(... withUser(list ?? [], user))`), the new test hung on
`await waitFor(() => expect(session.api.listUsers).toHaveBeenCalledTimes(2))`
until the 5 s default timeout, because nothing ever re-read the list — timed
out (red). After the fix, `pnpm --config.verifyDepsBeforeRun=false --filter
@markiro/standalone exec vitest run test/users-page.test.tsx -t "re-reads the
whole list after adding a user"` → 1 passed (green).

**D (org profile):** with `OrgProfileForm` not calling `onSubmitStart`, the
new org-page test failed:
`AssertionError: expected <div …(1)></div> to be null` — the "Изменения
сохранены." alert was still in the DOM next to the new field error (red).
After adding `onSubmitStart`/`setSavedRev(null)`,
`vitest run test/org-page.test.tsx` → 8 passed (green).

**D (SSCC block sizes):** identical shape of failure before the fix
("Изменения сохранены." still present) (red); after adding
`onSubmitStart`/`setSaved(null)` to `BlockSizesForm`/`SsccPage`,
`vitest run test/sscc-page.test.tsx` → 10 passed (green).

**I (users sort order):** before the fix, the new test failed with
`expected [ 'a_b', 'a-b', 'ab' ] to deeply equal [ 'a-b', 'a_b', 'ab' ]` —
confirmed independently in Node that
`["a-b","a_b","ab"].sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:"base"}))`
produces `['a_b','a-b','ab']`, i.e. `localeCompare` treats `-`/`_` as nearly
equal (red). After switching to `byLogin`,
`vitest run test/users-page.test.tsx -t "sorts a new user the way the host does"`
→ 1 passed (green).

**K (mutation offline):** temporarily changed
`mutations: { retry: false, networkMode: "always" }` to
`mutations: { retry: false }` in `src/office/office-query.ts`, then ran
`vitest run test/office-query.test.tsx -t "keeps reading and writing over IPC" --testTimeout=8000`:

```
FAIL  test/office-query.test.tsx > useOfficeQuery > keeps reading and writing over IPC while the webview reports itself offline
Error: Test timed out in 8000ms.
```

(red — the mutation stayed paused offline and `mutateAsync` never resolved).
Restored `networkMode: "always"`; `vitest run test/office-query.test.tsx` →
4 passed (green).

**L (own-row hint split):** before the source/i18n change, the updated test
assertion failed:

```
TestingLibraryElementError: Unable to find an element with the text: Свою
роль может изменить только другой администратор.
```

(red — the old combined key/text was still in place). After splitting
`RoleRadios`/`Checkbox` hints and the `ru.json` keys,
`vitest run test/users-page.test.tsx -t "lets administrators rename themselves"`
→ 1 passed (green).

## Verification commands and results

Focused, while iterating (see red/green above for the individual `-t` runs).

Brief's exact targeted command:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/users-page.test.tsx test/org-page.test.tsx test/sscc-page.test.tsx \
  test/office-query.test.tsx test/office.test.tsx test/form-errors.test.ts \
  test/wizard.test.tsx test/app.test.tsx
```

→ 8 test files, 92 tests passed.

Package gates:

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
  → 19 test files, 232 tests passed.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`
  → clean (`tsc -p tsconfig.json --noEmit`, no output).
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
  → clean (no output).
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
  → succeeded; only the pre-existing ">500 kB chunk" advisory from
  `vite build`, unrelated to this change (same chunking as before).

Rust (run outside the sandbox — binds 127.0.0.1):

- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline`
  → `an_unpaired_device_reports_null_and_refuses_host_requests ... ok`,
  `a_paired_device_reaches_the_host_through_the_ipc_shapes ... ok`
  (2 passed; 0 failed).
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
  → clean after running `cargo fmt --all` (write) once to reformat the two
  new `assert_eq!` calls (see deviation below); re-ran the `ipc` test
  afterward to confirm formatting didn't change behavior — still 2 passed.

Formatting and diff hygiene:

- `node_modules/.bin/prettier --check` on all 19 changed TS/TSX/JSON/MD files
  (the spec and `AGENTS.md` included; `src-tauri/tests/ipc.rs` excluded —
  Prettier has no Rust parser, covered by `cargo fmt` instead) → "All matched
  files use Prettier code style!"
- `git diff --check` → clean, no output.

Commit:

- `git log -1 --format=%B` shows the trailer exactly as
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git status --short` after the commit is empty (nothing left unstaged or
  untracked from this work).

## Deviations from the brief

- **Item A, second edit:** the `Edit` tool's `old_string` match failed once
  on the full 3-line paragraph (likely a whitespace/line-wrap subtlety
  between the tool's rendered view and the on-disk bytes); resolved by
  anchoring on a smaller, unique substring
  ("`с поддельным \`HostClient\` (проверки`") instead. After the replace, the
paragraph exceeded the doc's manual ~80–86 character wrap width (Prettier's
`proseWrap`is`"preserve"`per`.prettierrc.json`, so it does not reflow
prose), so I reflowed the paragraph by hand to match the surrounding
style, then re-verified with `prettier --check`.
- **Item J:** the brief's Rust snippet was not rustfmt-formatted; ran
  `cargo fmt --all` once (write) to match the workspace's rustfmt style, per
  AGENTS.md's "the workspace is rustfmt-clean and CI enforces it." No
  semantic change — verified the test still passes after formatting.
- **Item H:** worded the test's inline comment to say "the webview's online
  flag" (matching AGENTS.md's exact term) rather than keeping the original
  comment's "online state" — a wording-only choice to match AGENTS.md as
  instructed, not a behavior change.
- Test names for the new tests (items B, I) are descriptive rather than
  quoted from the brief verbatim, since the brief describes their shape as
  numbered steps rather than giving exact `it(...)` titles.

## Concerns

- Per the constraints file, only `cargo test -p markiro-standalone --test ipc
--offline` was run for this wave (not the full `--workspace`), since no
  other Rust production code changed — only the `ipc.rs` test file. This
  matches the brief's own "Verification" section for this wave.
- The `vite build` "chunk larger than 500 kB" advisory is pre-existing and
  unrelated to this change; not a regression introduced here.
- No browser, hardware, or Windows checks apply to this wave — it is a
  webview/Rust-test/doc fix wave with no UI-visible behavior beyond what the
  automated tests already assert (alert timing, table sort order, hint
  text). All verification above is automated; nothing required external
  confirmation.
- `apps/standalone/README.md` was not touched — none of items A–M reference
  it, and none of the removed/renamed i18n keys or texts appear there
  (checked by grep).

## Follow-up (re-review tightenings)

Commit: `6f3039842`
(`test(standalone): порядок пользователей со сложением регистра, восстановление
сети в офлайн-тесте`).

The re-review approved the wave ("Ready: Yes") and asked for two small test
tightenings:

**1. Item I's test proved byte order but not case folding.** Every login was
lowercase (`a-b`, `ab`, `a_b`), so a `byLogin` without `.toLowerCase()` would
have passed too, and `"ab"` (2 characters) breaks the host's 3–64 login rule.
Changed `test/users-page.test.tsx` to use the fixture logins `a-bc`/`abc` and
create a user with login `A_bc`, expecting the row order `["a-bc", "A_bc",
"abc"]` — an order only case folding produces, since raw `A` (0x41) sorts
before lowercase `a` (0x61).

Red run (temporarily changed `byLogin` in
`src/office/users/OfficeUsersPage.tsx` to compare `a.login`/`b.login`
directly, without `.toLowerCase()`):

```
FAIL  test/users-page.test.tsx > office users > sorts a new user the way the host does: ASCII case folded, then by byte
AssertionError: expected [ 'A_bc', 'a-bc', 'abc' ] to deeply equal [ 'a-bc', 'A_bc', 'abc' ]

- Expected
+ Received

  [
-   "a-bc",
    "A_bc",
+   "a-bc",
    "abc",
  ]
```

Restored `.toLowerCase()` (confirmed via `git diff` on `OfficeUsersPage.tsx`
showing no residual change — the file matches the prior commit exactly), then
`vitest run test/users-page.test.tsx -t "sorts a new user the way the host does"`
→ 1 passed (green).

**2. Item K's offline test had no cleanup net.** If an assertion inside it
timed out or threw before the `try/finally`'s `finally` ran (it wouldn't, but
a later edit could break that), `onlineManager` would stay offline for the
rest of the file's tests. Added a file-level
`afterEach(() => onlineManager.setOnline(true));` next to the imports in
`test/office-query.test.tsx`, alongside the existing `try/finally` (left
unchanged).

Verification, in the requested order:

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/users-page.test.tsx test/office-query.test.tsx`
  → 2 test files, 18 tests passed.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
  → 19 test files, 232 tests passed (same count as before — tests were
  edited, not added/removed).
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`
  → clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
  → clean.
- `node_modules/.bin/prettier --check` on both changed files → "All matched
  files use Prettier code style!"
- `git diff --check` → clean.
- `git log -1 --format=%B` on `6f3039842` shows the trailer exactly as
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

No deviations or new concerns from this follow-up.
