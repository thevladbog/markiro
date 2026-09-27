# Station storage off the Windows roaming profile — design proposal

**Status:** decisions D1-D5 taken by the owner on 2026-09-27 (section 12); D5
as compile-only Windows tests in PR CI. Implemented by plan
`docs/superpowers/plans/2026-09-27-station-local-storage.md`; section 13
records where the implementation departs from sections 6-8. No cloud API
change, no Postgres or SQLite schema change.

## Summary

The cloud station keeps all of its durable state in
`%APPDATA%\app.markiro.station\`, the Windows **roaming** AppData folder:
`station.json` (identity and the device key in plain text) and
`station-mirror.db` (outbox, SSCC pool cursor, offline grants, label jobs,
operator roster, credential-recovery state). With a roaming profile or AppData
folder redirection this state follows the Windows user to other computers. Two
computers holding one copy print duplicate SSCCs offline, and one of them stalls
its outbox forever on `409 station_batch_mismatch`; the server cannot tell them
apart.

Proposal: move both files, once and as one pair, to
`%LOCALAPPDATA%\app.markiro.station\`, where the WebView2 profile already
lives. The move uses a claim → copy → verify → commit protocol whose progress is
recorded in the non-roaming folder, survives interruption at any step, never
leaves two live copies, and never mints a new identity while data exists.
Where moving would make the data less durable than today, the station keeps
today's location and says so.

## 1. What is stored where (verified in code)

| Item                                             | Written by                                                                                                                                                                                                                                        | Windows path today                                | Content                                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `station.json`                                   | `read_config` / `write_config` / `clear_credential` commands (`apps/station/src-tauri/src/commands.rs:14-37`) via `app_config_dir()`                                                                                                              | `%APPDATA%\app.markiro.station\station.json`      | `machine_id`, `device_id`, `tenant_id`, device/organization/line names, **`api_key` in plain text** (`config.rs:11-30`), `server_url`                                                                                                  |
| `station-mirror.db` (+ `-journal` after a crash) | webview `Database.load("sqlite:station-mirror.db")` (`src/lib/sqlite.ts:9`), resolved by tauri-plugin-sql 2.4.0 against `app_config_dir()` (`wrapper.rs:79-86`, `path_mapper` `319-332`); `grant_atomic_execute` (`grant_transaction.rs:120-124`) | `%APPDATA%\app.markiro.station\station-mirror.db` | every offline table: `outbox`, `sscc_pool`, `operators_mirror`, `offline_grant_*`, `product_label_*`, `station_meta` (`install_id`, pinned batch ceilings, hardware config), `station_device_recovery` (`machine_id`, credential hash) |
| WebView2 profile                                 | Tauri forces `LocalData/<identifier>` on Windows (tauri 2.11.5 `manager/webview.rs:534-545`)                                                                                                                                                      | `%LOCALAPPDATA%\app.markiro.station\EBWebView`    | nothing durable: the station uses no localStorage or IndexedDB                                                                                                                                                                         |
| Program files                                    | NSIS `currentUser` default; no `installMode` override in `tauri*.conf.json`                                                                                                                                                                       | `%LOCALAPPDATA%\Markiro Station`                  | binaries                                                                                                                                                                                                                               |

`app_config_dir()` is `dirs::config_dir()/<identifier>` (tauri 2.11.5
`src/path/desktop.rs:238-242`), which on Windows is
`SHGetKnownFolderPath(FOLDERID_RoamingAppData)` (dirs 6.0.0 `src/win.rs`,
dirs-sys 0.5.0). `app_local_data_dir()` is `FOLDERID_LocalAppData`
(`desktop.rs:256-260`). On macOS both resolve to
`~/Library/Application Support`; on Linux they differ (`~/.config` and
`~/.local/share`). The updater, printer, scanner and power modules write no
files, and the SQL plugin has no preload.

**The two files are one unit.** `initializeDeviceRecovery`
(`src/lib/device-recovery.ts:102`) compares `station_device_recovery.machine_id`
and the stored credential hash with `station.json` (line 170); on mismatch it
purges the operator roster and seals the station. The sync batch id is
`<machineId>:<installId>:<highest outbox id>` (`src/lib/sync.ts:1056`): the
first part comes from `station.json`, the second from the database. Any move
must carry both files from the same source, together.

## 2. Why it matters (verified consequences)

When two computers hold copies of the same pair:

1. **Duplicate SSCCs on physical labels.** `burnSerial`
   (`src/lib/sscc-pool.ts:117`) advances a purely local cursor. Both copies
   burn the same serials offline; `boxes_tenant_sscc_uq`
   (`packages/db/src/schema/platform.ts:977`) rejects the second box only after
   both labels exist. The code itself calls a shared SSCC "the one failure the
   server cannot repair".
2. **One outbox stalls for good.** Both copies share `machineId`, `installId`
   and the `AUTOINCREMENT` counter, so their next batches carry the same id with
   different scans. The server compares the stored payload digest and answers
   `409 station_batch_mismatch`
   (`apps/api/src/modules/station-scans/station-scans.service.ts:473-503`). The
   station retries every failure except a revoked-credential 401 forever with
   the pinned payload (`src/lib/sync.ts:2105-2123`). Nothing is deleted; nothing
   more is delivered from that computer.
3. **Nothing detects it.** The server sees `machineId`/`installId` only inside
   the opaque batch id (sole mention: `station-scans/dto.ts:228`); a device is
   "API key → `station_devices` row". Re-pairing one computer revokes the other's
   key, but neither pairing nor `clear_credential` changes `machineId`,
   `installId`, the outbox counter or the SSCC cursor, so the collisions
   continue.
4. **Stale snapshot on one computer.** A roaming profile restored from an
   older server copy (failed upload at sign-out, deleted local cache) rewinds
   the SSCC cursor and the outbox counter: serials already printed but not yet
   synced are issued again, new batches reuse recorded ids (409 stall), and
   work done since the snapshot is gone.
5. **Folder redirection** puts the live SQLite database on an SMB share. An
   offline-first station then depends on the file server, or on Offline Files
   syncing a live database, and two computers signed in with one account open
   one database concurrently.
6. **Credential copies.** The plain-text device key is copied to the profile
   server and its backups.

## 3. Exposure

- **Local Windows account on the station PC, or a domain account with a plain
  local profile.** `%APPDATA%` is an ordinary local folder; nothing above happens
  through roaming. Probably the usual factory setup.
- **Domain account with a roaming profile.** The pair roams at sign-in and
  sign-out. A second computer where the same account signs in and the station is
  installed starts as a clone (programs are per-user and do not roam; the data
  does). A single computer is exposed to the stale-snapshot case.
- **AppData folder redirection.** Consequence 5, plus concurrent sharing.
- **One shared account on several line PCs with roaming.** Every newly
  installed station starts as a clone of the first. The worst case.

The repository has no evidence of what customers run. No document tells a
customer which Windows account to use. The per-user choice was made in plan 05a
("on Windows the app-config dir is already per-user, so ACLs govern access",
`docs/superpowers/plans/2026-07-23-05a-station-foundation.md:588`); roaming was
never considered. `docs/operations/first-customer-inventory/README.md:85-105`
already tells an operator to read `%APPDATA%\app.markiro.station\station-mirror.db`
and notes that the path was never checked on a real device. The standalone app
chose `app_local_data_dir()` for exactly this reason
(`apps/standalone/src-tauri/src/lib.rs`, branch
`claude/autonomous-desktop-station-9e6f13`).

Conclusion: latent on local-account PCs; real and silent in domain environments
with roaming or redirected AppData.

## 4. Goals and non-goals

Goals:

- The identity and the offline journal live on the machine that produced them,
  in a folder Windows neither roams nor redirects.
- Existing installations keep their credential and every queued fact. The move
  happens once, atomically, and survives interruption at any step.
- Never create a second live copy of an identity; never mint a new identity
  while station data exists somewhere.
- Where moving would make the data less durable than today, keep today's
  behaviour and report it.

Non-goals:

- Splitting clones that already exist (section 6.7; a support procedure).
- API changes, server-side clone detection, a new batch-id format.
- DPAPI protection of the key: separate hardening, and user-scope DPAPI master
  keys roam with the profile anyway.

## 5. Options

**A. `%LOCALAPPDATA%` with a one-time migration (recommended).** Not roamed and
not redirectable, per-user ACL as today, already holds the WebView2 profile, the
same choice as the standalone app. No installer change. Weakness: still inside
the user profile, so profile-deletion policies remove it. The durability guard
(6.5) handles that.

**B. `%ProgramData%\Markiro\Station`.** Machine scope, survives profile deletion,
one station per machine whatever the Windows user. Needs a per-machine installer
(today `currentUser`) or an elevated step to set an ACL; without one, other local
users could read the key. It also changes the per-user semantics. Too large for
this fix.

**C. Keep Roaming and only warn.** Detect roaming or redirection and warn, maybe
add the folder to `ExcludeProfileDirs`. Does nothing for redirection, depends on
domain policy, leaves the risk in place.

## 6. Design (option A)

### 6.1 Units

- **`storage::resolve(legacy_dir, local_dir, probe, hooks) -> Resolution`.** A
  file-system state machine with no Tauri dependency, testable on the host with
  temp directories. Failures are injected through a step hook, the pattern of
  `write_config_with_parent_syncs` in `config.rs`. `Resolution` is `Local(dir)`,
  `Legacy(dir, notice)` or `Blocked(reason)`, plus notices. **Legacy mode**
  means today's behaviour: the station reads and writes the given folder, which
  is either the original legacy folder or a claimed copy of it (6.3).
- **`storage::ProfileProbe`.** A trait with a Windows implementation:
  - `GetProfileType` (`windows_sys::Win32::UI::Shell`; `PT_*` constants in
    `Win32::System::GroupPolicy`);
  - the `DeleteRoamingCache` policy value under
    `HKLM\SOFTWARE\Policies\Microsoft\Windows\System`;
  - whether `FOLDERID_RoamingAppData` lies outside the profile (redirected).

  Other platforms report "local, not roaming". Tests use a fake, the pattern of
  `grant_clock::ClockSource`.

- **`StorageGate`.** Managed state.
  - `setup` runs `resolve` on a background thread. In tauri 2.11.5 the config
    window already exists and `setup` runs on the UI thread
    (`src/app.rs:2521-2533`), so a synchronous copy would freeze a visible window.
  - Commands that touch storage wait for the gate.
- **Consumers.** They switch from `app.path().app_config_dir()` to the gate:
  - `read_config`, `write_config` and `clear_credential` become async commands;
  - `grant_atomic_execute` uses the gate's database path;
  - a new `station_database_url` serves the webview;
  - an optional `station_storage_status` serves diagnostics.

  `config.rs` keeps its `&Path` API, and its atomic-write helpers become
  `pub(crate)` for the record file.

### 6.2 Layout

In `%LOCALAPPDATA%\app.markiro.station\`:

- `station.json` and `station-mirror.db` (+ sidecars), names unchanged.
- `station-storage.json`, the migration record, written with the existing atomic
  replace (`write_owner_only` + `ReplaceFileW`/`MoveFileExW` with write-through).
- `station-storage.lock`, held with `std::fs::File::lock` (stable since Rust
  1.89, no new dependency) while resolving. The single-instance mutex is
  `"{id}-sim"` without `Global\`
  (tauri-plugin-single-instance 2.4.3 `platform_impl/windows.rs:67`). It is per
  logon session, so two sessions of one user could otherwise race.

The record lives in the non-roaming folder on purpose. Neither a roaming download
nor another computer can make this machine believe a migration is finished or
unfinished.

### 6.3 Resolution algorithm

Under the lock:

0. **Same directory.** If `legacy_dir == local_dir` (macOS), record
   `committed/same-directory` and use Local.
1. **Read `station-storage.json`.**
   - `committed`: use Local. Finish a pending cleanup (best effort). If the
     legacy folder holds station files again, never load them. Report
     `RoamedCopyPresent { same_machine_id }`, parsing only `machine_id`, and
     leave the files alone (decision D3).
   - `claiming { claim_dir }`:
     - if `claim_dir` exists, resume at step 4;
     - if the legacy folder still holds data (the rename never happened),
       resume at step 3;
     - otherwise `Blocked(data missing)`: never mint.
   - unreadable: `Blocked`.
   - absent: step 2.
2. **Decide.** "Station files" means `station.json` or `station-mirror.db`;
   either one alone counts.
   - Durability guard (6.5) says Local is less durable: Legacy mode, write
     nothing.
   - Local and legacy both hold station files: `Blocked(conflict)`.
   - Only Local holds them (placed by support): record `committed/adopted`.
   - Only legacy holds them: step 3.
   - Neither: record `committed/fresh`, so a copy that roams in later is never
     adopted.
3. **Claim.**
   - Record `claiming { legacy_dir, claim_dir = <legacy_dir>.migrating-<uuid> }`.
   - Rename the legacy folder to `claim_dir`: same parent, one atomic rename.
     From then on neither an older version nor another computer finds the pair
     at the old path.
   - If the rename is still refused after three attempts 250 ms apart
     (antivirus, indexer), delete the record and run in Legacy mode from the
     legacy folder, with notice `LegacyInUse`.
4. **Copy under exclusive handles.**
   - Open every top-level regular file in `claim_dir` with Windows
     `share_mode(0)` and hold the handles until verification ends. Skip `*.tmp`
     (interrupted config writes) and `-shm`. The bundled SQLite opens files with
     `FILE_SHARE_READ | FILE_SHARE_WRITE` and no delete sharing (libsqlite3-sys
     0.30.1 `sqlite3.c:51817`). So an exclusive open fails with a sharing
     violation while another computer holds the database over SMB, and no one
     can write while we copy.
   - If an exclusive open fails, run this time in Legacy mode from `claim_dir`
     with `LegacyInUse` (equivalent to today). Resume next start.
   - Delete any non-authoritative `station.json`/`station-mirror.db*` in Local.
     They can only be leftovers of this migration: step 2 proved Local held none
     before the record.
   - Copy into `local/.migration-<uuid>/`, `sync_all` each file, then compare
     each copy with its source byte for byte (streaming).
   - The `-journal` travels with its database. An exact copy lets SQLite roll
     back a hot journal on first open exactly as it would have in place.
   - `.station-*.bak` recovery copies travel too.
5. **Install.** Rename the staged files into Local (same volume) and remove the
   staging folder.
6. **Commit.** Replace the record with
   `committed/migrated { legacy_dir, claim_dir, cleanup: pending }`. From here
   on Local is authoritative.
7. **Clean up.**
   - Delete from `claim_dir` exactly the files that were verified.
   - Remove the folder if it is empty.
   - Record `cleanup: done`.
   - Anything unexpected stays and is reported.

Any failure in steps 4-6 leaves the record at `claiming`. This time the station
runs in Legacy mode **from `claim_dir`**: a complete copy that older versions
and other computers cannot see. The next start resumes at step 4.

### 6.4 Interruption table

| Interrupted after                 | Authoritative copy | Next start                              |
| --------------------------------- | ------------------ | --------------------------------------- |
| steps 1-2 (no record)             | legacy folder      | repeats from step 2                     |
| record written, before the rename | legacy folder      | step 3 again                            |
| rename, during copy or verify     | `claim_dir`        | step 4 again                            |
| install, before commit            | `claim_dir`        | step 4 again; Local leftovers discarded |
| commit, before or during cleanup  | Local              | cleanup continues                       |

The invariant checked at every point: exactly one location is authoritative, and
it holds the complete pair byte for byte.

### 6.5 Durability guard

In these profiles Local is less durable than Roaming:

- temporary (`PT_TEMPORARY`);
- mandatory (`PT_MANDATORY`);
- roaming with `DeleteRoamingCache = 1`, where the local profile copy, including
  `%LOCALAPPDATA%`, is deleted at sign-out.

In those cases: Legacy mode, no record, a notice (`LocalLessDurable`;
`TemporaryProfile` also warns against pairing there). The guard is re-evaluated
at every start, so the migration runs once the policy changes. Redirected
Roaming alone does not block: Local is strictly better there.

### 6.6 Webview and the other consumers

- `src/lib/sqlite.ts` becomes `Database.load(await invoke("station_database_url"))`.
  - The URL is `sqlite:` plus the absolute path, with `%`, `?` and `#`
    percent-encoded: sqlx percent-decodes the file name.
  - The plugin's `PathBuf::push` of an absolute path replaces its base.
- `grant_atomic_execute` opens the same path.
- **A `Blocked` gate** makes `station_database_url` and `read_config` fail.
  - Startup already routes that failure to the existing `enroll.recoveryFailed`
    screen ("Локальная работа сохранена, но восстановление станции не
    завершено…").
  - It never mints an identity (`src/App.tsx:675-697`, `1419-1428`).
- **Notices** (`LegacyInUse`, `LocalLessDurable`, `TemporaryProfile`,
  `RoamedCopyPresent`) go to the log and to `station_storage_status`. How they
  are shown is decision D4.

### 6.7 Two copies that already exist

| Situation                                                     | What the migration does                    | Result                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One computer, roaming profile                                 | claims its local cached copy               | fixed; the next sign-out should remove the files from the server copy (confirm on test AD, section 9)                                                                    |
| Account used on PC A, later on PC B, which inherited A's pair | each computer migrates its own cached copy | **the clone remains**, now pinned per machine: it stops spreading but is not split. If B's copy roams back to A, A reports `RoamedCopyPresent { same_machine_id: true }` |
| Redirected AppData, the other computer running                | exclusive open or rename refused           | A stays in Legacy mode with `LegacyInUse`; nothing is split                                                                                                              |
| Redirected AppData, the other computer not running            | A takes the pair                           | the other computer, old or new version, finds nothing and starts unenrolled: no clone; it must be paired as its own device                                               |
| Station files in both Local and legacy, no record             | nothing                                    | `Blocked`, for support                                                                                                                                                   |

The migration cannot tell an original from a clone: both carry the same
identity. Splitting an existing clone is a support action:

1. Choose the computer that keeps the identity.
2. On the other, archive both files.
3. Pair it as a new device.

Pairing alone does not help, because `machineId` and `installId` stay and the
batch ids keep colliding. That runbook is a follow-up.

### 6.8 Rollback and downgrade

The updater never installs an older version (`updater.rs:599`, `version <= current`
is denied). A manually installed older build reads the legacy path, finds
nothing, and starts unenrolled; the data stays intact in Local.

Before rolling back, open the Update screen → "Station data" and confirm it
shows "Stored on this computer:" with `%LOCALAPPDATA%\app.markiro.station`; if
it shows a `…migrating-…` folder or "Stored in the roaming Windows profile:"
instead, do not roll back — follow `docs/runbooks/station-storage-recovery.md`
or contact the developers.

Manual rollback, with the station closed:

1. Move (do not copy) `station.json`, `station-mirror.db*` and `.station-*.bak`
   from `%LOCALAPPDATA%\app.markiro.station\` to
   `%APPDATA%\app.markiro.station\`.
2. Delete `%LOCALAPPDATA%\app.markiro.station\station-storage.json`.
3. Install the older build.

Skipping step 1 makes the older build start unpaired. Copying instead of
moving, or keeping the record, breaks the next upgrade: it resumes from the
stale local copy (the SSCC cursor rewinds, so SSCCs and batch ids repeat),
starts unpaired, or stops for support.

## 7. Tests

Per `apps/station/AGENTS.md`: interruption between steps, restart, and duplicate
invocation, without losing or duplicating a production fact.

**Rust on the host** (the Linux `station-rust` CI job). Temp directories, a fake
probe and the step hook:

1. Fresh start gives `committed/fresh`. `read_config` mints in Local; the legacy
   folder is untouched.
2. A legacy pair with `-journal` and `.station-*.bak` arrives byte-identical in
   Local. The legacy folder is gone and `*.tmp` is dropped.
3. Interrupt at every step boundary, then rerun: the result converges. At every
   interruption exactly one authoritative location holds the complete pair.
4. A second invocation after commit is a no-op. Two concurrent resolutions
   (threads, lock) produce one migration.
5. Claim refused (injected rename error): Legacy mode from the legacy folder, no
   record; the next run migrates.
6. Exclusive open, copy or compare failure (injected short write or flipped
   byte): Legacy mode from `claim_dir`; the next run completes.
7. A legacy pair that reappears after commit is ignored. Local is unchanged, and
   `RoamedCopyPresent` carries the right `same_machine_id`.
8. Station files in both places with no record: `Blocked`, both untouched. An
   unreadable record: `Blocked`.
9. Durability guard: temporary, mandatory, and roaming with `DeleteRoamingCache`
   give Legacy mode. Roaming without it, and redirected Roaming, migrate.
10. Same directory: no copy.
11. Real SQLite. Build a database with sqlx holding:
    - outbox rows;
    - an `sscc_pool` cursor;
    - `station_meta.install_id`;
    - `station_device_recovery.machine_id`.

    Migrate and reopen: `quick_check` is ok, the values are equal, and the
    recovery `machine_id` equals the one in `station.json`.

12. Database URL: paths with spaces, Cyrillic, `%`, `#` and `?` round-trip
    through `SqliteConnectOptions::from_str`.
13. Commands issued before the gate resolves wait, then use the resolved folder.
    A `Blocked` gate returns an error and never calls `config::read_config`,
    which would mint.

**Rust on Windows only** (`#[cfg(windows)]`). The beta workflow runs these only
in `seed-baseline` mode (the `cargo test` step of
`.github/workflows/station-beta-release.yml`); PR CI compiles them
(`cargo test --no-run` in `station-windows-build`, decision D5):

14. A live SQLite connection on the legacy database makes the claim or the
    exclusive open fail, which gives Legacy mode.
15. On the runner, `ProfileProbe` reports a local, non-temporary profile, and
    `FOLDERID_RoamingAppData` lies inside the profile.
16. Replacing an existing record goes through `ReplaceFileW`.

**Webview (Vitest):**

17. `sqlite.ts` loads exactly the URL from `station_database_url`, once, and
    never `sqlite:station-mirror.db`.
18. Startup with a failing `station_database_url` shows the recovery screen, not
    enrollment.

**Contracts:**

19. `tools/station-release/test/docs.test.mjs` and the acceptance documents
    carry the new invariant (section 8).

## 8. Documents and contracts that change with the code

- **Release acceptance.** Replace "path unchanged" with the new invariant in:
  - `docs/acceptance/station-stable-release.md` ("Station SQLite path and
    database remain unchanged");
  - `docs/acceptance/station-dual-origin-release.md` (`BOOTSTRAP-PRESERVE-02`);
  - the matching texts in `tools/station-release/test/docs.test.mjs`.

  The new invariant: "on the first start of the first release containing this
  change, the storage moves once
  to `%LOCALAPPDATA%\app.markiro.station`; counts are equal before and after;
  `%APPDATA%\app.markiro.station` holds no station files; later installs keep
  the Local path".

- **Operations.** `docs/operations/first-customer-inventory/README.md:85-105`
  and `docs/operations/first-customer-inventory/protocol-v1.md:216` get the new
  path, preferably read from
  `station_storage_status` rather than derived.
- **Architecture.** `docs/architecture.md` gets the invariant: "the station
  identity and journal live in machine-local, non-roaming storage".
- **IT guidance** (MKR-INS-04 or `apps/station/README.md`):
  - run the station under a local account, or one without roaming or redirected
    AppData;
  - enroll after disk imaging, not before.

## 9. Manual and external validation (not provable in CI)

- **Local account, Windows 10 and 11.** Upgrade from the current stable with an
  enrolled station and scans made offline. After the upgrade the queue drains,
  SSCCs continue and no pairing is needed.
- **Test AD with a roaming profile.**
  1. Migrate on PC A and sign out.
  2. Check that the profile share no longer holds the files.
  3. Sign in on PC B with the station installed. It must show enrollment, not
     A's identity.
- **Redirected AppData** with the station running on a second computer: expect
  `LegacyInUse`.
- **`DeleteRoamingCache` enabled:** no migration, and a notice.

None of these can be claimed from host tests.

## 10. Rollout

A station-only change: no API, Postgres or SQLite schema change. Ship it in a
beta, run section 9 against the beta, then promote to stable. The first start of
the new version migrates.

For stations the probe finds in roaming or redirected environments, rotate the
key with a same-record re-pair after migration, since plain-text copies may
remain in profile-share backups. This is an operational step, the owner's call,
and needs no code.

## 11. Residual risks

- **Existing clones stay clones** (6.7).
- **FSLogix or VHD profile containers** also carry `%LOCALAPPDATA%`, and a disk
  image taken after enrollment duplicates it. Deployment guidance covers these.
- **tauri-plugin-sql still touches Roaming.** It calls
  `create_dir_all(app_config_dir)` on every `load` (`wrapper.rs:79-84`). An
  empty legacy folder keeps reappearing, which is harmless. But if Roaming is
  redirected to an unreachable share without Offline Files, `load` panics there
  even though the database is local. Avoiding that means bypassing the plugin's
  path mapping; out of scope unless the owner asks.
- **Linux development machines relocate as well.** Harmless.

## 12. Owner decisions

Decided by the owner on 2026-09-27:

- **D1. Target: A, `%LOCALAPPDATA%`.** Rejected: B, `%ProgramData%`; C, warn
  only.
- **D2. Profiles where Local is less durable: keep Roaming and show a notice.**
  Rejected: migrate anyway; block the station.
- **D3. A legacy copy that reappears after migration: leave it and show a
  notice.** It may be another computer's live data. Rejected: delete it.
- **D4. Notices: station diagnostics and the log**, with ru/en strings.
  Rejected: log only.
- **D5. CI: PR CI compiles the Windows-only tests but does not run them**
  (section 13). Running them on `windows-latest` is a follow-up.

## 13. Implementation notes (plan 2026-09-27)

These supersede the named parts of sections 6-8.

- **Probe (6.1).** It is a function, `profile_facts()`, not a trait: `resolve`
  takes the resulting `ProfileFacts` value, and tests pass values directly. It
  reports temporary, mandatory and roaming profiles plus the
  `DeleteRoamingCache` policy. It has no folder-redirection check: no decision
  needs one, and the record's `legacy_dir` shows a UNC path when redirected.
  Test 15 drops its `FOLDERID_RoamingAppData` assertion.
- **Notices (6.6).**
  - The notices are `LegacyInUse`, `MoveFailed`,
    `LocalLessDurable { reason }`, `RoamedCopyPresent { same_machine_id }` and
    `ClaimLeftovers`.
  - `TemporaryProfile` is `LocalLessDurable { reason: temporary_profile }`.
  - A committed station whose profile later becomes less durable stays local
    and reports `LocalLessDurable`.
- **Extra blocks (6.3).** A claimed folder with station files but no record
  blocks, because this machine's record may be lost. So does a recorded claim
  whose folder holds no station files.
- **Stale sidecars (6.3 step 4).** Before a resumed install, every
  `station.json`, `station-mirror.db` and `-journal`/`-wal`/`-shm` in the local
  folder is removed. SQLite would otherwise replay a stale journal next to a
  fresh copy.
- **WAL (6.3 step 4).** tauri-plugin-sql creates the database in WAL mode
  (sqlx `create_database`), and the station can exit without a checkpoint, so
  committed facts may live only in `-wal`. The `-wal` travels with the
  database; `-shm` is skipped and rebuilt on open.
- **Same folder (6.3 step 0).** When `legacy_dir == local_dir` (macOS),
  resolution takes no lock and writes no record.
- **Cleanup (6.3 step 7).** Cleanup removes every top-level file of the
  recorded claimed folder, not only the verified ones: the verified names are
  not persisted, and the other files are transient.
- **UI (D4).** No diagnostics screen exists. The Update screen gets a "Station
  data" section (folder and notices), and the pairing screen warns on
  temporary and mandatory profiles (6.5).
- **CI (D5).** PR CI compiles the Windows-only tests
  (`cargo test --no-run` in `station-windows-build`) but does not run them. On
  Windows Server 2025 the Tauri test harness can fail before `main()` with
  `STATUS_ENTRYPOINT_NOT_FOUND`, so the stable gate is also compile-only.
  Running them needs a follow-up: a Tauri-free storage crate, or a test-binary
  manifest fix.
- **Rollback (6.8).** The release acceptance and runbooks now say that
  installing a build from before the move requires moving the files back to
  the roaming folder and deleting the record first, with the station closed.

- **Resolve after review (Task 5 fixes, owner-approved).**
  - A failed claim rename is decided by what is on disk. If the claimed folder
    holds the station files, the move continues. If the roaming folder still
    holds them, the intent is withdrawn and the station runs there with
    `LegacyInUse`. If neither does, the station is blocked. Retries stop on
    `NotFound`, because an earlier attempt may have landed without saying so.
  - Under the durability guard, a pending claim is renamed back to the roaming
    folder (`Step::Undo`), then any partial local copy and the record are
    dropped. A failed rename back is also decided by disk.
  - The guard never points the station at an empty roaming folder while the
    station files sit in Local (it adopts Local and reports
    `LocalLessDurable`) or in an unfinished claim (it blocks).
  - A claimed folder with station files and no record blocks the start on
    every branch. This supersedes 6.7 row 2 for a computer whose roaming copy
    sits next to another computer's stuck claimed folder: that computer stays
    blocked until support clears the folder.
  - Discarding local files never touches `station-storage.json` or
    `station-storage.lock`.
- **Final review fixes (owner-approved).**
  - An empty roaming folder only means a fresh install when `%APPDATA%` itself
    exists. Windows reports an unreachable redirected folder as not found, so
    a missing or unreachable `%APPDATA%` blocks instead of minting in Local.
  - Station files on both sides with no record block before the durability
    guard is considered.
  - Every blocked message names the folders involved. The recovery screen
    shows it («Данные станции заблокированы: …») instead of the generic
    `enroll.recoveryFailed` text, which supersedes 6.6 for storage;
    `docs/runbooks/station-storage-recovery.md` explains each message.
  - `read_config` and `clear_credential` never mint in a claimed folder whose
    `station.json` is gone (another logon session finished the move).
  - A process-wide mutex serializes the config commands, as the main thread
    did before they became async.
  - On Unix, copies keep the source file's permissions (0600 for the key file
    and its backups).
  - A pending cleanup only touches a `<legacy name>.migrating-*` sibling of
    the roaming folder; any other folder the record names is kept and reported
    as `ClaimLeftovers`.
  - Stale `.migration-*` staging folders and `.station-storage-*.tmp` record
    writes are removed when a move resumes and when the guard forgets one.
