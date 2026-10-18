# 2a7 Task 9 report - documents (AGENTS.md and the stage 2a spec)

Commit `f9f51c7d0` docs(standalone): floor printing in AGENTS.md and the stage 2a spec (branch claude/floor-2a7, base bda2117d0). One Co-Authored-By line (Claude Opus 5.5, project-pinned). `git status --short` empty after the commit. Documents only: `apps/standalone/AGENTS.md` (+272/-26 net with the spec) and `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (+98).

## What was done

- Read the dispatch, the rules, constraints, brief, `2a7-minors.md`, reports 1-8 and the Task 4 and 6 reviews (verdicts and findings), then opened the code at HEAD for every statement: `0007_floor_printing.sql`, `local_db.rs` (`TABLE_CLASSES`: 21 tables = 11 Disposable + 9 DeviceData + 1 Workstation), `workstation-settings.ts`, `label-render.ts`, `print-jobs.ts`, `print-runtime.ts`, `print-resolution.ts`, `LabelPanel.tsx`, `WorkScreen.tsx` (settleLabel, decide, recoverStalled, entry effect, attemptClose), `FloorApp.tsx`, `App.tsx`, `awake.ts`, `test-label.ts`, `WorkstationSetup.tsx` (save, test print), `ru.json` (`floor.print.*`, `floor.setup.*`).
- AGENTS.md: "Local database" class counts (the old "19 tables ... Workstation stays empty" was untrue) and a `0007` paragraph (classes, CHECKs, the open-job index and its triple repetition, unpinned query plans, unbounded bytes, no retention); "Hardware" (who calls the wrappers now; `~HS` not made; the 20 s limit and the busy address; the awake reset); "Floor work" (the SSCC-before-pipeline sentence, `closeSteps`/`onClosed` extension-point paragraph and the lost-answer box now found through its job; the closing sentence); new "Floor printing" section (job in the close transaction, states and codes, runtime, recovery, label panel, decisions, check, press guard, setup, sound, keep-awake) plus a list of accepted limits; "Shifts" one phrase (FloorApp now also has the setup); "Verification" the 2a7 manual Windows list.
- Spec: new section 21 "Уточнения плана 2a7" (everything the brief's section had, corrected to the executed code, plus the accepted limits and the not-verified statement).

## Section numbering (clash risk)

The spec on this branch has sections 1-20 (verified: 15 2a1, 16 2a3, 17 2a4, 18 2a6, 19 2a2, 20 2a5), so I took 21 (the brief says 19, which is taken here). An HTML comment in the section states the clash: plan 2a8 uses section 20 and ПЛ-Ц writes into the pilot spec; renumber at merges. The section was appended at the end of the file (ascending order), not after section 17 where the brief's anchor sat.

## Anchor adaptations (all mechanical)

1. Brief AGENTS fragment 1 (the `0006` paragraph ending "pins these rules on node:sqlite." followed by "## Writes"): the real text there is longer (query-plan lists, header remark); inserted the `0007` paragraph before "## Writes". Content extended by the CHECK/index/plan facts above.
2. Fragment 2 (Hardware intro): real text differed ("since plan 2a6 the app calls `onScan` alone ... printing ... wait for plan 2a7"); replaced by meaning with the brief's wording.
3. Fragments 3, 4, 5 matched; text kept except fragment 3's `~HS` rationale, which I hedged (the claim that COM without flow control and a spooler queue cannot answer is the plan's assumption and was not tried) and fragment 4 gained the "address stays busy until the call really ends" fact.
4. Fragment 6 (end of Floor work): real text is the extended 2a6 paragraph; the two sentences that Tasks 1-8 made untrue ("`closeSteps` ... are the extension points of plan 2a7", "the print recovery of plan 2a7 finds such boxes in `floor_boxes`") were rewritten, and the earlier "plan 2a7 reads a label's SSCC before the pipeline" sentence too.
5. Fragment 7 (Verification): the brief's anchor (tail of the 2a5 shifts bullet) is absent here; the 2a7 bullet was placed after the 2a6 work bullet (chronological order) instead of between the 2a5 and 2a6 bullets. Added to the brief's list: spooler job for a switched-off printer, stock label bytes size, canvas near 4096, double tap on the touch panel, reprint record reaching the host, kiosk window with the setup open, a "not run" statement.
6. Spec fragment 1: anchor was section 17's last line, which has other sections after it here; section 21 appended at the end instead (see numbering).

## Statements corrected relative to the brief (executed code differs from the plan)

- "Only `box` prints": kept. The brief said recovery "when the work screen opens and before it reads a job"; the code also has the operator's check button (`recoverStalled`), pairing-wide: documented.
- "A shift closes only once every label is done with": documented as plan 2a8's obligation; `shiftLabelsSettled` counts rows.
- The 400 ms view guard, the stalled panel, `printer_busy` advice, printer line before a reprint, reasons built from buttons, the deleted-printer fallback text, settings atomicity (DB in one transaction, the shell's scanner step separate), scanner/printer port clash, 32-scanner and port-name limits, `Save` staying active after a refused set: all from Tasks 5-8, verified in the code.

## All 2a7-minors items documented (where)

Former printer not named on a rebind (AGENTS limits + spec); damaged stored job blocks the shift line and local close (both); `verifyPrintedLabel` one boolean (both); shell scanner snapshot only connected/disconnected and baud rule (both); productionDate/shift number from the shift copy, final-review question (AGENTS Floor printing + limits, spec); recovery only on entering and by the operator's check button (both); 400 ms guard (both); 20 s limit incl. queue wait, leave waits for a send (both); unknown never re-sent (both); skip text promises no 2a8 screen with the restore instruction and test name (both); keep-awake not always in kiosk (spec, AGENTS); test print a marked sample (both); settings saved atomically in the DB (both); setup reachable from the list and a label's recovery (both); decision trusts the decided job (ПЛ-Ц, both). Extra honest limits found while checking: no query-plan pin for the print-job reads, unbounded base64 and no retention, editing the job's own printer profile moves where reprint goes, `FloorApp` reads the sound level once, leaving the setup does not cancel a test print.

## Gates

- Prettier gate, proven live: a deliberately mis-formatted scratch `docs/zz-probe.md` exited 1 with `[warn]` (deleted), then `node_modules/.bin/prettier --ignore-path .prettierignore --check` on both changed files from the worktree root: "All matched files use Prettier code style!", exit 0.
- `git diff --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`. `grep '\u0'` in the two documents: only the pre-existing `\u001d` at AGENTS.md line 582 (not mine).
- `git status --short` empty after the commit; no scratch file in the tree (message file in /tmp/claude/impl-2a7-t9).
- Tests: none run - documents only, no source, test, manifest or migration changed (no test can fail from them). Totals plan vs measured: not applicable.

## Not verified / limits (stated in the documents too)

Nothing of the floor's printing was exercised on a real printer, COM port, spooler, WebView2 canvas or audio, Windows, or with a screen reader; the manual list is a to-do, not a result. The `~HS` rationale for COM and spooler is an assumption.

## Concerns

- Section number: the owner's merge must renumber (21 here; 2a8 plan uses 20; ПЛ-Ц uses the pilot spec).
- AGENTS.md also still says plan 2a8's `RETAINED_TABLES` removes codes and boxes (pre-existing text); I wrote that print jobs have no retention in plan 2a7 and that decision 31 gives it to 2a8 - if 2a8's final retention list omits `floor_print_jobs`, that sentence needs a look.
