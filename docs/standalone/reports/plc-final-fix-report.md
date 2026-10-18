# ПЛ-Ц final fix wave: report

Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `7009153c7`. Tree clean after the last commit.

Status: DONE_WITH_CONCERNS (concerns below).

## Commits

| #   | Hash        | Subject                                                                    |
| --- | ----------- | -------------------------------------------------------------------------- |
| 1   | `b7d4b3b3f` | fix(standalone): a pallet is never taken apart while its label job is open |
| 2   | `f8d4eab80` | fix(standalone): the floor's words for a pallet's choice and its stops     |
| 3   | `cef62619f` | test(standalone): the pallet guards the suite did not pin                  |
| 4   | `4e7ff10bb` | docs(standalone): what the pallets changed in the old text                 |

Each commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (project-pinned by the dispatch document).

## What changed (FIX rows only)

- **m3 / A8 / A9 / A28 (commit 1).** `PALLET_LABEL_CLOSED_GUARD_SQL` is the first statement of `disassemblePallet`'s transaction.
  - It is a no-op `UPDATE floor_pallets` with `expectedChanges: 1` and `NOT EXISTS` an open `floor_print_jobs` row of the pallet, using `OPEN_JOB_SQL`.
  - On `changes_mismatch` the function re-reads the pallet's newest job; an open one throws `LabelWaitingError(palletId, "pallet")`, anything else stays `stale`.
  - The newest-job read became a shared helper `readLastPalletJob` (also used by `reprintPallet`).
  - Plan pinned in `test/floor-schema.test.ts` (Node SQLite 3.53) and `src-tauri/tests/local_db.rs` (shell SQLite 3.46): the pallet by `sqlite_autoindex_floor_pallets_1 (id=?)` and the open job by `floor_print_jobs_open (host_id=? AND device_id=? AND purpose=? AND subject_id=?)`, no SCAN, no TEMP B-TREE. The text-agreement list went from 27 to 28 and the Rust `reads` array from 74 to 76 entries.
  - Module header reworded. AGENTS.md Exceptions bullet reworded, known-limit bullet removed. Spec §19: «Исключения паллеты» extended, known-limit sentence removed.
  - The existing test "refused as stale … once the pallet is taken apart" disassembled a pallet under an unknown label through the module. That is now refused, so it sets `disassembled_at` by hand and says so; it still pins the reprint's own `palletLiveGuard`.
- **m4 / m5 / A16 / A22 / A23 / A27 (commit 2).**
  - `ru.json`: `signal.taken` = «ВЫБРАНО», `signal.notFound` = «НЕ НАЙДЕНО СРЕДИ ЗАКРЫТЫХ», `result.failed` says «проверьте исключения и числа смены». `palletFailed.body` names both causes plus the changed pallet. `palletWaits.body` names the administrator. `blocked.open_pallet` = «Коробов на открытой паллете: {{quantity}}. Сначала закройте её.»
  - New `floor.work.palletShiftOpen` («Смена не закрыта: когда паллета закроется, нажмите «Закрыть смену» ещё раз.»).
  - `pallet_no_serials` and `pallet_failed` carry `fromClose`. `confirmPalletClose` calls `closePallet(true)`, the link-back passes `waiting.fromClose`, and «Повторить» (`closePalletNow`) keeps the flag of the stop it dismisses.
  - `LabelWaitingError(subjectId, subject = "box" | "pallet")` names the subject in its message.
  - AGENTS.md: the «still says «короб»» bullet is removed, and the ВЦ3 bullet now says «Закрыть паллету и смену» (not "early close") and that the stop says so. Spec §19 limits gained the same sentence.
- **m1 / m2 / m7 (commit 3).** Tests only. See the mutant table.
- **m6 / m8 (commit 4).**
  - AGENTS.md: 23 tables, 11 `DeviceData` (8 of `0006` + `floor_print_jobs` + the two pallet tables), with ПЛ-Ц in the list.
  - `purgeAcknowledged` JSDoc now names pallets and pallet exceptions.
  - `confirmClose` JSDoc names the pinning test «takes no scan queued behind the close: it meets the closed shift».
  - Explicit-stop comment at `closed === "stopped"`.
  - The `closePallet` open-job comment (P5): unreachable from the screen, why it is kept.
  - Cross-reference comments on `reprintPallet` and `reprintBox`.
  - `pallets.ts` `PalletCloseResult` doc rewrapped.
  - Two test titles fixed.
  - Spec §19 «показывается, только пока…».
  - The ВЦ3 wording of the review was done in commit 2 together with the behaviour.

## Mutants (name, kill, restore proof)

`/tmp/claude/plc-fix/mut.py` backs up the file, checks the anchor matches exactly once, mutates, runs the named test files, restores, then runs `cmp` against the backup and compares sha256 before and after. Every row below has `cmp` silent and equal sha256 (`restored: true`). Raw results are in `/tmp/claude/plc-fix/mut-result-defs{1,2,3}.py.json`, logs in `/tmp/claude/plc-fix/mut-*.txt`, backups in `/tmp/claude/plc-fix/orig/`. The sha column is the file's sha256 prefix before the mutation.

Commit 1 (`pallet-exceptions.ts` `55b86e05cf63`; runs `floor-pallet-exceptions` + `floor-schema`):

| Mutant | One-line change                                  | Result                                                            |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------- |
| C1M1   | the guard statement removed from the transaction | killed: both new disassembly tests (2)                            |
| C1M2   | guard predicate `AND ${OPEN_JOB_SQL}` → `AND 0`  | killed: 4 (both new tests, the plan pin, the Rust text agreement) |
| C1M3   | stale diagnosis `isOpenJob(last)` → `false`      | killed: both new tests (2)                                        |
| C1M4   | guard `expectedChanges: 1` dropped               | killed: both new tests (2)                                        |
| C1M5   | guard `j.purpose = 'pallet'` → `'box'`           | killed: 3 (both new tests, the text agreement)                    |

Commit 2 (`WorkScreen.tsx` `a154f901350f`, `ru.json` `b2cbcca51dd5`, `pallet-exceptions.ts` `5d4c094a2cce`; runs the four UI files):

| Mutant | One-line change                                                       | Result     |
| ------ | --------------------------------------------------------------------- | ---------- |
| C2W1   | `closePallet(true)` → `closePallet()` in `confirmPalletClose`         | killed (2) |
| C2W2   | `closePalletNow` → `closePallet()` (flag lost on «Повторить»)         | killed (1) |
| C2W3   | link-back `closePallet(waiting.fromClose)` → `closePallet()`          | killed (1) |
| C2W4   | `pallet_no_serials` line `stop.fromClose &&` → `false &&`             | killed (1) |
| C2W5   | `pallet_failed` line `stop.fromClose &&` → `false &&`                 | killed (2) |
| C2W6   | `closePalletNow` → `closePallet(true)` (early close claims the shift) | killed (1) |
| C2W7   | `LabelWaitingError(palletId, "pallet")` → `(palletId)`                | killed (1) |
| C2W8   | `signal.notFound` back to «НЕТ ТАКОГО КОРОБА»                         | killed (2) |
| C2W9   | `palletWaits.body` without the administrator sentence                 | killed (1) |
| C2W10  | `result.failed` back to «числа короба»                                | killed (5) |
| C2W11  | `blocked.open_pallet` back to the old sentence                        | killed (2) |
| C2W12  | `palletFailed.body` without «или паллета изменилась»                  | killed (1) |

Commit 3 (`ExceptionFlow.tsx` `d1111ad8cc46`, `print-resolution.ts` `8310738c61f4`, `print-jobs.ts` `52c1b25c68c3`, `pallets.ts` `82e23a0b5f1e`):

| Mutant      | One-line change                                                             | Result                                                             |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C3T1 = V3   | `candidate.sscc === sscc` → `endsWith(sscc.slice(-4))`                      | killed: the new flow test                                          |
| C3T2 = R11  | pallet branch of `reprintStatements` `reasonCode: reason` → `"printer_jam"` | killed: both parametrised cases (unknown, sent awaiting its check) |
| C3T3 = V11a | «Перепечатать этикетку паллеты» `press()` → bare `onClick`                  | killed: the double-tap test                                        |
| C3T4 = V11b | «Расформировать паллету» `press()` → bare `onClick`                         | killed: the double-tap test                                        |
| C3T5        | `OPEN_JOB_READ_SQL` `ORDER BY created_at, purpose` → `purpose DESC`         | killed (6), the restart-order test among them                      |
| C3T6        | `LIVE_BOXES` drops `AND b.disassembled_at IS NULL`                          | killed: the real-`disassembleBox` close test                       |

No mutant survived. P5 (m6) is a comment only, as the review said (no screen flow reaches the check).

## Gates

- **Focused, verbose, empty stderr:** all new and changed test files. Per-commit runs: 328 (commit 1 set), 394 (commit 2 set), 165 (commit 3 set) and 220 (commit 4 set) tests, no `stderr |` and no failures.
- **Delayed-`setImmediate` stand** (3 ms, temporary files removed, tree clean):
  - Commit 2: `floor-work-pallets`, `floor-work-close-pallets`, `floor-work-pallet-exceptions`, `floor-work-exceptions` — 4 files, 178 tests passed.
  - Commit 3: the first three — 3 files, 128 tests passed.
  - The first run of the new restart test failed under the stand: `settled()` returned before the entry effect showed the label panel. It now waits with `findByText`, which is the right pattern for this stand.
- **Final full Vitest:** 122 files, 3786 tests passed (`--testTimeout=60000`, run concurrently with the cargo workspace). The review's baseline was 3777; this wave adds 9 tests (2 disassembly tests, 1 flow-level exact-SSCC test, 2 double-tap cases, 2 reason cases, 1 restart test, 1 shift-not-closed test).
- **`typecheck`, `lint`, `build` (webview):** exit 0 after every commit; `build` after commit 4.
- **Prettier gate:** run live from the worktree root with `--ignore-path .prettierignore` on every changed file. It was proven live once with a deliberately mis-formatted scratch file (exit 1, deleted). It caught `WorkScreen.tsx` and a test file after edits, and both were fixed with `--write`.
- **`cargo fmt --check`:** clean.
- **`git diff --check`:** clean.
- **`\u04` grep:** only `src/host/pairing-code.ts:66`.
- **Full cargo workspace, unsandboxed, once, on the final tree:** `cargo test --offline --locked --workspace` — 54 test binaries, **819 passed, 0 failed, 0 ignored**, exit 0, no warnings. Baseline before the wave was also 819 (no Rust tests added; the new pins live inside the existing `local_db.rs` plan test, which stays at 28 tests and passed alone after commit 1).
- **Not run:** Windows, a real printer, the touch panel, WebView2, a real host over a LAN, and `graphify update` (no `graphify-out` in the temp worktree).

## Anchor adaptations and notes

- `closePallet` was re-indented by Prettier (a default parameter forced the `useCallback` call to wrap), so commit 2's diff of that function is large but changes only indentation plus the `fromClose` parameter.
- `"taken"` of `floor.exceptions.signal` is never rendered (`show("ok", …)` keeps only the tone and the cue), so «ВЫБРАНО» has no visible assertion. Only «НЕ НАЙДЕНО СРЕДИ ЗАКРЫТЫХ» is checked, in the box flow and in the pallet flow.
- `LabelWaitingError`'s constructor signature changed (second optional parameter); all box callers are untouched.

## Concerns

1. The dispatch pins the trailer `Claude Opus 5.5`, while this session's attribution reminder names a different model. I followed the dispatch (project-pinned, consistent with the 13 earlier commits). If the owner wants the trailer to name the model that wrote this wave, those four commits need a reword.
2. The `disassemblePallet` transaction now refuses on any open pallet label job, not only the newest. After `stale` the diagnosis looks at the newest job only. If a state with an older open job under a newer decided one ever existed (the schema's unique open-job index makes it impossible), the caller would get `stale`, not `LabelWaitingError`. Nothing is written either way.
3. CARRY rows are untouched, as instructed: m11 (the in-queue host wait for pallet serials) and m12 (the early close without the tries loop). DROP rows are untouched too.
4. The full Vitest ran concurrently with the full cargo run under `--testTimeout=60000`. All passed; I did not repeat it in isolation.
