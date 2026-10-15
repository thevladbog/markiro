# Merge report: claude/infra-rk (bab6f7e5b) into claude/integration (6c57e8f9c)

Status: DONE. Merge commit: `b02dac3f2` (parents 6c57e8f9c, bab6f7e5b), worktree /tmp/claude/wt/integ, tree clean.

## Conflict resolutions (6, all union)

- `host/src/audit.rs`: `SHIFT_EXPORT` plus `SSCC_BLOCK_REGISTER`, `BACKUP_CREATE`, `BACKUP_SETTINGS_UPDATE`.
- `host/src/server.rs`: ЧЗ/О-Ф routes (boxes, pallets, export-source, exports, pallet-report-data, box report-data) followed by the three `/v1/office/backups*` routes.
- `src-tauri/src/lib.rs`: `manage_state` doc comment names the office folder (ЧЗ) and the installer role (`role`).
- `src/host/api.ts`, `test/support/office.tsx`: both method sets (report/export/pallet methods and getBackups/startBackup/updateBackupSettings/resumeFacts).
- Pilot spec: order §18 ПЛ-Х, §20 ЧЗ, §21 О-Ф, §22 РК (was 19), §23 УСТ (was 20); §19 stays reserved for ПЛ-Ц. Fixed: §11 "в разделе 22"; РК intro and УСТ intro (taken-numbers lists rewritten; РК-С takes the next free number, not 22); `docs/runbooks/standalone-backup-restore.md` line 3 ("разделам 11 и 22"); AGENTS «Backups and restore» ("§11 and §22"). Not yet told: РК-С (its §22 is now taken, next free) and ПЛ-Ц (§19) — the caller must pass this on.
- Prettier caught my first wording of the РК intro (a wrapped line began with "19." and parsed as a list); reworded and amended into the merge commit.

## Semantic checks

- `restore_pending` appears once each in `proto/fixtures/error-codes.json`, `proto/src/lib.rs` (`codes::ALL`, once in the list) and `src/host/errors.ts` (`API_ERROR_CODES`).
- `hello-restored.json` present; `no_secrets_in_logs` `facts_files == 17` still asserted and passing; `tests/ipc.rs` compiles against `manage_state(…, role)` (workspace tests pass); `shell.test.ts` `address_changed` rows present; "Резервные копии" entry in `nav.ts`/`routes.tsx`/`access.ts` (`manageBackups`) present beside integration's office routes.
- `apps/standalone/AGENTS.md`: no duplicate `##` headings; «Shift card and printed forms» then «Backups and restore» then «Marking rules».

## Gates

- `cargo fmt --check`: clean.
- `cargo test --workspace` (unsandboxed, --offline --locked): 70 result lines, 1111 passed, 0 failed, 0 ignored.
- Vitest full (`--testTimeout=60000 --hookTimeout=60000`): 133 files, 3985 tests passed, no errors.
- Both parity tests (export-parity, forms-parity): 2 files, 232 tests passed (also inside the full run).
- typecheck, lint, build: exit 0.
- `test:standalone-release:contract`: 51/51. `test:standalone-export`: 37/37. `tools/ci` tests: 47/47 unsandboxed (2 failed in the sandbox on `mktemp` EPERM only).
- Prettier gate (cwd = worktree root, repo-relative paths from `git diff --name-only 6c57e8f9c HEAD`, 64 files): proven live with a scratch file (exit 1, removed), then clean after the fix.
- `git diff --check 6c57e8f9c HEAD`: clean. `git status --short`: empty.

## Concerns / not exercised

- Vitest, typecheck and cargo ran before the final amend, which changed only one Markdown paragraph in the pilot spec (prettier re-checked after).
- No Windows run: the first CI push is the first real `standalone-windows-build`; read `smoke.ps1` step by step, including the backups-copy check (checklist item 6).
- A few early inspection commands used `cd` inside one Bash call (read-only).
