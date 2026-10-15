# ИМП: final fix wave, report

Worktree `/tmp/claude/wt/imp`, branch `claude/imp-cloud`, base `76f6adc28`. Five commits. Nothing was pushed. The tree is clean (`git status --short` is empty) and no scratch file is left.

| Commit      | Subject                                                                                                                           | Review items   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `a2a77521d` | fix(standalone-export): both extensions of the organization's prefix in the cut-over table; A4 pallet sheets left out with a note | C1, I1         |
| `15dfa2473` | fix(standalone-export): a prefix another tenant issues under stops the export                                                     | I2, m4, M11    |
| `588ec48fb` | fix(standalone-export): the transfer file appears whole or not at all                                                             | m1, m2         |
| `efc0f46f2` | fix(standalone): a rehearsal or old file asks twice before it is imported; forward-only boundary pinned                           | I4, M14 (m3)   |
| `9071ae4d8` | docs(standalone): install runbook points to the cut-over memo; logo, group and template notes                                     | I3, m5, m6, m8 |

Every message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (checked: 5 of 5). The plan's «Отклонения при исполнении» is left untouched for the controller. My own deviations are listed below.

## What changed

### 1. C1 and I1 (`a2a77521d`)

**C1: both extensions of the organization's prefix.**

- `sscc.mjs` `planSsccCounters` takes `organizationPrefix` as a required key (`undefined` throws; `null` means no organization, which only the unit tests use).
- It always seeds both rows `(prefix, 0)` and `(prefix, 1)`. A row the cloud never issued under gets `issuedMax: null`, starts at the extension's first serial (1 for boxes, 0 for pallets) and gets `cloudReseedTo = first + window`.
- `transform.mjs` passes `gln.slice(0, 9)`.

**I1: the cloud's A4 pallet sheets.**

- `export.sql` now reads:
  - `'format', t.format`;
  - a new count `palletSheetDefaults`, made of the organization's `default_pallet_sheet_template_id` plus the `org_pallet_sheet_template_defaults` rows.
- `transform.mjs` drops a template as `template_dropped` with reason `pallet_sheet` when its format is `pallet_sheet_v2` or its `spec.kind` is `pallet_sheet`. Any other non-`label_v1` format is dropped with reason `format`. A missing or `null` format (a copy older than 0183) is read as a label.
- A default or product that names a dropped sheet falls out through the existing notes (`template_default_dropped`, `product_template_dropped`).
- A new count note `pallet_sheet_defaults_lost` is added when the count is above 0. `palletSheetDefaults` joins `RAW_COUNTS`.

**Host, defence in depth.** `host/src/cloud_import.rs::check` refuses a template whose `spec.kind == "pallet_sheet"` (`validation_failed`, `payload.templates.N.spec`).

**Office.** New words in `import-notes.ts` and `ru.json`: the `pallet_sheet_defaults_lost` note and the reasons `pallet_sheet` and `format`.

**SQL fixtures.** The seed adds a real 0183-shaped sheet row (`0d0d…07`, format `pallet_sheet_v2`), the organization's default sheet and category 8's sheet. Cleanup deletes `org_pallet_sheet_template_defaults`. `raw-cloud.json` was regenerated from the live SQL output and diffed: the only changes are the `format` key on each template, the sheet row and `palletSheetDefaults: 2`.

**Golden file.** Regenerated with the tool's own `buildExportFile` plus prettier (script `/tmp/claude/impfix/gen-golden.mjs`). The diff is exactly the checksum and two new notes: `template_dropped` (`…07`, `pallet_sheet`) and `pallet_sheet_defaults_lost` (count 2). The checksum went from `sha256:9716b9df…45c5` to `sha256:f679947f…ea0e`. Updated pins:

- `test/cloud-import.test.ts` (title and regex);
- `test/cloud-import-page.test.tsx` (checksum prefix, «Замечания выгрузки: 26», plus the two new note texts);
- `cli.test.mjs` («Замечаний: 26»).

The payload did not change, so the Rust tests needed no change in this commit.

**Runbook.** §1 says A4 sheets are not carried. §4 adds the note to the list. The table section and §5 say the organization has both rows, and that a «выдано —» row of the organization is reseeded too.

### 2. I2, m4 and M11 (`15dfa2473`)

**SQL.**

- `export.sql` `prefixes` now also includes:
  - `substr(btrim(org_profiles.gln), 1, 9)`;
  - the counterparties' GLN prefixes (13-digit GLNs only).
- `ssccPrinted` is no longer filtered by `prefixes` (m4: legacy pre-block boxes under any prefix count).

**Transform.**

- Any `otherTenantsSscc` row under the organization's prefix throws `ExportError("sscc_prefix_shared")` with `error.shared` (prefix, extension, the other tenant's maximum). Any value stops it, and `--rehearsal` does not get past it.
- With `acceptSharedPrefix` the file is written, with one note per shared extension: `{code: "sscc_prefix_shared", issuerPrefix, extension}`. The other tenant's number never enters the file.
- Under any other prefix nothing stops.

**CLI.**

- `--accept-shared-prefix` added; the usage text names it and `sscc_prefix_shared`.
- On a refusal it prints one stderr line per shared row plus the owner-decision line, exit 2.
- When accepted, stderr carries an «Внимание: …» line saying what must happen before the first shift. A counterparty prefix gets a «Справка: …» line only.

**Office.** New note words for `sscc_prefix_shared`. `ssccHint` no longer claims that the warnings never reach the file, and it names both organization rows.

**Seed.**

- The other tenant's counter and blocks move from the organization's prefix to the counterparty prefix 460123400, so the default export needs no accept and the golden file stays a plain export.
- Its block `…98` now runs 800000–950000. Its end is the maximum, which kills M11.
- A new other-tenant counter under counterparty 3's prefix 460700000 proves that counterparty GLN prefixes are watched.

**Live SQL test, new final step.** It deletes this tenant's own counters, blocks, boxes and pallets under 460068200, then inserts:

- a legacy box under 460068200, serial 31234 (no counter or block row for that prefix);
- another tenant's counter under 460068200, extension 1.

It then asserts:

- `ssccPrinted` carries the legacy box (m4);
- `otherTenantsSscc` carries the shared prefix (I2(b));
- the export stops with `sscc_prefix_shared`;
- with accept, the cut-over rows are `[0, 31234, 40000]` and `[1, null, 0]`, and the file has the note.

**Golden file and pins.** The golden file gains the legacy box's floor row `460999900/0` (owner `unknown`, issued 777, start 10000, reseed 1010000) in `payload.ssccCounters` and `cutover`, and nothing else. The checksum went to `sha256:99628cca…469a`. Updated:

- `proto/fixtures/cloud-import-summary.json`;
- `proto/tests/cloud_import.rs` (count 4);
- `host/tests/cloud_import_rules.rs` (count 4, list);
- `host/tests/cloud_import.rs` (`counters_only_move_forward` summary, revisions, «SSCC» list);
- the page table row, the CLI summary line and the transform window expectations;
- the two webview checksum pins.

**Runbook.** §4.1 adds the code. §4.3 is rewritten:

- any serial stops the export;
- raising the standalone's counter does not hold;
- both steps are needed: stop or reseed the other tenant, then `--accept-shared-prefix`, and raise the standalone's counter if the other tenant is above its start;
- a counterparty prefix is only a «Справка» line.

### 3. m1 and m2 (`588ec48fb`)

**`writeWhole(path, text, fs = FS)` in `cli.mjs`.**

- It writes to `.<name>.<pid>-<random>.partial` next to the target (`wx`, mode 0600), keeps writing until every byte is down, fsyncs and closes.
- It then gives the file its name with `linkSync(temp, path)`, which never overwrites (EEXIST), and unlinks the temp file.
- On a file system without hard links (`EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS`) it checks `existsSync(path)` (EEXIST if the file is there), then renames.
- Any failure closes the descriptor and unlinks the temp file. The temp name is unique per run, so a run killed earlier never blocks the next one.

**`main`.** The default writer is now `writeWhole`.

**`--out-dir`.** It is now required (exit 64 before psql runs). The default `.` is gone.

**`.gitignore`.** It now ignores `markiro-cloud-export-*.json` and `.markiro-cloud-export-*.partial`. `git check-ignore` confirms both, and the golden fixture is not matched. No tracked file matches.

**Runbook.** §4 describes the whole-or-nothing write and the required `--out-dir`. §9.2 states what is and is not verified, plus the `kill -9` leftover.

### 4. I4 and M14 (`efc0f46f2`)

**Rehearsal file.**

- The confirmation dialog of a `rehearsal` file shows a `Checkbox` «Это пробная площадка: она будет удалена до переключения».
- «Перенести» stays off (`submitDisabled`) until it is ticked, and `onSubmit` also refuses while it is unticked, so Enter or a form submit cannot get through.
- The tick lives in the dialog's own state, so it is asked again at every opening.
- The done card of a rehearsal adds «Это была пробная площадка: удалите её…».

**Old file.** `describeFile(t, file, Date.now())` computes `staleHours`: whole hours when the age is strictly above 12 h, otherwise `null`. A future timestamp gives `null`. The page shows a warn `Alert` with the hours. It is computed once at read time, not in an effect.

**Host (M14).** New test `a_counter_at_or_one_above_the_files_start_is_kept_with_its_revision`:

- the site's box counter equals the file's start (30 000), and the pallet counter is one above it (10 001);
- after the import both values and both revisions are unchanged.

**Runbook.** §2.2 step 1, §6.2 step 1 and §9.1.2 describe the guards.

### 5. Docs (`9071ae4d8`)

- **`standalone-install.md`.** Lines 17–19 now point to the cut-over memo and keep «only automated tests; no real data, Windows or WebView2». Step 6 says the host starts empty, and that migration goes only onto a new site right after the wizard.
- **Memo.**
  - m6: the logo area prints empty (§1 and §2.2 step 3).
  - m8: cloud copies of stock templates stand next to the wizard's under the same names (§1).
  - m5: a `validation_failed` on a `chzProductGroupCode(s)` path may mean the site lacks the group (§6.2 table).
- **Spec §31.** New bullets: both organization rows, the shared-prefix stop (replaces the old «stderr only» bullet), A4 sheets, the file write, and the page guards. Open question 2 is reworded.
- **`AGENTS.md` («Cloud import»).** The same facts, under the tool, CLI and page paragraphs.

## RED / GREEN evidence

**RED, commit 1.** The new tests run against HEAD's `sscc.mjs` and `transform.mjs` (`/tmp/claude/impfix/c1-red.log`): 8 failed. They include «the organization's prefix gets both extensions…», «…is required…», «the cut-over table always has both extensions…», «an A4 pallet sheet stays in the cloud…», «a layout is a thermal label only in its own format…», «an output that lacks a list or a count…» (palletSheetDefaults) and the golden test. Host test before the refusal (`host-red.log`): `an_a4_pallet_sheet_is_no_thermal_template_and_is_refused ... FAILED`.

**RED, commit 2.** The new tests run against commit 1's `transform.mjs` and `cli.mjs` (`c2-red.log`): 5 failed. They are the shared-prefix stop and accept tests in transform and CLI, «only reported» (the counterparty «Справка» line), the arguments test and the `--help` test.

**RED, commit 3.** `cli.test.mjs` could not import `FS`/`writeWhole` (`c3-red.log`: SyntaxError, no export named `FS`).

**RED, commit 4.** `-t "asks twice"` (`c4-red.log`): 2 failed. These are «imports a rehearsal file only after its checkbox…» and «names the age…». The third test, «asks nothing more of a non-rehearsal file», is a regression guard that passed before and after. The M14 test pins an existing guard, so it was green at once; its mutants are below.

**GREEN.** Final runs:

| Gate                                                                                                      | Result                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool tests with the live DB: `STANDALONE_EXPORT_TEST_DATABASE_URL=… pnpm test:standalone-export`          | 120 tests, 120 passed, 0 skipped (base was 108, with the SQL test skipped without a DB). The SQL test ran against a disposable `postgres:17-alpine` container `markiro-impfix-pg` on 127.0.0.1:55631, with cloud migrations to 0185 applied by `@markiro/db db:migrate`, unsandboxed. The container was removed afterwards (`docker ps -a` shows none). |
| `node --test tools/ci/test/*.test.mjs` (unsandboxed)                                                      | 57 passed                                                                                                                                                                                                                                                                                                                                               |
| Parity tests                                                                                              | The tool↔domain SSCC equivalence ran (0 skipped; `packages/domain/dist` present). The golden-file parity runs in all three consumers: `proto --test cloud_import` 11, host `--test cloud_import` 21 and `--test cloud_import_rules` 23, and Vitest `cloud-import.test.ts` («agrees with canonical.mjs»). Rust also ran in the full workspace run below. |
| Webview typecheck, lint, build                                                                            | 0 / 0 / 0. Build shows only the old chunk-size warning.                                                                                                                                                                                                                                                                                                 |
| Full Vitest: `exec vitest run --testTimeout=60000 --hookTimeout=60000`                                    | 150 files, 4663 tests passed, stderr 0 bytes. Task 8 measured 150 / 4660, so +3. The plan's figure of 69 / 1760 is a different baseline.                                                                                                                                                                                                                |
| Focused Vitest (`cloud-import.test.ts`, `cloud-import-page.test.tsx`), verbose                            | 56 passed, stderr 0 bytes                                                                                                                                                                                                                                                                                                                               |
| The page file under the delayed-`setImmediate` stand (3 ms; scratch setup and config created and deleted) | 28 passed. The only stderr was Vite's warning about the scratch config's extensionless import, nothing from the tests.                                                                                                                                                                                                                                  |
| `cargo fmt --check`                                                                                       | clean                                                                                                                                                                                                                                                                                                                                                   |
| `cargo check -p markiro-host -p markiro-proto --all-targets`                                              | 0 warnings (run before each Rust commit)                                                                                                                                                                                                                                                                                                                |
| ONE full `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed)                         | exit 0. 75 `test result` lines, 1180 passed, 0 failed, 0 ignored.                                                                                                                                                                                                                                                                                       |
| Live prettier gate                                                                                        | Proved live with a mis-formatted scratch file (exit 1, file deleted). All changed JS, TS, JSON and MD files across `76f6adc28..HEAD` pass.                                                                                                                                                                                                              |
| Other checks                                                                                              | `git diff --check 76f6adc28..HEAD` clean. `grep -F '\u04'` finds only `pairing-code.ts:66`. `ru.json` has no duplicate keys (`object_pairs_hook`).                                                                                                                                                                                                      |

## Mutant table

Harness: `/tmp/claude/impfix/mut.py`. For each mutant it takes a pre-copy, applies a one-line change, runs the command, restores the file, compares with `cmp` and checks sha256. It touches Rust files after the restore. Logs are in `/tmp/claude/impfix/mut-<id>.log`. Every mutant was killed, and every file was restored with the same sha256.

| #    | Mutant (one line)                                         | Killed by                                                                    | Restore sha256 (first 16 hex) |
| ---- | --------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| C1a  | `sscc.mjs` drop `row(organizationPrefix, 1)`              | «the organization's prefix gets both extensions…»                            | d46e5e25ebfeebb1              |
| C1b  | transform passes `organizationPrefix: null`               | «the cut-over table always has both extensions…»                             | afc94878b6643803              |
| C1c  | drop the `undefined` check                                | «…is required, checked like any prefix…»                                     | d46e5e25ebfeebb1              |
| I1a  | drop `format === PALLET_SHEET_FORMAT \|\|`                | «a layout is a thermal label only in its own format…»                        | afc94878b6643803              |
| I1b  | drop the `spec.kind === "pallet_sheet"` branch            | same                                                                         | afc94878b6643803              |
| I1c  | drop the unknown-format branch                            | same                                                                         | afc94878b6643803              |
| I1d  | never note `pallet_sheet_defaults_lost`                   | golden test                                                                  | afc94878b6643803              |
| I1e  | `export.sql` drop `'format', t.format`                    | live SQL test                                                                | 3fa7d370ded5de31              |
| I1f  | `export.sql` drop the category sheet-defaults term        | live SQL test                                                                | 3fa7d370ded5de31              |
| I1g  | `export.sql` org default sheet term → `false`             | live SQL test                                                                | 3fa7d370ded5de31              |
| I1h  | host refusal `Some("pallet_sheet")` → `Some("never")`     | `an_a4_pallet_sheet_is_no_thermal_template_and_is_refused`                   | ea71ce1902f568c8              |
| I1i  | drop `pallet_sheet_defaults_lost` from `KNOWN_NOTE_CODES` | page «shows the file, the counters and the notes…»                           | 3af605d60a0fe890              |
| I2a  | shared stop `if` → `false`                                | CLI «…stops the export with exit 2, unless accepted»                         | 55a8feb1a49f12ac              |
| I2b  | shared filter `===` → `!==`                               | golden test                                                                  | 55a8feb1a49f12ac              |
| I2c  | drop the `sscc_prefix_shared` note                        | transform «…unless the owner accepts it»                                     | 55a8feb1a49f12ac              |
| I2d  | CLI does not pass `acceptSharedPrefix`                    | CLI exit-2/accept test                                                       | 2cb6484f05b7bab0              |
| I2e  | `--accept-shared-prefix` sets `false`                     | arguments test                                                               | 2cb6484f05b7bab0              |
| I2f  | `export.sql` drop the org GLN prefix union                | live SQL test, new step (`otherTenantsSscc` empty for 460068200)             | e87a6bd600447a3d              |
| I2g  | `export.sql` drop the counterparty GLN union              | live SQL test (raw lacks 460700000)                                          | e87a6bd600447a3d              |
| M11  | other tenants' block `to_serial` → `from_serial`          | live SQL test (900000 instead of 950000)                                     | e87a6bd600447a3d              |
| m4   | `ssccPrinted` filtered by `prefixes` again                | live SQL test (raw lacks 460999900)                                          | e87a6bd600447a3d              |
| W1   | drop `fsyncSync`                                          | «the file appears whole or not at all…»                                      | 0a0f942f2ce5f0c2              |
| W2   | no unlink of the temp file on failure                     | same                                                                         | 0a0f942f2ce5f0c2              |
| W3   | `linkSync` → `renameSync` (overwrites)                    | same (EEXIST case)                                                           | 0a0f942f2ce5f0c2              |
| W4   | FAT fallback without the `existsSync` check               | «without hard links… still never over another»                               | 0a0f942f2ce5f0c2              |
| W5   | one `writeSync` without the loop                          | «the file appears whole…» (short writes)                                     | 0a0f942f2ce5f0c2              |
| W6   | temp mode `0o600` → `0o644`                               | same (mode check)                                                            | 0a0f942f2ce5f0c2              |
| W7   | `--out-dir` requirement off                               | «the folder of the file is always named…»                                    | 0a0f942f2ce5f0c2              |
| W8   | no unlink of the temp file after the link                 | «the file appears whole…»                                                    | 0a0f942f2ce5f0c2              |
| W9   | drop the `.gitignore` line                                | «a transfer file written by mistake inside the repository is ignored by git» | fc7d518d754245b0              |
| W10  | empty `NO_HARD_LINKS` set                                 | «without hard links…»                                                        | 0a0f942f2ce5f0c2              |
| P1   | `submitDisabled={false}`                                  | «imports a rehearsal file only after its checkbox…»                          | 476622d6030b6b61              |
| P2   | drop `if (blocked) return;` in `onSubmit`                 | same (form submit sent `[true, false]`)                                      | 476622d6030b6b61              |
| P3   | `blocked = false`                                         | same                                                                         | 476622d6030b6b61              |
| P4   | `blocked = rehearsal` (tick ignored)                      | same                                                                         | 476622d6030b6b61              |
| P5   | `useState(true)` for the tick                             | same                                                                         | 476622d6030b6b61              |
| P6   | age `>` → `>=`                                            | «names the age…» (exactly 12 h)                                              | 476622d6030b6b61              |
| P7   | `Math.floor` → `Math.round`                               | same (72 h 59 min)                                                           | 476622d6030b6b61              |
| P8   | stale `Alert` not rendered                                | same                                                                         | 476622d6030b6b61              |
| P9   | after-rehearsal line always shown                         | «asks nothing more of a file that is not a rehearsal one»                    | 476622d6030b6b61              |
| P10  | after-rehearsal line never shown                          | rehearsal checkbox test                                                      | 476622d6030b6b61              |
| M14a | upsert `>` → `>= next_serial - 1`                         | `a_counter_at_or_one_above_the_files_start_is_kept_with_its_revision`        | 4fcd0d5153802a84              |
| M14b | upsert `>` → `>=`                                         | same (revision 2 → 4)                                                        | 4fcd0d5153802a84              |

## Counts: plan vs measured

The plan's counts (cargo 434, Vitest 69/1760, tool 28, tools/ci 48) describe a different baseline.

| Suite                     | Measured                      | Previous reference |
| ------------------------- | ----------------------------- | ------------------ |
| Tool tests                | 120                           | 108 at the review  |
| tools/ci                  | 57                            | —                  |
| Vitest                    | 150 files / 4663 tests        | 4660 at Task 8     |
| cargo workspace           | 1180 tests in 75 result lines | —                  |
| host `cloud_import`       | 21                            | 20                 |
| host `cloud_import_rules` | 23                            | 22                 |
| proto `cloud_import`      | 11                            | 11                 |

## Deviations (for the controller's «Отклонения»)

1. **The organization's prefix key accepts `null`.** `planSsccCounters` requires `organizationPrefix`, but `null` is allowed, so the existing SSCC unit tests keep their single-row expectations. `transform.mjs` always passes the GLN's prefix.
2. **I1 reads the new columns directly, not through `to_jsonb`.** `export.sql` reads `t.format`, `default_pallet_sheet_template_id` and `org_pallet_sheet_template_defaults` as they are. The tool's established rule is that a copy lacking a needed column stops psql (the existing «lacking» test), and the production cloud is at 0185. `transform.mjs` still tolerates a missing or `null` format.
3. **Extra cases beyond the review.** An unknown `format` is dropped with reason `format`. A sheet is also recognised by `spec.kind`.
4. **The host's sheet refusal is my addition.** The report does not ask for it ("if the brief says so" — it does not); I added it as cheap defence in depth. It applies only to the import's `check`; the office template routes are unchanged.
5. **I2 stops on any serial, and notes the accepted case.**
   - Any other-tenant serial under the organization's prefix stops the export. The condition is not "≥ start", because the other tenant keeps issuing; the old M7 boundary test is replaced.
   - A counterparty prefix only produces a «Справка» line, because the standalone never issues there (П4).
   - The optional file note was implemented (`sscc_prefix_shared`).
6. **The seed's other tenant moved off the organization's prefix.** It now sits on the counterparty prefix, so the golden file stays a plain export. The organization-prefix case is a live SQL step plus transform and CLI tests.
7. **m4 changed the golden payload.** Unfiltered `ssccPrinted` adds the legacy box's floor row (460999900, owner `unknown`), so `cloud-import-summary.json` and the host and proto counts changed. The review expected "the golden file does not change" for C1 only; I1 and m4 change it. The golden file changed in two commits (two notes in commit 1, one row in commit 2). Each commit's pins are consistent. The final checksum is `sha256:99628cca…469a`.
8. **m2: `--out-dir` is required instead of refusing a git work tree.** The review allowed either.
9. **m1: link-based no-overwrite with a FAT fallback.** The write uses a hard link, which never overwrites, rather than a plain rename, which would overwrite on POSIX. On FAT32/exFAT it falls back to a checked rename.
10. **I4: the age warning has no checkbox.** The review asked for a warning only. The threshold is strictly above 12 h, with floored hours.
11. **Runbook edits sit with their code.** The review places §1/§5 in commit 1 and §4.3 in commit 2; I also put the §4 and §9.2 write lines in commit 3 and the page lines in commit 4. Commit 5 holds the install runbook, m5/m6/m8, spec §31 and AGENTS.
12. **Not done.** m7 (two casts in `cloud-import.ts`, review: DROP/polish). The plan's «Отклонения» section is for the controller. The runbook still carries the review's owner checklist items only where they were already there.

## Self-review

**Credentials.** No verifier, salt or code appears in any new output:

- CLI refusals and warnings name prefixes, extensions and serials only, and the tests assert `assertNoSecret`;
- notes carry prefix and extension only, never the other tenant's number (asserted with «77777» and «950000» absent);
- the host's new refusal text is fixed.

**Golden discipline.**

- Both regenerations used the tool's own builder plus prettier, and each diff was inspected (shown above).
- `raw-cloud.json` was regenerated from the live SQL output and compared key by key.

**Tests.** Every new guard has a named, killed mutant. No assertion was weakened. The only edits to existing expectations follow from intended data changes: note count 24 → 26, the extra floor row, the required `--out-dir` in argument fixtures, and the M7 boundary replaced by «any serial stops».

## Concerns

1. **The FAT/exFAT fallback and Windows are tested only with injected fs failures.** No real flash drive or NTFS hard link was exercised. The fallback's `existsSync` → `renameSync` has a small window: a file created under the same name in between would be overwritten. This is acceptable for a single-operator tool.
2. **The shared-prefix stop is deliberately conservative.**
   - An other tenant with only an unused counter row under the organization's prefix still stops the export. Its reported maximum is then 0 (boxes) or −1 (pallets).
   - A client whose trial tenant shares the GLN always needs the owner's decision and `--accept-shared-prefix`.
3. **The age warning uses the office PC's clock.** A wrong clock hides or invents the warning.
4. **The host still accepts `rehearsal: true`.** The guard is page-only, as the review recommends; owner question 9.1.2 is still open.
5. **CI jobs were not run (no push).** `psql` on the runner and `verify-api-tests` with the new seed (`org_pallet_sheet_template_defaults` and the sheet CHECK constraint) were exercised only on local Postgres 17 with migrations to 0185.
