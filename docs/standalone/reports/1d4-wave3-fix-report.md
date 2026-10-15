# Plan 1d4 — fix round 3 (delta re-review findings W-I1, W-M1…W-M4)

**Status: DONE_WITH_CONCERNS** (the concerns are observations, nothing blocks). One commit on top of `4c57fd483`:
`ca81752eceb5d216bb07c6afdf7e6f36368dcec7`, subject byte-identical to the brief (checked by script), exactly one
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, last line of the message. 5 files, +173 −105:
`apps/standalone/AGENTS.md`, `apps/standalone/src/host/pairing-code.ts`,
`apps/standalone/src/office/operators/AddBadgeDialog.tsx`, `apps/standalone/test/operator-badges.test.tsx`,
`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`. Explicit `git add` of those five paths; tree
clean afterwards. Nothing under `apps/station`, `proto`, `packages/`, Rust, migrations, manifests, lockfile,
`.superpowers`, plan documents. No stash, no push, no new branch, no install.

## Per item: what and where

### W-I1 — Caps Lock: a code with `, . ; ' [ ] `` (or the shifted ones) reached the label

- `src/host/pairing-code.ts:88` — `withCyrillicCaseSwapped` is exported (doc comment kept, body untouched).
- `AddBadgeDialog.tsx:39-41` — new local helper `labelReadings(label)`: the label as typed,
  `fromRussianLayout(label)`, `fromRussianLayout(withCyrillicCaseSwapped(label))`, with a doc comment (the two
  mapped readings are the ones `parsePairingPayload` uses; why Caps Lock needs the second one).
- `AddBadgeDialog.tsx:129-130` — the guard, same position (after validation and the salt check, before `hashBadge`),
  same `setError("label", …, { shouldFocus: true })`, same message:
  `const scanned = values.code.toLowerCase();` and
  `labelReadings(values.label).some((reading) => reading.toLowerCase().includes(scanned))`.
  The comment above it now says: a scan is typed by key position, the label may hold the code as the Russian layout
  renders it, Caps Lock on or off (the same state for the label scan and the code scan), and Caps Lock also changes
  the case of the Latin letters, so the comparison ignores case.
- `test/operator-badges.test.tsx:470-474` — the existing `it.each` («refuses a label that holds %s as the Russian
  layout types it…») now takes the label the administrator typed as a parameter; two rows added, verbatim as in the
  brief: `["a separator code with Caps Lock on", "ПРОПУСК 7", "123,45678", "123Б45678"]`,
  `["a mixed code with Caps Lock on", "ПРОПУСК 7", "mrk,742", "ьклБ742"]`. Every step of the scenario stays (first
  scan into the label refused for the empty code; the Cyrillic scan into the code field gets the layout hint and the
  field is emptied and focused; the Latin code is refused by the guard: no `createBadge`, no `deriveBits`, message
  under the label with `aria-describedby`, focus on the label). A comment above the `it.each` explains the two rows.
- `AGENTS.md:786-…` — «the mapping the pairing scans use» became the two readings the pairing scans use (the layout
  mapping and the case-swapped one for Caps Lock) with the mechanism (seven ЙЦУКЕН letter keys, «,» → «Б» → `<`,
  «mrk,742» → «ьклБ742»); the «case or layout changed between the two scans» sentence became: the guard covers the
  Russian layout and Caps Lock as long as the state is the same for the label scan and the code scan and compares
  without case; not recognised: a layout or Caps Lock state that changed between the two scans, any other layout, a
  label edited after the scan. The two accepted false positives are kept; the swapped reading and the
  case-insensitive comparison are said to widen them slightly.

### W-M1 — first clause pinned

- `test/operator-badges.test.tsx:410-…` — the guard test is an `it.each` over «MRK-000742» («a letter code») and
  «123,45678» («a code with a separator»): label «Пропуск №7», the code appended into the LABEL verbatim
  (`wedgeInto(labelField(), code)`), then the same code into the code field.

### W-M2 — empty the code on a `labelHasCode` refusal, focus stays on the label

- `AddBadgeDialog.tsx:132` — `setValue("code", "")` after the `setError(…, { shouldFocus: true })` (not
  `scanAgain()`, which would move the focus to the code field).
- Comments: the comment above `refused` (`:99-101`, «a label that holds the code is the exception, see `submit`»)
  and the guard comment («the code stays, since only the label is wrong» removed: the code is emptied like after
  every refusal that involved it, why not `scanAgain`, the code is scanned again once the label is corrected).
- Tests: in the guard `it.each` the code field is empty after the refusal, focus on the label; the «correct the
  label and submit» half now scans the code again (`wedge(code)`) and checks one request with the label
  «Пропуск №8» and the hash via `verifyPhc(code, sentHash(session, 0))` (the check runs after the
  `deriveBits` count, since `verifyPhc` itself calls `deriveBits`). In the Russian-layout `it.each`:
  `expect(codeField().value).toBe("")` in place of «the code stays as it was scanned». Test titles say «empties the
  code» (they said «keeps the code»).
- Documents: `AGENTS.md:762` (table row, Code field → `emptied`), `:767-770` (prose: a label-only refusal by the form
  or the host keeps the code), `:771-…` (the guard is the exception: why, `setValue` and `setError` with
  `shouldFocus`, not `scanAgain`; the code is scanned again after the correction); spec §5.5
  (`…standalone-01-foundation-design.md:588-590`): «отказ только по подписи (форма или хост) код не стирает; подпись с
  кодом внутри код стирает, но фокус остаётся на подписи, и после правки код сканируют заново» with the pointer to
  `apps/standalone/AGENTS.md` kept. Searched both files for «keeps the code», «kept», «keep», «не стирает»,
  «labelHasCode»: no other sentence says the guard keeps the code (the top of the add-badge bullet does not repeat
  it).

### W-M3 — spec row 9

- Spec line 50: after «…никогда не видит PIN и код бейджа» the clause «(код может попасть на хост только в подписи
  бейджа, по ошибке; диалог добавления это перехватывает — см. `apps/standalone/AGENTS.md`)». Prettier re-padded the
  table (whitespace only): `git diff -w` on the spec shows exactly the separator row (dashes), row 9, and the §5.5
  lines; a normalised-cell comparison confirms that in row 9 only that clause was inserted.

### W-M4 — AGENTS wording

- `AGENTS.md:737-739`: «on an opening that reads the salt (the first, or one after the cache dropped it, see above)»
  in place of «on the first opening of the dialog» (lines rewrapped).

## Mutants (target `AddBadgeDialog.tsx`)

Pre-mutation copy `$TMPDIR/w3fix/AddBadgeDialog.tsx.pre`. sha256 before every run, after every revert, and of the
committed file (`git show HEAD:…`) is the same:
`f447dcdcd3a43fda17bf0c63d97fcef3a6d57cff1db0edb1b08c8431ecf8f702`. After every revert `cmp` exit 0 (the revert is
the inverse edit, applied to the mutated text by the driver, and then compared). Each run is the whole
`test/operator-badges.test.tsx` (28 tests), exit 1 in every row.

| Mutant                                                                                                                            | Failing tests                                                                                                                                                                                        | Failure output                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A: `labelReadings` returns `[label, fromRussianLayout(label)]` (swapped reading dropped)                                          | 2 of 28: the two Caps Lock rows (`separator code with Caps Lock on`, `mixed code with Caps Lock on`)                                                                                                 | `Unable to find an element with the text: В подписи есть код бейджа — уберите его: подпись видят все станции`          |
| B: `scanned = values.code` and `reading.includes(scanned)` (case-insensitive comparison dropped)                                  | 1 of 28: `a mixed code with Caps Lock on` only                                                                                                                                                       | same message (the separator Caps Lock row survives: digits and `,` have no case)                                       |
| C: `[fromRussianLayout(label), fromRussianLayout(withCyrillicCaseSwapped(label))]` (as-typed reading dropped, W-M1)               | 1 of 28: guard `it.each` row `a code with a separator as scanned` (the «MRK-000742» row survives: the mapped reading keeps Latin letters)                                                            | same message                                                                                                           |
| D: `[label, fromRussianLayout(withCyrillicCaseSwapped(label))]` (mapped reading dropped, existing mutant)                         | 1 of 28: `a code with a separator` as the Russian layout types it, Caps Lock off (the letter row survives, since the swapped reading with the case-insensitive comparison also reads «ЬКЛ» as «mrk») | same message                                                                                                           |
| E: `[label]` and `scanned = fromRussianLayout(values.code).toLowerCase()` (the code mapped instead of the label, existing mutant) | 5 of 28: every Russian-layout row (4) and the verbatim separator row; the verbatim letter-code row survives (a Latin letter code maps to itself)                                                     | same message                                                                                                           |
| F: `setValue("code", "")` dropped (W-M2, the code is kept)                                                                        | 6 of 28: both guard rows and all four Russian-layout rows                                                                                                                                            | `expected 'MRK-000742' to be '' // Object.is equality`, `expected '123,45678' to be ''`, `expected 'mrk,742' to be ''` |
| G (extra): `scanAgain()` in place of `setValue("code", "")` (the focus moves to the code field)                                   | 6 of 28: same six                                                                                                                                                                                    | `expected <input …(11)></input> to be <input …(11)></input>` (the focus assertion)                                     |

Extra check of the new `verifyPhc` half: a scratch copy of the test file (deleted after) with the emptied-code
assertion removed from the guard `it.each` only, run against mutant F: both guard rows then fail at
`await expect(verifyPhc(code, sentHash(session, 0))).resolves.toBe(true)` with `expected false to be true` (the
re-scan is glued to the kept code and hashed as «MRK-000742MRK-000742»), so the re-scan half catches a kept code
independently of the emptied-code assertion.

Red first: the updated tests run against the unchanged `4c57fd483` source before the fix: 6 failed | 22 passed. The
four rows that existed before (two guard rows, two Russian-layout rows) fail on `expected 'MRK-000742' to be ''`
(and the separator twins), and the two new Caps Lock rows fail on `Unable to find … В подписи есть код бейджа …`.

## Checks

- `test/operator-badges.test.tsx`, `--reporter=verbose` (stdout and stderr to different files under `$TMPDIR/w3fix`):
  28 passed (25 before: the guard test is two rows, the layout test four), stderr empty (0 bytes; `pnpm exec` prints
  no `$ vitest run` line).
- The same file under the delayed-`setImmediate` 3 ms stand (recipe from the plan, two temp files in the package,
  deleted right after): 28 passed, stderr empty. The stand was shown to bite: a scratch test asserting that
  `setImmediate` takes at least 2.5 ms passes with the stand config and fails without it; the three temporary files
  are deleted (`git status` clean).
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`: exit 0. `lint`: exit 0 (stderr:
  only pnpm's `$ …` line for both).
- `node_modules/.bin/prettier --check` on the five changed files: clean (the spec's table was re-padded by
  `prettier --write`, whitespace only, see W-M3). `git diff --check` (worktree before the commit, and
  `HEAD~1..HEAD` after): clean.
- Full `… --filter @markiro/standalone test`: **37 files / 813 tests passed** (baseline 810, +3: 25 → 28 in the badges
  file), no `Errors`/unhandled lines, stderr only `$ vitest run`.
- `… --filter @markiro/standalone build`: exit 0 (the pre-existing chunk-size warning for the DataMatrix chunk).

## Not run / not verified

- No Rust file touched, so no cargo run.
- Nothing beyond jsdom: no WebView2, no real wedge scanner under the Russian layout with Caps Lock, no Windows or
  NVDA. The typed text is simulated from the Caps Lock behaviour `pairing-code.ts` documents.
- `graphify update .` skipped: the worktree has no `graphify-out/`.

## Deviations and observations

- One `cd` slipped into a read-only inspection command (a `grep` loop over files in `$TMPDIR`); it had no effect on
  the tree, and the tool resets the working directory between calls. No other `cd`.
- The `AGENTS.md` paragraph after the failure table is now three paragraphs (message lifetimes and what is kept; the
  guard and why the code is emptied; the readings and the limits), and the sentence about «Отозвать» starts its own
  paragraph. Before, it was one paragraph that ended with «Отозвать». Wording of the untouched sentences is kept.
- The first-column text of the `labelHasCode` table row is unchanged («… or its Russian-layout form …»): it still
  describes the guard, Caps Lock is in the prose, and a longer text would re-pad the whole table.
- The `it.each` titles changed («and keeps the code» → «and empties the code»; the guard rows read «… holds %s as
  scanned …»).
- Observation, not changed (outside the brief): the two rows that still keep the code (the form refuses the label,
  the host refuses the label) have the same glue path W-M2 described if the administrator deliberately clicks into
  the masked code field and scans again before correcting the label: the glued code passes every rule, and the guard
  does not see it because the label does not hold that string. The brief scoped W-M2 to the guard refusal, and the
  two «keeps the masked code when …» tests still pin the earlier decision.
