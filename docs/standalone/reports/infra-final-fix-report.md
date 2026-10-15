# Infra stream — final fix wave report (РК + ИМП-1 + УСТ)

Status: **DONE_WITH_CONCERNS** (nothing Windows-side was run; see Concerns).
Worktree `/tmp/claude/wt/inf`, branch `claude/infra-rk`, base `310bfed51`, HEAD `bab6f7e5b`, 15 commits, `git status --short` empty. Every commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer (checked over `310bfed51..HEAD`). The session was interrupted once, after the C1 test commit. I resumed from the tree as it stood: `restore.rs` and `tests/restore.rs` were uncommitted.

## Commits (tests before production, as section (b) proposes)

| #   | SHA         | Subject                                                                                                                                                                     |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `f4aa73145` | test: a restore over a host that never finished its wizard, or another host's database, takes the unread margins                                                            |
| 2   | `3b2aca4a6` | fix: restore — the margins and the summary follow whether the current database is this copy's history (C1)                                                                  |
| 2b  | `a4ac97ff4` | test: a restore over this host's database made again by a start takes the unread margins (kills the wizard-check mutant)                                                    |
| 3   | `199b19787` | test: rotation keeps the copy it just made; the office warns of a host clock behind its newest copy                                                                         |
| 4   | `a74359674` | fix: rotation never takes the fresh copy; the clockBehind warning (I1)                                                                                                      |
| 5   | `a88c6483c` | test: the smoke test finds a verified copy in backups with the data folder's SIDs and an Administrators owner (`smoke.ps1` + contract)                                      |
| 6a  | `9508d4609` | test: a copy is flushed through a writable handle, and Administrators own the data directory                                                                                |
| 6   | `efeab3b17` | fix: a copy is flushed through a writable handle (Windows); the data folder's owner is Administrators (C2, M4)                                                              |
| 7   | `ac7e26e9a` | test: an upgrade keeps the service's account; Timeout{Running} = exit 4; broken hold read = 500; failed state read queues no copy (+ M9 unit test)                          |
| 8   | `8bca09e58` | fix: install keeps an existing account; Timeout{Running} → 4 with the NSIS text; start_backup reads before it queues; the folder-task panic keeps the list (I2, M3, M2, M9) |
| 8b  | `5c5bd6f83` | test: «Сделать копию сейчас» answers the hold it read before it asked for the copy (kills a surviving mutant)                                                               |
| 9a  | `9fa0ab79e` | test: the release evidence names the PR head, and the export tool's tests run after the domain is built                                                                     |
| 9   | `af4d13612` | fix: the release evidence names the PR head; the export tool's tests run in the Windows job (M8, M5)                                                                        |
| 10  | `f17381613` | docs: runbooks, AGENTS and pilot spec after the final review                                                                                                                |
| 10b | `bab6f7e5b` | test: the installer's exit-4 window and its log line both say the service may still be starting (kills a surviving mutant)                                                  |

Deviations from the proposed grouping:

- **Extra test commits.** 2b, 6a, 8b and 10b are test commits that pin a guard a mutant showed was unpinned. 6a is the "install tests in their own test commit first" case that the proposal allows.
- **Commit type.** Commit 9 uses `fix(standalone):` rather than `ci(standalone):`, as the dispatch asked.
- **Test edits inside fix commits.** Some fix commits change existing tests mechanically, because the behaviour they pinned changed:
  - commit 6: `tests/install.rs` — the step sequences and the `runs[…]` indexes now include the two owner `icacls` runs;
  - commit 8: `a_second_install_over_a_stopped_service…` now expects `account: None`, the I2 behaviour.

## What changed, per finding (triage decision → done)

- **C1 (FIX).** Code: `host/src/restore.rs`. Tests: `host/tests/restore.rs` +3.
  - `read_live` now also returns whether the wizard was done (`site.initialized_at`).
  - `restore_until` computes `history_known = current == Read && initialized && !foreign`. `foreign` means no `host.json` (a new identity) or a manifest host id that differs from this folder's.
  - When `!history_known`:
    - `unread_sscc_floor` and the `UNREADABLE_CURRENT_MARGIN` audit jump apply;
    - revocations are not carried (`carried = None`), so the summary prints "the previous database was not read: … active again";
    - a new line says "the current database is not this copy's history (a new host, one whose wizard never finished, or another host's): every SSCC counter is at least 100000 above the copy's highest number".
  - Live numbers still count as floors. `RestoreReport.history_known` is new, and `audit_floor` takes `history_known`.
  - Tests:
    - the reviewer's new-PC scenario: counters 110 000/110 000 instead of 9500/440, `carried == None`, both lines, audit id = copy + 1 000 000 + 1, `details.carried == null`;
    - a copy of host A restored over an initialized host B;
    - this host's own `host.json` beside a database made again by a start.
- **C2 (FIX).**
  - `host/src/backup/copy.rs` gains `pub fn sync_file`, which opens the file for writing and then calls `sync_all`. `make_copy` uses it, and `restore.rs` drops its private copy and imports it.
  - `tools/standalone-release/smoke.ps1`, in the host step:
    - waits up to 120 s for a `markiro-host-*.db` with its `.json` in `backups`;
    - checks that the `backups` folder and the copy have exactly `S-1-5-18,S-1-5-19,S-1-5-32-544`.
  - `workflow.test.mjs` pins those checks.
  - The seam test, as allowed: `a_copy_is_flushed_through_a_handle_opened_for_writing` (Unix, mode 0444 → `PermissionDenied`). It kills a read-only `sync_file`. The call-site mutant (`File::open(&partial)?.sync_all()` in `make_copy`) **cannot be killed on Unix**; only the Windows smoke step can catch it.
- **I1 (FIX).**
  - `folder::rotate(dir, keep_also)` always keeps the copy the run just made. The worker passes `manifest.file` for both folders.
  - `backup-warnings.ts` adds `clockBehind`: the newest copy of either folder is more than 1 h after the host's `now` (`CLOCK_AHEAD_MS`). `ru.json` has the text.
  - Tests:
    - a `backup_copy` rotate test with 30 later copies;
    - a `backup_worker` test with copies a week ahead in both folders;
    - Vitest for the bound (exactly 1 h is quiet, 1 h + 1 s warns), each folder, tone and key.
- **I2 (FIX).**
  - `ServiceSpec.account: Option<&'static str>`. `register_and_start(existed, …)` sets `None` for an existing service.
  - `install_windows.rs` maps `None` → `account_name: None`, which ChangeServiceConfigW receives as NULL and leaves alone. I checked this in the windows-service 0.8.1 source.
  - The create branch uses `spec.account.unwrap_or(SERVICE_ACCOUNT)`, so a new service is never LocalSystem.
  - Tests: upgrade → `account: None`; the fresh spec → `Some(LocalService)`.
- **M1 (FIX, test only).** `restore_hold.rs`: `site.facts_held_since` is renamed, so facts and code checks answer 500 `internal`. The reviewer's fail-open mutant `.unwrap_or(None)` is now KILLED.
- **M2 (FIX).**
  - `start_backup` reads the settings and the hold in a rolled-back transaction first. Then it calls `request_manual`, then builds the state from memory.
  - Tests: a failed read → 500, then GET `running == null`, then POST → 202. A held host's POST answer carries the hold (commit 8b).
- **M3 (FIX).**
  - `failure_code` maps `Timeout { waiting_for: Running }` → 4. `Timeout { Stopped }` stays 1.
  - The NSIS DetailPrint and MessageBox say «не осталась запущенной или ещё запускается» and suggest `sc query`.
  - Unit test plus a hook-text contract on both lines (commit 10b).
- **M4 (FIX).**
  - Before the grant, `install` now runs:
    - `icacls <Markiro parent> /setowner *S-1-5-32-544`, only when the parent folder is named `Markiro`, so no drive root or `ProgramData` is touched;
    - `icacls <data dir> /setowner *S-1-5-32-544 /T /C`.
  - The smoke test checks `GetOwner(SecurityIdentifier)` = `S-1-5-32-544` for the data dir and for `%ProgramData%\Markiro`.
- **M5 (triage CARRY; done anyway because the dispatch asked explicitly — see Concerns).** `ci.yml` standalone-windows-build gets `- run: pnpm test:standalone-export` right after `pnpm turbo build --filter '@markiro/standalone...'`, which builds `@markiro/domain`. A contract test pins the order.
- **M6 (DOC).** The month key example is now `OCT26`. PIN and badge changes made after the copy revert (§4 and §7 check 3). "хеши ключей устройств" in §2 and spec §19.
- **M7 (DOC).** The restore runbook (§5 preamble, §6 step 1) and spec §19 now say every PC of the site must be on the host's version before a restore. The schema was not relaxed.
- **M8 (FIX).** The prepare step gets `env: PR_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}` and uses `--source-sha "$env:PR_HEAD_SHA"`. The no-step-env contract now exempts exactly that step, and a separate test pins its `env`.
- **M9 (FIX).**
  - `worker.rs` adds a `folder_outcome` helper: when the folder task did not finish, it returns `Err` lists, which do not overwrite the status, and the second folder gets an `internal` failure.
  - Test: a `#[cfg(test)]` unit test that builds a real `JoinError` from a panicking `spawn_blocking`.
- **Docs (commit 10).**
  - `standalone-backup-restore.md`: §1 copy-now, retention and warnings; §2 account, hashes, owner; §4; §5 step 5; §6 step 3; §7 checks 1 and 3; §8; §10.
  - `standalone-install.md`: account kept, owner, exit 4 also covering "still starting", the CI list.
  - `apps/standalone/AGENTS.md`: «Installer and service» and «Backups and restore».
  - Pilot spec §19/§20.
- **РК-С input.** Appended as item 11 of `.superpowers/sdd/rk-minors.md`. Not implemented: after a new-PC restore, re-paired stations have new device ids, so the copy's blocks answer `block_mismatch` and facts from them get `sscc_not_issued`. It lists options (a), (b) and (c).
- **Not written:** the plan's «Отклонения при исполнении» entries (left to the controller).

## RED / GREEN evidence (logs under `/tmp/claude/fix-infra-final/`)

- **C1.**
  - RED: `c1-red.txt` — both tests failed with `left: [("460068200", 0, 9500), ("460068200", 1, 440)]`.
  - Commit 2b's test RED against the pre-fix `restore.rs` (swapped in temporarily and restored, `cmp` ok): `c1b-red.txt`.
  - GREEN: `c1-green-{1,2,3}.txt` (32/32 ×3); final 33/33 ×3.
- **I1.**
  - RED: `i1-red-worker.txt` (the copy was gone), `i1-red-copy.txt` (E0061 compile error on the new `rotate` signature), `i1-red-vitest.txt` (1 failed).
  - GREEN: `i1-green*.txt`.
- **C2/M4.**
  - RED: `c2-red-contract.txt` (contract 1 failed), `c2-red-seam.txt` (E0432: `sync_file` missing), `m4-red.txt` (owner args missing).
  - GREEN: `c2-green*.txt`.
- **Commit 7.**
  - RED: `r7-install.txt` (E0308 on `Option`), `r7-routes.txt` (running = manual after the 500), `r7-bin.txt` (left 1 right 4), `r7-lib.txt` (E0425), `r7-nsis.txt` (1 failed).
  - `r7-hold.txt` passed at once: the code was already right, and the test pins it (the mutant table shows it now kills fail-open).
  - GREEN: `g8*.txt`.
- **CI.** RED: `ci-red.txt` (2 failed). GREEN: `ci-green.txt` (51/51).

## Mutants (harness `/tmp/claude/fix-infra-final/mut.py`, log `mutants.txt`, one log per mutant)

The harness copies the file to `before-<name>`, applies the mutant, runs the suite, restores, touches the file, and checks SHA-256 plus `cmp`. Every row below is `restored=True`.

| Mutant                                                                     | Result                                                                                              | Killed by                                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| c1-drop-foreign (`initialized && !foreign` → `initialized`)                | KILLED                                                                                              | another-host test                                                                                                                              |
| c1-drop-initialized                                                        | first SURVIVED (the new-PC case also has a new identity) → commit 2b → c1-drop-initialized-2 KILLED | made-again test                                                                                                                                |
| c1-initialized-always (`is_some() \|\| true`)                              | KILLED                                                                                              | made-again test                                                                                                                                |
| c1-carry-always (`revoked.filter` dropped)                                 | KILLED                                                                                              | both C1 tests                                                                                                                                  |
| c1-audit-margin-by-current                                                 | KILLED                                                                                              | both                                                                                                                                           |
| c1-no-summary-line                                                         | KILLED                                                                                              | both                                                                                                                                           |
| c1-foreign-none-false (`is_none_or` → `is_some_and`)                       | SURVIVED — **equivalent**                                                                           | `existing == None` implies no `host.db` (`would_orphan_host_data` refuses otherwise), so `current == Absent` and the history is unknown anyway |
| i1-rotate-ignores-keep                                                     | KILLED                                                                                              | rotate test                                                                                                                                    |
| i1-worker-local-none / -second-none                                        | KILLED                                                                                              | worker clock-back test                                                                                                                         |
| i1-ahead-bound-ge / -local-only / -second-only / -sign                     | KILLED                                                                                              | Vitest clockBehind (+ stale tests for -sign)                                                                                                   |
| c2-smoke-no-copy-wait / -no-manifest / -copy-sids / -owner / -owner-parent | KILLED                                                                                              | workflow contract                                                                                                                              |
| c2-sync-readonly (`sync_file` via `File::open`)                            | KILLED                                                                                              | seam test                                                                                                                                      |
| c2-callsite-readonly (`make_copy` back to `File::open(..).sync_all()`)     | SURVIVED — **not killable on Unix** (stated)                                                        | only `smoke.ps1` on Windows                                                                                                                    |
| m4-no-recursive / -no-parent / -no-dir-owner / -owner-sid                  | KILLED                                                                                              | owner test (+ order tests)                                                                                                                     |
| m4-any-parent (no `Markiro` name check)                                    | KILLED                                                                                              | `install_opens_the_port_the_host_was_configured_with`                                                                                          |
| i2-always-some                                                             | KILLED                                                                                              | upgrade test, second-install test                                                                                                              |
| i2-fresh-none                                                              | KILLED                                                                                              | spec test                                                                                                                                      |
| m3-timeout-1                                                               | KILLED                                                                                              | bin exit-code test                                                                                                                             |
| m3-nsis-text                                                               | first SURVIVED (the DetailPrint kept the phrase) → commit 10b → -text-2 and -detail KILLED          | installer contract                                                                                                                             |
| m1-fail-open (`.unwrap_or(None)`, the reviewer's M6)                       | KILLED                                                                                              | `a_hold_that_cannot_be_read…`                                                                                                                  |
| m2-queue-first                                                             | KILLED                                                                                              | 4 route tests                                                                                                                                  |
| m2-no-hold (answer without hold)                                           | first SURVIVED → commit 8b → -no-hold-2 KILLED                                                      | held-host test                                                                                                                                 |
| m9-empty-list / -second-empty                                              | KILLED                                                                                              | worker unit test                                                                                                                               |
| m8-merge-sha / -env-value                                                  | KILLED                                                                                              | PR-head contract                                                                                                                               |
| m5-no-export / -export-first                                               | KILLED                                                                                              | export-order contract                                                                                                                          |

## Windows `cfg(windows)` re-check

Probe crate: a copy of `/tmp/claude/ust-probe2` in `/tmp/claude/fix-infra-final/probe` (uncommitted). It `#[path]`-includes the real `install.rs`, `install_windows.rs`, `network_profile.rs` and the `cfg(windows)` fns of `main.rs`, with `#![deny(warnings)]`.

- `cargo check --offline --target x86_64-pc-windows-msvc` → 0 errors, 0 warnings. `cargo clippy` with the same target → clean. The macOS check is clean too.
- Liveness: a mutant `account_namez` in `install_windows.rs` fails the msvc probe with E0560. The file was restored (`cmp` ok) and touched.

## Gates

- `cargo fmt --check` clean.
- `cargo check -p markiro-host -p markiro-proto --all-targets` → 0 warnings.
- `cargo clippy -p markiro-host --all-targets`: the only warning is the existing one at `host/tests/facts.rs:83`, a file I did not touch.
- Focused suites, final:

  | Suite            | Result   |
  | ---------------- | -------- |
  | restore          | 33/33 ×3 |
  | backup_copy      | 28       |
  | backup_retention | 4        |
  | backup_worker    | 13       |
  | backup_routes    | 14       |
  | backup_schema    | 5        |
  | install          | 28       |
  | installer_cli    | 7        |
  | restore_hold     | 9        |
  | known_blocks     | 11       |
  | network_profile  | 8        |
  | lib              | 90       |
  | bin              | 8        |

- **ONE unsandboxed `cargo test --workspace --no-fail-fast`:** exit 0, 67 result lines, **1029 passed**, 0 failed, 0 ignored, 0 warnings. The baseline was 1019, so +10.
- Node:
  - `pnpm test:standalone-release:contract` 51/51 (baseline 48, +3 tests);
  - `pnpm test:standalone-export` 37/37, 0 skipped;
  - `node --test tools/ci/test/*.test.mjs` 47/47 (unsandboxed; inside the sandbox two tests fail on `mktemp` EPERM).
- Webview: typecheck 0, lint 0, build 0.
- Full Vitest at `--testTimeout=60000 --hookTimeout=60000`: **107 files / 3142 tests passed** (baseline 3141, +1).
- `backup-warnings.test.ts` verbose run: stderr empty. The delayed-`setImmediate` stand does not apply, because the test covers a pure function with no React or effects.
- PRETTIER GATE (cwd = repo root, `pnpm --dir /tmp/claude/wt/inf exec prettier --ignore-path .prettierignore --check …`):
  - proved live: a scratch `apps/standalone/src/zz-prettier-scratch.ts` → "Checking formatting…", `[warn]`, exit 1; then deleted;
  - then clean over all 10 changed TS/JS/JSON/MD/YAML files (`git diff --name-only 310bfed51..HEAD`); `--file-info` shows none of them ignored. `.rs`, `.ps1` and `.nsh` files are not covered by prettier.
- `git diff --check 310bfed51..HEAD` clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` → only `src/host/pairing-code.ts:66`. No `\u0` in added Rust, SQL or JSON lines.
- `git status --short` is empty, and no scratch files are left.

## Concerns

1. **Nothing ran on Windows.** That covers the C2 behaviour itself, `icacls /setowner` (including whether `/C` still gives a non-zero exit when an item fails), the kept account through ChangeServiceConfigW NULL, exit 4 on Timeout through NSIS, and the new smoke steps. The first `standalone-windows-build` run is the proof.
2. **The C2 call-site mutant survives on Unix by nature.** Only the smoke step's verified-copy wait catches it.
3. **M5 conflict.** The triage table says CARRY to ИМП Task 3, but the dispatch explicitly asked me to add the CI step after the domain build, so I added it. If the controller prefers the triage, revert the one `run:` line plus its contract test (`9fa0ab79e` / `af4d13612` also hold M8, so take care when reverting).
4. **M4 residual.** If a user pre-created `%ProgramData%\Markiro`, `ProgramData`'s inherited CREATOR OWNER grant on that folder stays after the owner reset, so that user could still rename `Host` away while it is closed. The install runbook says so. A full fix would harden or refuse a pre-existing `Markiro` folder. Not done; a candidate CARRY.
5. **Wording of the "not read" line.** When the database was read but is not the copy's history (new PC, another host), the reused summary line still begins "the previous database was not read". The new line printed before it gives the real reason, the runbook explains both, and the existing tests pin the old line's text.
6. **Merge notes.**
   - `install.rs`, `install_windows.rs`, `main.rs`, `routes/backups.rs` and `worker.rs` changed; `audit.rs`, `server.rs` and `lib.rs` (the union conflicts) were not touched.
   - The pilot spec §19/§20 got text edits inside those sections, so they will move with the renumbering at merge.
