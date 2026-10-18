# Plan 1e4, Task 8 report

Status: DONE. Commit a050aa213 `fix(standalone): «Шаблоны» — шаблон, удалённый на другом рабочем месте, и один порядок названий` (base 1fb64ef7f). Trailer: exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## What was done

Plan fragments applied verbatim, in order (tests first, then Step 3 items 1-19). `byNameThenId` in `records.tsx` is used by `activeFirstByName`, `templatesByName` and `templateOptions`; `templateFailure` answers `not_found` with `office.templateEditor.errors.missing` (key already present in ru.json); both list dialogs call `onMissing` on `not_found` after setting the failure; `TemplatesPage` passes `missing = () => void templates.refetch()` to both. Two extra tests added (see below). Host, proto, shell, station, packages untouched.

## Evidence

- Baseline before: `Test Files 53 passed, Tests 1254 passed` (/tmp/claude/t8-base.txt).
- RED (3 files): `Tests 3 failed | 61 passed (64)`, the three predicted messages: options order (`expected [ '', …(2) ] to strictly equal [ '', …(2) ]`), `templateFailure` strict equal, dialog (`expected '✕Запись не найдена.' to be '✕Шаблона больше нет на хосте: его уда…'`).
- GREEN (3 files): 64 passed; `--reporter=verbose` run: 64 passed, stderr 0 bytes, no `stderr |` blocks.
- Delayed-`setImmediate` stand (3 files + template-list + records: 5 files): 80 passed; and templates-page alone with the extras: 50 passed. Stand files removed.
- Full gate: prettier --check (10 files) clean, `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`, typecheck 0, lint 0, `pnpm test`: **53 files, 1259 tests** passed.
- Counts: plan expects 1191 (1188 + 3); on this tree 1254 baseline + 3 plan tests = 1257, plus 2 extras = 1259.

## Mutants (each restored byte-identically: `cmp` against /tmp/claude/before and sha256 equal, checked by the script /tmp/claude/mut.py)

Plan mutants:

| #   | Mutant                                       | Failing test                                                                                                                          | Key line                                                             |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | options sort without id (localeCompare)      | template-options "put templates of the same name…"                                                                                    | `expected [ '', …(2) ] to strictly equal`                            |
| 2   | drop `not_found` branch in `templateFailure` | template-text "says a template deleted…", templates-page "says so in either dialog…"                                                  | `expected '✕Запись не найдена.' to be '✕Шаблона больше…'` (2 failed) |
| 3   | drop `onMissing` call in StateDialog         | "says so in either dialog…"                                                                                                           | `expected "vi.fn()" to be called 2 times, but got 1 times`           |
| 4   | same in CategoriesDialog                     | same                                                                                                                                  | same                                                                 |
| 5   | drop id from `byNameThenId`                  | template-list "sorts by name… then by id", records "orders records with equal names by id", options "put templates of the same name…" | `3 failed \| 17 passed (20)`                                         |

Extra mutants killed by the plan's tests (nothing to add): E1/E2 (`onMissing?.()` unconditional in State/Categories dialog) killed by the existing stale-switch / stale-categories tests (`called 2 times, but got 3 times`); E3 (`missing = reload`, dialog closes) killed; E4 (`missing` no-op) `got 1 times`; E5 (double refetch) `got 3 times`; E6/E6b (`onMissing` not wired to categories / state dialog in the page) `got 1 times`; E8 (activeFirstByName without id), E9 (templatesByName without id: 2 tests), E10 (id order reversed: 4 tests), E11 (collator without `numeric`: 6 tests, incl. options "58×40 before 100×100"), E12 (options non-numeric), E13 (options reversed), E15 (`||` to `&&`: 10 tests), E16 (drop archived-first) all killed.

Survivors of the plan's tests, which the two extra tests kill (both in `templates-page.test.tsx`, describe "a template deleted on another workstation"):

- "reads the list once, leaves the dialog open with its message and no notice behind it, and writes again on a second click" (both dialogs; after settle: list read exactly twice, dialog still open with the message, exactly one `.mk-alert` in the document, second click writes again and re-reads once, total 3). Killed mutants: Xb `missing` also sets a page notice (survived plan tests, killed here: `.mk-alert` count), Xa `refetch().then(() => setDialog(null))` (closed dialog after the read), Xc delayed second refetch via `setTimeout`.
- "reads the list again only for a template that is gone, not for any other refusal" (`validation_failed` 422 in both dialogs: one write, one list read, message is not the "gone" text). Makes E1/E2 (unconditional `onMissing`) fail by a test of their own (before, only incidental stale tests caught them).

Equivalent (argued) mutants:

- E14 `(a.id < b.id ? -1 : 1)` in `byNameThenId` (equal ids return 1 instead of 0): survives all tests. Equal ids mean the same record (unique keys; `getRowKey` is the id), so the branch is not reachable with valid data; with duplicate ids V8's sort gave identical output in 5980 random trials (arrays of 2-300 elements with duplicate names and ids, original vs mutant comparator, node v24.18.0), so not observable even then.
- Xd `{ onMissing?.(); return; }` adds a `return` that already follows: identical code path.
- Not tried: `error.status === 404` instead of `error.code === "not_found"` in the dialogs (same on every host answer for this route); consumers `ProductDialog`, `TemplateDefaultsPage`, `CategoryDefaultDialog` pass `templateOptions(...)` to a Select with no sorting of their own (the defaults page only `.filter`s after it), so their order is the seam's order; no consumer-level test added.

## Files changed

src: `src/office/records.tsx`, `src/office/template-options.ts`, `src/office/templates/{template-list,template-text}.ts`, `src/office/templates/{TemplateStateDialog,TemplateCategoriesDialog,TemplatesPage}.tsx`. tests: `test/{template-options,template-text,templates-page}.test.{ts,tsx}`.

## Concerns / notes

- `CategoryDefaultDialog.tsx` still has its own `NAMES` collator for sorting groups (not templates); outside this task's file list, left alone.
- `git status --short` empty after the commit; no scratch files remain. No cargo run (none required).
- Checks not run: browser/Windows/host-side verification (none in scope).
