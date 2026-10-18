# Plan ОЧ, Task 8 — report

Status: DONE_WITH_CONCERNS (docs only; concerns below). Commit `96209f28b` on `claude/m1` (/tmp/claude/wt/m1), base `852856087`. Tree clean.

## What was done

Three documents, one commit (`docs(standalone): plan ОЧ in AGENTS, the restore runbook and the pilot spec §27`):

- `apps/standalone/AGENTS.md`: «Facts» fragment replaced per brief (plus the receipt operators 4/5 that unmark); stale statements removed (the screen's request no longer skips a failed send's pause; the bar's `SERIALS_LOW` 100 warning replaced by `readShiftStock`; «only trace is the bar's count»); retention «Known limits» bullet replaced per brief and extended with the honest cost of the `r` clause (non-covering `outbox_shift`, hourly O(records of that shift), not measured at 600 000, covering partial index needs a new migration — not done); new section «Outbox recovery» (brief text + «Known limits of the queue screen»: writes outside the work gate / idle sign-out, offline scans count no attempts, second block with same id keeps first reason, older-pairing records only counted, inclusive threshold wording, not-run list); «Backups and restore»: mark on the LAST part, 0–64 blocks with `more`, «Left open» rewritten (first-part bullet gone, mixed-fleet limit added: stations without `more` are marked after the first part); table count 24 -> 25 (`floor_block_drops` DeviceData; counted from `TABLE_CLASSES`: 12 Disposable, 12 DeviceData, 1 Workstation); new paragraph on migration `0013` with the real cross-stream facts (shell: 0010 ХП and 0013 ОЧ here; 0011 A4 / 0012 WH belong to other streams; sqlx `VersionMissing` for a database holding a higher number than the binary knows — developer hazard only); new «Verification» by-hand bullet for ОЧ (not run on Windows / real host / touch).
- `docs/runbooks/standalone-backup-restore.md`: check 5 «Вернула» bullet rewritten (last part; empty request for a station without blocks; older-build stations marked after first part) and a bullet that the queue screen shows host refusals after a restore (`unknown_shift`/`not_entered` are pointless to resend); §8 «Отметка «Вернула»» replaces the first-part item; §8 new item on the previous pairing's records (status bar «Не отправлено прежним подключением», record N, keep data, tell the developer); a developer-only note on migration gaps / `VersionMissing` under «Порядок миграций». Brief's fragments of the old text had already been changed by ХП (empty request), so the replacement was applied by meaning, keeping the still-true clause about the former device's row.
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: appended `## 27. Уточнения плана ОЧ` at the very end. This branch's spec ends at §25 (ХП); §26 (I1) is absent here, §27 is as allocated (stated in the section itself). Added the honest limits, the mixed-fleet fact, the migration numbers and a «Не проверено» list. §24's first-part bullet left as is and superseded by a sentence in §27 (the convention ХП used for its own supersession).

## Checks (all in /tmp/claude/impl-och-t8/)

- Prettier gate live-proved (scratch `const  x   =  1` -> `[warn]`, rc 1, deleted); the three docs clean after fixing two inline code spans that prettier re-wrapped; `git diff --check` clean; `grep '\u04'`: only `src/host/pairing-code.ts:66`.
- typecheck 0, lint 0, build 0.
- Full Vitest `--testTimeout=60000 --hookTimeout=60000`: 152 files / 4721 passed / 0 failed (plan-end expectation = Task 7's 4721). No `template-editor` timeouts this run.
- Parity tests `export-parity` + `forms-parity`: 2 files / 253 passed.
- `cargo fmt --check` 0. ONE final `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: rc 0, 71 binaries, 1134 passed, 0 failed, 0 `warning:` lines.
- `graphify update .`: exit 1 (graph is untracked; same as Task 5), tree still clean.

## Concerns

- Not verified: Windows, a real host restore over LAN, WebView2, real touch (>=64 px asserted by class in jsdom only), a real refusal then «Отправить снова» on two PCs, SQLite 3.46 only via the shell's developer-machine test.
- Merge: spec §27 here is appended after §25 with no §26; when the I1 stream merges its §26, §27 must follow it. Shell migration numbering has gaps (0011/0012 from other streams): verify `local_db.rs` migration-version assertion at the merge (adapted in Task 1, journal assertion made gap-tolerant).
- Claims in the new text rest on earlier tasks' reports (open items: covering partial index not done; `floor_block_drops` never purged; the idle sign-out unmounting the screen while the write completes).
- The Task-8 brief's «Если ХП переписал пункт об индексе» case: ХП's index bullet was left untouched.
- Deviations of the plan are NOT written (controller's).
