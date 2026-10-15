# 2a7 final-wave fix report

Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `f9f51c7d0`. Scratch and logs: `/tmp/claude/fix-2a7-final/`.

## Commits

| Hash        | Subject                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b6d664036` | test(standalone): the setup's fields through the real keyboard wedge, and the label panel's words for a failed job                                                |
| `81d14a9c5` | fix(standalone): the setup's text fields take input from the scan source; a test label clears what was typed before it; the panel promises nothing it cannot know |
| `0ffeb4f58` | docs(standalone): the final review's answers for floor printing                                                                                                   |

Each carries exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git status --short` is empty after the last commit.

## What changed

**I1 (FIX).** `WorkstationSetup.tsx`:

- One shared `manualEntry = { onFocus, onBlur }` is spread into all 7 `Input`s: the printer form's name, host, TCP port, COM port and baud, and the scanner port and baud. The handlers call `source.setManualTextEntryActive(true/false)`.
- A `useLayoutEffect` cleanup keyed on `[source, editing]` sets it `false`. The printer form closing with the focus on a field sends no blur (the 1f2 lesson), and unmount is covered too.
- `source.clearPendingInput()` runs when a test label has gone, just before `setTest({ kind: "sent" … })`. This drops type-ahead on a `Select`.

**m5 (FIX).**

- `pending.body` now says «…программа предложит решить, вышла ли этикетка…».
- New `floor.print.target.replacedFailed` has no «возможно, лежит у прежнего» clause.
- `LabelPanel.tsx` `targetText` takes the panel's `mayExist` and chooses `replaced` (unknown or waiting check) or `replacedFailed` (failed).

**m1 (DOC).**

- The production-date question is closed in AGENTS.md «Floor printing» and in spec §21. The «Open for the final review» bullet is gone.
- The host rule is cited: `update_shift`, `host/src/routes/office_shifts.rs` lines 398–432. `fixed_changed` on an `Active` shift answers `status_conflict`.
- The pinning test is `an_active_shift_takes_only_its_plan_and_a_closed_one_nothing` in `host/tests/office_shifts.rs`, case `productionDate` → 409.
- The number is drawn at creation, and each job stores its `fields`, which a reprint replays.
- The text now says the copy is taken "as entered (`keepEnteredShift`)", not "the host's last list".

**m2 (DOC).**

- The `CHECK` is kept. The measured sizes are recorded in AGENTS.md and the spec: 58×40 ZPL 20.7 KB at 203 dpi and 45.2 KB at 300 dpi; 100×150 ZPL up to 128.6 KB.
- The 30 000-job estimate is recorded as roughly 0.6–1.3 GB at the 58×40 sizes.
- Clearing is documented as plan 2a8's retention duty.
- Checked in `docs/superpowers/plans/…2a8…`: line 7228 lists `RETAINED_TABLES` with `"floor_print_jobs"`, and the plan's retention test uses it. Nothing was added to `2a7-minors.md`.

**m3, m4 (DOC).** Both are added to the accepted list in AGENTS.md and in the spec. The forget-warning count is noted as a plan 2b item.

**Setup and panel text.** The «Floor printing» paragraphs now describe the setup's text fields and the clearing of typed-ahead input. They also describe the new split between `replaced` (a label that may exist) and `replacedFailed` (a failed job).

The DROP minors (m6, m7 and the rest of the DROP/CARRY rows) were not touched.

## RED / GREEN

**RED.** Tests only, before the fix (`/tmp/claude/fix-2a7-final/red.txt`): `floor-setup` + `floor-work-print` gave 6 failed and 110 passed.

- Wedge, test label scanned after typing: the screen shows a mismatch (the reviewer's scenario).
- Wedge, type-ahead on a list (`Select`).
- Every text field keeps its keys and its Enter (the first field fails: Enter was swallowed as a scan).
- A field removed with the focus on it.
- The pending text.
- The failed-job `replacedFailed` text.
- The setup-unmount test passed pre-fix because the flag was never set. It is killed by mutant W5.

**GREEN** (`green.txt`): the same two files give 116 of 116.

## Mutants

Harness `mut.py`, log `mut.out`. Each mutant was run against both files, and the original was restored from `/tmp/claude/fix-2a7-final/orig/` after each. The harness checked `cmp` and sha256 against the pre-mutation file and printed `restored True` for all of them. `git diff` of the sources against the fix commit is empty.

| #        | One-line mutant                                                      | Killed by                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1       | `onFocus` sets `false`                                               | «leaves every text field its own keys and its Enter…»                                                                                                                       |
| W2       | `onBlur` does nothing                                                | the same test, and «reads the first scan of a test label…»                                                                                                                  |
| W3.1–3.7 | one of the 7 `Input`s loses `{...manualEntry}` (each of the 7 tried) | «leaves every text field its own keys…» (each of the 7)                                                                                                                     |
| W4       | layout-effect deps `[source]` (drops `editing`)                      | «scans again when a field goes away with the focus on it». «puts the focus on the section it shows…» also failed in that run; it passed unmutated in 4 runs (see Concerns). |
| W5       | cleanup removed                                                      | «scans again when a field goes away…» and «scans again when the setup itself goes away…»                                                                                    |
| W6       | no `clearPendingInput` at the test send                              | «drops what was typed ahead on a list before the test label goes…»                                                                                                          |
| L1       | `targetText` always uses the may-lie text                            | the new failed-job test                                                                                                                                                     |
| L2       | `targetText` never uses it                                           | existing «warns that the printer of the label is gone…»                                                                                                                     |
| L3       | the reason view passes `mayExist = false`                            | the same existing test                                                                                                                                                      |
| T1       | pending text reverted                                                | «offers no check for a send this app still holds…» (now asserts the text)                                                                                                   |

## Gates

- Typecheck, lint and build: exit 0 (`tc.out`, `lint.out`, `build.out`).
- Prettier: run as `node_modules/.bin/prettier --ignore-path .prettierignore --check <repo-relative paths>` from the worktree root. A deliberately mis-formatted `test/zz-probe.ts` made it exit 1 with `[warn]` (file deleted). All changed files then passed: both test files, `LabelPanel.tsx`, `WorkstationSetup.tsx`, `ru.json`, `AGENTS.md`, and the spec.
- `git diff --check`: clean.
- `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`. No `\u0` in the diff of the docs and JSON.
- Verbose run of the two changed test files: stderr 0 bytes, 0 `stderr |` lines, 116 of 116 pass.
- Delayed-`setImmediate` stand (3 ms; its two temporary files were deleted right after): `floor-setup` + `floor-work-print` + `floor-app` give 202 of 202, stderr empty.
- **Full Vitest** at `--testTimeout=60000 --hookTimeout=60000`: **110 files, 3293 tests passed**, stderr empty, no unhandled errors. The base was 3287 and I added 6 tests (5 wedge tests, 1 failed-job text test); the pending text is asserted inside an existing test.
- Not run: cargo (no Rust touched), browser, Windows or hardware checks.

## Self-review and concerns

- `source.clearPendingInput()` sits after `await printing.send(...)`, so it also drops keys typed during the send. This is stricter than "just before `setTest`", and harmless.
- The layout effect also resets the manual flag when the printer form opens or closes. That is correct, because the focused field is removed either way.
- W4 also failed «puts the focus on the section it shows…» once. It passed in the unmutated verbose, delay-stand and full runs. It is a possible load-dependent flake of an existing focus test. I did not investigate further and made no change to it.
- The spec §21 header comment (`План 2a8 берёт §20`) is stale: the final review (e.4) says 2a8's section is §22. I did not touch it (out of scope) and mention it for the 2a8 dispatch.
- The plan's «Отклонения при исполнении» (draft (c) of the review) lives on the plans branch. The controller writes it; two more lines for it: the wedge fix I1 and `replacedFailed`.
