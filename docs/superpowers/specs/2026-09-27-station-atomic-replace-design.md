# Station config replacement on Windows — design

**Status:** approach "MoveFileExW + guard" chosen by the owner on 2026-09-27.
`read_config` keeps minting a new identity when `station.json` is missing
(follow-up, section 5). No cloud API, TypeScript, Postgres or SQLite change.

## Summary

`config::replace_config_file` installs `station.json` and the storage-move
record `station-storage.json` on Windows with
`ReplaceFileW(destination, temporary, NULL, REPLACEFILE_WRITE_THROUGH, …)`.
Two of its documented failures leave no file under the destination name, and
the callers then delete the only complete copies. For `station.json` that
means a new identity on the next read. The fix installs every write with a
single `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` and
adds a guard that never throws away the last copy of a document.

## 1. Evidence

Microsoft's `ReplaceFileW` reference (MicrosoftDocs/sdk-api), with no backup
name:

- `ERROR_UNABLE_TO_MOVE_REPLACEMENT` (1176): the replaced file no longer
  exists; the replacement keeps its own name.
- `ERROR_UNABLE_TO_MOVE_REPLACEMENT_2` (1177): the replacement keeps its own
  name; the replaced file survives under a different name, known only when a
  backup name was passed.
- 1175 and every other error: both files keep their names.
- `REPLACEFILE_WRITE_THROUGH` is documented as not supported.

`MoveFileExW`: `MOVEFILE_REPLACE_EXISTING` replaces an existing destination;
`MOVEFILE_WRITE_THROUGH` makes the call return only once the move is on disk.
`FlushFileBuffers` requires a handle with `GENERIC_WRITE`.

Code on `main` (b78b991bb):

- `write_config_with_parent_syncs` backs up `station.json` to
  `.station-<uuid>.bak`, then on a failed replace deletes both the temporary
  sibling and that backup. After 1176/1177 they were the only known copies.
- `read_config` then finds no `station.json` and mints a new `machine_id`.
  Device recovery sees it differ from `station_device_recovery.machine_id`,
  purges the operator mirror and seals.
- `storage::record::write` has the same pattern. A lost record blocks the next
  start on the orphaned claim, which is safe and covered by
  `docs/runbooks/station-storage-recovery.md`.
- The comment behind `ReplaceFileW` says Windows cannot rely on `rename`
  replacing an existing file; `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`
  does, and Rust's `fs::rename` uses it. What `ReplaceFileW` adds — carrying
  the old file's ACL, creation time and streams over — is unused: the station
  sets no ACL of its own on these files.

A plausible trigger, not reproduced: antivirus or a backup agent holding
`station.json` open, with delete sharing, during a write.

## 2. Decision

1. **One rename.** On Windows `replace_config_file` always calls `MoveFileExW`
   with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`; the
   `ReplaceFileW` branch and its `exists()` check go. A failed rename leaves
   the old destination under its name, so deleting the temporary sibling and
   the backup is correct again. The write-through flag also makes the storage
   move's commit record durable before its clean-up starts. Other platforms
   keep `fs::rename`.
2. **Guard.** `config::install_replacement` runs the replace and, when it
   fails, looks at the disk:
   - the destination is present, or there never was one: `Unchanged`; the
     caller removes the temporary sibling (and the backup) as before;
   - an existing destination is gone: the temporary sibling is the last
     complete copy, so the replace is retried up to 3 times, 250 ms apart
     (the storage move's rename cadence). Success finishes the write normally;
     otherwise `Stranded`, and the caller keeps every copy and returns an error
     that names them.

   `write_config` and `record::write` both use it. The replace primitive is
   injected, like the directory syncs already are, so host tests can simulate
   a failure that removes the destination. With decision 1 this branch is
   unreachable according to the documentation; it guards against the
   undocumented.

3. **No extra flush.** Reopening the destination for writing and calling
   `sync_all` adds no documented guarantee beyond `MOVEFILE_WRITE_THROUGH`,
   and it would give a completed write a new way to report failure.

## 3. Trade-off

`MoveFileExW` without POSIX semantics refuses to replace a destination that
another process holds open. The write then fails with the old file intact, as
any other I/O error does today; callers already surface and retry it.
`ReplaceFileW` with a backup name could succeed there, at the cost of handling
each of its error states and a separate flush.

## 4. Verification

- Host tests (`cargo test`, macOS locally and the Linux `station-rust` CI
  job): a failed replace that keeps the destination discards the new copy; one
  that loses it installs the new copy; one that cannot reinstall keeps the new
  and the previous copies and names them; a failed first write leaves nothing
  behind; the same loss and reinstall cases for the storage record.
- Windows: the new `MoveFileExW` call is type-checked against
  `x86_64-pc-windows-msvc` in a scratch crate; CI's `station-windows-build`
  compiles the tests (`--no-run`) but runs none.
- Not verified: the Windows branch has not run. Before a stable release,
  `cargo test` must pass on a Windows 10/11 machine where the Tauri test harness
  starts, ideally with a second process holding `station.json` open during a
  write.

## 5. Out of scope

- `read_config` minting a new identity when `station.json` is missing but a
  `.station-*.bak` exists. It only matters when the guard's retries also fail.
- A POSIX-semantics fallback (`FileRenameInfoEx`) for destinations held open.
- The storage-move design (`2026-09-27-station-local-storage-design.md`) still
  describes `ReplaceFileW`; it records that implementation as it was merged.
