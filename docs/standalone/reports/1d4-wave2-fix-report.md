# Plan 1d4 — fix round for the wave re-review: report

Repository `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`, branch
`claude/autonomous-desktop-station-9e6f13`, base `34babfeed`.

**Status: DONE.**

| Commit | SHA                                        | Subject (byte-identical to the brief, checked by script)                                                                                                       |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1/2    | `4d428de50c7d93057ae92c0d7e8e78cdb4e3bfea` | `fix(standalone): ревью волны 1d4 (1/2) — код бейджа, набранный в раскладке ЙЦУКЕН, не попадает в подпись; фокус на подписи при отказе формы закреплён тестом` |
| 2/2    | `4c57fd48351f55a14050622b20ffc6550af3538f` | `fix(standalone): ревью волны 1d4 (2/2) — решение 9 спеки о проверке бейджа, остаточные окна сканера, формулировки о VACUUM и о сбое отправки`                 |

Each message is the subject, a blank line and exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line
(read back with `git cat-file commit`; `git log` is abbreviated by the `rtk` hook). Files: commit 1 — `AddBadgeDialog.tsx`,
`test/operator-badges.test.tsx`, `AGENTS.md` (3); commit 2 — `AGENTS.md`, the spec, `src-tauri/src/local_db.rs`,
`host/tests/badges.rs` (4). Nothing under `apps/station`, `proto`, `packages/`, migrations, manifests, the lockfile or
`.superpowers/` (this report aside; the directory is git-ignored). No `git stash`, no push, no new branch, no
`pnpm install/add`; pnpm always as `pnpm --config.verifyDepsBeforeRun=false …`.

**Totals.** Vitest 37 files / 810 tests (baseline 808, +2 = the two rows of the new `it.each`), stderr only pnpm's
`$ vitest run` line, no `Errors` line; the changed file alone 25/25 verbose (stderr 0 bytes) and 25/25 under the 3 ms
`setImmediate` stand; `cargo fmt --check` clean; `cargo check --workspace --all-targets --offline` exit 0;
`cargo test -p markiro-host --test badges --offline` 8/8 (the full workspace `cargo test`, 36 suites / 348 tests, was not
run, per the brief: the controller runs it).

## Items

### I-1 — the label guard misses the code as the Russian layout types it (commit 1)

- `apps/standalone/src/office/operators/AddBadgeDialog.tsx`: `import { fromRussianLayout } from
"../../host/pairing-code.js"` (between the `client` and `protocol` imports, the file's alphabetical order and the
  `../../host/…` style of `PairingCodeDialog.tsx`); the guard in `submit` is now
  `values.label.includes(values.code) || fromRussianLayout(values.label).includes(values.code)`, written as a
  three-line `if (…)` (a single line is 102 columns). Position unchanged: after the form's validation and the salt check,
  before `hashBadge`; same `setError("label", …, { shouldFocus: true })`, same message key, the code kept. The guard's
  comment now says why the second clause exists (a wedge scanner types by key position; a label typed in Russian needs
  that layout, so the scan lands in it as the layout renders it — «MRK-000742» as «ЬКЛ-000742»; the code field refuses a
  Cyrillic scan and the layout is switched as the hint says, so the code that reaches it is Latin).
- `apps/standalone/test/operator-badges.test.tsx`: new `it.each` right after «refuses a label that holds the scanned code
  before hashing or sending, and keeps the code», rows `["a letter code", "MRK-000742", "ЬКЛ-000742"]` and
  `["a code with a separator", "123,45678", "123б45678"]`, with the same helpers (`type`, `wedgeInto`, `wedge`,
  `labelField`, `codeField`, `openAdd`) and the `crypto.subtle.deriveBits` spy. Flow: label «Пропуск №7» typed; the
  Cyrillic form appended into the LABEL and submitted (empty code refused, focus moves to the code field, the label
  holds «Пропуск №7» + the Cyrillic form, no request); the Cyrillic form wedged into the CODE field (layout hint, the
  field emptied and focused); the LATIN code wedged into the code field → refused by the guard: message under the label
  (`aria-describedby` points at it), `document.activeElement` is the label input, the code still in the code field,
  `deriveBits` not called, `createBadge` not called. Two lines of the new test were re-wrapped by `prettier --write`
  (the `findByText(...)` calls, over 100 columns at the `it.each` indentation); nothing else in the file was reformatted.
- `apps/standalone/AGENTS.md`: the failure-table row is now «The label has the code or its Russian-layout form
  (`labelHasCode`)» (66 characters, so the column width of 67 is kept and prettier re-pads nothing); the prose after the
  table says the label is tested as typed AND as the Russian layout types it (with the two examples and
  `fromRussianLayout` in `src/host/pairing-code.ts`), that both tests are plain substring tests (the two documented
  false positives are kept, the second test widens them only by the mapped text), and that the guard catches the
  accidental forms only — a scan whose case or layout changed between the two scans (another layout, Caps Lock toggled in
  between) is not recognised. «the one way a code could leave the webview in clear text» became «… by accident». The
  sentence at «Operators and badges» now reads «so the host never sees a PIN or a badge code (the one field a code could
  reach is a badge's label, and the add dialog guards it as described under «Бейджи» in "Office pages"). It stores PHC
  strings …» (the colon after «badge code» became a full stop after the parenthesis).

### M-2 — the row «the form refuses the label → focus on the label» is pinned (commit 1)

`test/operator-badges.test.tsx`, «keeps the masked code when the form refuses only the label, and sends it once the label
is corrected»: after the `Подпись — до 100 символов` message, `await waitFor(() =>
expect(document.activeElement).toBe(labelField()))` with a two-line comment (react-hook-form focuses in a timer).

### I-2 — the spec's decision table, row 9 (commit 2)

`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, row 9 «PIN и бейджи», the clause «Станция
проверяет их кодом станции без изменений» is now «Станция проверяет PIN кодом станции, как прежде, а бейдж — по правилам
входа плана 1f из `apps/standalone/AGENTS.md` (обрезанный скан хешируется один раз солью площадки, строки сравниваются
целиком, неоднозначный бейдж отвергается, скан кириллицей отвергается с подсказкой о раскладке), см. §5.6». The
rationale cell is untouched. **The new cell is longer than the table's widest one (row 3), so prettier re-padded the whole
decision table** (19 lines): whitespace only, plus the separator row's dashes and the header row's padding;
`git diff -w` on the spec shows exactly 3 changed lines (separator, row 9, the VACUUM line below).

### M-1 — the two scan-straddle residuals (commit 2)

`AGENTS.md`, in the «Бейджи» paragraph right after «…after a failure the field is editable again.»: a scan that straddles
the moment the field becomes editable loses its head (a read-only field does not take it) and sends its tail, which
`badgeCodeRule` accepts; the moment is the salt's arrival on the first opening of the dialog and the end of a failed
submit (`scanAgain` empties and focuses the field inside the callback, while `readOnly` drops only when React renders
`isSubmitting: false`); nothing detects it, the badge matches no station, the remedy is to revoke it and add it again
(plan 1f's sign-in test is the first place it shows); accepted, since a scan of about 0.1 s has to straddle a boundary.

### M-3 — VACUUM wording (commit 2)

`apps/standalone/src-tauri/src/local_db.rs`, doc comment of `clear_copies`: «`VACUUM` is not needed for the rows deleted
here: it would only shrink the file. It would do more for bytes a writer freed before it ran with `secure_delete`, which
nothing here scrubs (see "Local database" in `apps/standalone/AGENTS.md`).» — cited by heading. Spec (line 455): the quoted
phrase is gone, now «так что для них `VACUUM` сделал бы больше, чем сжатие файла)», the rest kept.

### M-4 — alert lifetime (commit 2)

`AGENTS.md`: «an alert until the next send» → «an alert until the next submit the form accepts (`setFailure(null)` runs
before the label guard, so a `labelHasCode` refusal clears it although nothing is sent, while a refusal by the form itself
leaves it)».

### M-5 — comment in `host/tests/badges.rs` (commit 2)

«It is the one refusal that takes a revision before it fails» → «It is the one badge refusal that takes a revision before
it fails» (re-wrapped over two comment lines, ≤ 78 columns).

## Mutants (commit 1's new tests)

Runner: a scratch Python script under `$TMPDIR/wave2` (`mutant.py`): copies the file to `$TMPDIR/wave2/<name>.orig.<tag>`,
applies one exact single-match replacement, runs
`pnpm … --filter @markiro/standalone exec vitest run test/operator-badges.test.tsx --reporter=verbose`, restores in a
`finally` from the copy, and prints sha256 before / mutated / after and a byte comparison (`filecmp.cmp(shallow=False)`,
i.e. `cmp`). Target of every mutant: `apps/standalone/src/office/operators/AddBadgeDialog.tsx`, **sha256 before = after =
`f77882cfc3e6e29b70ccbfcbea79f53fe1fa87307f6f15037345781d54ad6297`** (equal to `git show HEAD:<file> | shasum -a 256`),
`cmp` identical after every run (the tree held the uncommitted commit-1 edits while they ran; `git status --short` is empty now, after both commits). The full outputs are in
`$TMPDIR/wave2/c1-mut*.out|err` (`/tmp/claude-501/wave2/`).

| Mutant                                                                                                                                                                   | sha256 of the mutated file                                         | Result (exit 1)                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** (brief): second clause dropped — `if (values.label.includes(values.code)) {`                                                                                       | `5b6ac103775bcf8eadfe7be2dc1196feb516681d06d6e33be4abbbc2236fe36c` | 2 failed \| 23 passed — both new rows: `Unable to find an element with the text: В подписи есть код бейджа — уберите его: подпись видят все станции` (the guard does not fire, so the submit goes on to the hashing and the request; the message under the label never appears) |
| **B** (brief): clause kept, `fromRussianLayout` applied to the CODE — `values.label.includes(fromRussianLayout(values.code))`                                            | `6bc7ce2b13c17631b23a123036847722bc35a3c57c5b04656766556e333d4fc6` | 2 failed \| 23 passed — the same two rows, the same message (the letter code has no mapped characters, and «123,45678» becomes «123?45678», so neither is found in the label)                                                                                                   |
| **D** (M-2): `shouldFocusError: false` in `useForm({…})`                                                                                                                 | `cfe51cfa08d64e86034e316bab57166731686faac0a26b20016a923299805184` | 1 failed \| 24 passed — «keeps the masked code when the form refuses only the label, and sends it once the label is corrected»: `expected <input …(11)></input> to be <input …(11)></input> // Object.is equality` (the focus stayed in the code field)                         |
| D against the PRE-CHANGE test file (`git show 34babfeed:apps/standalone/test/operator-badges.test.tsx`, 23 tests, run as a scratch copy inside `test/`, deleted at once) | same as D                                                          | **exit 0, 23 passed — the mutant survives the old file**, so the new assertion alone closes the gap the review named                                                                                                                                                            |
| C (extra): both sides mapped — `fromRussianLayout(values.label).includes(fromRussianLayout(values.code))`                                                                | `a0a961831854cd9004889c9524928ecef561a2942ac2ddf3d4cecdc19432b485` | 1 failed \| 24 passed — only the separator row (same `Unable to find … В подписи есть код бейджа …`): the letter code has no mapped characters, so the letter row survives this mutant and the separator row is what kills it                                                   |
| E (extra): the hashing moved before the guard (`await hashBadge(…)` inserted)                                                                                            | `585e27aa5136544e5e2b09b7ed629d70a469c6b7af085d1623b3f74f6002ef89` | 3 failed \| 22 passed (the existing guard test and both new rows): `expected "deriveBits" to not be called at all, but actually been called 1 times`                                                                                                                            |
| F (extra): the guard also empties the code (`setValue("code", "")`)                                                                                                      | `5b18ddbd09970d2dc54f298948ea5d120422d33481c0b26b389968d9c1022045` | 3 failed \| 22 passed: `expected '' to be 'MRK-000742'` (existing test and letter row), `expected '' to be '123,45678'` (separator row)                                                                                                                                         |
| G (extra): the guard's `setError` without `shouldFocus`                                                                                                                  | `27727f71647c318f90a3b83d7ae9a9d042dec8ecbbeadf8e9c42e68a0faf96e5` | 3 failed \| 22 passed: `expected <input …(11)></input> to be <input …(11)></input>` (focus on the label)                                                                                                                                                                        |

Both rows die on both required mutants, so no row needed strengthening. The two rows are not interchangeable: the letter
code has no character the mapping changes, so mutant C survives the letter row, and only the separator row («123,45678»,
mapped to «123?45678») kills it.

## Checks

- Changed test file, verbose (stdout and stderr to different files): 25 passed, stderr 0 bytes (before and after prettier
  re-wrapped two lines).
- Delayed-`setImmediate` stand at 3 ms (the plan's recipe: `test/delayed-immediate.setup.ts` + `vitest.delay.config.ts`
  in the package, both removed right after): 25 passed, stderr 0 bytes. The stand was checked to be live — a scratch test
  measured `setImmediate` at 0.09 ms under the default config (its `>= 2.5 ms` assertion failed there) and passed under the
  stand; the scratch test was deleted.
- `typecheck` and `lint` (exit 0) on the commit-1 content (run right before committing; the commit changed nothing after them) and again after commit 2; `prettier --check` on `AddBadgeDialog.tsx`,
  `operator-badges.test.tsx`, `AGENTS.md` (commit 1) and on `AGENTS.md` and the spec (commit 2): clean; `git diff --check`
  (and `git diff --check 34babfeed..HEAD`) clean.
- Full Vitest on the commit-1 content (right before committing) and again at HEAD: 37 files / 810 tests passed both times.
- After commit 2: `pnpm … --filter @markiro/standalone build` (the shell embeds `dist`), `cargo fmt --manifest-path
apps/standalone/Cargo.toml --all -- --check` (no output), `cargo check … --workspace --all-targets --offline` (exit 0),
  `cargo test … -p markiro-host --test badges --offline` (8 passed) — all inside the sandbox.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test` shows only `src/host/pairing-code.ts:66`; none in the four
  Markdown/Rust files of commit 2 either; no control or invisible characters in any changed file.

## Deviations and notes

- The AGENTS.md failure-table row is worded to fit the existing column (66 ≤ 67 characters), so that table was not
  re-padded; the spec's decision table was (see I-2) because row 9's clause cannot fit in the room left in its column.
- AGENTS.md is hard-wrapped and prettier does not rewrap prose, so two insertions leave a short line each («…and the» in
  the alert paragraph and «answer is the new badge, not its operator, so the badge» in the «Бейджи» one); the rendered
  Markdown is unaffected, and I did not reflow the rest of those paragraphs to keep the diff to the named edits.
- The extra mutants C, E, F, G and the pre-change-file run of D are beyond the brief; no other file was mutated.
- Not changed, deliberately (outside the brief): the spec's row 9 still says the host «никогда не видит PIN и код бейджа»,
  the same unqualified claim that AGENTS.md now qualifies with the label caveat.
- For the controller's `.superpowers/sdd/1d4-deviations-draft.md` (not edited by me): its `<<WAVE2_SHAS>>` is
  `4d428de50` and `4c57fd483`, `<<TOTAL_TESTS>>` is 810; its statements about the guard (as typed and through
  `fromRussianLayout`, case- and layout-switch not recognised) and about the two straddle residuals «записано в
  `AGENTS.md`» are now true.

## Not verified

WebView2 (focus, `readOnly`, WebCrypto in the real webview), a real wedge scanner under the Russian layout (jsdom only),
NVDA, Windows, the full workspace `cargo test` (binds 127.0.0.1; the controller runs it), the `standalone-windows-build` job.
