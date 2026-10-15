# Merge 2a5 into claude/integration

Merge commit: 84c056f80 (no follow-up commits needed). Parents 1095d4af4 + baceddf49. One trailer.

Conflicts (as predicted, only two files):

- apps/standalone/AGENTS.md hunk 1: 2a5 "station's side" paragraphs put at the end of "Shifts", before integration's whole "## Facts".
- apps/standalone/AGENTS.md hunk 2 (Verification): 2a5 wording on the station's side ran only against a fake HostApi + integration's «Итоги»/«Выпуск» fixture-totals sentence; stale "totals not read / «Итоги» not built" dropped.
- Spec: 2a5 section renumbered 18 -> 20 (18 stays reserved for 2a6: the 2a6 plan text with "## 18. Уточнения плана 2a6" is in the tree as a plan, but not yet in the spec). Comment at section 19 updated to name 18 = 2a6, 20 = 2a5. Plan 2a5 (line ~11040-11041) reference to §18 updated to §20 (included in the merge commit). Note: 2a8 (§20) and О-Ф (§21) numbers will clash at their merges.

Auto-merged, checked: protocol.ts, api.ts, ru.json (no duplicate keys, nested-aware python check), office.tsx, api/protocol tests. No semantic conflicts; typecheck clean.

Gates (on /tmp/claude/wt/integ): typecheck ok, lint ok, build ok, prettier --check on 47 changed files ok (2 files deleted by 2a5: FloorOperatorScreen.tsx, floor-operator.test.tsx, no references remain), git diff --check ok, `\u04` grep only pairing-code.ts:66.
Vitest focused (21 files): 1132 passed. Full package: 89 files, 2636 tests passed, no timeouts (--testTimeout/--hookTimeout=60000).
Cargo: `check --workspace --tests` ok; shell `--test local_db` 27 passed, `--test ipc` 26 passed (unsandboxed). Host suites not run (unchanged by 2a5).
Not done: graphify update (checklist item 8), ledger/plan items 6-7 of the checklist.
