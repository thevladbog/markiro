# Signer credential off the Windows roaming profile — design proposal

**Status:** implemented on branch `claude/beautiful-chaum-eac340` on
2026-09-27; the owner's decisions S1-S4 and S6-S13 are in section 13, and S5
is an operational step that stays open. The release waits for the Windows
checks in section 10, run on a manually installed build before **Publish
signer stable** (section 11). The change stays inside `apps/signer`: no cloud
API, contract, Postgres or installer change.

## Summary

The signer keeps its state in `%APPDATA%\app.markiro.signer\`, the Windows
**roaming** AppData folder: `signer.json` (agent id, tenant name, server URL,
selected certificate thumbprint, and the agent secret as a user-scope DPAPI
blob) and the `journal\` directory. With a roaming profile or AppData(Roaming)
folder redirection the folder follows the Windows user to other computers, and
so do the user's DPAPI master keys. Microsoft documents this for
`CryptProtectData` (Remarks): "a user with a roaming profile can decrypt the
data from another computer on the network". The header of
`signer-core/src/storage.rs` claims the opposite.

A second computer where the same user signs in and the signer is installed
becomes the same cloud agent. Nothing on the server tells the two apart: the
agent is authenticated by its secret alone, and the hostname is recorded once,
at pairing. The two computers race for the tenant's single refresh task. When
the one without the qualified certificate's key wins, the refresh fails while
the cabinet shows a healthy agent under the first computer's name.

Proposal: move the folder once to `%LOCALAPPDATA%\app.markiro.signer\`, where
the WebView2 profile already lives, with a crash-safe copy → verify → commit →
retire protocol adapted from the station proposal
(`docs/superpowers/specs/2026-09-27-station-local-storage-design.md`, commit
`47741d2fd`, branch `claude/recursing-hawking-94197e`). Keep user-scope DPAPI.
Stop deleting a credential that merely fails to decrypt. Correct the comments
and runbooks. Binding the secret to the computer and server-side clone
detection are laid out as separate options.

## 1. What is stored where (verified in code)

| Item                                 | Written by                                                                                                                                                                                                   | Windows path today                                                                           | Content                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `signer.json`                        | `storage::write_config` on pairing, certificate choice, server-URL change and `clear_credential` (`signer-core/src/storage.rs:58-85`); folder from `app.path().app_config_dir()` (`src-tauri/src/lib.rs:40`) | `%APPDATA%\app.markiro.signer\signer.json`                                                   | `agentId`, `tenantName`, `serverUrl`, `certThumbprint`, `agentSecretProtected` (`storage.rs:18-31`)        |
| `.signer.json.tmp`                   | an interrupted `write_config` (`storage.rs:61`)                                                                                                                                                              | same folder                                                                                  | a partial config, never read                                                                               |
| `journal\signer.jsonl`, `.1` to `.6` | `Journal::open(config_dir.join("journal"))` (`signer-core/src/runtime.rs:166`)                                                                                                                               | `%APPDATA%\app.markiro.signer\journal\`                                                      | redacted events, at most 7 × 1 MiB (`journal.rs:15-18`), no hostname per entry                             |
| WebView2 profile                     | Tauri forces `LocalData` on Windows (tauri 2.11.5 `src/manager/webview.rs:534-543`)                                                                                                                          | `%LOCALAPPDATA%\app.markiro.signer\EBWebView`                                                | nothing durable: the UI uses no browser storage                                                            |
| Autostart                            | NSIS hook (`src-tauri/windows/installer-hooks.nsh:14`) and `src-tauri/src/autostart.rs`                                                                                                                      | `HKCU\...\CurrentVersion\Run\MarkiroSigner`, `HKCU\Software\Markiro\Signer\AutostartEnabled` | the quoted path of the per-user executable. HKCU roams with a roaming profile, not with folder redirection |
| Program files                        | NSIS `currentUser` default: no `installMode` in `tauri.conf.json`; the Tauri CLI 2.11.4 template sets `StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"`                                                       | `%LOCALAPPDATA%\Markiro Signer`                                                              | binaries; they do not roam                                                                                 |

`app_config_dir()` is `dirs::config_dir()/<identifier>` (tauri 2.11.5
`src/path/desktop.rs:238-242`), which on Windows is `FOLDERID_RoamingAppData`
(dirs 6.0.0 `src/win.rs:8`, dirs-sys 0.5.0 `src/lib.rs:177`).
`app_local_data_dir()` is `FOLDERID_LocalAppData` (`desktop.rs:256-260`,
`win.rs:11`, `lib.rs:181`). On macOS both resolve to the same folder.

`DpapiStore::protect` calls `CryptProtectData` with `dwFlags = 0`, no entropy
and no description (`signer-core/src/storage_dpapi.rs:28-38`): user scope,
without `CRYPTPROTECT_LOCAL_MACHINE`.

The runtime reads `signer.json` at the top of every loop iteration
(`runtime.rs:309`; at most about 25 s apart while idle) and again before each
task (`runtime.rs:458`). It writes the file on pairing (`:275`), certificate
selection (`:588-594`), server-URL change (`:596-601`) and unpair (`:293-300`).

## 2. What the agent secret can do (verified in the API)

- **The secret alone authenticates.** `SignerAgentGuard` hashes the
  `x-signer-token` header, loads the active agent with that `secret_hash`,
  attaches `tenantId` and `signerAgentId`, and bumps `last_seen_at`
  (`apps/api/src/tenancy/signer-agent.guard.ts:37-56`). The protocol carries
  no machine or install identifier. The hostname travels only in the pair
  request and becomes the agent `name`
  (`apps/api/src/modules/signer-agents/signer-agents.service.ts:425-428`),
  which the cabinet labels "Computer" (`apps/admin/src/i18n/en.json:3951`).
- **What a holder can do.** A holder can long-poll and claim the tenant's
  refresh task, whose payload holds the True API base URL, an optional MChD INN
  and the token format. A holder can `complete` the task with any string up to
  64 KiB (`packages/platform-contracts/src/chz-signer.ts:42-45`). The API
  stores that string, encrypted, as the tenant's True API token in place of
  the current one, and writes the reported certificate onto the agent row the
  cabinet shows (`signer-tasks.service.ts:176-218`). A holder can also `fail`
  the task.
- **What a holder cannot do.** A holder cannot read the stored token, and
  cannot produce a valid True API token without the UKEP private key, which
  stays in CryptoPro. The secret is therefore an integrity and availability
  credential for the tenant's Chestny ZNAK integration, not a key to its data.
- **One tenant may have several active agents.** `chz_signer_agents` has no
  uniqueness on tenant or status (`packages/db/src/schema/chz.ts:71-73`), and
  pairing never revokes an earlier agent (`signer-agents.service.ts:412-431`).
- **One open refresh task per tenant.** The partial unique index
  `chz_signer_tasks_open_uq` enforces it (`chz.ts:136-138`). Claims use
  `FOR UPDATE SKIP LOCKED` (`signer-tasks.service.ts:64-94`). `complete` and
  `fail` accept only the agent that claimed the task (`:124-131`, `:252-258`).
  A clone passes that check, because it shares the agent id.

## 3. What a second computer does

**Preconditions:**

- the same Windows user signs in on computer B;
- `%APPDATA%` reached B through a roaming profile or folder redirection;
- the signer is installed on B.

With a roaming profile the `Run` value roams too. It points at the same
per-user path, so B starts the signer at sign-in.

1. **Same agent.** B decrypts the blob with the roamed master keys and polls
   with the same secret. The cabinet shows one agent, named after A.
   `lastSeenAt` is fed by both computers.
2. **The refresh task goes to whichever computer claims it first.**
   - Both long polls retry the claim every 2 s
     (`signer-tasks.service.ts:26`, `:49-62`).
   - If B wins but cannot sign, the task fails with a `CRYPTO_*` code. B
     cannot sign when the token or key container is not there, when CryptoPro
     is missing, or when it has another certificate.
   - The next task comes at the next 15-minute scheduler tick inside the
     90-minute lead window (`chz-constants.ts:23`,
     `signer-scheduler.service.ts:94-153`).
   - Each attempt is then a coin toss. Enough lost tosses let the 10-hour
     token expire, which stops CHZ exports and status checks.
   - The cabinet then reports, for example, "certificate not found" for a
     certificate that works on A. A PIN prompt may also appear on B's desktop
     (plausible, not verified).
3. **Monitoring and audit mislead.** `lastSeenAt` stays fresh while A, the
   actual UKEP computer, is switched off. `chz_api_tokens.agent_id` and the
   task's `agent_id` cannot say which computer minted a token. That conflicts
   with the audit-accuracy requirement in `AGENTS.md`.
4. **The shared file couples the computers.** The coupling is live with
   redirection, and happens at sign-in and sign-out with a roaming profile:
   - choosing a certificate on one computer changes it for the other
     (`runtime.rs:588-594`), which then fails with `CRYPTO_CERT_NOT_FOUND`;
   - a credential that fails to decrypt on one computer is cleared
     (`runtime.rs:329-346` → `clear_credential`), unpairing every computer
     that shares the file. The operator pairs again, and the previous agent
     stays `active` in the cabinet with nobody holding it;
   - a revocation (401) unpairs all of them, which is correct;
   - both append to one journal with no hostname per entry, and an export
     labels everything with the exporting computer's name
     (`runtime.rs:603-615`);
   - a roaming profile uploads at sign-out, so an older copy can overwrite a
     newer pairing.
5. **Copies of the credential.** The blob and the user's DPAPI master keys sit
   in several places:
   - on the profile or redirection share;
   - in that share's backups;
   - in cached profiles on every computer where the user signed in, including
     computers where the signer was never installed.

   Whoever can act as that Windows user can recover the secret from any of
   these copies.

## 4. Exposure

- **Local account, or a domain account with a local profile.** `%APPDATA%` is
  an ordinary local folder, and none of section 3 happens. This is probably
  the usual setup at a small manufacturer.
- **Domain account with a roaming profile.** The file, the master keys and the
  autostart entry roam. A live clone needs the signer installed on the second
  computer. That is likely after trial installs on several PCs, or after an IT
  roll-out. A single computer can also have an older copy restored at sign-in.
- **AppData(Roaming) redirection.** One live file for every computer where the
  user is signed in.
- **Terminal servers with User Profile Disks or FSLogix.** The whole profile,
  `%LOCALAPPDATA%` included, follows the user between session hosts, so the
  signer runs wherever the session is. That is one identity used from one
  session at a time. It is a clone only when the user holds two sessions at
  once. This proposal does not change it (section 12).

The UKEP computer is an office PC, usually in accounting or management. That
is exactly the kind of machine domain policies cover, more often than line
stations. The cabinet tells customers to install the signer "on the computer
holding the qualified certificate" (`en.json:3949`). Nothing tells them which
Windows account or profile type to use. The repository has no evidence of what
customers run.

Conclusion: the problem is latent on workgroup PCs, and real and silent in
domains with roaming or redirected AppData. The worst case is a token refresh
that is flaky or stops, with misleading monitoring, plus copies of a
credential that can overwrite the tenant's True API token.

## 5. Goals and non-goals

Goals:

- The agent credential and the journal live in a folder that Windows neither
  roams nor redirects.
- Existing installations keep their pairing through the update. The move
  happens once and survives interruption at any point.
- A copy that roams in after the move is never loaded and never deleted. The
  move deletes only the legacy files it has verified as copied.
- Where the local folder is less durable than the roaming one, the signer
  keeps today's location and says so.
- A local decryption failure never destroys the stored credential.
- The comments and runbooks state what DPAPI actually guarantees.

Non-goals:

- Splitting clones that already exist. Section 7.8 gives the support steps.
- Any cloud API, contract, database or installer change. Option C is separate.
- A different DPAPI scope. Option B is separate.

## 6. Options

**A. `%LOCALAPPDATA%` with a one-time move (recommended).**

- Neither roaming profiles nor Folder Redirection move this folder. Folder
  Redirection offers AppData(Roaming), not the local AppData folder.
- It is the same choice as the station (owner decision D1) and the standalone
  app. The standalone guide says of its DPAPI-protected device key: never move
  it to a roaming directory (`apps/standalone/AGENTS.md`, branch
  `claude/autonomous-desktop-station-9e6f13`).
- No installer or API change.
- DPAPI stays as it is, so the blob moves as bytes and needs no re-encryption.
- Weaknesses: profile containers carry the local folder too, and
  profile-deletion policies remove it. The durability guard (7.5) covers the
  second.

**B. Bind the secret to the computer.**

How: wrap the blob in machine-scope DPAPI (`CRYPTPROTECT_LOCAL_MACHINE`)
inside the existing user-scope layer, so decryption needs both this user and
this computer. A weaker variant adds machine-specific entropy such as
`MachineGuid`; that value is not secret, and disk images that were not
generalised duplicate it.

Gains:

- a copied file is useless on another computer, even for the same user; that
  covers profile containers and profile-migration tools;
- the layer that fails tells "another user" apart from "another computer".

Costs:

- it breaks deployments where the signer is meant to follow the user. A
  terminal-server farm with profile disks would move one file between session
  hosts, and each host would need a new pairing;
- it needs a scheme marker and a re-wrap during the move;
- an older build would misread the new blob;
- the cross-computer behaviour can only be checked on two real machines;
- on its own, without A, it makes redirection worse: today's
  unreadable-credential path clears the shared file.

Machine scope alone, without the user layer, would let every local account
decrypt the secret. Rejected.

**C. Server-side install binding.**

How: the agent generates an install id in the local folder and sends it at
pairing and on every call. The API records it and flags, or refuses, a second
install id on one agent. The cabinet shows "used from two computers".

Gains: it is the only option that detects clones that already exist, and it
makes the profile-container and multi-agent cases visible.

Costs:

- it is a cross-surface change: a header or a contract change (`.strict()`
  schemas and the `deny_unknown_fields` Rust mirror), a Postgres migration,
  the guard, the cabinet and OpenAPI. A header keeps the strict body schemas
  unchanged;
- agents that send no id need a compatibility path;
- flagging versus blocking is a policy choice.

It belongs in its own spec.

**D. Warn only.** Detect roaming or redirection and ask IT to exclude the
folder. This does nothing for redirection and leaves the risk in place.
Rejected, as for the station.

**Recommendation:** ship A now together with 7.6. Do not do B. Do C as a
follow-up if the owner wants existing clones detected.

## 7. Design (option A)

### 7.1 Units

- **`signer_core::storage_location::resolve(legacy_dir, local_dir, probe, hooks) -> Resolution`.**
  - A file-system state machine with no Tauri dependency.
  - Testable on the host with temporary folders; a step hook injects failures
    (the station plan's pattern).
  - `Resolution { dir, notices }`: `dir` is the local folder, or the legacy
    folder when the move is postponed or ruled out.
- **`ProfileProbe`.** A trait. The Windows implementation reads:
  - `GetProfileType` (`PT_TEMPORARY`, `PT_MANDATORY`, `PT_ROAMING`,
    `PT_ROAMING_PREEXISTING`);
  - the `DeleteRoamingCache` policy value under
    `HKLM\SOFTWARE\Policies\Microsoft\Windows\System`.

  These are the calls the station plan already type-checked for
  `x86_64-pc-windows-msvc`. Other platforms report a local profile.
  `signer-core` needs the `windows-sys` features `Win32_UI_Shell`,
  `Win32_System_GroupPolicy` and `Win32_System_Registry`; no new crates. Copy
  the code rather than share a crate: the station and the signer are separate
  Cargo workspaces with separate release trains.

- **The shell.** `lib.rs` resolves before `Runtime::new` and passes
  `resolution.dir`. Nothing else changes around it:
  - `storage.rs` keeps its `&Path` API;
  - nothing else calls `app_config_dir()` (one call site, `lib.rs:40`).

  Resolution runs synchronously in `setup`:
  - the window starts hidden (`tauri.conf.json:20`);
  - today's `Runtime::new` already reads the same folder synchronously
    (`runtime.rs:166`, `:178`);
  - the move adds a few small file operations, once. After it, startup no
    longer touches the roaming folder.

  The roamed-copy check (7.3 step 1) runs as a background task, because a
  redirected share can hang for its whole network timeout.

- **`Runtime`** receives the notices and exposes them as
  `AgentStatus.storageNotices`, mirrored in `src/lib/bridge.ts`.

### 7.2 Layout

In `%LOCALAPPDATA%\app.markiro.signer\`, next to `EBWebView\`:

- `signer.json` and `journal\`, names unchanged.
- `signer-storage.json`, the move record. It is written with the temporary
  file + `sync_all` + rename pattern that `write_config` already uses.
- `signer-storage.lock`, held with `std::fs::File::lock` (stable since Rust
  1.89) while resolving. The single-instance mutex is `"{id}-sim"` without
  `Global\` (tauri-plugin-single-instance 2.4.3
  `src/platform_impl/windows.rs:67`), so it is per logon session. Two
  sessions of one user on a terminal server could otherwise resolve at once.
  If the lock cannot be taken, nothing moves or cleans up that run, but the
  record still decides: it is only ever replaced by an atomic rename, so it
  is read without the lock, and a committed record keeps the local folder
  authoritative (S6).

The record lives in the local folder on purpose. Neither a roaming download
nor another computer can make this computer believe a move is done or not
done.

### 7.3 Resolution algorithm

One rule carries the protocol: **without a committed record the legacy folder
is authoritative; with one, the local folder is.** A single atomic write of
the record switches the authority.

Unlike the station, the signer copies first and retires the legacy folder
after the commit:

- the only critical file is `signer.json`, a few hundred bytes;
- there is no live database to guard with exclusive handles;
- in the few milliseconds when both folders hold the credential, the only
  effect is to prolong a clone that already existed.

The station's claim-first order would also work here if the owner prefers one
protocol for both applications.

Under the lock:

0. **Same folder** (macOS). Record `committed/same-directory` and use it.
1. **The record says `committed`.** Use the local folder.
   - If `cleanup` is pending, retry step 6 (best effort).
   - In the background, if the legacy folder or a retired sibling
     (`<legacy>.retired-*`) holds `signer.json`: parse only `agentId` and
     report `RoamedCopyPresent { sameAgent }`. Never load that file and never
     delete it.
   - A record that does not parse counts as committed when the local folder
     holds `signer.json` (the background check still runs), and as absent
     otherwise. A record that exists but cannot be opened (an antivirus scan,
     a sharing violation) keeps the local folder and moves nothing (S7, S8).
     Only the absent case runs the move, and the move deletes nothing it has
     not verified as copied.
2. **No record, and the durability guard (7.5) finds the local folder less
   durable.** Use the legacy folder, write nothing, report the reason.
3. **Look at the legacy folder.**
   - **It holds neither `signer.json` nor journal files.** Record
     `committed/adopted` if the local folder holds `signer.json` (placed there
     by support). Otherwise record `committed/fresh`, so a copy that roams in
     later is never adopted. Use the local folder.
   - **It cannot be read** (an error other than "not found", such as an
     unreachable share). Use the legacy folder for this run and report
     `MovePostponed`. That is today's behaviour; the next start retries.
4. **Copy** whichever of `signer.json` and the journal files the legacy
   folder holds.
   - Write the legacy `signer.json` bytes into the local folder (temporary
     file + `sync_all` + rename), read them back and compare.
   - Copy `journal\signer.jsonl*` the same way. A journal failure is not fatal;
     the new journal notes it.
   - Skip `.signer.json.tmp`.
   - Overwrite local files left by an earlier interrupted attempt: the legacy
     folder is still authoritative.
   - If anything fails on `signer.json`, use the legacy folder for this run
     and report `MovePostponed`.
5. **Commit.** Record
   `committed/migrated { cleanup: pending, retiredDir, copiedConfig }`, with
   `retiredDir = <legacy>.retired-<nanos>-<pid>` chosen at this point and
   `copiedConfig` holding the FNV-1a fingerprint and length of the copied
   `signer.json` (no credential material), so step 6 still recognises the file
   after a restart.
6. **Retire.**
   - Before renaming, compare the roaming `signer.json` with `copiedConfig`. A
     different file belongs to someone else: leave the folder in place, and
     the background check reports it.
   - Rename the legacy folder to `retiredDir`: same parent, one atomic rename.
   - In `retiredDir`, delete `signer.json` only if its bytes equal what was
     copied, then delete the journal files.
   - Remove the folder if it is empty, and record `cleanup: done`.
   - A `signer.json` that another computer changed in the meantime stays
     and is reported at every start: the background check also looks in
     retired folders. Unknown files stay and are not reported, because they
     are not ours (S9).
   - If the rename is refused (folder in use, share unreachable): keep
     `cleanup: pending`, report `LegacyCleanupPending`, and retry at the next
     start. The local copy is already authoritative, so a pending cleanup
     never blocks the agent.

### 7.4 Interruption table

| Interrupted                                  | Authoritative copy | Next start                                           |
| -------------------------------------------- | ------------------ | ---------------------------------------------------- |
| before the record is written (steps 2-4)     | legacy folder      | repeats from step 2; local leftovers are overwritten |
| after the commit (step 5), before the rename | local folder       | step 6                                               |
| after the rename in step 6                   | local folder       | deletion resumes in `retiredDir`                     |

At every point exactly one location is authoritative, and it holds a complete
`signer.json`.

### 7.5 Durability guard

The predicate is the same as the station's (station spec §6.5, owner decision
D2):

- a temporary profile;
- a mandatory profile;
- a roaming profile with `DeleteRoamingCache = 1`, where the local profile
  copy, `%LOCALAPPDATA%` included, is deleted at sign-out.

In these cases the signer stays in the legacy folder and reports why. The
guard is re-evaluated at every start. Temporary and mandatory profiles discard
both folders at sign-out anyway, so the pairing screen also warns that the
pairing will not survive.

Redirected Roaming alone does not stop the move: the local folder is strictly
better there.

### 7.6 An unreadable credential is not deleted

Today a failed `unprotect` journals the error and calls `unpair()`, which
rewrites `signer.json` without the blob (`runtime.rs:329-346`).

After the move, the file is local while the DPAPI master keys stay in the
user's roaming folder. Take a redirected folder without Offline Files and an
unreachable share: decryption fails where today reading the file itself fails
and is retried. Without a change, the move would turn a network outage into a
forced re-pairing.

New behaviour:

- keep the file;
- show the pairing screen with an explanation: "the saved pairing cannot be
  read by this Windows user on this computer";
- keep retrying decryption with the existing backoff, and return to work if
  it succeeds;
- a new pairing overwrites the file, as today.

A 401 from the cloud still clears the credential: it is an authoritative
revocation.

### 7.7 Notices

Every notice goes to the journal and to `AgentStatus.storageNotices`. The
Status tab shows each one as a warning in Russian and English. The pairing
screen also shows `CredentialUnreadable` and `LocalLessDurable` for a temporary
or mandatory profile.

- `LocalLessDurable { reason }`: the signer stays in the roaming folder
  (temporary or mandatory profile, `DeleteRoamingCache`).
- `MovePostponed`: the legacy folder could not be read, or the copy failed.
  The next start retries.
- `LegacyCleanupPending`: the old roaming copy could not be removed yet. This
  computer no longer uses it.
- `RoamedCopyPresent { sameAgent }`: pairing data arrived in the roaming
  folder after the move. With `sameAgent`, a copy of this agent may run on
  another computer: revoke it in the cabinet and pair only the computer that
  holds the qualified certificate.
- `CredentialUnreadable`: see 7.6.

A one-time journal entry records the move itself. Every fallback also
journals its step and OS error (`Resolution.diagnostics`), for example
`copy signer.json: Access is denied. (os error 5)`; these lines are never
shown in the UI.

### 7.8 Copies that already exist

| Situation                                                      | What the move does                               | Result                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| One computer, roaming profile                                  | moves its cached copy, retires the legacy folder | fixed; the next sign-out should drop the folder from the server copy (verify on a test domain)            |
| A and B both hold the identity through a roaming profile       | each moves its own cached copy                   | **the clone remains**, pinned per computer: it stops spreading but is not split                           |
| Redirected AppData, B runs an old version                      | A moves and retires the shared folder            | B finds nothing on its next loop and shows pairing: no clone. Pair B only if it should be a second signer |
| Redirected AppData, the computer without the key updates first | it takes the identity                            | the UKEP computer shows pairing. The move cannot tell which computer holds the key container              |

Splitting an existing clone is cheap for the signer:

1. Revoke the agent in the cabinet. Every copy gets 401 and returns to
   pairing.
2. Pair the UKEP computer again.

Revocation also deletes the tenant's stored token
(`signer-agents.service.ts:312-327`), so CHZ calls pause until the new agent
completes its first refresh. A runbook paragraph is part of the change.

### 7.9 Rollback and downgrade

The updater installs only newer versions: tauri-plugin-updater 2.10.1 checks
`release.version > self.current_version` (`src/updater.rs:532`), and the signer
sets no custom comparator.

NSIS updates keep both folders. Only an uninstall with the "delete application
data" box ticked removes them, and it removes both (Tauri CLI 2.11.4 NSIS
template, outside update mode).

A manually installed older build reads the roaming folder, finds nothing, and
shows pairing; the local copy stays intact. To recover:

1. Copy `signer.json` back to `%APPDATA%\app.markiro.signer\`.
2. Delete `signer-storage.json`.

If the operator pairs again on the older build and upgrades later, the newer
build keeps the local copy and reports the roaming one as
`RoamedCopyPresent { sameAgent: false }`.

## 8. Tests

**Rust on the host** (the Linux `signer-rust` CI job, and locally). Temporary
folders, a fake probe and the step hook:

1. No legacy folder: `committed/fresh`, the runtime uses the local folder, and
   the legacy folder is not created.
2. A legacy `signer.json` and journal files arrive byte-identical. The record
   is committed, the legacy folder is gone, and `.signer.json.tmp` is dropped.
3. Interrupt at every step boundary, then rerun: the result converges. At
   every interruption exactly one authoritative location holds a complete
   `signer.json`.
4. No record, and the local copy is older than the legacy one: the legacy one
   wins.
5. A second run after the commit is a no-op. Two concurrent resolutions
   (threads, lock) move once.
6. The rename in step 6 is refused: the record stays committed and
   `LegacyCleanupPending` is reported; the next run retires. A legacy
   `signer.json` changed between the copy and the retirement is kept and
   reported.
7. A legacy `signer.json` reappears after the commit: never loaded, never
   deleted, and `RoamedCopyPresent.sameAgent` is right for the same and for a
   different `agentId`.
8. Durability guard, one test per reason: the legacy folder is used and no
   record is written; the move runs once the fake policy clears.
9. An unreadable legacy folder, or an injected copy or compare failure: the
   legacy folder is used, no record is written, `MovePostponed` is reported,
   and the next run completes.
10. Same folder: no copy.
11. Runtime with a failing `SecretStore`: `signer.json` is unchanged, the
    phase is `unpaired`, `CredentialUnreadable` is reported, and a later
    success returns to `idle`. Pairing overwrites the file. A 401 still clears
    the credential (the existing test stays).

**Rust on Windows only.** The `signer-windows-build` job already runs
`cargo test` on `windows-latest`, so unlike the station nothing new is needed
in CI:

12. `ProfileProbe` on the runner reports a local profile that is neither
    temporary nor mandatory.
13. A DPAPI blob written into a legacy folder decrypts after the move: the blob
    is not bound to a path.

**Webview (Vitest):**

14. Notices render on the Status tab.
15. The pairing screen shows the unreadable-credential and temporary-profile
    warnings.
16. The ru and en keys stay in parity.

## 9. Documents that change with the code

- `signer-core/src/storage.rs:1-6`: replace the header. Proposed text:
  "On-disk agent state under `%LOCALAPPDATA%\app.markiro.signer\signer.json`,
  moved once from the roaming `%APPDATA%` folder (`storage_location`). The
  agent secret is a user-scope DPAPI blob (`storage_dpapi.rs`): another
  Windows user cannot decrypt it, but the same user can on any computer that
  has their DPAPI keys, which a roaming profile or redirected AppData
  provides. That is why this file must stay in non-roaming storage."
- `storage_dpapi.rs:1-6`: add the same caveat. The ciphertext is tied to the
  user, not to the computer.
- `runtime.rs:332-333`: the comment "the blob belongs to another user or
  profile" follows 7.6.
- `docs/runbooks/signer-agent-manual-e2e.md:126`: the path.
- `docs/runbooks/signer-windows-acceptance.md`: an upgrade check. The pairing
  and the certificate are kept, the roaming folder is gone, and the local
  folder is present.
- `apps/signer/README.md`: where the data lives, plus IT guidance for the UKEP
  computer:
  - use a local account, or a profile without roaming or redirected AppData;
  - pair after disk imaging, not before.
- `docs/architecture.md`: one invariant shared with the station proposal.
  Device credentials (the station key, the signer secret, the standalone
  device key) live in machine-local, non-roaming storage.
- `docs/superpowers/specs/2026-08-28-chz-signer-agent-design.md:190` names
  `%APPDATA%\Markiro Signer`, which was never the real path. Add a pointer to
  this spec.

## 10. Checks that need real Windows or a domain

**Proved by CI** (`windows-latest`, local profile): the DPAPI round trip, the
probe on a local profile, and the whole state machine. The state machine also
runs on Linux.

**A real Windows PC with a local account** (Windows 10 and 11):

- Upgrade from 0.1.4 with a paired agent and a chosen certificate.
- Expected: no new agent in the cabinet, the certificate is kept, and the next
  refresh completes through CryptoPro. `%APPDATA%\app.markiro.signer` is gone
  and the journal continues.
- Uninstall with and without "delete application data".

**A test Active Directory domain, roaming profile:**

1. Before the fix, confirm the premise: the same user on B decrypts A's blob,
   and B polls as A's agent.
2. With the fix, move on A and sign out. Check that the profile share no
   longer holds `app.markiro.signer`.
3. Sign in on B, where the signer is installed. Expect the pairing screen, not
   A's identity; `lastSeenAt` follows A only.
4. `GetProfileType` reports a roaming profile.

**A test domain with AppData(Roaming) redirection:**

- B, still on 0.1.4, shows pairing within one loop after A upgrades.
- The local AppData path is not redirected.

**Redirection without Offline Files, with the share taken offline:**
`CredentialUnreadable` appears, the file is kept, and the signer recovers when
the share returns.

**`DeleteRoamingCache = 1`, a temporary profile, and a mandatory profile:** no
move, and the notices are shown.

None of these can be claimed from host tests.

## 11. Rollout

A signer-only change: no API, Postgres or contract change.

The signer has only a stable channel: `signer-stable-release.yml` is its one
release workflow, and `tools/signer-release` rejects beta versions. Every
operator who accepts the update runs the move on the next start, so the
checks come first:

1. Build the release commit and install it by hand over a paired 0.1.4 on
   Windows 10 and Windows 11; run section 10 as far as the environment allows.
2. Confirm that `signer-windows-build` ran on the pull request: it is the only
   job that runs the `#[cfg(windows)]` tests.
3. Publish with `signer-stable-release.yml`.

For tenants known to use roaming profiles or redirection, revoke and pair
again after the upgrade, so the copies in profile-share backups become
useless. This is an operational step and the owner's call; it needs no code.

## 12. Residual risks

- **Existing clones stay clones** until they are revoked and paired again
  (7.8). Without option C nothing detects them.
- **Profile containers** (User Profile Disks, FSLogix) carry `%LOCALAPPDATA%`.
  The signer follows the user between session hosts; that is a clone only with
  concurrent sessions. Option B would pin it to one host and break that use.
- **A disk image taken after pairing** duplicates the credential, as it would
  with any local storage.
- **Two separately paired agents on one tenant**, only one of which holds the
  key, still split the refresh tasks by chance. That is existing multi-agent
  behaviour, not caused by roaming, and outside this change. Option C's
  cabinet view would make it visible.

## 13. Owner decisions

Decided by the owner on 2026-09-27:

- **S1. Target: A**, `%LOCALAPPDATA%` with copy → commit → retire. Rejected:
  B on top of A; D, warn only.
- **S2. The station decisions D2-D4 carry over:**
  - the durability guard keeps Roaming, with a notice;
  - a copy that roams in after the move is reported, never loaded, never
    deleted;
  - notices go to the journal and to the signer UI.

  Rejected: notices in the journal only; moving regardless of profile type.

- **S3. An unreadable credential is kept (7.6)** and the signer asks for a new
  pairing, as part of this change. Rejected: today's wipe.
- **S4. Option C becomes a separate spec after A ships.** Rejected: including
  it in this change; not doing it.

Decided by the owner during the implementation review on 2026-09-27:

- **S6. A lock failure reads the record anyway.** A committed record keeps the
  local folder; nothing moves or cleans up without the lock. Rejected: falling
  back to the roaming folder.
- **S7. A record that exists but cannot be opened counts as moved:** the local
  folder stays and nothing moves. Rejected: treating it like a corrupt record.
- **S8. The roamed-copy check runs while the record does not parse** and the
  local folder holds `signer.json`.
- **S9. A changed `signer.json` left in a retired folder is reported at every
  start; unknown files are not reported.** Rejected: reporting unknown files
  in the journal; reporting the changed file only on the move run.

Decided by the owner in the final review on 2026-09-27:

- **S10. Every fallback journals why** (the step and the OS error), without a
  new notice.
- **S11. A roaming journal folder that cannot be listed no longer postpones
  the move;** the journal stays behind, as step 4 allows.
- **S12. The unreadable-credential notice suggests revoking the previous
  agent** in the cabinet after pairing again.
- **S13. The release is verified on a manually installed build** before
  **Publish signer stable**, because the signer has no beta channel.

Still open:

- **S5. Operational rotation** (revoke and pair again) for tenants known to
  use roaming or redirection. Recommended where known; it needs no code.
