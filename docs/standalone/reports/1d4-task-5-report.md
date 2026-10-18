# Plan 1d4, task 5 report: operator badges in the office (list, add from a scanner, revoke)

Status: DONE. Commit `c524d0abb` `feat(standalone): бейджи операторов в офисе` on `claude/autonomous-desktop-station-9e6f13` (not pushed, no new branch).

## What was implemented

Exactly the brief, step by step. Every code block, fragment, i18n string, doc sentence and the commit message were taken from the brief's own fenced blocks by a small script (`$TMPDIR/t5/apply.py`), which refuses a fragment that does not occur exactly once. All 11 anchors of Steps 3 and 6 matched on the first try, so nothing was improvised. Afterwards a second script compared every committed file and fragment with the brief's blocks: all identical.

- «Бейджи» button in an operator's row opens `BadgesDialog`: label or «Без подписи», «Добавлен <дата>», state in words («Действует» / «Отозван»); revoked badges stay listed, dimmed (`badge-list__item--revoked`), with no button.
- `AddBadgeDialog`: the salt comes from `GET /v1/office/badge-salt` through `useOfficeQuery(officeKeys.badgeSalt, …, { staleTime: Infinity })`; `not_found` says the host is not set up yet; the submit stays off until the salt is read; the hidden code field takes the focus; the TRIMMED zod output is hashed with `hashBadge` INSIDE `onSubmit` (so the `FormDialog` in-flight guard covers the hashing), the body comes from `badgeCreate` only; the answer is a `BadgeInfo`, which the page puts into the cached operator at once (`withBadge`, no re-read). A `badge` conflict goes under the code: the owner's name when `details.operatorId` is a UUID of a listed operator (`badgeHolder`), otherwise the generic text.
- `RevokeBadgeDialog`: `destructive` confirmation; after the 204 the badge is marked revoked in the cache at once (`withBadgeRevoked`, this PC's clock as a mere marker), then the list is re-read and brings the host's time.
- `OperatorsPage` switches three dialogs (list, add, revoke) by operator id, reading the operator from the cached list, instead of nesting modals. `useOfficeQuery` got `staleTime` (default 0), `officeKeys.badgeSalt` was added.
- Write-pattern rules that reviewers check, all met: the code is hashed inside `onSubmit` before the body is built, so the mutation variables hold only the hash; no `raw: true` on the resolver; `onAdded` / `onRevoked` run after the `try/catch`, and every `catch` ends with `return`; bodies come from the builders; a `badge` conflict lands under the code field; the revoke shows in the cache before the re-read.
- Docs: `apps/standalone/AGENTS.md` (two fragments: `badge` in the conflict list and «a badge code» in the hashing sentence, plus a new «Бейджи» bullet) and spec §5.5.

## Tests

Baseline before the change (measured): `pnpm … --filter @markiro/standalone test` gave 35 files / 720 tests, all passing, stderr only pnpm's `$ vitest run`.

### TDD evidence

RED (Step 2): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx` -> exit 1.

```
 Test Files  1 failed (1)
      Tests  11 failed (11)
 FAIL  test/operator-badges.test.tsx > operator badges > lists an operator's badges, revoked ones too, dimmed and in words
TestingLibraryElementError: Unable to find role="button" and name "Бейджи оператора «Анна Кузнецова»"
```

All 11 fail with that same message (the three `it.each` cases are reported together under one message line). Expected: the button does not exist before Step 3, and every test opens the dialog through it.

GREEN (Step 4):

- same command -> `Test Files 1 passed (1)`, `Tests 11 passed (11)`, stderr empty.
- `… exec vitest run test/operators-page.test.tsx` -> `Tests 15 passed (15)`, stderr empty.
- both files with `--reporter=verbose` (stdout and stderr in different files): 26 tests passed, stderr 0 bytes.
- both files under the delayed-`setImmediate` stand (the two temporary files created exactly as in the notes, run with `--config vitest.delay.config.ts`, then deleted; `git status` clean of them, never staged): `Test Files 2 passed (2)`, `Tests 26 passed (26)`, stderr 0 bytes.

### Mutation evidence

Each mutation: `shasum -a 256` before, a pre-mutation copy for `cmp`, the brief's scratch edit (fragment replaced by the brief's block, offset recorded), the named command, then the inverse edit at the recorded offset, then sha256 equality and `cmp` against the pre-mutation copy.

1. `AddBadgeDialog.tsx`, salt read on every opening (`staleTime` removed). sha256 before and after: `d895909b5483284a953b0dd01af090433ee65ba5388d3a75df724e3c12e4070c` (equal; `cmp` identical). Command: `… exec vitest run test/operator-badges.test.tsx -t "once per session"` -> exit 1:
   `FAIL … reads the site's salt once per session` / `AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times`.
2. `AddBadgeDialog.tsx`, holder not named. sha256 before and after: `d895909b…4070c` (equal; `cmp` identical). Command: `… -t "names the operator"` -> exit 1:
   `FAIL … names the operator who already holds the badge, under the code` / `TestingLibraryElementError: Unable to find an element with the text: Этот бейдж уже у оператора «Вера Лебедева»`.
3. `OperatorsPage.tsx`, revoke not marked before the re-read. sha256 before and after: `f010231c47d6fd94e5b66e8fa8ac21b1c23e04e041cce047298b1fd63e2fa0d2` (equal; `cmp` identical). Command: `… -t "revokes a badge"` -> exit 1:
   `FAIL … revokes a badge after a confirmation, shows it revoked at once, then reads the list again` / `TestingLibraryElementError: Unable to find an element with the text: Отозван` (the failure dump shows the `<li>` still saying «Действует»: the re-read has not arrived).

### Final checks (Step 7, once, before the commit)

| Check                                                                         | Result                                                                                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm … --filter @markiro/standalone test`                                    | exit 0, `Test Files 36 passed (36)`, `Tests 731 passed (731)` (720 + 11); stderr only `$ vitest run`                          |
| `… typecheck`                                                                 | exit 0                                                                                                                        |
| `… lint`                                                                      | exit 0                                                                                                                        |
| `… build`                                                                     | exit 0 (only Vite's advisory about chunks over 500 kB, on `index` and the lazy `PairingDataMatrix`; the new code is a few kB) |
| `node_modules/.bin/prettier --check` on the brief's paths                     | all matched files use Prettier code style                                                                                     |
| `git diff --check` (and `git diff --cached --check`, `git show --check HEAD`) | exit 0                                                                                                                        |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                   | only `src/host/pairing-code.ts:66`; no literal `\u` at all in the changed files; all changed files are valid UTF-8            |
| every new `office.operators.badges.*` key (25)                                | referenced literally in the new code                                                                                          |
| `git log -1 --format=%B`                                                      | the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` appears exactly once, no other `Co-Authored-By` line    |

## Files changed (12, +810 / -11)

Created: `apps/standalone/src/office/operators/{badge-forms.ts,BadgesDialog.tsx,AddBadgeDialog.tsx,RevokeBadgeDialog.tsx}`, `apps/standalone/test/operator-badges.test.tsx`.
Modified: `apps/standalone/src/office/operators/{OperatorsPage.tsx,operator-records.ts}`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.
Nothing under `apps/station`, `apps/standalone/{proto,host,src-tauri}` or any Rust file; no dependency added; no `git stash`, no push, no `pnpm install`.

## Self-review

- Completeness: every brief step done in order, all three mutations shown failing with the named messages and reverted byte-identically, every doc fragment applied, every i18n key used.
- The test proves "a hash, not the code" without `verifyPhc`: the site's salt is fixed, so `toStrictEqual` on `createBadge`'s arguments against `badge-create.json` is stronger. That fixture is the byte-exact hash of the trimmed «MRK-000742» under `badge-salt.json`'s salt (`credentials.test.ts` reproduces it), and the scanned value had spaces around it, so it also proves the trim before hashing. The arguments of `createBadge` are the mutation's variables, so they hold only the hash and the label. (A PIN needs `verifyPhc` because its salt is random; a badge does not.)
- Discipline: nothing beyond the brief; the brief's code was not edited.

## Concerns (none blocking; the brief prescribes the code and text verbatim, so none was changed)

1. «Once per session» is slightly stronger than what is implemented. `staleTime: Infinity` keeps the salt fresh, but the default `gcTime` (5 minutes) drops an unobserved query, so the add dialog closed for more than 5 minutes reads the salt again. Checked with a scratch probe (QueryClient with the office defaults, `window` defined so `gcTime` is the webview's 5 minutes, fake timers): reads 1 -> 1 after 1 minute closed -> 2 after 5 minutes 1 second closed. Harmless (the salt is constant, one small GET), but the wording in `AGENTS.md` and spec §5.5 says «once per session». If exact wording matters: `gcTime: Infinity` for that query (`OfficeQueryOptions.gcTime`) plus a fake-timer test, or soften the wording.
2. `badge.label ?? t("office.operators.badges.unnamed")` is written in four places (`BadgesDialog`, `RevokeBadgeDialog`, `OperatorsPage.badgeLabel`, and inline in `OperatorsPage.badgeSummary`, which could call `badgeLabel`). Verbatim from the brief.
3. Cosmetic, not seen in a browser: `.badge-list__item` is a per-row grid `1fr auto auto`; revoked rows have no button, so their chip sits at the right edge while active rows' chips sit left of the button.
4. Not verified (outside automated checks): a real browser or Tauri webview, a real keyboard-wedge scanner, and Windows. Focus on the code field is checked in jsdom only; by React's child-first effect order `Modal`'s own initial focus (its first control) runs before the dialog's `setFocus("code")`, so the code field should win in a real webview, but that was not exercised.
5. No `graphify update .`: there is no local graph (`graphify-out/` does not exist in this worktree).
6. Scratch files (outputs, my three helper scripts, `blocks.py`, `apply.py`, `mutate.py`) live in `$TMPDIR/t5/`, a directory that already held earlier tasks' scratch files; same-named outputs of earlier runs may have been overwritten. No repository impact.

---

# Fix round 1

Status: DONE. Commit `fefeaf1e4` `fix(standalone): ревью задачи 5 плана 1d4 — повторный скан не дописывается к прежнему коду, общее место записи в кэш списка, withBadge без дублей`, one commit on top of `c524d0abb` (subject checked against the brief by a script; the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` appears exactly once). Not pushed. 11 files, +349 / -54. Nothing under `apps/station`, `proto`, `host`, `src-tauri`; no dependency.

Totals: Vitest 37 files / 741 tests (baseline 36 / 731: +1 file `test/operator-records.test.ts`, +10 tests = F1 5 + F2 2 + F5 3).

## What changed, per item

- F1 (Important) `AddBadgeDialog.tsx`: a refused code is emptied and the field takes the focus back (`scanAgain`: `setValue("code", "")` with no validation, so the message stays until the next input, then `setFocus("code")`). It runs for the three refusals of the code: (i) the client-side zod refusal, through `handleSubmit`'s second argument (`refused`, only when `invalid.code` is set); (ii) the named-holder `badge` conflict; (iii) the field outcome of `writeFailure` when its field is `code`, which covers the `badge` conflict with no known holder and `validation_failed` on `badgePhc`. A label refusal and an alert (transport or unknown failure) keep the code, so the same scan can be pressed again. Write pattern kept: `onAdded` after the `try/catch`, every `catch` ends with `return`, `onSubmit` never rejects.
- F2 (Important) `records.tsx`: `useChangeList<T>(key)` returns `(change: (list: T[]) => T[]) => void` with the old logic (`getQueryData`, then `setQueryData`, else `invalidateQueries`); `useStoreRecord` is `change((list) => withRecord(list, record))` on top of it; `OperatorsPage` uses it in place of the local `changeList` (and no longer needs `useQueryClient`).
- F3 (wording only, no code change): `AGENTS.md`, spec §5.5 and the doc comment of `AddBadgeDialog` now say what is true (not read again while cached with `staleTime: Infinity`, a dialog reopened soon reuses it, read again once the cache has dropped it, about five minutes without an add dialog, harmless because the salt never changes); the test is now titled `reads the site's salt once and reuses it when the dialog is opened again soon`, so the filter of the earlier mutation 1 is now `-t "reads the site's salt once"`.
- F4 `operator-records.ts`: one helper `badgeLabel(badge, t: TFunction)` (the precedent is `lineLabel`), used in `BadgesDialog`, `RevokeBadgeDialog` and in `OperatorsPage` (the row summary and the two notices); the rule now exists in one place.
- F5 `operator-records.ts`: `withBadge` puts the badge among the operator's badges with `withRecord` (replace in place, else append), so applying it twice gives one badge.

## Covering tests (all in the commit)

- `test/operator-badges.test.tsx` (11 -> 16): a new helper `wedge(text)` APPENDS to the field (`fireEvent.change(field, { target: { value: field.value + text } })`, then Enter), next to `scan`, which replaces the value and so could not show the defect; `scan` now shares `codeField` and `pressEnter` with it (same behaviour). New tests: `empties the masked code after the layout refusal, so the next scan is not glued to it` (scan `ЬКЛ-000742`, hint shown, field empty and focused, message still there, then `MRK-000742`: the body is `{ badgePhc: BADGE_PHC, label: null }`, the fixture hash of `MRK-000742` alone); `empties the masked code when the host %s, so the next scan is not glued to it` for three refusals (names the holder, does not know the holder, refuses its hash: `validation_failed` on `badgePhc`), each with the focus first moved to the «Добавить» button, as after a mouse press, so the focus assertion can only pass if `setFocus` ran; after the second scan `verifyPhc("MRK-000743", sentHash(session, 1))` is true, i.e. the body is the hash of the second code alone, not of `MRK-000742MRK-000743`; `keeps the masked code when the refusal is not about it, so the same scan can go again` (a 101-character label refused by the form, then a transport failure, the code is still there, and the third press sends the same fixture hash twice).
- `test/records.test.tsx` (+2): `useChangeList > applies the change to the cached list and stores what it returns`, `useChangeList > reads the list again, and stores nothing, when no list is loaded`. The `useStoreRecord` describe now takes its client and wrapper from a shared `cachedClient` helper; its assertions are unchanged.
- `test/operator-records.test.ts` (new, 3): appends a new badge after the operator's own and leaves other operators as they are; puts an existing badge in place of itself; applied twice gives one badge (all three also check that the input list is not changed).

RED (the tests written first, run against the unchanged source): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx test/records.test.tsx test/operator-records.test.ts --reporter=verbose` -> exit 1, `Test Files 3 failed (3)`, `Tests 8 failed | 23 passed (31)`:

- layout: `AssertionError: expected 'ЬКЛ-000742' to be '' // Object.is equality`; the three host refusals: `AssertionError: expected 'MRK-000742' to be '' // Object.is equality`;
- `useChangeList` x2: `TypeError: useChangeList is not a function`;
- `withBadge` in place / twice: `AssertionError: expected [ { …(4) }, { …(4) }, { …(4) }, …(1) ] to strictly equal [ { …(4) }, { …(4) }, { …(4) } ]` and `expected [ { …(8) } ] to strictly equal [ { …(8) } ]` (a duplicate).
  The two tests that passed already are the ones that pin behaviour the fix must keep: the append case and `keeps the masked code when the refusal is not about it`.

GREEN: the same command with `test/operators-page.test.tsx` added (the page changed): `Test Files 4 passed (4)`, `Tests 46 passed (46)`, exit 0. Note: my first green run printed `An update to Input inside a test was not wrapped in act(...)` on stderr in the three host-refusal tests: the test called `button.focus()` directly, outside `act`, and the blur re-rendered `Input`. The test now does `act(() => …focus())`; stderr is empty.

- `--reporter=verbose` on those 4 files, stdout and stderr in different files: 46 passed, stderr 0 bytes.
- the 3 ms delayed-`setImmediate` stand (the two temporary files created exactly as in the notes, `--config vitest.delay.config.ts` on the same 4 files, then deleted; never staged): `Tests 46 passed (46)`, stderr 0 bytes.
- `pnpm … --filter @markiro/standalone test`: `Test Files 37 passed (37)`, `Tests 741 passed (741)`, stderr only `$ vitest run`; `typecheck` exit 0; `lint` exit 0; `build` exit 0 (only the earlier Vite chunk-size advisory); `node_modules/.bin/prettier --check` on the changed files clean; `git diff --check` and `git show --check HEAD` exit 0; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` prints only `src/host/pairing-code.ts:66`.

## Mutations (scratch edit at a recorded offset, the inverse edit at that offset, then sha256 equality and `cmp` with a pre-mutation copy)

| Mutation                                                                            | File, sha256 before = after                                                                               | Result                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 required: remove the clearing (`setValue("code", "")`)                           | `AddBadgeDialog.tsx` `c5e92bbc491afb7cbee9d3019c7b9af51a9ab1771b793d93a6bc2060a4f59870`, `cmp` identical  | exit 1, `Tests 4 failed \| 12 passed (16)`: the layout test (`expected 'ЬКЛ-000742' to be ''`) and the three host-refusal tests (`expected 'MRK-000742' to be ''`); the keep test passes                                                        |
| F1 extra: drop `setFocus("code")` from `scanAgain`                                  | same file and hash, `cmp` identical                                                                       | exit 1, `3 failed`: the three host-refusal tests, `expected <button type="submit" …(3)></button> to be <input …(12)></input>`; the layout test passes because react-hook-form itself focuses an invalid field                                   |
| F1 extra: clear on every client refusal (`refused` without the `invalid.code` test) | same file and hash, `cmp` identical                                                                       | exit 1, `1 failed`: the keep test, `expected '' to be 'MRK-000742'`                                                                                                                                                                             |
| F1 extra: drop `if (outcome.field === "code") scanAgain();`                         | same file and hash, `cmp` identical                                                                       | exit 1, `2 failed`: `does not know who holds it` and `refuses its hash` (`expected 'MRK-000742' to be ''`); the named-holder case passes                                                                                                        |
| F2 required: `useChangeList` without the `invalidateQueries` branch                 | `records.tsx` `1a8c0739d1bbdab3dc89d3b7d65b7022289e0e1da5bb3b63e69b9e0b8f3a2073`, `cmp` identical         | exit 1, `2 failed \| 10 passed (12)`: `useChangeList > reads the list again, and stores nothing, when no list is loaded` and the older `useStoreRecord` no-list test, both `expected "invalidateQueries" to be called 1 times, but got 0 times` |
| F5 required: `withBadge` back to an unconditional append                            | `operator-records.ts` `e0405ae2242e5ecec6022a84195f1d20253b69f6e2e18b7c7fa4924a8cbb1154`, `cmp` identical | exit 1, `2 failed \| 1 passed (3)`: `puts a badge the operator already has in place of it` and `applied twice gives one badge`                                                                                                                  |

## Notes and concerns

1. F1 asked for two new tests; there are five cases (1 layout + 3 host refusals + 1 keep), because the brief names three refusals of the code and the fix has a branch for each: without the parametrized cases the `field` branch (unknown holder, `validation_failed` on `badgePhc`) had no test (the extra mutation above shows it), and without the keep test the `invalid.code` guard had none. Say if you want them cut back to two.
2. Beyond F3's list, the `AGENTS.md` badges bullet also states the new F1 rule and that `useChangeList` is idempotent by id (one sentence each). The spec was changed for F3 only.
3. Left as history, by "nothing else": the plan file `docs/superpowers/plans/2026-09-29-standalone-1d4-office-operators-badges.md` still says «once per session» for the salt (lines 112, 4275, 4478, 4843, 5637, 5680), and `gcTime` is still the default, as asked (wording only).
4. react-hook-form 7.85's `setFocus` runs in a `setTimeout`, so the tests wait for the focus with `waitFor`. In a real webview the focus after a refusal, and a real wedge scanner, were not exercised; only jsdom was.

---

# Fix round 2

Status: DONE. Commit `d2ecac5b1` `fix(standalone): ревью задачи 5 плана 1d4 (2) — после сбоя запроса код тоже очищается, поле кода закрыто до соли`, one commit on top of `fefeaf1e4` (subject checked against the brief by a script; the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` appears exactly once). Not pushed. 6 files, +127 / -50. Nothing under `apps/station`, `proto`, `host`, `src-tauri`; no dependency.

Totals: Vitest 37 files / 745 tests (baseline 37 / 741: +4 tests, no new file).

## What changed, per item

- G1 (Important) `AddBadgeDialog.tsx`: the alert branch calls `scanAgain()` too, so any failed attempt that involved the code (the form refuses it, the `badge` conflict, `validation_failed` on `badgePhc`, or a failed request shown as an alert) empties the masked field, without validation, and refocuses it; a retry is a new scan. Only a refusal of the label alone keeps the code (the form's, or a host `validation_failed` on `label`). Write pattern kept (`onAdded` after the `try/catch`, every `catch` returns, `onSubmit` never rejects). The comments at `scanAgain` and `refused` and the `AGENTS.md` bullet state the new rule.
- G2 `AddBadgeDialog.tsx`: the code input is `readOnly` while the salt is missing (loading or failed); it stays focusable. One local `saltMissing` now feeds both `submitDisabled` and `readOnly`. `AGENTS.md` says so in one clause.
- G3 the doc comment of the dialog says «it is not read again while it is cached (`staleTime: Infinity`)».
- G4 `AGENTS.md` credits `withBadge` (through `withRecord`) with the replacement by id, and `useChangeList` only with writing the changed list into the cache.
- G5 `records.tsx`: `useChangeList<T>` takes `change: (list: readonly T[]) => T[]`; it compiles with every caller (`withRecord`, `withBadge`, `withBadgeRevoked`, the page). The two tests of `useChangeList` were retyped for the read-only list. This is type-level only; `typecheck` is its check.
- G6 spec §5.5: one clause beside «назван по имени этого оператора»: a code that was refused or could not be sent is scanned again, the field is empty and in focus.
- G7 test: `validation_failed` on `label` from the host keeps the code and puts the message under the label. It is a test of its own, not a fourth row of the emptying table, because its assertion is the opposite one (the code is kept).

## Covering tests (all in the commit; `test/operator-badges.test.tsx` 16 -> 20)

- `empties the masked code when the host cannot be reached, so the next scan is not glued to it`: a new row of the table, now named `CODE_FAILURES` (the host's refusals plus a request that fails). Same body as the other rows: the focus is first moved to the «Добавить» button, the first scan `MRK-000742` fails with a transport error, the alert shows, the field is empty and focused, and the second APPENDING scan `MRK-000743` is hashed alone (`verifyPhc("MRK-000743", sentHash(session, 1))`).
- `keeps the masked code when the form refuses only the label, and sends it once the label is corrected`: the label half of the earlier keep test (its transport half is gone, replaced by the row above); the corrected label is sent with the fixture hash of the code scanned first.
- `keeps the masked code when the host refuses only the label, and shows it under the label` (G7): the message is the label's `aria-describedby`, the code is still `MRK-000742`, and the same hash goes out after the label is corrected.
- `keeps the code field read-only until the site's salt is read`: the salt read is held pending, the field is `readOnly`, then the read is answered and it is not (it waits for `getBadgeSalt` to have been called before answering, so it does not race the query's effect).
- `keeps the code field read-only when the site's salt could not be read`: the read fails (`unreachable`), the `LoadError` shows, the field is `readOnly`.

RED (tests first, run against the source of `fefeaf1e4`): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx --reporter=verbose` -> exit 1, `Tests 3 failed | 17 passed (20)`: `empties the masked code when the host cannot be reached…` (`AssertionError: expected 'MRK-000742' to be '' // Object.is equality`) and both read-only tests (`AssertionError: expected false to be true // Object.is equality`). The two «keeps» tests already passed: they pin what does not change.

GREEN: the same command with `test/records.test.tsx test/operator-records.test.ts test/operators-page.test.tsx` added: `Test Files 4 passed (4)`, `Tests 50 passed (50)`, exit 0, stderr 0 bytes. The same 4 files under the 3 ms delayed-`setImmediate` stand (the two temporary files created exactly as in the notes, run with `--config vitest.delay.config.ts`, then deleted; never staged): `Tests 50 passed (50)`, stderr 0 bytes. `pnpm … --filter @markiro/standalone test`: `Test Files 37 passed (37)`, `Tests 745 passed (745)`, stderr only `$ vitest run`; `typecheck` exit 0; `lint` exit 0; `build` exit 0 (only the earlier Vite chunk-size advisory); `node_modules/.bin/prettier --check` on the changed files clean; `git diff --check` and `git show --check HEAD` exit 0; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` prints only `src/host/pairing-code.ts:66`.

## Mutations (scratch edit at a recorded offset, the inverse edit at that offset, then sha256 equality and `cmp` with a pre-mutation copy)

All four on `apps/standalone/src/office/operators/AddBadgeDialog.tsx`, sha256 before = after = `9364706a35787a404d7901c4df1aab74529e51f2d603445ddb67e8a61cd0f052`, `cmp` identical each time:

| Mutation                                                                                                              | Result                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| G1 required: keep the code on alerts again (`scanAgain()` removed from the alert branch)                              | exit 1, `Tests 1 failed \| 19 passed (20)`: `empties the masked code when the host cannot be reached…`, `expected 'MRK-000742' to be ''` |
| G2: drop `readOnly={saltMissing}`                                                                                     | exit 1, `2 failed \| 18 passed`: both read-only tests, `expected false to be true`                                                       |
| G7: drop the `=== "code"` guard (`scanAgain()` on every host field refusal)                                           | exit 1, `1 failed \| 19 passed`: `keeps the masked code when the host refuses only the label…`, `expected '' to be 'MRK-000742'`         |
| round 1 guard, rerun on the rewritten test: clear on every client refusal (`refused` without the `invalid.code` test) | exit 1, `1 failed \| 19 passed`: `keeps the masked code when the form refuses only the label…`, `expected '' to be 'MRK-000742'`         |

## Notes and concerns

1. Residual, not changed (outside the brief): the field is editable while a request is in flight (only `FormDialog` drops the Enter). A second scan typed then is glued to the first code, and it is dropped with it whenever the request ends in an alert, a `badge` conflict or a refusal of the hash. It survives only if the host refuses the LABEL alone (`validation_failed` on `label`), which needs a label the form accepted and the host does not; closing that too would mean making the field read-only while the request is pending (`add.isPending`, plus the hashing window). Not tested for the same reason.
2. Beyond the listed docs, `AGENTS.md` also says that the code field is read-only until the salt is read (G2, one clause).
3. Verified in jsdom only: `readOnly` is asserted as the attribute, as the brief says, since jsdom cannot show the typing. A real webview and a real wedge scanner were not exercised.
