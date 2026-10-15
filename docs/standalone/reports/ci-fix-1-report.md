# CI fix 1: report (first push, run 38221455774)

Worktree `/tmp/claude/wt/integ`, branch `claude/integration`, base 5cc679ae7. Tree clean after the last commit.

## Commits

- e87e8b49d test(standalone): the suffix-room test stays within Linux's 255-byte name
- 58ce9066b test(standalone-export): the .gitignore check survives a CRLF checkout
- ef3ac51bb ci: the standalone app's Vitest suite runs in its own required job

## (1) standalone-rust: `office_files::tests::the_last_segment_leaves_room_for_the_suffix`

**Root cause.** The test created real folders named with 145 Cyrillic `я`, which is 290 UTF-8 bytes (300 with ` (99)`). Linux (ext4) allows at most 255 bytes per path component, so `fs::create_dir` failed with ENAMETOOLONG (log: `office_files.rs:1291:47 ... Os { code: 36, kind: InvalidFilename }`). APFS counts Unicode characters and NTFS counts UTF-16 units, which is why it passed on macOS. The production rule (name in characters, path in UTF-16 units) is a Windows rule and is correct. Only the test was wrong.

**Fix (test only).** The longest name is now `"я"×100 + "a"×45`. That is still 145 characters (MAX_NAME_CHARS − SUFFIX_CHARS) and still more bytes than characters (245), so a guard that counts bytes fails the test. With ` (99)` it is 250 bytes, under 255. The test asserts all three facts about its own name. The rest is unchanged: the 146-character name is refused and writes nothing, folders 2..98 are pre-made, the call gets ` (99)` at exactly 150 characters, and `existing_folder` accepts it.

**Mutants** (file copied to /tmp/claude/cifix1/office_files.fixed.rs, restored with cp+touch; shasum eb601532… before and after, `cmp` identical). Each was run against the focused test:

| mutant on `save_with` guard                                       | result                |
| ----------------------------------------------------------------- | --------------------- |
| `last.chars().count()` → `last.len()` (bytes)                     | killed (panic :1301)  |
| `>` → `>=`                                                        | killed (panic :1301)  |
| `MAX_NAME_CHARS - SUFFIX_CHARS` → `MAX_NAME_CHARS`                | killed (assert :1286) |
| `last.encode_utf16().count() > MAX_NAME_CHARS - SUFFIX_CHARS + 1` | killed (assert :1286) |

**Scan for the same bug.** I checked every `.repeat(` in host/src-tauri/proto Rust. Cyrillic or long names reach the disk only in office_files. `a_path_is_counted_in_utf16_units_with_the_suffix` uses ASCII names (≤ ~110 bytes), and `deep` is refused before the disk is touched. `only_a_html_of_a_plain_name_is_opened` (146×`я`.html) is a pure refusal. Host `validate.rs` and `src-tauri/tests/device.rs` (`"Я"×100`) use them as values, not file names. On Linux CI, 248 of 249 lib tests had already passed. Not run on Linux in that run (cargo stopped at the lib failure): src-tauri main.rs unit tests, src-tauri/tests/*.rs, doc-tests. None of them puts long or Cyrillic names on disk, but they are not yet proven on Linux.

## (2) standalone-windows-build: cli.test.mjs:99 `.gitignore` check

**Root cause.** It is CRLF, not path separators. The test read `.gitignore` as text and used `split("\n")`. windows-latest checks out with `core.autocrlf=true`, and `.gitattributes` does not pin `.gitignore` to LF. So every line kept a trailing `\r`, and `lines.includes("markiro-cloud-export-*.json")` was false. Evidence from the log: the failure is at line 101 (the first `includes`), it took 1.17 ms (no subprocess, no path handling), and it failed on Windows only, with 116/117 passing. The `.gitignore` pattern itself (no slash, so it matches at any depth) is correct.

**Fix (test only).** The test now splits on `/\r?\n/u`. It also asks git: `git check-ignore --no-index --verbose` on a transfer file and a `.partial` temporary file (the real `writeWhole` name shape), each at the root and deep in the tree. Each must be matched by the repository's `.gitignore` and not by a negated pattern, so a user's global excludes cannot make it pass. Paths are given with `/`, which git accepts on Windows. `cwd` is the repo root via `fileURLToPath`.

**Mutants** (`.gitignore` and the test restored, `cmp` identical):

| mutant                                                                                   | result                                                                                  |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `.gitignore` converted to CRLF, fixed test                                               | passes (the fix works)                                                                  |
| `.gitignore` CRLF, old `split("\n")` test                                                | fails "the transfer file is not ignored" (reproduces CI)                                |
| pattern scoped to root `/markiro-cloud-export-*.json`                                    | killed                                                                                  |
| `.partial` line removed                                                                  | killed                                                                                  |
| `!apps/**/markiro-cloud-export-*.json` appended (text line kept, nested file un-ignored) | killed (`negated`); it survived my first version, which is why negation is now detected |
| pattern only in a global `core.excludesFile` (repo line removed, text check disabled)    | killed                                                                                  |

**Static scan of the Windows steps that did not run** (this was the first CI run of the standalone jobs ever, so nothing after `test:standalone-export` has run yet):

- `cargo test --workspace` on Windows: every `std::os::unix` use I found is under `#[cfg(unix)]`, `#[cfg(all(test, unix))]` or a guarded block. My heuristic flagged `key_file.rs` tests, which are false positives (the module is `cfg(all(test, unix))`). I tried a cross `cargo check --tests --target x86_64-pc-windows-msvc`, but it cannot run here: libsqlite3-sys needs the MSVC C headers. So Windows compile and run is not verified. With the new test name, the office_files paths stay ≤ 240 UTF-16 units if the runner's temp root is ≤ 64 units (`C:\Users\runneradmin\AppData\Local\Temp\.tmpXXXXXX` ≈ 51). That is the same bound as the old test.
- Installer build: `tauri.installer.conf.json` names `binaries/markiro-host`, and the job copies the host to `markiro-host-x86_64-pc-windows-msvc.exe` (matches). productName "Markiro Standalone" matches smoke.ps1's `$installDir`.
- smoke.ps1: it reads statically fine. Operator precedence in `-join ',' -eq` is left to right. `print-fingerprint` exists in the host CLI. It needs an elevated runner, which GitHub provides. Nothing obviously wrong, but it is all unexercised.

## (3) verify-app-tests cancelled at 25 min

**Measured.** verify-app-tests on main (last 6 green runs): 16.9, 12.7, 16.6, 20.6, 14.3, 21.0 min, with no standalone app on main. Run 38221455774: the other suites finished at 20.1 min (08:06:04 → 08:26:12). `@markiro/standalone#test` then ran 4.6 min, unfinished, until the cancel (job log fetched with `gh api`). Locally on 4 workers: standalone 130 s (187 files, 5555 tests) against station 133 s. The station takes 359 s on the hosted runner, so standalone on CI is about 6 min.

**Why not a timeout raise.** It would need 21 + 6 = 27 min, so ≥ 35 min with 30% headroom, and the slice would stay serial. A split runs in parallel and keeps verify-app-tests at its main-branch profile.

**Change.**

- `verify-app-tests` adds `--filter=!@markiro/standalone`.
- A new job `standalone-app-tests` (ubuntu-latest, `timeout-minutes: 20`) runs `pnpm turbo test --filter=@markiro/standalone --concurrency=1 --force`. Turbo builds domain, platform-contracts and ui first; there is no DB. A turbo `--dry=json` confirms the union of the two slices equals the previous slice.
- `HEAVY_JOBS` gains `standalone_app_tests`. As a result, classify-changes exposes the output, `required-results.mjs` requires it (it iterates HEAVY_JOBS), and `ci-required.needs` lists it.
- Classifier: `packages/ui` and `packages/domain` (and the lists derived from domain, e.g. offline grants) add the job. The app's non-Rust paths, `src-tauri/migrations/` and `src-tauri/tests/fixtures/` select it instead of `verify_app_tests`. Nothing else in the app slice reads apps/standalone; I grepped. Rust-only paths are unchanged.
- Tests: heavy-job lists in workflow.test.mjs, required-results.test.mjs and affected.test.mjs. Plus new tests: verify-app-tests' turbo step excludes standalone, and the new job runs exactly that suite with no env. A selected standalone-app-tests that is cancelled or missing fails the gate.

**Mutants** (restored, `cmp` identical): filter dropped (1 fail), ci-required need dropped (1 fail), HEAVY_JOBS entry dropped (29 fails), domain fan-out dropped (2 fails), web path back to verify_app_tests (1 fail), job gated on the wrong output (1 fail).

## Gates

- `node --test tools/ci/test/*.test.mjs` (unsandboxed; sandboxed it fails on mktemp EPERM): 59/59 pass.
- `pnpm test:standalone-export`: 120 tests, 119 pass, 1 skipped (SQL test without DB), 0 fail.
- `cargo test -p markiro-standalone --lib`: 249/249 pass. Focused `office_files`: 32 pass.
- `cargo fmt --all --check`: OK.
- Prettier gate over the 6 changed JS/YAML files: clean. Proved live, a misformatted scratch file was flagged (exit 1) and deleted.
- `git diff --check`: OK. `git status --short`: empty.

## Not done or not verifiable here

- No Linux run of the fixed Rust test. The 255-byte bound is asserted inside the test.
- No Windows run of anything: the CRLF fix, cargo on Windows, installer, smoke.ps1.
- The new job's 20-minute budget is extrapolated from local and station ratios, not measured on CI. Re-check it after the first run.
- verify-app-tests' existing 25 min against main's 21 min worst case is only ~19% headroom. This was already the case before this change; I did not change it.
- `graphify update .` not run in the integration worktree.
