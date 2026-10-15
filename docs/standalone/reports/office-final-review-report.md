# Office stream (plans ЧЗ + О-Ф): final whole-part review

I reviewed the worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, HEAD `257423c67`. The base is `91bfdbbba`, and the range holds 21 commits (ЧЗ 1–9 with the T4 and T7 fix rounds, О-Ф 1–9 with the T3 fix round). I read the rules, both constraint files, the ledger, the minors queues (`chz-minors.md`, `pof-minors.md`, `plh-minors.md` item 8), the ЧЗ T5 and T7 reviews, both plan headers, and the whole production diff package (`review-office-final.diff`, read through). I sampled the tests. All of my own runs were focused files and one-line mutants. At the end `git status --short` of the worktree is empty.

## Verdict

**WITH FIXES: Critical 0, Important 2, Minor 10.**

Nothing found breaks data, security, role isolation or the bytes of a file the customer uploads.

- **Exports.** I took a real host answer, produced by the Rust host from facts. It has pallets, a pallet taken apart, an open pallet, a late box, a box taken apart and a loose box. I ran it through the cloud's own source and runner, and through the office's port. The result is 33 of 33 runs equal, byte for byte.
- **Goldens.** Both are bound at the expected hashes, and both cloud parity tests pass.
- **Shell.** The file-writing shell holds its security properties after both fix rounds and О-Ф Task 5. Three mutants of my own on it were all killed.
- **The two Important findings.** One is a documentation contradiction: AGENTS says the opposite of what the code does about re-reading at each press. The other is the known `asyncUtilTimeout` gate failure under load. Both have one-line fixes.

## (a) Findings, most severe first

### Important

**I1. AGENTS.md says the opposite of the code about when a form's rows are read.**

- Location: `apps/standalone/AGENTS.md:2899-2902`, section "Shift card and printed forms", bullet "Printing".
- What it says: "each press draws the form again from the rows the dialog read when it opened".
- What the code does: `PrintFormDialog.tsx`, `press()` → `readAgain()`, re-reads the host's rows, or for the blank its five records, at every press. Its own doc comment says so ("each press reads them AGAIN before it draws"), and so do the О-Ф T7 commit message and pilot spec §21 ("диалог читает заново").
- Why it matters: the bullet's own parenthesis then contradicts it ("while the dialog reads fresh"). A maintainer trusting AGENTS could remove the re-read as redundant, and a dialog left open would then print a box as it was. The calibration counts a document that lies as Important.
- Fix: "each press reads the rows again (the blank its five records) and draws from them; only the card's button for the shift's placards decides from the card's cached pallet list."

**I2. The full Vitest suite is not green at the plan's final gate under load.**

- Location: `apps/standalone/test/setup.ts`; failing file `test/print-form-dialog.test.tsx`.
- Cause: Testing Library's `asyncUtilTimeout` defaults to 1000 ms, and `--testTimeout` does not raise it. Under load, `findBy*` gives up before the test's own timeout. This is the О-Ф T9 report, and the ledger confirms it.
- Fix, ready to apply (append to `test/setup.ts`):
  ```ts
  // A findBy*/waitFor waits up to the test's own timeout, not Testing Library's 1 s: under a
  // loaded machine the first paint of a heavy dialog takes longer, and no test here asserts
  // that something does NOT appear within a wait (checked: no `.rejects` on findBy/waitFor,
  // no waitForElementToBeRemoved), so only the time to a genuine failure grows.
  import { configure } from "@testing-library/react";
  configure({ asyncUtilTimeout: 15_000 });
  ```
- What I checked before proposing it:
  - No test in `apps/standalone/test` depends on the 1 s default. A grep for `.rejects` with `findBy`/`waitFor` and for `waitForElementToBeRemoved` finds nothing. The only explicit `timeout:` is `print-form-dialog.test.tsx:729` (20 000 ms), which this change leaves alone.
  - Under the default 5 s gate the test timeout still bounds every wait. A slow `findBy` then fails as "test timed out", where today it fails as "Unable to find…". That is the one cost.
  - The node-environment suite `test/phc-contract.test.ts` imports the setup file. With the change applied as a scratch edit it still passes (2/2), and `print-form-dialog.test.tsx` passed (36/36). I restored the file byte for byte (sha256 equal).
- Policy note: the root AGENTS forbids "increase timeouts simply to obtain a green run". The fixer should say in the commit why this is not that: the wait is not an assertion about speed, and the gate stays the test timeout. Also record it as a deviation.

### Minor

- **m1. A taken-apart closed box is counted in the dialog's «Закрытых коробов» without any test noticing.**
  - Location: `src/office/exports/export-checks.ts:142-146` (`exportCounts`).
  - Mutant T2 drops `&& box.disassembledAt === null`. It survives all four files that should catch it: `export-checks`, `export-checks-warnings`, `export-plan` and `export-dialog` (61 tests).
  - Effect: information only, no file byte changes.
  - Fix: add a test where a closed box with an SSCC is taken apart and `closedBoxes` excludes it.
- **m2 (ЧЗ T5 review m1). The sub-second order of a pallet's boxes is unbound.**
  - Location: `export-source.ts:333`. Comparing closes only to the second survives.
  - Fix: add a rules test. Two boxes on one pallet close at `…:00.900Z` (id `…1`) and `…:00.100Z` (id `…2`); expect box 2 first.
- **m3 (ЧЗ T5 m2). The tie key of the code order is unbound.**
  - Location: `export-source.ts:87-88`. Breaking ties by canonical text instead of by hash survives.
  - Fix: add a rules test with two codes at one instant whose hash order runs against their text order (hash `aa…` with text `KM-Z`, hash `bb…` with text `KM-A`; expect `KM-Z` first).
- **m4 (ЧЗ T5 m3). The shift date's source is only half bound.**
  - Location: `export-source.ts:172`; test `test/export-source-rules.test.ts:422`.
  - Fix: in that test, also set `stationClosedAt: "2026-10-09T01:00:00.000Z"` and `closedAt: "2026-10-09T01:00:00Z"`.
- **m5 (pof-minors R14). The time-zone test depends on the machine's zone.**
  - Location: `test/form-data.test.ts:159-164`. It compares with this machine's zone, so on a UTC machine it cannot tell "this PC's zone" from UTC.
  - Fix, as `test/civil-date.test.ts:141-150` already does: set `process.env.TZ = "Pacific/Kiritimati"` in a `try/finally`, and expect `formTimeZone(unknown)` and `formTimeZone(undefined)` to be `"Pacific/Kiritimati"`.
  - When fixed, delete the AGENTS bullet about R14 (`AGENTS.md`, end of "Shift card and printed forms").
- **m6 (ЧЗ T5 review note). The backstop line of the coverage check has no comment.**
  - Location: `export-source.ts:222` (`if (code === undefined) return null;`).
  - My earlier M5 mutant showed it is the backstop of the ownership rule: with the two coverage conditions removed, this line alone refuses an unowned item.
  - Fix: a one-line comment so nobody deletes it as dead code.
- **m7. Docs drift and ragged lines.**
  - `AGENTS.md:2792` says "The dialog (`ExportDialog.tsx`, from «Смены»)"; it now also opens from the shift's card.
  - `AGENTS.md:2046` and `:2932` are ragged lines of more than 100 characters (the 2932 one is in "Logs").
  - Pilot spec §20 says "Номер 19 занят планом ПЛ-Ц". On `claude/infra-rk`, §19 is РК, so renumber at merge (see (f)).
- **m8. The export dialog's pallet rows differ from the card.**
  - Location: `ExportDialog.tsx:493-500` (`palletRow`/`palletOpen`).
  - The SSCC shows as 18 bare digits, where the card and the forms show `(00)…`.
  - A pallet taken apart shows "коробов: N": its boxes still linked on the host (`export-checks.ts:131-134`), next to the refusal. This is what chz-minors item 1 asked consumers not to do; the card shows «—».
  - Cosmetic; CARRY or fix with the next touch of the dialog.
- **m9. Duplicated time-zone fallback.**
  - Location: `ExportDialog.tsx:116-119`. It repeats `formTimeZone` (`render-form.ts`), with the same rule written twice.
  - Fix: use `formTimeZone(org.data)` (with m5 it is tested once).
- **m10. Query-plan pins run without `sqlite_stat1`.**
  - Measured: a 100 000-scan shift built from the host's own migrations (sqlite 3.44 CLI).
  - Without stats, `BOX_ITEMS_SQL` searches `boxes` PK → `scans_shift` → `box_items` PK, as pinned, in 0.10–0.22 s per box (machine under load). That confirms the documented ~0.14 s.
  - After `ANALYZE` on a single-shift database, the planner flips to `SCAN box_items`. With many shifts `scans_shift` should still win, so this is only a latent risk.
  - Today the host never runs `ANALYZE` or `PRAGMA optimize` (grep of `host/src`).
  - CARRY, as a note for any plan that adds stats (РК: VACUUM/ANALYZE after restore). The real fix is an index on `box_items(box_id)`, a host migration.
- **Not a finding (plan-mandated, all fields named).** `shiftCreate` builds the pallets fields with a conditional spread of two literal objects (`requests.ts:393`). The rule "never a spread" aims at spreading input, which this is not. DROP.

### Seams checked (what I did, adversarially)

1. **Compliance-critical exports.**
   - Golden hashes: shift-export-parity `golden.json` sha256 is `17b06c6be128baa2cfe09f9178b24d26f3e2ea9563bc0f7e12fffc2405b5d8c9` (218 runs). `cases.json` is `ff9c379a…`.
   - Cloud parity tests: `standalone-export-parity` and `standalone-forms-parity` both pass (2/2, no database).
   - End to end, from a real host:
     - A scratch host test (deleted) produced a shift through the facts route: two codes at one instant, 7 boxes, 3 pallets (p1 closed with a late box at 42.300 after its 40.000 close, p2 open, p3 closed and then taken apart), a box taken apart, a loose box, and the station's close at `…:30.412Z`.
     - It dumped `export-source`, `pallet-report-data` and box 3's `report-data` to `/tmp/claude/rev-office/`.
     - Fed to the cloud's own source and runner as a case (scratch copy of the cloud test with `EXPORT_PARITY_WRITE=1` into `/tmp/claude/rev-office/fx`, CI unset), and to the office's `runExport` over the raw host answer: **33 of 33 runs byte-equal**. That covers the shift formats at `null`/2/3 lines and all three pallets. Pallet 1 lists its late box (3 boxes); pallet 2 gives `PALLET_NOT_CLOSED`, pallet 3 `PALLET_DISASSEMBLED`. The pallets formats write 2 pallets, Ч1 included, with 1 box suppressed by the open pallet.
     - Scratch files were deleted, and `git status` was clean after each step.
   - Operation date (Ч2): the files carry `stationClosedAt` (`.412Z`), not the host's whole second.
   - Code ownership, compared with the cloud's code:
     - Cloud: its box disassembly releases registry rows (`station-scans.service.ts:2310-2392`, `emptyBox` → `releaseCode`) and stamps `removedAt = now()` = `disassemblyReceivedAt`.
     - Host: `facts/exception.rs:104-125` stamps `removed_at` and `disassembled_at` from the same `occurred_at`. That makes the `removed_at = b.disassembled_at` rule of `BOX_ITEMS_SQL` equivalent, and the host releases the codes as well.
     - Cloud harness: its fake database ignores `where` and `orderBy`. All cloud orderings except the pallet's own boxes are JavaScript sorts, which the harness does run, and the pallet-box SQL order is emulated. So the golden binds every order the cloud computes.
   - Audit `shift.export`: written only after the save (Ч5), under `begin_write` + `require_session_in`, with no revision. Mutant H3 (`station_closed_at` from any event) is killed.
2. **The file-writing shell.**
   - One-pass path model: `check_segments` → `decode` → length and path checks → filesystem.
   - Names: allowlist only (`is_alphabetic`/`is_numeric` plus ` -_.()`), extensions csv/txt/xml/html, device names refused, root-only writes.
   - New folders come from the atomic `create_dir` loop. Files are written with `create_new` (O_EXCL / CREATE_NEW), mode 0600 on Unix.
   - Links: `symlink_metadata` on every folder of the way, and on the form file when opening.
   - `open_office_file`: only `.html` under `Формы`, and `open_office_folder` only existing real folders.
   - Launcher: `%SystemRoot%\explorer.exe`, the path quoted through `raw_arg`, started in the system folder, a `"` refused.
   - Resource caps: 100 000 files, 256 MiB, and a base64 length bound before decoding.
   - TOCTOU between a check and a create or open is reachable only by a same-user process, which can write there anyway; the webview cannot make links.
   - The JavaScript `formFileName` allows a subset of what Rust's `is_name_char` takes (`\p{L}\p{N}` against Alphabetic/Numeric), so the direction is safe.
   - My mutants: S1 (FORMS_ROOT check dropped), S2 (form file followed through `metadata`), S3 (suffix units dropped from `path_fits`). All killed.
   - Not verified: Windows behaviour (Explorer, junctions, OneDrive, MAX_PATH).
3. **Forms parity.**
   - Golden: print-forms `golden.json` sha256 is `58d40eb3f5f77bf7e7feb54a53c4eda26ea02640cbe4ebac9cd7b83b3533520f` (12 runs). `cases.json` is `2a971a11…`.
   - Coverage gaps in the golden:
     - Late box: the forms list it like any box, the mapping is the same, and the card flags it.
     - Unclosed box on a pallet: unreachable on the host (`ReportPalletBox.closed_at` is NOT NULL by construction).
     - Ties and ordering: bound by host tests (my mutant H2 is killed) and by `form-data-rules` (my mutant T1, which keeps a taken-apart pallet among the placards, is killed).
   - Freshness: verified in the code (`readAgain` at each press).
   - Moscow «Сформирован»: owner note, documented.
   - The watermark: golden case `placard-a5-disassembled`.
   - The frame's `sandbox` keeps scripts out: my mutant T3 (`allow-scripts` added) is killed.
   - The webview's CSP allows inline styles and `data:` images, so `@page` styles and the logo work in the frame. The forms carry no `<script>`.
4. **Host routes.**
   - Auth: every office role reads; the POST is any office role (Ч4).
   - Errors: `not_found` for an unknown shift or box; a device key alone gives 401 `credential: session` (tests).
   - Snapshot and plans: one deferred read transaction, rolled back; EXPLAIN pinned for every query (see m10).
   - Mutant H1 (box report keeps items taken out earlier) is killed.
   - Memory: the whole answer in memory, about 63 MB of JSON at 200 000 codes (ЧЗ T5 measurement). Acceptable for a station PC in the pilot; already documented.
   - The `pub` read seams (`read_rows`, `read_box_rows`, `read_pallet_rows` with an `after_query` hook) are a generic, zero-cost test seam with a no-op in the route. Acceptable; record them as deviations.
   - Log walk: covers all six routes and asserts that their answers hold the code, serial and SSCCs the walk searches for.
5. **UI.**
   - Focus moves to the progress region and then to the outcome; the live regions are always present; the `role="presentation"` alerts sit inside them; Modal `closeLabel` and table `empty` texts are present.
   - Cancel: Escape or X while reading or forming cancels instead of closing; nothing closes while saving or recording.
   - Big shifts: the box list is paged at 50 and the pallet list is not paged (documented). A single synchronous step at 200 000 codes, or a draw of a big form, freezes WebView2 for seconds (documented; the worker is not done).
   - Every `t()` key used by the new UI exists in `ru.json` (script check), dynamic keys included.
6. **Contract tests across packages.**
   - Nothing under `apps/api/src` changed; only the two tests did.
   - Both write modes refuse when `CI` is set.
   - `tools/ci/affected.mjs`: a change of the fixtures under `packages/domain` runs both the API and the standalone jobs. The Rust `office_files` test `include_str!`s the export golden, which the domain jobs (`standaloneJobs`) cover. The isolating cases of ЧЗ T4 and О-Ф T3 are present.
7. **Documents.** AGENTS sections "Shift exports", "Shift card and printed forms", "Logs", "Audit", "Office pages" and spec §20/§21 match the code, except I1 and m7. Unverified surfaces are stated as such, and I found no overclaim beyond I1.
8. **Tests as a suite.**
   - О-Ф T7 harness race: the implementer's frozen sources (`/tmp/claude/impl-pof-t7/frozen/*`) equal commit `dbaacb885` byte for byte.
   - The pre-campaign backup, formatted with prettier, differs from the commit only by the intended edits: the D1 guard and the `office.forms.changed` message removed, and the "planned" guard on the card's pallet list.
   - The worktree equals HEAD (`git diff --stat HEAD` empty).
   - My 11 mutants (3 host, 3 shell, 5 TypeScript): 10 killed, 1 survives (m1). Each was restored with `cp`, `cmp` silent and sha256 equal, and the Rust files were `touch`ed.
9. **Scope and process.**
   - Paths: only allowed ones (apps/standalone, the two apps/api tests, the two domain fixture folders, the pilot spec).
   - No manifest, lockfile or migration changed.
   - Trailers: 21 of 21 commits carry exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   - `git diff --check` is clean, and there is no `\u04` escape in added lines.
   - `cargo fmt --check` passes.
   - Prettier gate:
     - Over all 71 changed JSON/TS/TSX/CSS/MD files, run from the root with repo-relative paths and `--ignore-path .prettierignore`, it is clean.
     - It is live: a scratch file `const   x  =  1` failed it (exit 1).
     - `prettier.getFileInfo` reports 0 of 71 ignored.
10. **Merge readiness.** See (f).

## (b) Triage

| Item                                                              | Decision                        | Reason                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chz-minors 1 (show `disassembledAt`, not counts)                  | DROP (done)                     | The card shows «—» for a taken-apart pallet's boxes and units; the dialog's row remains (m8, CARRY).                                                                                                                                    |
| chz-minors 2 = ЧЗ T5 m1–m3                                        | FIX                             | m2/m3/m4 above: three rules tests, each with its mutant shown failing.                                                                                                                                                                  |
| chz-minors 3 = ЧЗ T5 m4 (failure with no trace)                   | DROP (resolved)                 | ЧЗ T8 shows `GENERATION_FAILED` with a reason (domain code or error class, never the message); AGENTS says "nothing logs it".                                                                                                           |
| chz-minors 4 (audit counts unverifiable)                          | DROP (documented)               | AGENTS "Audit" and spec §20 say it.                                                                                                                                                                                                     |
| chz-minors 5 (T8 addenda 1–4)                                     | DROP (done)                     | Pallet list used for `pallet_count_mismatch`; Russian texts for every warning and refusal, the 12-digit INN explained; `late_boxes` shown next to `disassembled_pallets` and documented; zone passed to `exportFolder` with no default. |
| chz-minors 6 (`invalid_request` in plain words)                   | DROP (done)                     | `office.exports.files.invalid_request` text.                                                                                                                                                                                            |
| chz-minors 7 (COM0/LPT0, no temp-then-rename, Windows unverified) | CARRY (owner / Windows check)   | Documented in AGENTS and spec §20.                                                                                                                                                                                                      |
| ЧЗ T7 review M1–M4                                                | DROP (fixed in the fix round)   | Suffix room, UTF-16 path cap, cleanup failure logged, extension allowlist; my S3 mutant re-verified the path cap.                                                                                                                       |
| ЧЗ T7 review M5 (COM0/LPT0)                                       | CARRY                           | Plan-mandated test; owner's call.                                                                                                                                                                                                       |
| ЧЗ T7 review M6 (stale mutant log)                                | DROP                            | Process only.                                                                                                                                                                                                                           |
| ЧЗ T5 review note (line 222 backstop)                             | FIX                             | m6, a comment.                                                                                                                                                                                                                          |
| pof-minors 1(1) Moscow «Сформирован»                              | DOC (done) / owner note         | Parity with the cloud; Gelendzhik is on Moscow time.                                                                                                                                                                                    |
| pof-minors 1(2) form file names                                   | DROP (done)                     | `formFileName` plus the Rust test `the_names_of_the_forms_are_taken`.                                                                                                                                                                   |
| pof-minors 1(3) R14                                               | FIX                             | m5.                                                                                                                                                                                                                                     |
| pof-minors 2 (pallets not paged, no auto-refresh)                 | CARRY                           | Documented; page the list at about 1000 pallets.                                                                                                                                                                                        |
| pof-minors 2 (duplicate status cell, no negative role test)       | DROP                            | Cosmetic; both roles may plan.                                                                                                                                                                                                          |
| pof-minors 2 (key `palletsFact`)                                  | DOC                             | Deviation to record.                                                                                                                                                                                                                    |
| pof-minors 2/3 (render and draw cost)                             | CARRY                           | Documented; a worker is the real fix.                                                                                                                                                                                                   |
| pof-minors 3 (harness race)                                       | DROP                            | Verified clean (frozen = commit; backup diff intended).                                                                                                                                                                                 |
| pof-minors 3 (placards button uses the cached list)               | DOC                             | Correct in spec §21; AGENTS states it inside the I1 bullet — fix with I1.                                                                                                                                                               |
| plh-minors 8 (late box onto a closed pallet)                      | DROP for this stream (done)     | The export warns (`late_boxes`, shift and pallet documents); the card flags «Закрыт после закрытия паллеты»; the forms print it as the cloud does (byte parity forbids a mark). Refusing it upstream is ПЛ-Ц's business.                |
| I1 (AGENTS printing bullet)                                       | FIX                             | Docs.                                                                                                                                                                                                                                   |
| I2 (`asyncUtilTimeout`)                                           | FIX                             | `test/setup.ts`.                                                                                                                                                                                                                        |
| m1 (closed-box count survivor)                                    | FIX                             | Test.                                                                                                                                                                                                                                   |
| m7 (docs drift and ragged lines)                                  | FIX (docs)                      |                                                                                                                                                                                                                                         |
| m8 (dialog pallet row)                                            | CARRY                           | Cosmetic.                                                                                                                                                                                                                               |
| m9 (zone fallback duplicated)                                     | FIX (optional, 1 line) or CARRY | It is a production-code change that touches the dialog's tests.                                                                                                                                                                         |
| m10 (plans without stats)                                         | CARRY                           | Note for РК and future migrations.                                                                                                                                                                                                      |

**Proposed fix wave (ONE fixer), three commits, tests separate from production code:**

1. `test(standalone): …`, tests only:
   - `test/setup.ts`: `asyncUtilTimeout` 15 000 (I2).
   - `test/export-source-rules.test.ts`: m2, m3, m4.
   - `test/export-checks.test.ts`: m1.
   - `test/form-data.test.ts`: m5 (TZ pinned).
   - Mutant evidence for each new test:
     - m2: pallet box order compared to the second.
     - m3: tie broken by canonical text.
     - m4: shift date from `stationClosedAt`'s day.
     - m1: drop `box.disassembledAt === null` in `exportCounts`.
     - m5: the unknown zone maps to `"UTC"` instead of the PC's.
   - Each must fail and the file then be restored byte for byte.
2. `fix(standalone): …`, production code:
   - The `export-source.ts:222` backstop comment (m6).
   - Optionally m9: `ExportDialog` uses `formTimeZone`.
3. `docs(standalone): …`:
   - AGENTS I1, m7 (the «Смены» and card wording, two ragged lines, the R14 bullet deleted).
   - The deviations below, appended to both plans' «Отклонения при исполнении» on the branch that holds the plans (`claude/autonomous-desktop-station-9e6f13`, under `docs/superpowers/plans/`; the plans are NOT in the `claude/office-chz` tree, so the fixer must not create them there).

Gates for the wave:

- The touched Vitest files.
- `pnpm --dir … exec prettier --ignore-path .prettierignore --check <files>` from the root, shown live.
- `git diff --check`.
- No cargo run is needed: no Rust changes.

## (c) DEVIATIONS TO RECORD (Russian drafts)

**План ЧЗ, «Отклонения при исполнении»:**

- Задача 1: чтение строк выгрузки вынесено в `office_exports::read_rows(pool, id, after_query)`. Это публичный шов: маршрут передаёт пустое замыкание, а тест снимка пишет с другого соединения между запросами. В тексте плана шва нет.
- Задача 4: раунд исправлений добавил случаи `removed-item-moved` и `open-box-on-pallet`. Без них мутанты «снятая позиция остаётся» и «открытый короб в документе паллеты» выживали. Эталон теперь 218 прогонов (`golden.json` sha256 `17b06c6be128baa2cfe09f9178b24d26f3e2ea9563bc0f7e12fffc2405b5d8c9`, `cases.json` `ff9c379a…`), счётчики задач 5–9 сдвинулись на +21. Режим записи `EXPORT_PARITY_WRITE=1` отказывает при заданном `CI`.
- Задача 5: добавлен `test/export-source-rules.test.ts` (39 тестов). Мутант P7d не эквивалентен, его убивает случай `open-box-on-pallet`. Три мутанта ревью (порядок коробов паллеты до миллисекунды, второй ключ порядка кодов, источник даты смены) закреплены тестами в финальной волне.
- Задача 6: добавлены предупреждения `late_boxes` и `pallet_count_mismatch` и файл `test/export-checks-warnings.test.ts`.
- Задача 7: после ревью оболочка усилена. Имена берутся из короткого списка (буквы и цифры любого письма, пробел, `-_.()`), расширения — только csv, txt, xml, html. Путь передаётся `explorer.exe` в кавычках через `raw_arg`, тестируемый построитель `explorer_launch`. Последний сегмент оставляет место под « (99)». Путь длиннее 240 единиц UTF-16 — `invalid_request`. Неудавшаяся уборка папки пишется в журнал по виду ошибки. `COM0` и `LPT0` оставлены обычными именами (тест плана).
- Задача 8: добавлены `export-plan.ts` и `test/export-plan.test.ts`: проверка форматов идёт по шагам с отдачей управления, отмена работает до начала сохранения. Диалог грузится отдельным чанком. Причина `GENERATION_FAILED` (код домена или класс ошибки, не сообщение) показывается в диалоге, а не в журнале. Для `pallet_count_mismatch` диалог читает список паллет.
- Задача 9: раздел спецификации пилота — «20». На момент написания номер 19 был занят в других ветках (ПЛ-Ц; в ветке РК 19 — это РК). При слиянии потоков разделы нумеруются заново.
- Финальная волна: `asyncUtilTimeout` Testing Library поднят до 15 с в `test/setup.ts`. Это не ослабление: ожидание `findBy*` — не проверка скорости, предел остаётся тайм-аутом теста, и ни один тест не ждёт, что элемент не появится. Добавлены тесты на мутанты ревью задачи 5 и на исключение расформированного короба из числа закрытых коробов. Поправлены документы.

**План О-Ф, «Отклонения при исполнении»:**

- Задачи 1–2: чтения вынесены в публичные швы `office_reports::read_box_rows` и `read_pallet_rows` с `after_query`, как в ЧЗ. У расформированного короба в `pallet-report-data` `units` = 0, хотя облако считает позиции на момент расформирования. Байты форм совпадают: такой короб формы не печатают со счётом и не считают.
- Задача 3: раунд исправлений добавил случаи бланка `task-form-pallets-off-stale-capacity` и `task-form-pallets-on-no-capacity`. Эталон теперь 12 прогонов (`golden.json` sha256 `58d40eb3f5f77bf7e7feb54a53c4eda26ea02640cbe4ebac9cd7b83b3533520f`, `cases.json` `2a971a11…`).
- Задача 4: добавлен `test/form-data-rules.test.ts`. Тест неизвестного пояса зависел от пояса машины (мутант R14 выживал на машине в UTC); в финальной волне пояс задан в тесте явно.
- Задача 5: добавлены `formFileName` (имя формы приводится к списку имён оболочки, устройства Windows получают префикс «Форма ») и `test/support/office-files.ts`. Кадр печати — `sandbox="allow-same-origin allow-modals"` без скриптов. Файлы создаются с правами 0600 на Unix.
- Задача 6: ключ `office.shiftCard.palletsFact` вместо `office.shiftCard.pallets`: тот столкнулся с объектом `pallets` в `ru.json`. В карточке появились отметки: поздний короб, расхождение счёта паллеты в обе стороны, дата расформирования. Тестов 26 вместо 9 по плану.
- Задача 7: добавлены `task-inputs.ts` (общий для карточки и диалога) и `prepareForm` (данные отдельно от тяжёлого рисования, `test/prepare-form.test.ts`). Диалог читает строки заново при каждом нажатии, для бланка — пять записей. Снят избыточный guard D1 и сообщение `office.forms.changed`: отказ показывает сам диалог по только что прочитанным строкам. Первый прогон мутаций испортил исходники: два прогона гонялись. Исходники восстановлены сверкой с копией; финальное ревью подтвердило, что замороженные исходники равны коммиту `dbaacb885`.
- Задача 8: все 44 фрагмента применились. Диалог меняет паллеты только у запланированной смены: у активной хост отказывает.
- Задача 9: раздел спецификации пилота — «21». В обходе журнала проверка `contains(canonical)` из брифа заменена проверкой полей ответа (код, серия, хвост, SSCC): группа GS в JSON экранирована, и строка из брифа не совпала бы никогда.
- Финальная волна: исправлены пункт AGENTS о печати (строки читаются заново при каждом нажатии) и тест часового пояса.

## (d) What could not be verified

- Windows: Explorer launching the quoted path, the default browser for `.html`, junctions and OneDrive-redirected «Документы», MAX_PATH, `COM0`/`LPT0`. The Windows branch is only type-checked by the earlier reviewer's probe; I did not re-probe it.
- WebView2: the print dialog for the sandboxed frame, `afterprint`, `@page` A4/A5 on paper, and the freeze time of big shifts.
- Full suites: whole Vitest, `cargo test --workspace`, `no_secrets_in_logs` and `ipc` (unsandboxed). Also typecheck, lint and build. All not re-run, per instructions.
- The CI selection in a real GitHub run.
- Uploading an autonomous XML to Честный знак and the customer's sample files (П3); the cloud's Postgres collation for Ф6 (`SHOW lc_collate`).
- Planner behaviour on sqlite 3.46 with stats on a year of shifts (m10 used the 3.44 CLI).

## (e) Notes for the other streams and plans

- **РК:**
  - A restore without facts makes a later export build fewer codes, and the golden cannot see it.
  - Restoring rows of `shift.export` is plain audit.
  - If РК adds `ANALYZE`, `PRAGMA optimize` or `VACUUM INTO` with stats, re-run the EXPLAIN pins with stats present (m10).
  - Merge conflicts with this branch: `audit.rs` (actions, union), `server.rs` (routes, union), `api.ts`, `protocol.test.ts`, `test/support/office.tsx`, AGENTS and the spec (§19 РК). Renumber so that ЧЗ and О-Ф stay consecutive.
- **ПЛ-Ц / 2a8:**
  - `BOX_ITEMS_SQL` relies on the disassembly stamping `box_items.removed_at` and `boxes.disassembled_at` from ONE instant (`facts/exception.rs:104-125`). Changing either silently empties «Состав короба» of a box taken apart; host tests H1 would catch it.
  - A box joining a closed pallet (plh-minors 8) is flagged here, and refusing it upstream is ПЛ-Ц's call.
  - Office facts files unchanged; `facts_files` stays 17.
- **Ф7 (exceptions and rejected records plan):** `ShiftCardPage.tsx` is the place; no routes exist yet.
- **Owner:** Ч1 (a taken-apart pallet still written as a pallet), Moscow «Сформирован», `COM0`/`LPT0`, the Ф6 collation, П3 samples, and the 64 px question for an office on a touch panel.

## (f) Merge checklist (into `claude/integration`, HEAD `0ffeb4f58`)

1. `git merge-tree 0ffeb4f58 HEAD` predicts 4 conflicts:
   - `apps/standalone/AGENTS.md`: keep both, in the order Facts → Floor work → Floor printing → Shift exports → Shift card and printed forms → Marking rules. Keep both "Logs" and "Verification" additions.
   - `src/host/api.ts`: union of the import lines `ssccBlockSchema` and the three report schemas.
   - `test/protocol.test.ts`: keep both `describe` blocks ("facts of the floor" and the О-Ф box/pallet form data); check the merged imports.
   - `test/support/office.tsx`: union of the fakes (`requestSsccBlock`, `checkCode`, `sendFacts`, `getBoxReportRows`, `getPalletReportRows`).
   - Auto-merged: `ipc.rs`, `shell.css`, `protocol.ts`, `ru.json` (valid, no duplicate keys in all three predicted merges), `api.test.ts`.
2. The same 4 conflicts are predicted against `claude/floor-2a7` (it contains `0ffeb4f58`, and changes nothing in host or proto since the base).
3. Against `claude/infra-rk`, 7 conflicts: AGENTS, `audit.rs`, `server.rs`, `api.ts`, `protocol.test.ts`, `office.tsx`, the pilot spec. All are unions; renumber the spec sections (ПЛ-Х 18, then 19–22 for ПЛ-Ц, ЧЗ, О-Ф and РК in one agreed order), and fix spec §20's "Номер 19 занят планом ПЛ-Ц" sentence and РК's paragraph to match.
4. After each merge:
   - Build: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`, then standalone typecheck and lint. A new `HostApi` member from either side breaks a full fake elsewhere: only typecheck sees it.
   - Focused Vitest: `protocol`, `api`, `export-*`, `forms-parity`, `form-data*`, `print-form*`, `shift-*`, `office-files*`.
   - Cargo (`--offline --locked`): `-p markiro-host --test office_exports --test office_boxes --test office_reports --test fixtures`, `-p markiro-standalone --lib office_files`; unsandboxed: `--test ipc` and `--test no_secrets_in_logs` (`facts_files` 17).
   - The two API parity tests, the prettier gate over the merged files (shown live), and `cargo fmt --check`.
5. Do not merge before the fix wave lands (I1, I2) unless the controller accepts the AGENTS contradiction temporarily.
