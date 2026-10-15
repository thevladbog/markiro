# Plan 1d4, Task 4 report: the «Операторы» page in the office

Status: DONE (no blocking concerns; a few observations under "Issues and concerns").
Commit `cd46efbb2 feat(standalone): страница «Операторы» в офисе`
(branch `claude/autonomous-desktop-station-9e6f13`, on top of `9bf19c24e`; not pushed).

## What I implemented

Everything in the brief, in its step order. Nothing was retyped: a scratch parser kept in `$TMPDIR/t4`
(outside the repo) reads the brief's own «Create» blocks and «фрагмент … заменить на …» pairs and applies
them with an exactly-once assertion (nothing is written if any anchor fails). After writing, each created
file was compared with `cmp` against the brief's own block (awk-extracted between the fences): all 8 are
byte-identical (the test file and the 7 sources).

- `src/office/operators/operator-forms.ts`: `newOperatorSchema`, `operatorEditSchema`, `pinFormSchema`
  (+ their input types); the PIN repeat refines onto `pinConfirm` with `rules.pinConfirm`.
- `src/office/operators/operator-records.ts`: `activeFirstByLogin` (active before turned-off, then by
  personnel number as text, `a.login < b.login`, no numeric collator).
- `CreateOperatorDialog.tsx`, `EditOperatorDialog.tsx`, `OperatorPinDialog.tsx`, `OperatorAccessDialog.tsx`:
  `FormDialog`-based; every failure sorted by `writeFailure` / `alertFailure`; stale writes offer
  «Загрузить заново» (`onReload`); the access dialog is `destructive` for turning off, `primary` for on.
- `OperatorsPage.tsx`: the list (login, name, role, PIN set / not set, badges in use with labels, access in
  words as a `StatusChip`), the four dialogs switched by one state, a success notice, no delete, no
  «Бейджи» button (task 5).
- `office-query.ts` (`officeKeys.operators`), `nav.ts` (item between «Линии» and «Устройства»,
  `roles: ["admin"]`), `routes.tsx` (`operators` route inside `RequireRole roles={["admin"]}`).
- `i18n/ru.json`: `rules.pinConfirm`, `office.nav.operators` and the whole `office.operators.*` group
  (including `office.operators.badges.unnamed`, which the list already needs; task 5 adds the rest of
  `badges.*`).
- Docs: two edits in `apps/standalone/AGENTS.md` (the write rule now mentions hashing in the `try` and the
  turn-off confirmation; a new «Операторы» paragraph in "Office pages") and the operators paragraph of
  spec §5.5.
- `test/operators-page.test.tsx`: the brief's 15 tests, unchanged.

Nothing changed under `apps/station`, `apps/standalone/proto|host|src-tauri` or any Rust file; no
dependency, manifest or lockfile change; no `pnpm install`/`add`; no stash; no push; no new branch.

## Anchors

All 10 «фрагмент» anchors of Steps 3 and 6 (7 + 3) matched exactly once against HEAD `9bf19c24e`, checked
with a dry run of all 18 operations (1 + 7 creates, 7 + 3 fragment edits) before anything was written. The
four mutation fragments matched exactly once when applied and exactly once when reverted. Nothing was
improvised.

## Baseline

`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` before any edit:
34 files / 705 tests passed; stderr only `$ vitest run` (the controller's number).

## TDD evidence

### RED (Step 2)

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operators-page.test.tsx`
(stdout and stderr to separate files; exit 1).

    Test Files  1 failed (1)
         Tests  14 failed | 1 passed (15)

All 14 failures are `TestingLibraryElementError: Unable to find role="link" and name "Операторы"` (14
occurrences). The one that passes is «is not in a technologist's menu», as the brief predicts: it guards the
role, and mutation 1 below shows it is not empty. Expected: the page, the menu item and the route did not
exist yet.

### GREEN (Step 4)

Same command after Step 3 (exit 0, stderr empty):

    Test Files  1 passed (1)
         Tests  15 passed (15)

- `--reporter=verbose`: 15 tests, stderr 0 bytes, no `act(...)`/Warning/Error text in either stream.
- Under the delayed-`setImmediate` stand (the two temporary files created exactly as in the plan, run with
  `--config vitest.delay.config.ts --reporter=verbose`, then deleted; `git status` afterwards showed neither
  file): 15 passed, stderr 0 bytes.
- Rerun once more on the committed state through `rtk proxy` (raw output, no wrapper trimming): 15 passed,
  stderr 0 bytes, no `stdout |`/`stderr |` console blocks.

## Mutation evidence

Each: `shasum -a 256` before, a copy of the file, the scratch edit (fragments cut from the brief), the named
command, the reverse edit, `shasum -a 256` after, `cmp` against the copy. No mutation was committed; the
mutated files equal their pre-mutation copies (the three files in the commit also equal their `HEAD` blobs;
`FormDialog.tsx` is not in the commit and has no diff).

### Mutation 1: `nav.ts` opens the item to the technologist

`roles: ["admin"]` became `roles: ["admin", "technologist"]` for `/operators`.
Command: `... exec vitest run test/operators-page.test.tsx -t "technologist's menu"` (exit 1):

    FAIL  test/operators-page.test.tsx > office operators > is not in a technologist's menu
    AssertionError: expected <a class="mk-sidebar__link" …(2)>…(1)</a> to be null
    Tests  1 failed | 14 skipped (15)

Revert: sha256 before and after `30cb529cbbee194d9eb017e032d76c84b2715eccdad65c617d52136df358b743`;
`cmp` against the pre-mutation copy: byte-identical.

### Mutation 2: `FormDialog.tsx` loses the second-submit guard

`if (inFlight.current) return;` removed.
Command: `... exec vitest run test/operators-page.test.tsx -t "double click"` (exit 1):

    FAIL  test/operators-page.test.tsx > office operators > hashes and sends one operator for a double click
    AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
    Tests  1 failed | 14 skipped (15)

Revert: sha256 before and after `0d3856302f541d58c90ec1b62b0413544938385d96f091da72463d8b4edde728`;
`cmp`: byte-identical; `git diff --quiet` on the file: no diff.

### Mutation 3: `operator-records.ts` sorts personnel numbers as numbers

`... || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0)` became `... || Number(a.login) - Number(b.login)`.
Command: `... exec vitest run test/operators-page.test.tsx -t "lists active operators first"` (exit 1):

    FAIL  test/operators-page.test.tsx > office operators > lists active operators first, each group by personnel number as text
    AssertionError: expected [ '0042', '99', '100', '042' ] to deeply equal [ '0042', '100', '99', '042' ]
    Tests  1 failed | 14 skipped (15)

Revert: sha256 before and after `0b8f9227ac20bcb9d2e13605b0cdb694af27f1b63c466e950b7963213c9f51d8`;
`cmp`: byte-identical.

### Mutation 4: `CreateOperatorDialog.tsx` sends the raw form values

`zodResolver(newOperatorSchema)` became `zodResolver(newOperatorSchema, undefined, { raw: true })`.
Command: `... exec vitest run test/operators-page.test.tsx -t "trimmed values"` (exit 1):

    FAIL  test/operators-page.test.tsx > office operators > adds an operator with the trimmed values and only a hash of the PIN
    AssertionError: expected [ [ 'office-session-token', …(1) ] ] to strictly equal [ [ 'office-session-token', …(1) ] ]
    -   "login": "0043",            +   "login": " 0043 ",
    -   "name": "Иван Петров",      +   "name": " Иван Петров ",

(the `pinPhc` and `role` lines are equal; the failing lines are the untrimmed `login` and `name`, a superset
of the brief's «`login: " 0043 "` вместо `"0043"`».) Revert: sha256 before and after
`9a721a5a1c9d25481b6bb88a3f66b48ac031bbb902b01b77c36c35321a1c311b`; `cmp`: byte-identical.

## Checks (Step 7), all from the repository root, no `cd`

| Check                                                                       | Result                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` | 35 files / 720 tests passed (705 + 15; the brief's 698 is 22 low, as the controller said); stderr only `$ vitest run`; rerun through `rtk proxy` on the committed state: same, no console blocks or `act(...)` text |
| `... typecheck`                                                             | exit 0                                                                                                                                                                                                              |
| `... lint`                                                                  | exit 0                                                                                                                                                                                                              |
| `... build`                                                                 | exit 0 (Vite's chunk-size warning is the existing `PairingDataMatrix` and main chunks)                                                                                                                              |
| `node_modules/.bin/prettier --check` on the brief's file list               | all formatted                                                                                                                                                                                                       |
| `git diff --check` (worktree and `--cached`)                                | clean                                                                                                                                                                                                               |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                 | only `src/host/pairing-code.ts:66`                                                                                                                                                                                  |
| New test file, `--reporter=verbose`                                         | 15 tests, stderr 0 bytes                                                                                                                                                                                            |
| New test file under the delayed-`setImmediate` stand                        | 15 passed, stderr 0 bytes; both temporary files deleted before lint                                                                                                                                                 |

Not exercised by this task (and not claimed): the Rust workspace (no Rust file changed), a real browser or
Tauri window, Windows. `graphify update .` was not run: this worktree has no `graphify-out/graph.json`.

## Files changed (14, 1164 insertions, 8 deletions)

Created: `apps/standalone/src/office/operators/{operator-forms.ts,operator-records.ts,CreateOperatorDialog.tsx,EditOperatorDialog.tsx,OperatorPinDialog.tsx,OperatorAccessDialog.tsx,OperatorsPage.tsx}`,
`apps/standalone/test/operators-page.test.tsx`.
Modified: `apps/standalone/src/office/{office-query.ts,nav.ts,routes.tsx}`, `apps/standalone/src/i18n/ru.json`,
`apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.

Commit message: the brief's subject, a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
`git log -1 --format=%B | grep -c Co-Authored-By` prints 1 (and 1 for a case-insensitive `co-authored`).
Explicit paths were staged (the brief's list); no `git add -A`.

## Self-review

Write-pattern rules the reviewers check (each verified in the committed source):

- The PIN is hashed inside `onSubmit`, from the trimmed zod output (`values.pin`, the value the form
  validated), as the first statement of the `try`, before the body builder is called
  (`CreateOperatorDialog.tsx:55` then `:56-57`; `OperatorPinDialog.tsx:58` then `:59`). The `FormDialog`
  in-flight guard therefore covers the hashing (the double-click test and mutation 2 show it), and the
  mutation variables (`OperatorCreate` / `OperatorUpdate`, which TanStack Query keeps) hold only the hash:
  the create test asserts the body with `toStrictEqual` (four keys) and `verifyPhc` of the PIN against the
  hash it carries.
- `raw: true` is set nowhere (`grep raw` over the new sources: none).
- The callback after a saved write (`onCreated`, `onSaved`) runs after the `try/catch`; every `catch` ends
  with `return;` (all four dialogs: one `catch`, one `return;`).
- Bodies come from `operatorCreate` / `operatorUpdate` only; ids go into the path (`api.updateOperator(token,
operator.id, body)`).
- Strictness: no `any`, no casts (the only `as` hits are a comment and `as const`), no non-null
  assertions, no native form elements (ESLint would reject them); controls from `@markiro/ui`.
- Text: 67 distinct i18n keys are used by the new code and all resolve in `ru.json` (checked with a scratch
  script, since the test i18n throws on a missing key only for paths a test renders); all 51 leaf keys under
  `office.operators` are referenced by the code, so none is dead. `\u04` grep is clean.
- Scope: nothing beyond the brief; the fixed 15-test file is byte-identical to the brief's block.

## Issues and concerns

None blocking. Observations, all about coverage the brief fixes rather than defects:

1. `office.operators.pinUnset` («PIN не задан») is not rendered by any of the 15 tests: no fixture has
   `hasPin: false`. The key exists (script-checked) and the branch is a one-line ternary, but a regression
   there would not be caught. I did not add a test: the brief fixes the file at 15 tests and the total at 720.
2. `stale_revision` is tested only for the edit dialog («Загрузить заново»); the PIN and access dialogs use
   the same `WriteFailureAlert` with `onReload`, but their stale path has no test of its own. The
   `hashPin`-failure path (a non-`HostError` in the `try`) ends in the generic `errors.unknown` alert via
   `errorMessageKey`, also untested (WebCrypto failing is not a realistic case).
3. Mutation 4 only proves the trimming for the create dialog; the PIN and edit dialogs take the same
   resolver pattern without their own «raw» mutation (the brief's choice).
4. The brief's Step 7 total (698) is 22 low, as the controller's message says; the real total is 720.
5. The `$TMPDIR/t4` scratch tools (`apply.mjs`, `mutate.mjs`, logs) stay outside the repo and are not committed.
