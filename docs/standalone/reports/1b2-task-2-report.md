# Task 2 report: Хранение ключа устройства и `device.json`

Plan: 1b2. Worktree: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`
(branch `claude/autonomous-desktop-station-9e6f13`).

## What was implemented

Followed the brief (`.superpowers/sdd/1b2-task-2-brief.md`) verbatim, step by step.

1. **Dependencies** (`apps/standalone/src-tauri/Cargo.toml`)
   - Added `thiserror = "2"` to `[dependencies]`.
   - Added a new `[target.'cfg(windows)'.dependencies]` section with
     `base64 = "=0.22.1"` and
     `windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }`.
   - `apps/standalone/Cargo.lock` picked up the three new dependency edges for
     `markiro-standalone` (`base64 0.22.1`, `thiserror 2.0.21`,
     `windows-sys 0.61.2`) via a normal `cargo` resolve — no other package in
     the lockfile moved.

2. **`apps/standalone/src-tauri/src/lib.rs`**
   - Added `pub mod device_config;` and `pub mod secret_store;` next to the
     existing `pub mod host_probe;` (alphabetical order; `cargo fmt` did not
     reorder them further).

3. **`apps/standalone/src-tauri/src/secret_store.rs`** (new) — copied from the
   brief exactly:
   - `Scheme::{Dpapi, Plain}`, `ProtectedSecret { scheme, value }` with a
     hand-written `Debug` that hides `value` (`finish_non_exhaustive`).
   - `SecretStoreError::{Protect, Unprotect, WrongScheme(Scheme)}` via
     `thiserror`.
   - `NATIVE_SCHEME` = `Dpapi` on Windows, `Plain` elsewhere.
   - `protect`/`unprotect` dispatch to `write_native`/`read_native`, which are
     either the `dpapi` module (Windows) or an identity passthrough (else).
   - `#[cfg(windows)] mod dpapi` wraps `CryptProtectData`/`CryptUnprotectData`
     from `windows-sys`, base64-encoding the ciphertext, mirroring
     `apps/signer/signer-core/src/storage_dpapi.rs`.
   - 4 tests (one Windows-only, compiled out elsewhere via `cfg(windows)`).

4. **`apps/standalone/src-tauri/src/device_config.rs`** (new) — copied from
   the brief exactly:
   - `DeviceConfig { host_address, fingerprint, host_id, device_id, kind: DeviceKind, line_id: Option<String>, device_key: ProtectedSecret }`,
     `camelCase` + `deny_unknown_fields`.
   - `DeviceConfigError::{Io { path, source }, Parse { path, source }}` via
     `thiserror`.
   - `path`, `load` (`Ok(None)` on `NotFound`), `save` (write a `0600`
     temporary file, `fsync`, `rename`, `fsync` the directory on Unix), and
     `clear` (tolerates a missing file).
   - 6 tests covering: missing file, atomic save + read-back with no leftover
     temp file, owner-only permission (Unix), a stale crash-leftover temp file
     not blocking a save, a corrupt file being reported without being
     overwritten, and `clear` being idempotent.

No code deviated from the brief's text — both modules were used verbatim
(only `cargo fmt` reflowed two `assert_eq!` calls that exceeded the line
width; see "Deviations" below).

## Test evidence

- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --lib`
  → **PASS**, `15 passed (1 suite, 0.06s)` (ran inside the default sandbox).
  Breakdown (`-- --list`): 6 `device_config::tests::*`, 6 pre-existing
  `host_probe::tests::*`, 3 `secret_store::tests::*` (the 4th,
  `windows_never_stores_the_plaintext`, is `#[cfg(windows)]` and does not
  exist in the macOS binary at all — matches the brief's "4 теста
  `secret_store` (тест Windows пропущен на macOS)").
- **Windows DPAPI type-check** (Step 4): built the throwaway crate exactly as
  specified in `$TMPDIR/dpapi-check`, copying `secret_store.rs` in as its
  `lib.rs`, then ran
  `cargo check --manifest-path "$TMPDIR/dpapi-check/Cargo.toml" --target x86_64-pc-windows-msvc --offline`.
  → **`Finished` \`dev\` profile [unoptimized + debuginfo] target(s) in 4.34s**,
  zero warnings, zero errors. This ran successfully **inside the sandbox** —
  all needed crates (`windows-sys 0.61.2`, `base64 0.22.1`, `thiserror 2.0.21`,
  `serde`/`serde_derive`, `windows-link`, etc.) resolved and compiled offline
  from the existing cargo registry cache; the sandbox did not need to be
  disabled for this step. This proves the `#[cfg(windows)]` DPAPI code is
  syntactically and type-correct against `windows-sys 0.61.2`'s actual API
  shape; it does not exercise `CryptProtectData`/`CryptUnprotectData` at
  runtime (that needs a real Windows machine — see Concerns).
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`,
  run **with the sandbox disabled** per the task's environment notes (some
  suites in this workspace, e.g. `host`, bind `127.0.0.1`) → **PASS**,
  `98 passed (19 suites, 2.22s)`, exit code 0. This covers `proto`, `host`,
  and `src-tauri`, including the tests added in this task.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` then
  `... --all -- --check` → clean (exit 0 both times). `fmt` reflowed two
  `assert_eq!` calls in the new test modules across multiple lines (line
  length) and nothing else; behavior/assertions unchanged.
- `git diff --check` (on the staged diff) → clean, no whitespace errors.

## Files changed

- `apps/standalone/src-tauri/Cargo.toml` — modified (deps).
- `apps/standalone/Cargo.lock` — modified (3 new resolved dependency edges
  for `markiro-standalone` only).
- `apps/standalone/src-tauri/src/lib.rs` — modified (2 new `pub mod` lines).
- `apps/standalone/src-tauri/src/secret_store.rs` — new.
- `apps/standalone/src-tauri/src/device_config.rs` — new.

Commit: `b56f4e78` — `feat(standalone): ключ устройства под DPAPI и атомарный device.json`,
trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (verified with
`git log -1 --format=%B`). Staged explicitly (`Cargo.toml`, `Cargo.lock`,
`src-tauri/src`), nothing else touched; `git status --short` was clean before
starting and shows a clean tree after the commit.

## Deviations

- Module declaration order in `lib.rs`: placed `device_config` and
  `secret_store` alphabetically around the existing `host_probe` line
  (`device_config`, `host_probe`, `secret_store`) rather than appending both
  immediately after `host_probe` in the order the brief listed them. This is
  a purely cosmetic ordering choice; the brief only said to add them "рядом
  с" the existing line and did not mandate an order, and `cargo fmt` does not
  reorder `mod` statements, so this reflects a deliberate (not accidental)
  choice on my part. No behavior or test depends on declaration order.
- `cargo fmt` reflowed two test assertions
  (`a_foreign_scheme_is_refused`'s `assert_eq!` in `secret_store.rs`, and
  `saves_atomically_and_reads_back`'s `assert_eq!` in `device_config.rs`)
  from one line to several because they exceeded the configured line width.
  No other formatting changes were needed; this is exactly the "Перед каждым
  коммитом: `cargo fmt`" step the constraints file requires, not a
  correction to a bug in the brief's code.
- No other deviations. The code compiled and the tests passed exactly as the
  brief described, with the counts it predicted.

## Concerns

- The DPAPI code (`secret_store::dpapi`, `#[cfg(windows)]`) is verified only
  by type-checking against `windows-sys 0.61.2`'s API shape in a throwaway
  crate on macOS, per the brief's Step 4 and the scoped guide's note that
  "Windows service (and later DPAPI...) is only compiled by the
  `standalone-windows-build` job; running it needs a manual check on
  Windows." No claim is made here that `CryptProtectData`/`CryptUnprotectData`
  actually work at runtime, that the per-user binding behaves as expected, or
  that the real `markiro-standalone` crate (with Tauri's Windows-only
  transitive dependencies) compiles clean under `x86_64-pc-windows-msvc` —
  only the isolated DPAPI module was checked, exactly as instructed.
- This task only adds the two modules; nothing yet calls `secret_store` or
  `device_config` from `lib.rs`'s Tauri commands or elsewhere. That wiring is
  Task 3 per `.superpowers/sdd/1b2-constraints.md`'s file map
  (`tls.rs`, `host_client.rs`, `device.rs`, `host_probe.rs`/`lib.rs` changes,
  `tests/device.rs`), so no dead-code warnings were expected or seen, and
  none appeared in either the `--lib` or `--workspace` runs.
