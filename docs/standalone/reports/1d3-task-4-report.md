# Plan 1d3, Task 4 — the «Контрагенты» page: report

Status: DONE. Commit `d4df8bb398a4b0b8bc31a445976d536c10245d8c` on `claude/autonomous-desktop-station-9e6f13`
(`feat(standalone): страница «Контрагенты» в офисе`), on top of `383c1209c`. Not pushed, no new branch, no stash.

## What I implemented

Exactly the brief, in its step order, taking the code blocks from the brief file itself (extracted by line range,
then diffed against the files: byte-identical, no retyping):

- `src/office/records.tsx` — shared parts of archivable lists: `activeFirstByName` (active before archived,
  `Intl.Collator("ru", { numeric: true })`, then id), `withRecord`, `useStoreRecord` (a saved record goes into the
  cached list; with no list loaded the list is re-read), `ArchiveStatus` (`StatusChip`, the state in words).
- `src/office/counterparties/counterparty-form.ts` — `counterpartyFieldsSchema`, `CounterpartyFields`,
  `COUNTERPARTY_FIELDS`, `counterpartyFields(record | null)`, `toCompanyInput(values)`.
- `src/office/counterparties/CounterpartyDialog.tsx` — one dialog for add and change (`FormDialog`), whole record +
  `expectedRev` on change, the «В архиве» box only when changing, every failure sorted through `writeFailure`
  (`onSubmit` never rejects), `submitDisabled` until something changed.
- `src/office/counterparties/CounterpartiesPage.tsx` — the list (`Table`), «Добавить контрагента» and per-row
  «Изменить» for administrators only (`useCan("editReference")`), the read-only note for technologists, success notice.
- `office-query.ts` (`officeKeys.counterparties`), `nav.ts` (menu item, both roles, section «Организация»),
  `routes.tsx` (`/counterparties`, not wrapped in `RequireRole`: every role reads), `ru.json` (nav, `office.common.active`
  / `archived`, the `office.counterparties` block).
- Docs: `apps/standalone/AGENTS.md` («Office pages»: archive-first ordering, the counterparties rules) and the stage-1 spec §5.5.

The «form sends what it validated» rule holds: `toCompanyInput` sends `name`, `inn`, `gln` trimmed (an empty INN is
`null`) and `parsePrefixList` splits and de-duplicates the prefixes; the values reaching it are the zod output of
`handleSubmit` anyway (the resolver returns the parsed data), and the explicit `.trim()` makes it independent of that.
Bodies are built only by `counterpartyCreate` / `counterpartyUpdate`, field by field; ids go into the path only.

## TDD evidence

RED (before any implementation; the test file was diffed against the brief first):

    pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/counterparties-page.test.tsx
    ... Test Files  1 failed (1) / Tests  10 failed (10)
    10x TestingLibraryElementError: Unable to find role="link" and name "Контрагенты"

Expected, as in the brief: the menu item does not exist yet, so every test dies in `openCounterparties` / the menu check.

GREEN (same command, after the implementation):

    Test Files  1 passed (1) / Tests  10 passed (10)

Verbose run, stdout and stderr captured separately: 10 tests listed with a check mark each, exit 0, **stderr 0 bytes**
(no `act(...)` warnings, no React or i18n noise).

## Checks (automated)

Baseline before starting: 30 files / 585 tests, green.

| Check                                                        | Result                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm ... --filter @markiro/standalone test`                 | 31 files / **595 tests** passed (the brief's 594 is 1 low, as you said); stderr only pnpm's `$ vitest run` line             |
| `pnpm ... typecheck` (`tsc --noEmit`)                        | exit 0                                                                                                                      |
| `pnpm ... lint` (eslint)                                     | exit 0                                                                                                                      |
| `node_modules/.bin/prettier --check` on the 11 changed files | all formatted                                                                                                               |
| `git diff --check` and `git diff --cached --check`           | clean                                                                                                                       |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`  | one hit, pre-existing and intentional: `src/host/pairing-code.ts:66` (the regex `/[\u0400-\u04ff]/`); none from this change |
| Unicode scan of the new files and added lines                | only Cyrillic, `«»`, `—`, `§`; no NBSP, soft hyphen, zero-width characters, no trailing whitespace                          |
| `git log -1 --format=%B`                                     | the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer appears exactly once, no other `Co-Authored-By`       |

### Race check (the `setImmediate` vs `setTimeout(0)` trap)

None of the ten tests is racy; I found nothing to change. How I know, rather than guessing:

- Stand from the project memory note (a scratch setup file inside the Vite root replacing `globalThis.setImmediate`
  with `setTimeout(cb, N)`, plus a scratch vitest config with `setupFiles: [scratch, "test/setup.ts"]`).
- Positive control first: a scratch component whose state is set by an effect chain passes 3/3 under the default config
  and fails 3/3 under the 3 ms stand (`Unable to find an element with the text: done`), so the stand does bite.
- The new file passed 5/5 at 3 ms and 3/3 at 10 ms; the whole suite passed at 3 ms (31 files / 595 tests).
- 16 concurrent runs of the new file (2 rounds of 8) under the default config, on a loaded machine: 16/16 passed.
- Why it holds: the assertions right after `findBy*` are on DOM that the same React batch produced (the notice and the
  closed dialog come from one continuation); the table update after a save goes through TanStack's `setTimeout(0)`
  notification, which is queued before RTL's own `setTimeout(0)` drain after `findBy*` and so runs first. No test asserts
  the result of a passive effect.
- All three scratch files (setup, config, control test) were deleted; `git status` was clean before and after the commit.

## Files changed (11, +742 -1)

Created: `apps/standalone/src/office/records.tsx`, `apps/standalone/src/office/counterparties/{counterparty-form.ts,CounterpartyDialog.tsx,CounterpartiesPage.tsx}`, `apps/standalone/test/counterparties-page.test.tsx`.
Modified: `apps/standalone/src/office/{office-query.ts,nav.ts,routes.tsx}`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.
Nothing under `apps/station`, `apps/standalone/{proto,host,src-tauri}` or any Rust file; no dependency added.

## Self-review

- Completeness: every brief step done in order; the 9 «фрагмент → заменить на» anchors each matched exactly once
  (checked with a dry run before applying; the two docs anchors were applied after GREEN, as the brief orders).
- Behaviour covered by the ten tests: menu for both roles; natural sort with archived last and «—» for a missing INN or
  no prefixes; technologist read-only; add sends each field by name with trimmed values and de-duplicated prefixes;
  client-side rules (control character in the name, 9-digit INN, GLN check digit, 3-digit prefix) block the request;
  change sends the whole record with the loaded `expectedRev` and `archived`; blank INN becomes `null` and un-archiving
  works; a stale change offers «Загрузить заново» which closes the dialog and re-reads the list; a host
  `validation_failed` on `gln` lands under the field with `aria-describedby`; a double click and a click while in flight
  send one request.
- Discipline: nothing beyond the brief. `graphify update .` was not run: this worktree has no `graphify-out/graph.json`.
- Docs claim checked against the host: counterparties are read `ORDER BY archived, name, id` and lines
  `ORDER BY archived, name_key, id` (bytewise), so the sentence «the host sorts bytewise» in AGENTS.md is true.

## Observations about the brief (none blocking)

1. `CounterpartyDialog` calls `onSaved(...)` inside the `try`, so an exception thrown by the page's `onSaved` would be
   shown as a write failure for a write that succeeded. Same shape as the existing users dialogs; the page callback
   cannot throw in practice. Left as specified.
2. `useForm<CounterpartyFields>` types `handleSubmit`'s values as the zod input while it receives the output; harmless
   because input and output types are identical here and `toCompanyInput` trims again.
3. The INN and prefix labels and hints reuse `org.inn`, `org.innHint`, `org.gs1Prefixes`, `org.gs1PrefixesHint`;
   name and GLN have their own keys. As specified.
4. The brief's totals (594) are 1 low; the truth is 595, as you predicted.

## Not run (and why)

- `vite build` / `pnpm ... build`: not part of the brief's Step 6, TS-only change with no new dependency; it would also
  refresh the git-ignored `apps/standalone/dist` that the Cargo tests read.
- Cargo tests, browser or visual check, Windows: not applicable to this change (no Rust touched; the office needs the
  Tauri IPC, so there was no live page to look at). Automated DOM tests are not visual confirmation.
