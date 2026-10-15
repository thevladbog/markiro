# Plans РК-С, РК, УСТ, ИМП — «Отклонения при исполнении»

Status: DONE. One commit (see git log) on claude/autonomous-desktop-station-9e6f13, message `docs(standalone): plans РК-С, РК, УСТ, ИМП — the deviations at execution`.

Only the «Отклонения при исполнении» section of each plan changed (RK-S: filled; UST: filled; ИМП: section did not exist, appended after «Перенесено»; РК: existing entry extended — intro sentence about missing final review replaced, new paragraph «Итоговое ревью части и волна исправлений» before «Перенесено», «Перенесено» items on РК-С and queue items 6/8 updated, «Не проверено» and «Счёт» extended).

Sources: rks-task-1..5-report, rks-task-2-review, rks-final-review-report (c), rks-final-fix-report, rk-minors, OWNER-DECISIONS; infra-final-review-report (c), infra-final-fix-report, ust-task-1..7-report, ust-minors; imp-task-1-report/review, imp-task-2-report, imp-minors, OWNER-DECISIONS.

Gates: prettier --check on 4 files clean (live proof: scratch .md gave [warn], exit 1, deleted); git diff --check clean.

Notes: commit hashes and test counts come from the reports (not re-run). ИМП states plainly "не исполнен" (Task 1 only; Task 2 NEEDS_CONTEXT on pinPhc/badgePhc/badgeSalt; 3–9 parked). РК-С records that I-2 overrides the plan's «Перенесено» 4.
