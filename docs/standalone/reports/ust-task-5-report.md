# УСТ Task 5 report — the installer: Tauri overlay, NSIS hooks with roles, release artifact, signing overlay

Status: DONE_WITH_CONCERNS (NSIS hooks, PowerShell and everything Windows were never compiled or run; see "Not run").
Commit: `c9a8603d6` feat(standalone): the NSIS installer with three roles, the release artifact and the signing overlay (branch `claude/infra-rk`, on `ccfd04bba`). Worktree `/tmp/claude/wt/inf` clean after the commit. No OWNER STEP: no manifest, lockfile or Cargo.toml touched (root `package.json` only got the one script line the brief names).

## What I did

Brief applied (tests first), then extended for the dispatch's mandatory items:

- `apps/standalone/src-tauri/tauri.installer.conf.json` (overlay: `externalBin`, perMachine, Russian, hooks) — verbatim. The base `tauri.conf.json` is untouched (a sidecar there would break `cargo test`).
- `apps/standalone/src-tauri/windows/installer-hooks.nsh` (UTF-8 with BOM, verified `efbbbf`).
- `tools/standalone-release/prepare.mjs`, `sign-overlay.mjs`, three test files, `apps/standalone/.gitignore` (`/src-tauri/binaries/`), root script `test:standalone-release:contract`, `tools/ci/affected.mjs` (one line) and `tools/ci/test/affected.test.mjs` (one case).

### Additions beyond the brief

Hooks (`installer-hooks.nsh`):

1. **Exit code 4 of `markiro-host install` = WARNING with the restore hint** (`DetailPrint` + `MessageBox … /SD IDOK`, text: stop the service with `sc stop MarkiroHost`, repeat `markiro-host restore`, start it; data untouched); install continues. `${ElseIf} $0 != "0"` still fails closed (`MARKIRO_FAIL`, error level 2). Only 0 and 4 pass. The brief's hook tested `!= 0` only.
2. **Role spelling (found by reading the code, not in the brief):** NSIS `==`/`!=` ignore case, so `/ROLE=HOST` passed the brief's checks and would have been written as `{"role":"HOST"}`; the shell's `installation.rs` accepts only lower-case names and refuses anything else, so that PC would silently become a locked-down station. The hook now maps `$0` to the literal `"host"`/`"station"`/`"office"` (and fails on anything else, which also catches a damaged registry value) before `StrCpy $MarkiroRole $0`. The file content is therefore exactly `{"role":"host|station|office"}` plus CRLF, no other key.
3. `installation.json` write checked: `FileOpen` followed by `${If} ${Errors}` → `MARKIRO_FAIL` (a missing file would make an office PC a station).
4. Upgrade over a running service: PREINSTALL `stop-service` result is read (a non-zero code is logged, the NSIS file-in-use dialog stays the backstop); upgrade never calls `uninstall`; PREUNINSTALL in update mode only stops. `$DeleteAppDataCheckboxState` forced 0, so data is never deleted (brief).
5. Each hook saves and restores `$0`/`$1` (`Push`/`Pop`, as `apps/signer` does) instead of clobbering the template's registers.
6. Header comment documents the exit-code contract (install 0/4/other, network-check 3) and the case rule.

Tools: 7. `prepare.mjs`: the installer name (version check) is computed before the output directory is created, so a bad version leaves nothing behind. 8. `sign-overlay.mjs`: a timestamp URL with a user name or password is refused ("must not contain credentials"), so the tool can never echo a credential. It reads no environment variable and no file; only the public thumbprint is ever in its output.

Tests beyond the brief (brief 15 → 38 measured): installer 7 → 18, prepare 6 → 13, sign-overlay 2 → 7. Highlights: exit-4 branch contents, case canonicalization before keeping the role, `FileOpen` error check, every `MessageBox` carries `/SD` or sits behind `${Silent}`, `SetErrorLevel 2`, register save/restore, `$INSTDIR` only inside double quotes, the exact list of `Delete*` statements (nothing outside `$INSTDIR\installation.json`, `$INSTDIR\markiro-host.exe` and our registry keys), accepted `/ROLE=` list, every `nsExec` followed by its `Pop $0`, If/EndIf/macro balance (compensates for no `makensis`), no secret words in the hooks, root script text; prepare: determinism (two runs identical, no clock/path in the evidence), every evidence field and every `SHA256SUMS` defect refused even with consistent sums, status whitelist, CLI run, unknown flag, import has no side effect; sign-overlay: whole-match thumbprint, scheme and credentials, CLI output and refusal.

## RED / GREEN

- RED 1: `node --test tools/standalone-release/test/*.test.mjs` → `ENOENT … tauri.installer.conf.json`, `ERR_MODULE_NOT_FOUND … prepare.mjs` and `… sign-overlay.mjs` (`/tmp/claude/impl-ust-t5/red1.txt`). RED 2: `node --test tools/ci/test/affected.test.mjs` → 19 pass, 1 fail "deployment and release tooling selects its consuming jobs" (`red2.txt`).
- GREEN: `pnpm --config.verifyDepsBeforeRun=false run test:standalone-release:contract` → 38 tests, 38 pass, stderr empty (the one line is pnpm's `$ node --test …` echo); per file prepare 13, sign-overlay 7, installer 18. `node --test tools/ci/test/*.test.mjs` (unsandboxed) → 47 pass (plan: 47). `final.txt`, `ci.txt`.
- Plan counts: `prepare` 6 / `sign-overlay` 2 / `installer` 7 = 15 contract tests, CI 47. Measured: 38 contract tests (15 brief + 23 mine; the brief's `installer.test.mjs` assertion on the install branch was adapted, see below), CI 47.
- Real Tauri CLI on macOS: host copied to `src-tauri/binaries/markiro-host-aarch64-apple-darwin`; `tauri build --config src-tauri/tauri.installer.conf.json --debug --no-bundle` → `Built application at: …/debug/markiro-standalone` exit 0; with the signing overlay produced by `sign-overlay.mjs` as a second `--config` → exit 0; a typo overlay (`installmode`) → `error on bundle > windows > nsis … is not valid under any of the schemas`, exit 1 (`tauri1/2/3.txt`). `binaries/` removed afterwards (git ignores it).
- Dry run of `prepare.mjs` on the fake installer: `markiro-standalone-0.1.0-windows-x86_64-setup.exe 941ef2fd…3b3e (NotSigned)` — equals the brief's expected line; listing `SHA256SUMS`, installer, `release-evidence.json`.

## Mutants (script `/tmp/claude/impl-ust-t5/mutate.py`, log `mutants.log`; each file copied to `/tmp/claude/impl-ust-t5/orig/` first, restored, `cmp` and sha256 equal; 74 of 74 killed and `restore ok`)

The first run found two survivors; both were fixed by strengthening tests and re-run: S6b (password-only URL credential check removed → added `https://:pw@host` case) and S10 (`parseArgs` `strict: false` in `sign-overlay.mjs` → the unknown-flag test now passes a valid pair plus `--password`). The first draft of the `$INSTDIR` quoting test also stripped single quotes first, which would have hidden `'$INSTDIR\markiro-host.exe install'`; fixed (mutant H9) before the final run.

| Mutant (one line)                                                                      | Killed by                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| H1 drop `StrCpy $DeleteAppDataCheckboxState 0` (brief)                                 | uninstall and upgrade never delete data                         |
| H2 `${ElseIf} $0 != "0"` → `== "99"` (fail-closed lost)                                | only the host role registers…; exit code 4                      |
| H3 / H22 / H23 warning loses `/SD IDOK` / the `sc stop` hint / becomes a fail          | exit code 4…; silent-safe; only the host role registers…        |
| H4 role kept in typed case (`StrCpy $0 "station"` → `$0`)                              | role written in the exact spelling…                             |
| H4b `StrCpy $MarkiroRole $2`                                                           | same                                                            |
| H5 `FileOpen` error check → `DetailPrint`                                              | installation.json is written whole or the install fails         |
| H6 / H6b `SetErrorLevel 0` / no `/SD` in `MARKIRO_FAIL`                                | silent-safe… error level 2                                      |
| H7 profile dialog without the `${Silent}` guard                                        | silent-safe                                                     |
| H8 / H25 missing `Pop $1` / `Push $1`                                                  | registers saved and restored                                    |
| H9 unquoted `$INSTDIR` command line                                                    | every path is quoted; host role registers…                      |
| H10 `Delete "$INSTDIR\*.*"`                                                            | deletion whitelist                                              |
| H11 role-mismatch guard `!=` → `==` (brief)                                            | role comes from /ROLE=…                                         |
| H12 silent-needs-role guard disabled                                                   | role comes from /ROLE=…; silent-safe                            |
| H13 `$UpdateMode = 1` → `<> 1` (brief)                                                 | uninstall and upgrade never delete data                         |
| H14 extra key in `installation.json`                                                   | only the host role registers… (FileWrite regex)                 |
| H15 `Delete` of another file                                                           | host role…; deletion whitelist                                  |
| H16 PREINSTALL runs `uninstall` instead of `stop-service`                              | role comes from…; upgrade stops the host and never `uninstall`s |
| H17 `password=` comment                                                                | hooks hold no secret                                            |
| H18 BOM removed                                                                        | UTF-8 with a byte order mark                                    |
| H19 Run-value deleted under another name                                               | deletion whitelist                                              |
| H24 `network-check` code 3 → 2                                                         | only the host role registers…                                   |
| H26 service branch inverted                                                            | same                                                            |
| H27 `/ROLE=office` rejected                                                            | the three roles are the only ones /ROLE= accepts                |
| H28 / H29 lost `Pop $0` after `install` / `stop-service`                               | same test (every nsExec has its Pop)                            |
| B1 / B2 missing `${EndIf}` / `!macroend`                                               | blocks balance                                                  |
| G1 `.gitignore` entry removed                                                          | host binary stays out of git                                    |
| C1 `perMachine` → `currentUser`; C2 sidecar path typo                                  | only the installer build bundles the host                       |
| R1 root script glob changed                                                            | the root script runs these contracts                            |
| A1 `affected.mjs` line removed                                                         | affected.test.mjs "deployment and release tooling…"             |
| P1 `installers.length !== 1` → `=== 0` (brief)                                         | refuses a bundle with no installer or with two                  |
| P2 authenticode check off                                                              | status tests                                                    |
| P3 / P4 SHA / repository regex anchors                                                 | a bad version or source is refused…                             |
| P5 non-empty output check                                                              | refuses…non-empty output; CLI second run                        |
| P6 name computed after `mkdir`                                                         | refused before anything is written                              |
| P7a–f schemaVersion / product / version / roles / authenticode / source checks removed | evidence that does not describe this release…                   |
| P8 / P9 / P9b size / asset count / asset hash checks                                   | same test (checksum mismatch)                                   |
| P10 / P11 / P12 / P13 `SHA256SUMS` name regex / duplicate / hash / name-set checks     | SHA256SUMS must list exactly…                                   |
| P14 asset set check off                                                                | rejects changed bytes and an extra file                         |
| P15 roles order, P16 installer name, P19 version regex anchor                          | prepare / names tests                                           |
| P17 main without import guard; P18 `strict: false`                                     | import runs nothing; CLI unknown flag                           |
| S1–S4 uppercase, whitespace strip, `^`, `$`                                            | sign-overlay tests                                              |
| S5 scheme check off; S6 / S6b username / password check                                | scheme and credentials test                                     |
| S7b `tsp: false`, S8 `sha1`, S9 raw URL, S12 raw thumbprint                            | builds the Tauri overlay…                                       |
| S10 `strict: false`; S11 main without guard                                            | CLI test; import runs nothing                                   |

## Anchor adaptations

- `tools/ci/test/affected.test.mjs`, `tools/ci/affected.mjs`, `package.json`, `.gitignore`: all brief fragments matched exactly once (`standaloneJobs` already existed in the tree).
- One deliberate change to a brief test: in `installer.test.mjs` "only the host role registers the service…" the regex after `install'` was `${If} $0 != "0"\n MARKIRO_FAIL`; it is now `${If} $0 == "4"[\s\S]*?${ElseIf} $0 != "0"\n MARKIRO_FAIL`, matching the exit-4 warning branch the dispatch mandates.
- The brief's code files were not prettier-clean only where I added tests; prettier changed none of the brief's own lines.

## Not run / not verified (be explicit)

- NSIS: no `makensis` here. The hooks were never compiled; only tests of the text and block balance. Template facts taken from the brief and the signer's hooks, not verified against Tauri CLI 2.11.4's `installer.nsi` (not available locally): hook positions, `${GetOptions}` being instantiated, `$UpdateMode` and `$DeleteAppDataCheckboxState` existing and being read after PREUNINSTALL, `MAINBINARYNAME`, registry view 64, whether the template uses `$0`/`$1` (I save them).
- PowerShell / `pwsh` not installed; this task contains no PowerShell (`smoke.ps1` is Task 6).
- Not run on Windows: real silent/dialog installs, `/ROLE=` case handling in a real installer, exit codes 4 and 3 reaching the hook through `nsExec`, service stop during an upgrade, Run key, uninstall keeping `%ProgramData%\Markiro\Host`. CI job (Task 6) and the owner's manual list are the only places.
- Real Tauri CLI was run only on macOS with `--debug --no-bundle`: it validates the overlay schema, it did not build an NSIS installer.
- Authenticode signing was never run (no certificate by design); `sign-overlay.mjs` output was only fed to the CLI's schema check.

## Concerns for the controller

1. `NSIS_HOOK_PREUNINSTALL` follows the brief: a failed `uninstall`/`stop-service` is only logged (`DetailPrint`), so the files can be removed while the service stays registered, pointing at a missing binary. Not changed since the brief fixes it; Task 6's smoke test and the manual list should cover an uninstall with a running host.
2. A failed `MARKIRO_FAIL` abort in POSTINSTALL leaves the files and the registry role in place (the role is written before `install` runs); a re-run with the same role converges, with another role it is refused, as the brief intends.
3. The PREINSTALL role dialogs (two `MessageBox` questions) have no default for silent mode, correctly: a silent install without a role fails with code 2 before them (tests assert every other dialog has `/SD` or a `${Silent}` guard).
4. Task 7 runbook: exit 4 text and `sc stop` / repeat-`restore` advice are now in the installer message; the runbook should say the same.
5. Case: `/ROLE=Host` is accepted and stored as `host`; the registry role comparison is also case-insensitive, so a changed case of the same role is not a "role change".

## Gates

`prettier --ignore-path .prettierignore --check` on `tools/standalone-release tools/ci package.json apps/standalone/src-tauri/tauri.installer.conf.json`: "All matched files use Prettier code style!" (gate proven live: a mis-formatted scratch `.mjs` → `[warn]`, exit 1, deleted). `git diff --check` clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` → only `src/host/pairing-code.ts:66`; no `\u0` in the files I wrote. `git status --short` empty after the commit; no scratch files in the tree. Rust and webview untouched, so cargo, Vitest, typecheck, lint, build and the delayed-`setImmediate` stand do not apply.

## Files

- `/tmp/claude/wt/inf/apps/standalone/src-tauri/tauri.installer.conf.json` (new)
- `/tmp/claude/wt/inf/apps/standalone/src-tauri/windows/installer-hooks.nsh` (new, BOM)
- `/tmp/claude/wt/inf/apps/standalone/.gitignore`, `/tmp/claude/wt/inf/package.json`, `/tmp/claude/wt/inf/tools/ci/affected.mjs`, `/tmp/claude/wt/inf/tools/ci/test/affected.test.mjs`
- `/tmp/claude/wt/inf/tools/standalone-release/{prepare,sign-overlay}.mjs` and `test/{prepare,sign-overlay,installer}.test.mjs` (new)
- Evidence: `/tmp/claude/impl-ust-t5/` (RED/GREEN, Tauri CLI runs, mutant harness and log, originals).
