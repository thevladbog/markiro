# Docs and merge for the first beta: report

Status: DONE_WITH_CONCERNS (only minor concerns, listed below).

## Commits

- Plans checkout, branch claude/autonomous-desktop-station-9e6f13: `3696ff79e` docs(standalone): plans ДРВ, А4, СКЛ, ХП, ОЧ, I1, ИМП — the deviations at execution. It touches 7 plan files, +440/−17, and only their «## Отклонения при исполнении» sections.
- Integration worktree /tmp/claude/wt/integ, branch claude/integration:
  - `2cc8fcd93`: merge of the plans branch (`--no-ff`, parents 8c3011c9c and 3696ff79e). It brings 20 plan files and nothing else.
  - `5cc679ae7`: docs/runbooks/standalone-beta-1.md (new), plus fixes to the pilot spec and the cut-over memo.
- Every commit carries exactly one Co-Authored-By trailer.

## STEP 1: «Отклонения» sections

- One section per plan, written from the task, final review (c), final fix and merge reports, in the ПЛ-Ц style.
- ИМП was rewritten as executed:
  - Task 1 is kept;
  - the restart after decision A is recorded;
  - tasks 2–9 are covered;
  - golden checksums: 9716b9df → f679947f → 99628cca;
  - test counts, final review C1/I1–I4 with the five fix commits, open owner questions;
  - merge 4843a1ae0, with a note that the stale §31 prose was fixed later at 0ca4d78d0.
- The СКЛ merge bullet was moved to the end of its section.
- Contradictions the drafting found between sources (each resolved to the later source):
  - ДРВ: Task 7 reported 4722 green, but the fix report shows 3 forms-parity failures at the review commit.
  - ХП: the optional fix wave M2–M5 was never done and is listed as open.
  - СКЛ: the restore fix used `outcome = 'accepted'` plus the `wh_outbox_accepted` index in the unreleased 0012, so stations holding the old 0012 must be recreated (dev-only).
  - ОЧ: the old host reads only the last part of a `more: true` request.
  - I1: the plan's own «Не проверено» still says «Изменить адрес хоста»; it was left alone because it sits outside the section.

## STEP 2: merge

- The only conflict was in docs/superpowers/plans/2026-10-09-standalone-2a5-floor-shifts.md (2 hunks).
- The plans side is a strict superset of the integration side. It has the same Задача 1–9 text, the final wave split into tests, code and docs with hashes, and Перенесено (whose `other_host` gate entry is item 26 of 2a6-addenda), Не проверено and Счёт.
- I took the plans side for both hunks. That keeps all of both sides' content without duplicating verbatim blocks. The integration-side «Перенесено» line (host_probed) is identical on both sides.

## STEP 3

- docs/runbooks/standalone-beta-1.md has sections (a)–(f): contents by plan, what never ran, an 11-step prioritized first test, diagnostics, known limits and owner decisions, and how to report.
- Every path and name in it was checked against the install, backup and cut-over runbooks, ci.yml, prepare.mjs, ru.json and AGENTS.md:
  - artifact name, file names, CI step name and triggers;
  - host log path and ACL;
  - the app has no file log, so diagnostics go through stderr;
  - office page names.
- Pilot spec:
  - §22, §23 and §27 now say the allocated numbers are final; §23 had «нумеруются заново при каждом слиянии».
  - §31 no longer says «перенос листов — план А4».
- Cut-over memo:
  - §1: A4 sheets are not imported; the standalone has its own sheet library.
  - §1 and §2.2: a cloud template's logo field prints the bundled Markiro logo, not a blank. Checked in shift-render.ts.
- AGENTS.md section references (§8, §11, §22, §26, §30, §31) were already right and were not changed.

## Gates

- Prettier, run from each worktree root, was proven live: a scratch file gave exit 1 and was then deleted.
  - Plans checkout: the 7 files are clean.
  - Integration: the 20 merged plan files and the 3 STEP 3 files are clean.
- `git diff --check` is clean in both.
- Both trees are clean.
- Big test suites were not run (docs only, per the brief).

## Concerns

1. The app's exe name and install dir on Windows are unconfirmed: NSIS uses `${MAINBINARYNAME}`. The guide tells the owner to read them from the shortcut or the Run key.
2. The install runbook says «Настройка рабочего места», but the screen title is «Рабочее место». The install runbook was not edited.
3. The 2a5 conflict was resolved by taking the plans side, not by textual concatenation, because the content is a superset.
