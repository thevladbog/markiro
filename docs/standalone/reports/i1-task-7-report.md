# Plan I1, Task 7 report: documents (runbook, install, AGENTS, pilot spec §26) and the full check

Status: DONE_WITH_CONCERNS. Commit `9942dcf7c` on `claude/m2` (BASE `f10dacf70`, the merge of `claude/integration`). `git status --short` is empty after the commit. One `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## What was done (docs only, no code)

Files: `docs/runbooks/standalone-backup-restore.md`, `docs/runbooks/standalone-install.md`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`. The brief's fragments were applied by exact-once replacement scripts (`/tmp/claude/impl-i1-t7/*.py`), then adapted to the true shape from the Task 1-6 reports and the code.

- Runbook section 2: the triple of files, `verify-copy` identity lines, and a new bullet "Ключ хоста в копиях": who can read the file, how the host closes it (empty file first, then `icacls` SYSTEM + Administrators + OWNER RIGHTS, or `0600`), what happens when the folder cannot hold the permissions (copy without the key, office warning, "нет" in the column), protect the share and USB drives like the host PC, ACLs are not encryption (the admin of the share PC can read it), leak means calling support (no command), Windows unverified (section 10, item 11).
- Section 5: restore-summary line for the identity; step 6 got the Task 4 limits: after "an interrupted restore was found: it had finished" the "revocations active again" line of the first run is lost, so do check 3; an orphan `identity.partial` may remain (key copy, next restore removes it).
- Section 6 rewritten: stations keep their pairing with a copy carrying the identity; copy selection, install without wizard, the three files, `verify-copy`, restore summary lines (incl. `--take-identity` / `--keep-identity` / damaged / port), step 7 on the NEW ADDRESS (give the new PC the old IP/name, or «Сменить адрес хоста» on every station and office PC; the office signs in again because a restore ends all sessions; no network discovery), old PC's service disabled; "Что теряется и на новом ПК с ключом хоста"; "Копия без ключа хоста" keeps the old loss text (what still loses the pairing: older copy, unclosable folder, lost/damaged/tampered key, `--keep-identity`, stations paired after the copy). The "open owner decision" paragraph and heading are gone.
- Sections 7-10 and header: check 1, the preface, section 8 items (new PC, key in copies, copy of another host, interrupted restore), "not implemented" list, checklist, section 10 items 9 (third and fourth runs) and 10, new item 11 (Windows ACL checks). References to the renamed subsection updated.
- `standalone-install.md`: new-address bullet for a restore with the key; the "why the data folder is protected" bullet mentions the `.identity` files.
- `AGENTS.md`: identity bullet in "Backups and restore", the restore paragraph (`identity_plan`, flags, staging, C1 `foreign`), the two interrupted-restore limits, the "NEW PC" paragraph rewritten (no "open owner decision"), Verification list.
- Spec: §22 ("not done" list and restore bullet), §24 (status-line bullet; the open owner decision replaced by the decided text), new §26 appended at the end (the spec ended at §24 on this branch; §25 is not present).

## Differences from the brief's wording (all by meaning, for honesty)

1. The UI label is «Сменить адрес хоста» (`ru.json`, `HostAddressDialog.tsx`), not «Изменить адрес хоста»; used the real one in the docs.
2. The office warning text is «Рядом с последней копией … нет ключа хоста …» (as Task 5 wrote it), not «Последняя копия во второй папке — без ключа хоста…».
3. "Файл защищается" text states the order from Task 1 (protected while still empty), OWNER RIGHTS, and that the list cannot tell a missing key from a damaged one (Task 5).
4. Section 6 step 6 says "revocations carried over" must be absent only in an uninterrupted run (Task 4 concern 1).
5. Extra stale statements found and fixed that the brief did not list: the file header (spec list, "Не покрыто"), section 7 "Только строка …", section 5 pair-of-files mention, section 8 "Не реализовано" (also "проверка прав папки до сохранения" from the plan's «Перенесено»), cross-reference names, spec §22 "копия удостоверения хоста" in two places, the `verify-copy` description.

## Step 8 (plan РК-С file)

`docs/superpowers/plans/2026-10-11-standalone-rk-s-station-restore.md` is NOT in this tree (only `2026-07-29-...i1-integrations...` matches `i1`/`rk-s` listing); skipped. The controller should record it under «Отклонения при исполнении».

## Gates

- `cargo fmt --all -- --check`: clean.
- ONE final full `cargo test --workspace --offline --locked --no-fail-fast`, unsandboxed: 72 result lines, **1189 passed, 0 failed, 0 ignored**, exit 0, 0 warnings (equals Task 6; no Rust changed). Log `/tmp/claude/impl-i1-t7/workspace.txt`.
- `typecheck`, `lint`, `build`: exit 0.
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: **148 files, 4612 tests passed**, exit 0. A first run had 3 failures in `forms-parity.test.ts` (golden says «ПАЛЕТА», received «ПАЛЛЕТА»): `packages/domain/dist` was stale (built before commit 26572c386). After `pnpm --filter @markiro/domain build` (untracked build output) the full run is green. Not a defect of this task, but a fresh-worktree trap.
- Both parity tests: `markiro-proto --test backup` 6 passed; `test/backups.test.ts` 7 passed.
- Prettier gate proven live (a mis-formatted scratch `.md` failed with exit 1 and was deleted), then clean on the 4 files. Prettier first reformatted two inline-code spans broken across lines in the runbook, which unindented list continuations; I rewrote those lines so no code span crosses a line and rechecked.
- `git diff --check` clean; `grep -rnF '\u04'` only `pairing-code.ts:66`. `graphify-out` does not exist in the worktree, so no graph update.

## Not verified (stated in the docs as such)

Windows `icacls` on NTFS / shares / FAT32 and exFAT, owner and OWNER RIGHTS under `LocalService` and a local account, rename over `tls\key.der`, `tls\cert.der`, `host.json` under antivirus, a real second PC with DHCP/DNS and the firewall port, the WebView2 office column and warnings, and the shell/station reaction to the new `restoreEpoch` after an address change. No browser, hardware or Windows check was done.

## Concerns

1. The restore summary line printed by the host (`restore.rs` ~2402) says «Офис → «Изменить адрес хоста»», while the UI button is «Сменить адрес хоста». A host text fix (one string) would remove the mismatch; the docs use the real label.
2. The list cannot tell "no key" from "damaged key" (Task 5 concern 1); the spec §26 and the docs say so and list the distinction as not done.
3. `identity.partial` can stay after a cut before the marker; the runbook tells the engineer not to copy it and to ask the developer how to remove it (the next restore removes it, but there is no instruction for a one-off manual removal).
4. The `rules` file `i1-implementer-rules.md` describes a floor plan; followed the dispatch standard and the brief.
5. Deviations are left for the controller as asked.
