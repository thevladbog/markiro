# Infra stream — final whole-part review (РК 1–8, ИМП Task 1, УСТ 1–7)

Branch `claude/infra-rk`, HEAD `310bfed51`, base `370ec784c`, 18 commits. Worktree `/tmp/claude/wt/inf`; it was clean at the start and is clean at the end (`git status --short` is empty, HEAD unchanged).

## Verdict

**NEEDS FIXES.** Critical 2, Important 2, Minor 9.

Most of the stream holds up. The restore swap with the intent marker, the counter floors, the copy+1 revision, carrying revocations forward, the WAL fold, the hold layer, known-block registration, the role separation, the CI job's secret hygiene and the installer's role file all check out. All but one of my 12 mutants were killed (Evidence).

Two defects sit on the paths the stream exists for:

- **C1.** The runbook's new-PC restore procedure gives a 2-block SSCC margin, not the promised 100 000, and its output tells the engineer the old database "was read". I reproduced this.
- **C2.** On Windows every local copy will fail. The copy is flushed through a read-only handle, and `FlushFileBuffers` requires write access.

Neither shows on macOS, and no test or smoke step would catch either.

---

## (a) Findings, most severe first

### C1 — Critical — restore on a new PC (runbook §6) gets only the 2-block margin and reports "revocations carried over"

**Where:**

- `host/src/restore.rs:661-681` (`current_state`)
- `:1696` (`if current != Current::Read` gates the unread margin)
- `:1539-1546` (`audit_floor`)
- `:1759-1762` (carried)
- `:1872-1881` (summary)
- `docs/runbooks/standalone-backup-restore.md` §6 steps 1–3, §5 step 5, §7 checks 1 and 3

**Failure scenario:**

1. Runbook §6 step 1 says to install «Markiro Автоном» with the host role and not run the wizard.
2. `markiro-host install` starts the service and waits until it runs. `crate::start` → `db::open(create_if_missing)` creates a migrated, **uninitialized** `host.db`, plus `host.json` and `tls/`.
3. Step 2 stops the service. Step 3 restores the second-folder or flash-drive copy.
4. `current_state` opens that empty database read-only. That succeeds, so it returns `Current::Read` with empty floors.
5. The result:
   - every counter is the copy's floor + 2 blocks. The 100 000 margin that the runbook (§6 step 3, §8), AGENTS «Backups and restore» and the pilot spec §19 promise for this case is never applied;
   - the audit sequence gets no +1 000 000 margin;
   - the summary prints `revocations carried over from the previous database: 0 devices, 0 operators, 0 badges, 0 office users` instead of `the previous database was not read: … are active again`.
6. Runbook §5 step 5 and §7 check 1 tell the engineer that line means "the old database was read", so check 1 is "only insurance". That leads straight to re-issued SSCCs, and revoked devices, badges and operators come back unannounced.

The same happens when a copy from host A is restored over an initialized database of another host B (`other_host` = true): B's numbers say nothing about what A issued after the copy.

**Evidence:** scratch test `/tmp/claude/rev-infra/zz_rev_scratch.rs` (deleted from the tree afterwards; log `/tmp/claude/rev-infra/scratch1.log`). It issues two box blocks on host A, makes a copy, creates a fresh data folder with `HostConfig::load_or_create` + `db::open` (what the installer's first start leaves), then restores. Output:

- `current = Read`
- `SSCC 460068200/0: 5500 -> 9500` and `460068200/1: 40 -> 440`; the unread rule would give 110 000 / 110 000
- `revocations carried over from the previous database: 0 devices…`
- `the copy was made by another host…`

**Fix (production):**

- Compute a single `history_known = current == Read && live_initialized && !other_host`. `live_initialized` is `site.initialized_at IS NOT NULL`, read in `read_live` (an uninitialized database issued nothing).
- When `!history_known`:
  - apply `unread_sscc_floor` and the `UNREADABLE_CURRENT_MARGIN` audit margin;
  - set `carried = None`, so the summary prints the "not read … active again" line;
  - print a distinct line, e.g. "the current database is not this copy's history (a new or unfinished host): every SSCC counter is at least 100000 above the copy's highest number".
- The live floors still count as floors; only the margins and the wording change.

**Fix (tests):**

1. The scratch scenario as a real test: counters `(PREFIX,0,110_000)` and `(PREFIX,1,110_000)`, `carried == None`, the "not read" summary line, and the audit row id ≥ copy + 1 000 000.
2. A copy of host A restored over an initialized host B: the margins apply.
3. A mutant that drops `!other_host` or `live_initialized` must fail.

**Docs:** runbook §6 step 3 must name the line the engineer will actually see. §5 step 5 and §7 checks 1 and 3 must stop equating "revocations carried over" with "read".

### C2 — Critical — on Windows every local copy fails: `sync_all` on a read-only handle

**Where:** `host/src/backup/copy.rs:369`:

```rust
fs::File::open(&partial)?.sync_all()?;
```

**Failure scenario:**

- `File::open` gives a `GENERIC_READ` handle, and `sync_all` is `FlushFileBuffers`. Win32 documents that "the file handle must have the GENERIC_WRITE access right", and otherwise the call fails with `ERROR_ACCESS_DENIED` (5).
- So on Windows `write_copy` fails after the copy was written and verified. `make_copy_tagged` removes the partial, and `classify_io` maps the error to `access_denied`.
- Every scheduled, startup and manual copy fails: the office shows «нет прав на запись» for the host's own folder, and no copy ever exists on the only target platform.
- `restore.rs:785-789` (`sync_file`) shows the author of the restore code knew this ("on Windows a flush needs write access, and a read-only handle is refused"). The copy path was missed, and nothing ran on Windows.
- `smoke.ps1` never checks that a copy appears, so CI would stay green.

**Fix:**

- Production: `fs::OpenOptions::new().write(true).open(&partial)?.sync_all()?`, ideally through one shared `sync_file` helper in `backup/copy.rs` that `restore.rs` reuses.
- Smoke: after "the host answers", add a step to `tools/standalone-release/smoke.ps1`:
  - wait up to 120 s until `%ProgramData%\Markiro\Host\backups` holds a `markiro-host-*.db` with its `.json`;
  - check that the copy's SIDs are exactly `S-1-5-18,S-1-5-19,S-1-5-32-544`. This also proves on CI that `backups\`, created before `icacls`, got the propagated ACL;
  - update `tools/standalone-release/test/installer.test.mjs` / `workflow.test.mjs`, whichever pins the smoke checks.

**Confidence:** high (documented Win32 contract), but not run on Windows.

### I1 — Important — a clock set back makes every new copy rotate away at once while the office stays green (rk-minors 6, still open)

**Where:**

- `host/src/backup/folder.rs:82-101` (`rotate`) and `retention.rs` (`keep`)
- `worker.rs:500-523` (rotate right after `make_copy` / `replicate`)
- `src/office/backups/backup-warnings.ts:35-38` (`stale`)

**Scenario:**

- Suppose the host clock goes back by a day or more: a CMOS reset, manual setting, or an offline site without NTP.
- With ≥24 newer copies and the copy's day and month already represented by newer copies, `keep` drops the fresh verified copy in the same run. Every later run does the same until the clock passes the newest copy.
- `scheduled_due` sees "no copy of today" every hour, because the newest copy is dated in the future. So the host copies hourly and deletes each copy.
- The office stays green:
  - `lastAttempt` is `ok`;
  - `stale()` computes `now − future` < 0, so there is no warning;
  - the copy list still shows the old copies.
- The database goes uncopied for as long as the skew lasts. The runbook only says "do not set the clock back".

**Fix:**

- Production:
  - `folder::rotate(dir, keep_also: Option<&str>)` never deletes the copy just made; the worker passes `manifest.file` for both folders;
  - add a warning `clockBehind` (newest copy's `createdAt` later than the host's `now` + 1 h) in `backup-warnings.ts` and `ru.json`.
- Tests:
  - a folder with 30 copies dated after a fresh one: `rotate` keeps the fresh one;
  - a worker test with the clock set back a week: the run's copy is still listed;
  - Vitest for `clockBehind`;
  - mutants for both.

### I2 — Important — every reinstall (the only update path, П13) resets a customised service account

**Where:** `host/src/install_windows.rs:91` (`account_name: Some(OsString::from(spec.account))` passed to `change_config` for an existing service), and `install.rs:242`.

**Scenario:**

- The plan's own answer to П14 (rk-constraints: "вторая папка по сети работает, когда служба запущена под … `markiro-backup`") needs IT to switch the service account.
- Every update by reinstall runs `change_config` with `NT AUTHORITY\LocalService` and silently reverts it.
- After the update the network second folder fails («нет прав на запись»): copies stop reaching the off-host folder until someone reads the office warning and repeats `sc config … password=` by hand.
- The runbooks document the manual step; the code makes it necessary after every update.

**Minimal code change:**

- Make `ServiceSpec.account` an `Option<&'static str>`.
- `install()` already knows `existed` (from `stop`), so it can pass `account: None` for an existing service: `register_and_start(existed, …)`.
- `WindowsServices::configure` maps `None` to `account_name: None, account_password: None`. `ChangeServiceConfigW` with a NULL start name and password leaves both unchanged.
- A fresh install keeps `LocalService`.
- Test in `host/tests/install.rs`: the upgrade path's configured spec has `account == None`, and a fresh install's has `Some(LocalService)`. Mutant: always `Some`.
- Then drop the manual step from `standalone-install.md` (lines 83–85, 325–326), AGENTS «Installer and service» and spec §20.

### Minor

1. **M1 — the hold's fail-closed read has no test.**
   - Code: `host/src/server.rs` (`restore_hold`, `.map_err(ApiError::internal)?`).
   - My mutant `…unwrap_or(None)` (fail-open: facts pass through when the read fails) SURVIVED the `restore_hold` suite.
   - The code is right; the guarantee is unpinned.
   - Test: `ALTER TABLE site RENAME COLUMN facts_held_since TO x`, then `POST /v1/device/facts` → 500 `internal`, not the route's answer.
2. **M2 — `start_backup` answers 500 after the copy was queued (rk-minors 8).**
   - Code: `routes/backups.rs:118-127`. The runbook (§1) papers over it.
   - Fix: read the settings and hold in the transaction first, roll back, then `request_manual`, then build the state from memory (it cannot fail).
   - Test: break the settings read → 500 and no copy queued (`running == null` on the next GET once fixed).
3. **M3 — the install wait's `Timeout { waiting_for: Running }` exits 1 although the service stays registered.**
   - Code: `host/src/main.rs:failure_code`, `installer-hooks.nsh` (code ≠ 0/4 → `MARKIRO_FAIL`, abort).
   - A slow first migration makes the installer report a failure over a service that comes up a minute later.
   - Fix: map `Timeout { waiting_for: Running }` to 4 (or a new 5), and widen the NSIS warning text ("не осталась запущенной или ещё запускается"). `Timeout { Stopped }` from the pre-stop stays 1.
   - Tests: unit test plus a hook text test.
4. **M4 — the data directory's owner is never reset.**
   - Code: `install.rs:355-364` (`icacls … /inheritance:r /grant:r`).
   - A local user can pre-create `%ProgramData%\Markiro\Host`: ProgramData gives Users create-folder rights. That user stays owner and keeps implicit `WRITE_DAC` after the installer's ACL, so they can re-grant themselves read access to `host.db` and `tls\key.der`.
   - Fix: a second `icacls <dir> /setowner *S-1-5-32-544 /T /C` (and the same for `%ProgramData%\Markiro`), or refuse to install when the owner is not SYSTEM or Administrators.
   - Smoke: add `(Get-Acl $dataDir).Owner` → Administrators SID.
5. **M5 — `pnpm test:standalone-export` (ИМП Task 1, 37 tests) runs in no CI job.**
   - `tools/standalone-export/` classifies as null, i.e. HEAVY (full run), but no job invokes the script.
   - Harmless while nothing imports `sscc.mjs`. CARRY to ИМП Task 3 (imp-minors 3, m5).
6. **M6 — backup runbook inaccuracies.**
   - §5 step 5 gives the example `shift numbers 2026-10: …`; the real key is `OCT26` (`months_between` → `shifts::month_key`).
   - §4 «Что восстановление не возвращает» names only office passwords. PIN and badge changes made after the copy also revert: a leaked PIN changed after the copy works again. Add it to §4 and §7 check 3.
   - §2 says copies hold "ключи устройств"; §0 correctly says "хеши ключей устройств".
7. **M7 — a station on an older build rejects a restored host's `hello`.**
   - The old `helloSchema` is `.strict()`, so it refuses `restoreEpoch`. A strict schema accepting the field as optional is plan-mandated; the gap is mixed versions across PCs.
   - DOC: the restore runbook requires every PC on the same version before a restore.
8. **M8 — the release evidence names the PR's merge commit, not the head.**
   - `.github/workflows/ci.yml` passes `--source-sha "$env:GITHUB_SHA"`. On `pull_request` that is the synthetic merge commit, so `release-evidence.json` names a commit that is not on the branch.
   - Fix: pass `PR_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}` through `env:` (not inline) and use `$env:PR_HEAD_SHA`.
9. **M9 — a panic in the folder task clears the local copy list.**
   - Code: `worker.rs:536-540` (`(Ok(Vec::new()), …)`).
   - A panic in the folder blocking task blanks the local copy list in the status, so the office shows "нет проверенных копий" until the next good run. Keep the previous list instead (`Err` → do not overwrite).
   - Cosmetic.

---

## Seams — what I checked

### 1. The restore path after the fix round

**Crash matrix with the intent marker.** D = data folder, S = `host.db.partial`, A = `restore-T/`, M = `host.restore-intent`.

| #   | Cut after                                                | On disk                                               | `start` / service                                                                       | Re-run of `restore`                                                                                                                                 |
| --- | -------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | verify, lock, `load_or_create`                           | unchanged (maybe a new `host.json` in a fresh folder) | starts on the old db                                                                    | ok                                                                                                                                                  |
| 1   | `finish_interrupted` / `remove_staging` / reading floors | old db; Visit removes the `-wal`/`-shm` it created    | ok                                                                                      | ok                                                                                                                                                  |
| 2   | staging (place, migrate, raise, settle, sync, check)     | old db + S, no M                                      | ok (S is an orphan)                                                                     | `remove_staging` first, ok                                                                                                                          |
| 3   | `write_intent` (`.partial` written, not renamed)         | `M.partial` + S                                       | ok (only M counts)                                                                      | ok (`create_private(…, false)` truncates the stale partial)                                                                                         |
| 4   | M renamed, A created (empty)                             | M, S, old db, empty A                                 | **refuses** (lock taken, then `refuse_unfinished`; service exits 1, retried every 60 s) | S exists → `put_back` (nothing), remove A, M, S → RolledBack → normal restore                                                                       |
| 5   | WAL → A                                                  | M, S, db without its WAL, WAL in A                    | refuses                                                                                 | RolledBack: WAL back beside db (stale `-shm` in D is rebuilt), then read **with** the WAL ✓ (C2 of the task review is closed)                       |
| 6   | db → A                                                   | M, S, no db                                           | refuses (no empty db is created: the marker check comes before `db::open`)              | RolledBack: all three back ✓                                                                                                                        |
| 7   | S → db                                                   | M, restored db with M's epoch                         | refuses                                                                                 | Finished: M removed, then a second restore over it. The first restored db is `Read`; A (the original live db + WAL) counts through `aside_floors` ✓ |
| 8   | swap done, M not yet removed                             | as 7                                                  | refuses                                                                                 | as 7                                                                                                                                                |
| U   | crash during `put_back`                                  | M and S still there                                   | refuses                                                                                 | continues `put_back`; "both … are there" only for a non-`-shm` duplicate (unreachable by the swap order)                                            |
| X   | marker with neither S nor epoch db                       | —                                                     | refuses                                                                                 | "call support. Nothing was changed" ✓ (tested)                                                                                                      |

**Other checks:**

- **Counters and serials.** Counters are strictly above both databases and every `restore-*/host.db`: counter, block ends (which cover `consumed_through`), box and pallet serials, and shift numbers from counters and from `max(number_seq)`. Capped at the prefix capacity.
- **Unreadable margin.** When the live db is unreadable or absent: copy max + 100 000, rounded up to 10 000. Broken in the C1 case.
- **Revision and audit ids.** The revision is copy+1, checked against `src/local/reference-sync.ts:597-606`: `page.rev < since` → WIPE and refetch. Audit ids are above both databases.
- **Revocations and sessions.** Revocations are carried only toward revoked: devices, operators plus tombstone, badges plus tombstone, office users. All office sessions are deleted. No hard deletes of these tables exist in the host, so "deleted after the copy" cannot resurrect anything.
- **WAL fold.** A copy with a WAL is refused when it has a manifest, and folded in a 0700 private temp folder without one.
- **Running host.** The host-running lock is honoured.
- **Output.** It prints paths, the copy's SHA-256, counters and the epoch. No secrets.

### 2. The hold

- **Held:** only `/v1/device/facts` and `/v1/device/codes/*`, by exact path or prefix, before auth, any method, 503 `restore_pending` with `Retry-After: 60`.
- **Open:** blocks, shifts, the feed, known-blocks and the office (integration has no other device route that writes a permanent decision).
- **Fail-closed:** correct in code, but untested (M1).
- **Resume:** admin-only, re-checked in the transaction, audited, idempotent with no row.
- **Known blocks:**
  - `known` / `block_mismatch`;
  - an id reused as a `request_id` → mismatch;
  - extension > 9 → `range_invalid`; 2–9 → `prefix_unknown`;
  - overlap across devices and revoked blocks;
  - in-request duplicates and overlaps;
  - the counter only moves forward; one revision; the epoch mark is set once.
- **UI:** the Resume dialog is honest (no station code yet) and requires the checkbox.
- The station's `hostOwner` lets a scan through on a failed code check, so the hold does not block the floor.

### 3. The backup worker

- **Copy:** `VACUUM INTO` into a pre-created 0600 file, then `integrity_check` immutable, SHA-256, rename, manifest through `write_synced`. Broken on Windows (C2).
- **Retention:** clock-back is still open (I1).
- **Second folder:** a failure there is isolated from the local result, but a hung share stalls the whole worker until the OS gives up. The "stuck" warning covers it; CARRY to stage 5.
- **Free space:** not pre-checked (owner step).
- **Permissions:**
  - the local copies inherit the protected data-folder ACL; the smoke test proves propagation only for `tls\key.der`, so add the backups check (C2 fix);
  - the second folder's ACL is the administrator's;
  - the restore temp folder is 0700 or the user's own `%TEMP%`.
- **Shutdown:** 10 s for HTTP, 10 s for the worker, then `shutdown_runtime` 5 s. That fits the 30 s stop hint, and abandoned threads die with the process.

### 4. The installer and the service

- **icacls:** `icacls <dir> /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-19:(OI)(CI)M`.
  - The inherited `Users` ACEs are removed and the grants are inheritable. `SetNamedSecurityInfo` (used by icacls) propagates them to existing children.
  - Explicit ACEs of other SIDs and the owner are kept (M4).
  - Nothing grants `Users` or `Everyone`.
- **Firewall:** Private, Domain, `LocalSubnet`, TCP port from `host.json`, no `-Program`.
- **Service account:** `change_config` resets the account (I2).
- **Exit codes:** 4 is mapped and tested (mutant M7 killed); the 30 s Timeout gives exit 1 (M3).
- **Role file:**
  - exact `{"role":"…"}` with `deny_unknown_fields` (mutant killed);
  - the NSIS `==` is case-insensitive, so roles are mapped to literals;
  - an invalid registry value aborts the install.
- **Role separation in the shell:**
  - claim kind `office` only for the office role (mutant killed);
  - `local_pair` refused for the office role (mutant killed, loopback test);
  - the role comes only from the shell (`install_role`), and the webview enters kiosk mode only once the role is known.
- **`host_origin`:** strict `https://host[:port]`, and the pinned certificate is required before the key is sent.
- **NSIS:**
  - paths are quoted;
  - `$0`/`$1` are pushed and popped, except on `Abort`, which is harmless;
  - a silent install without a role fails;
  - uninstall keeps the data and only logs a failed uninstall.
- **Tools:**
  - `sign-overlay` refuses a timestamp URL with credentials and needs a 40-hex thumbprint;
  - `prepare` validates the repository, SHA and status;
  - an unsigned build works.
- **CI:**
  - no `secrets.`, no `pull_request_target`, workflow-level `permissions: contents: read`, `persist-credentials: false`;
  - every action is pinned to 40 hex (the `upload-artifact` pin matches the other workflows);
  - `${{ }}` appears only in `with:` (`github.sha`, `runner.temp`) and in `if:`;
  - the fork-PR artifact holds only the unsigned installer, the evidence and the sums;
  - `affected.mjs` routes `tools/standalone-release/` to the standalone jobs.

### 5. ИМП

- Only `tools/standalone-export/sscc.mjs` and its test are on the branch. The tests ran 37/37.
- No added line in any non-`.md` file contains `pinPhc`, `badgePhc` or `badgeSalt` (checked with `git diff … ':!*.md' | grep '^+'`).
- Nothing implements the parked Tasks 2–9.

### 6. Cross-stream contracts

- **Host migrations:** this branch adds only host `0011`; integration adds no host migration after the base (`0012_pallets` is in both). The `0011`-after-`0012` test is present.
- **Shell migrations:** none on this branch. Integration has shell `0007`; РК-С plans `0009`.
- **Tables and logs:** `TABLE_CLASSES` is untouched. `no_secrets_in_logs` still counts `facts_files` = 17 (this branch adds no file on the facts path, and integration is also at 17).
- **`hello.restoreEpoch`:** `skip_serializing_if`, Rust lenient, Zod strict-optional (M7).

### 7. Tests as a suite

- **Hygiene of the mutation harness:** `git status` is clean, and every mutated file was restored byte-identically (SHA and `cmp`, touched).
- **Counts re-run (focused, green):**
  - `restore` 30
  - `restore_hold` 8
  - `known_blocks` 11
  - bin 8
  - `backup_worker` 12
  - `backup_routes` 13
  - `backup_copy` 26
  - `backup_retention` 4
  - `install` 27
  - `network_profile` 8
  - `installer_cli` 7
  - lib `restore::` 22
  - shell lib 140
  - `host_address` 7
- **Node:**
  - `standalone-release` 48/48 (from the repo root; from another cwd `prepare.test` fails on a relative path, so the suite depends on cwd, as its script does);
  - `tools/ci` 47/47 (unsandboxed);
  - `standalone-export` 37/37.
- **Not re-run:** workspace cargo 1019 and Vitest 3141 (machine load).
- **Prettier gate:** live (a scratch file fails it with "Checking formatting…" and exit 1), then clean over all 64 changed TS/JS/JSON/MD/YAML/CSS files, none of them ignored (`--file-info` checked for each). The `.rs`, `.ps1` and `.nsh` files are not prettier-covered.

### 8. Documents

- Both runbooks, the AGENTS sections and spec §19/§20 are accurate except:
  - C1: the new-PC margin and the meaning of the "carried" line;
  - I2: the manual account step;
  - M6.
- The AGENTS «Installer and service» section is honest about nothing having run on Windows.

### 9. Scope and process

- **Changed paths:** `apps/standalone/{host,proto,src,src-tauri,test}`, `.github/workflows/ci.yml`, `tools/{ci,standalone-export,standalone-release}`, `docs/runbooks/*`, the pilot spec, `apps/standalone/AGENTS.md` and `.gitignore`.
- **Manifests:** only the root `package.json` changed, by two script lines. No `Cargo.toml`, `Cargo.lock` or lockfile change.
- **Trailers:** 18/18 commits have exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Diff hygiene:** `git diff --check` is clean, and the only `\u04` match is `pairing-code.ts:66` (pre-existing).

### 10. Merge into `claude/integration` (`6c57e8f9c`)

`git merge-tree` gives **6 conflicts**, all unions: `host/src/audit.rs`, `host/src/server.rs`, `src-tauri/src/lib.rs` (a doc comment of `manage_state`), `src/host/api.ts`, `test/support/office.tsx`, and the pilot spec. The office review's predicted 7th (`routes/mod.rs`, AGENTS.md, proto `lib.rs`) auto-merges.

---

## (b) TRIAGE

| Item                                                                                             | Decision                                      | Reason                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------- |
| rk-minors 1 (extension bound)                                                                    | DROP                                          | done: `range_invalid` above 9                                              |
| rk-minors 2 (UUID epoch)                                                                         | DROP                                          | done                                                                       |
| rk-minors 3 (`0011` after `0012`)                                                                | DOC                                           | done (runbook §8, AGENTS); re-check after a sqlx bump                      |
| rk-minors 4 (no free-space check; AV rename; UNC; rows; `host.db` 0644)                          | CARRY owner/stage 5                           | needs a dependency; documented; Windows-only items stay in the manual list |
| rk-minors 5 (`shutdown_timeout`)                                                                 | DROP                                          | done, tested                                                               |
| rk-minors 6 (clock-back retention)                                                               | **FIX** (I1)                                  | silent loss while green                                                    |
| rk-minors 7 (in-flight partial; copy per start)                                                  | DROP                                          | documented, harmless                                                       |
| rk-minors 8 (409 per brief; uncancellable probe; `\\?\UNC`; invisible Unicode; 500 after queued) | FIX the 500 (M2); DROP the rest               | the rest is documented or cosmetic                                         |
| rk-minors 9 (runbook items, flake)                                                               | DROP / DOC                                    | all present except PIN/badge revert → DOC (M6); flake fixed                |
| rk-minors 10 (ext 2–9; resume confirmation; 503 everywhere; РК-С)                                | CARRY РК-С; DROP `MAX_EXTENSION`              | РК-С plan written; `prefix_unknown` for 2–9 is harmless                    |
| ust-minors 1 (Windows ACL / firewall / SCM unverified)                                           | CARRY Windows trial; FIX the owner reset (M4) | smoke proves ACL propagation on `tls\`; extend it to `backups\` (C2 fix)   |
| ust-minors 2 (marker → exit 1 loop; locked once; exit 4 hint)                                    | DROP                                          | documented in both runbooks and NSIS                                       |
| ust-minors 3 (`ensure` before icacls; StartPending stop)                                         | DROP                                          | done                                                                       |
| УСТ T2 notes                                                                                     | DROP                                          | documented                                                                 |
| УСТ T3 (role shape; `invalid_request` mapping; S3 untested)                                      | DROP; CARRY S3 to the manual list             | the dialog maps `invalid_request`; S3 needs a real app start               |
| УСТ T4 (role-aware pairing screen; stale office pairing)                                         | CARRY owner/UX                                | new UI                                                                     |
| УСТ T5 (failed uninstall only logs; makensis never compiled)                                     | CARRY CI first run                            | smoke covers uninstall with a running host                                 |
| imp-minors 1 (shift counter drop must surface)                                                   | CARRY ИМП Task 2                              | parked                                                                     |
| imp-minors 2 (m1 throw, m2 code, m3 window validation)                                           | CARRY ИМП Task 2                              | keep the approved module untouched while parked                            |
| imp-minors 3 (m4 cross-tenant prefix, m5 CI)                                                     | CARRY ИМП Task 3 (+ M5)                       | parked                                                                     |
| Task 5 review M3 (`quick_check` on the current db)                                               | CARRY                                         | low value now                                                              |
| Task 5 review I1 tail (passwords/PINs, other-host device revoke)                                 | CARRY owner (OWNER-DECISIONS 7)               | DOC M6                                                                     |
| Task 5 review I2 (block sizes changed after the copy)                                            | DOC                                           | runbook check 1 says "take the larger size"                                |
| NEW C1                                                                                           | **FIX**                                       |                                                                            |
| NEW C2                                                                                           | **FIX**                                       |                                                                            |
| NEW I2 (account reset)                                                                           | **FIX**                                       |                                                                            |
| NEW M1, M3, M4, M8                                                                               | FIX                                           | cheap                                                                      |
| NEW M5                                                                                           | CARRY ИМП Task 3                              |                                                                            |
| NEW M6, M7                                                                                       | DOC                                           |                                                                            |
| NEW M9                                                                                           | FIX (optional)                                | one line                                                                   |
| Second-folder hang stalls the worker                                                             | CARRY stage 5                                 | documented ("stuck" warning)                                               |

**Proposed fix wave (one fixer; tests before production in separate commits):**

1. `test(standalone): a restore over a host that never finished its wizard, or another host's database, takes the unread margins` — 2 tests (RED).
2. `fix(standalone): restore — the margins and the summary follow whether the current database is this copy's history` — C1, `restore.rs` only.
3. `test(standalone): rotation keeps the copy it just made; the office warns of a host clock behind its newest copy` — host + Vitest (RED).
4. `fix(standalone): rotation never takes the fresh copy; the clockBehind warning` — I1, `folder.rs`, `worker.rs`, `backup-warnings.ts`, `ru.json`.
5. `test(standalone): the smoke test finds a verified copy in backups with the data folder's SIDs and an Administrators owner` — `smoke.ps1` plus its contract test (RED as a contract).
6. `fix(standalone): a copy is flushed through a writable handle (Windows); the data folder's owner is Administrators` — C2 and M4, `copy.rs`, `install.rs` (+ install tests in their own test commit first if the seam changes).
7. `test(standalone): an upgrade keeps the service's account; a start that does not finish in 30 s is exit 4; a broken hold read is a 500; a failed state read queues no copy` — tests (RED).
8. `fix(standalone): install keeps an existing account; Timeout{Running} → 4 with the NSIS text; start_backup reads before it queues; the folder-task panic keeps the list` — I2, M3, M2, M9.
9. `ci(standalone): release evidence names the PR head` — M8 (`env:` only).
10. `docs(standalone): runbooks, AGENTS and pilot spec after the final review` — C1 wording, I1, I2 (manual step removed), M6, M7.

Then run the full gate: cargo workspace, Vitest, Node, prettier.

---

## (c) DEVIATIONS TO RECORD (Russian drafts)

**Plan РК — add to «Отклонения при исполнении»** (a paragraph after «Задача 8»):

> **Итоговое ревью части (поток инфраструктуры, РК + ИМП-1 + УСТ, HEAD `310bfed51`): нужны исправления — Critical 2, Important 2, Minor 9.** (1) Восстановление на новый ПК по памятке (§6: установщик уже запустил службу и создал пустую базу без мастера) давало `Current::Read` и запас два блока вместо 100 000, а сводка писала «revocations carried over… 0» — воспроизведено (9500 вместо 110 000); исправлено: запасы и строка «не прочитана» действуют, если текущая база не история хоста копии (мастер не пройден или копия другого хоста). (2) На Windows каждая копия падала бы на `sync_all` дескриптора только для чтения (`FlushFileBuffers` требует права записи); исправлено, дымовая проверка CI теперь ищет проверенную копию в `backups` и её права. (3) Пункт 6 очереди закрыт: ротация не трогает только что сделанную копию, офис предупреждает, если часы хоста отстали от новейшей копии. (4) Пункт 8 очереди закрыт: `start_backup` читает состояние до постановки копии. Тест закрепляет закрытие удержания при ошибке чтения базы (мутант выживал). Восемь собственных мутантов ревьюера по РК убиты, один выжил (закрыт тестом). Номер раздела спецификации пилота «19» при слиянии в `claude/integration` меняется (там уже 18, 20, 21) — см. чек-лист слияния.

Also correct «Перенесено»: items 6 and 8 are fixed in the final wave, so remove them from the carry list.

**Plan УСТ — new section «Отклонения при исполнении»** (draft):

> Исполнено 2026-10-11 в ветке `claude/infra-rk` (7 коммитов `297a00bf8…310bfed51`, после РК и ИМП-1), ревью задач не было, итоговое ревью части — общее с РК. Сверх плана: задача 1 — откат неудавшейся чистой установки, `StoppedAfterStart`; задача 2 — код выхода 4 («служба зарегистрирована, но не осталась запущенной»), `icacls.exe`/`powershell.exe` по абсолютному пути из проверенного `%SystemRoot%`, API менеджера служб вместо `sc.exe`, ожидания не дольше 60 чтений; задача 3 — `local_pair` отказан на ПК с ролью `office`, строгая проверка адреса хоста (`host_origin`); задача 4 — роль установщика сильнее подключения на диске, киоск-режим включается только после ответа оболочки о роли; задача 5 — NSIS сравнивает строки без учёта регистра, роль переводится в точный литерал (иначе `/ROLE=HOST` записал бы `"HOST"` и ПК стал бы запертой станцией), код 4 — предупреждение, обновление останавливает службу; задача 6 — дымовая проверка покрывает код 4 с маркером восстановления, удаление при работающем хосте, точный файл роли, числовое состояние службы; артефакт выкладывается и для пулл-реквестов из форков (без подписи и секретов); задача 7 — памятка для ИТ, раздел спецификации «20. Уточнения плана УСТ» (номер пересчитывается при слиянии). Итоговое ревью: установка поверх переписывала учётную запись службы (ломала вторую папку по сети после каждого обновления) — исправлено, учётная запись существующей службы сохраняется; тайм-аут запуска 30 с теперь код 4, а не отказ установки; владелец каталога данных — Администраторы. Перенесено: экран подключения ПК офиса с учётом роли; синхронизация справочников на ПК офиса (хеши PIN в его базе); поиск хоста (mDNS); привязка правила брандмауэра к программе; подпись в защищённом выпуске; смена роли без удаления. Не проверено: ничего не запускалось на Windows; хуки NSIS ни разу не компилировались; `smoke.ps1` не исполнялся (PowerShell 7 нет на macOS); строка чтения роли в `run` не покрыта тестом. Счёт на `310bfed51`: cargo workspace 1019/0 (67 наборов), Vitest 107/3141, Node: `test:standalone-release:contract` 48, `tools/ci` 47, `test:standalone-export` 37.

**Plan ИМП — entry for Task 1** (draft):

> Задача 1 (`cf08ddf07`) исполнена и прошла ревью (одобрено: Critical 0, Important 0, Minor 5). Сверх брифа: префикс ровно 9 цифр, расширение 0/1, максимум по ключу вместо перезаписи (бриф мог повторить SSCC), `maxConsumedThrough` учитывается, серии от 9 990 000 — отказ. Задачи 2–9 приостановлены (решение владельца 1: перенос хешей PIN/бейджей и соли или новые учётные данные). Обязательные добавки к задачам 2 и 3 — в `imp-minors.md` 1–3. CI пока не запускает `test:standalone-export` (задача 3 добавит шаг и сборку `packages/domain`).

---

## (d) Could not be verified

- **Windows:**
  - the C2 behaviour itself (from the Win32 contract, not observed);
  - the service manager, `icacls` propagation and owner;
  - the firewall rule, `Get`/`Set-NetConnectionProfile`;
  - NSIS (never compiled), `smoke.ps1` (never run);
  - exit 4 on a real SCM;
  - rename against antivirus, directory flush, UNC and USB, a real full disk;
  - WebView2 for the page;
  - reading `installation.json` from Program Files;
  - the Tauri template facts the hooks rely on (`$UpdateMode`, `GetOptions`, hook positions);
  - whether `Abort` in POSTINSTALL leaves an uninstall entry.
- **CI:** the `standalone-windows-build` job has never run; the `upload-artifact` SHA was checked only against the repo's other pins.
- **Suites not re-run:** cargo workspace 1019 and Vitest 3141 (machine load). Only focused suites and Node were run.

## (e) Notes for the other streams and plans

- **РК-С:**
  1. **After a new-PC restore the stations re-pair with NEW device ids.** Every block the copy holds under the old device id answers `block_mismatch` to `blocks/known`, and facts from those blocks would get `sscc_not_issued`.
     - The plan must decide one of: (a) a known-blocks rule that accepts a block whose serials match exactly but whose device is a revoked or orphaned old device (host change); (b) re-pairing keeps the device identity; (c) the runbook makes the station finish and drain on the old host before the switch (impossible when the disk died).
     - The same applies to queued facts across `device_forget` and re-pair.
  2. Its spec section is numbered §22 by the plan, which collides after this merge: renumber it at merge.
  3. Mind C1: the station-side wipe is the only reliable resync after a new-PC restore.
  4. The hold's 503 also hits code checks; the station already treats a failed check as "let the scan through".
- **ИМП (on resume):** imp-minors 1–3 are mandatory addenda. M5 (CI step plus building the domain first). If the owner picks A (carry hashes), the transfer file is as sensitive as a backup copy: the same 0600/ACL rules, delete after import, and a runbook line.
- **Floor stream (2a8, ПЛ-Ц):** new device routes that write permanent decisions against host state must be added to `server::held_by_a_restore` (the hold matches by path). New host migrations take `0013+` (`0011` is taken). Any new facts module must update `no_secrets_in_logs` `facts_files`.
- **Office stream:** no office audit-label list exists yet. When one is added, include `backup.create`, `backup.settings.update`, `host.restore`, `host.restore.resume` and `sscc.block.register`.

## (f) Merge checklist (infra → `claude/integration` `6c57e8f9c`)

1. Land the fix wave on `claude/infra-rk` first, then re-run the gate there.
2. Merge. Resolve the 6 union conflicts:
   - `audit.rs`: keep `SHIFT_EXPORT` and the three backup actions;
   - `server.rs`: keep both route groups;
   - `src-tauri/src/lib.rs`: the merged doc comment mentions both the role and the office folder;
   - `api.ts` and `test/support/office.tsx`: union.
3. **Pilot spec:** integration has §18 ПЛ-Х, §20 ЧЗ, §21 О-Ф (§19 is reserved for ПЛ-Ц on the floor branch).
   - Renumber РК to §22 and УСТ to §23 (or whatever is next free at merge time). Fix §11's "уточнения — в разделе 19" and the УСТ section's list of taken numbers.
   - Fix the references: `standalone-backup-restore.md` line 3 ("разделам 11 и 19"), AGENTS «Backups and restore» ("§11 and §19").
   - Tell РК-С (its §22) and ПЛ-Ц (§19).
4. **Semantic checks after the merge:**
   - `cargo test --workspace`: compile `manage_state(…, role)` against integration's ЧЗ shell changes; check `tests/ipc.rs`; `no_secrets_in_logs` stays at 17; the `0011`-after-`0012` test passes; the `hello` fixtures include `hello-restored.json`; `error-codes.json` / `codes::ALL` / `API_ERROR_CODES` contain `restore_pending` once.
   - Vitest: the `nav.ts` / `routes.tsx` / `access.ts` «Сервис → Резервные копии» entry next to integration's office routes, and the `shell.test.ts` TABLE rows (`address_changed`).
   - AGENTS.md: the auto-merged sections are in a sensible order with no duplicate section heading.
5. Run Node `test:standalone-release:contract` (from the repo root), `tools/ci` tests, `test:standalone-export`, and the prettier gate (live) over the merge diff.
6. After the merge, the first push to CI is the first real Windows run (`standalone-windows-build`): read `smoke.ps1`'s output step by step, including the new backups-copy check.

## Evidence

- Mutants (`/tmp/claude/rev-infra/mut.py`, log `mutants.txt`, one log per mutant). Every mutated file was restored byte-identically (SHA-256 + `cmp`) and `touch`ed; baselines are green.

  | #   | Mutant                             | Result                                          |
  | --- | ---------------------------------- | ----------------------------------------------- |
  | M1  | `start` ignores the restore marker | KILLED (3 `cut_off` tests)                      |
  | M2  | counter margin 1 block             | KILLED (4+)                                     |
  | M3  | unread margin only when Absent     | KILLED (`an_unreadable_current_database…`)      |
  | M4  | revocations not carried            | KILLED (`revocations_made_after_the_copy…`)     |
  | M5  | code checks not held               | KILLED                                          |
  | M6  | hold fails open on a read error    | **SURVIVED** → Minor M1                         |
  | M7  | exit code 4 → 1                    | KILLED                                          |
  | M8  | known-block overlap ignored        | KILLED (3)                                      |
  | M9  | a `secrets.` reference in the job  | KILLED (`workflow.test` "doesNotMatch secrets") |
  | M10 | role file accepts unknown keys     | KILLED                                          |
  | M11 | office role claims as a station    | KILLED                                          |
  | M12 | office role allowed `local_pair`   | KILLED (loopback, unsandboxed)                  |

- C1 reproduction: `/tmp/claude/rev-infra/zz_rev_scratch.rs` and `scratch1.log`. The scratch file was removed from the tree.
- `git merge-tree --write-tree --name-only 6c57e8f9c HEAD`: tree `ae2ccd3aa…`, the 6 conflicts listed above.
- Process note: some early inspection commands used `cd /tmp/claude/wt/inf` inside a single Bash call (the shell resets each call). The prettier gate itself ran as `pnpm --dir /tmp/claude/wt/inf exec prettier --ignore-path .prettierignore --check <repo-relative paths>`.
