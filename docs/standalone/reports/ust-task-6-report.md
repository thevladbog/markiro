# УСТ Task 6 report — CI: installer build, smoke test on the runner, artifact

Status: DONE_WITH_CONCERNS (nothing here ran on Windows or in GitHub; see "Not run").
Commit: `1972a0ebd` ci(standalone): build the installer, install, crash, reinstall and uninstall it on the Windows runner, keep the artifact (branch claude/infra-rk on c9a8603d6). Worktree clean. No OWNER STEP, no manifest/lockfile touched.

## What I did

- `.github/workflows/ci.yml`, job standalone-windows-build: both brief fragments applied verbatim (timeout 75; contract step, release host build, sidecar copy (bash), `tauri build --config src-tauri/tauri.installer.conf.json --bundles nsis`, smoke (pwsh), prepare (pwsh), upload-artifact with the same SHA pin as the other uploads, 30 days). Nothing else in the workflow changed; permissions stay workflow-level `contents: read`; no secret, no env, no signing step.
- `tools/standalone-release/smoke.ps1`: the brief's script plus (beyond the brief, per dispatch and ust-minors):
  - **exit 4 of the host**: stop the service, drop a `host.restore-intent` file (its presence alone makes `start` refuse, host/src/restore.rs), reinstall with /S: installer must still exit 0, service stays registered and not Running, role/rule/data intact; marker removed in a `finally`, `sc start`, wait for Running and the HTTPS answer (≤120 s).
  - **uninstall with a running host** (own step): service Running and answering before; after: exit 0, service gone, no `markiro-host` process, nothing on the port, `markiro-host.exe` removed, firewall rule gone, the four data files kept and `host.json` equal to its pre-uninstall text, Run value, registry role and `installation.json` gone.
  - **role file**: exact text `{"role":"<role>"}` (case-sensitive compare, no BOM) for host/office/station; registry role checked; `/ROLE=HOST` is accepted as the same role and written lower-case; no role file after the refused no-role install.
  - **service state by numbers**: `[int](Get-Service …).Status` (Stopped 1, Running 4, 0 = absent) instead of text; `FailureActionsOnNonCrashFailures` read from the service's registry key beside the sc.exe text matches (these remain text and assume an English runner).
  - one firewall rule after reinstall(s) (`.Count -eq 1`); `$PSNativeCommandUseErrorActionPreference = $false`.
- `tools/standalone-release/test/workflow.test.mjs`: the brief's 2 tests (module-level reading of smoke.ps1 moved to the top, otherwise verbatim) plus 8: no secret/permissions/environment/`pull_request_target`/signing in the job; every `uses` pinned to a 40-hex commit, the upload pin equals the workflow's only upload pin, no network fetch/`curl`/`${{ }}` in any `run`; the upload's exact `with`; runner/shell/step wiring; smoke.ps1 is bracket-balanced by a small PowerShell tokenizer, `#requires 7`, Stop, StrictMode, no Invoke-Expression/download/EncodedCommand, the only URI is the host on 127.0.0.1 with `-SkipCertificateCheck` once, every Start-Process waits and reads its exit code, the only Remove-Item is the marker, no env other than ProgramFiles/ProgramData, no key bytes read; step titles in order and every WaitFor ≤120 s; numeric states and exact role text; the exit-4, uninstall-with-running-host and data-kept contents.
- `tools/ci/affected.mjs` selection (`tools/standalone-release/` → standalone_rust + standalone_windows_build) and its test case (smoke.ps1 path) already exist from Task 5 (c9a8603d6); nothing to change, and `node --test tools/ci/test/*.test.mjs` covers it (47 pass).

## RED / GREEN

- RED: `node --test tools/standalone-release/test/workflow.test.mjs` → `ENOENT … smoke.ps1` (the whole file fails at load because my version reads the script at module level; the brief's version fails two named tests). `/tmp/claude/impl-ust-t6/red.txt`.
- GREEN: workflow tests 10/10; `pnpm --config.verifyDepsBeforeRun=false run test:standalone-release:contract` → 48 tests, 48 pass (plan: 17 = Task 5's brief 15 + 2; measured 38 from Task 5 + 10 now); unsandboxed `node --test tools/ci/test/*.test.mjs` → 47 pass (plan 47). `js-yaml` parses ci.yml in the test.

## Mutants (script `/tmp/claude/impl-ust-t6/mutate.py`, log `mutants.log`/`mutants2.log` after prettier; originals copied to `/tmp/claude/impl-ust-t6/orig/`; every restore checked by sha256 and `cmp`; 53 of 53 killed, all restore ok)

The first harness run mis-parsed the reporter (all "survived"); the second found one real survivor, S15, which was my badly chosen mutant (changed only the message); redone as `RemoteAddress -eq 'Any'`.

| Mutant (one line)                                                                                                                                                                                                                                                                                               | Killed by                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| W1 smoke step removed (brief) / W17 `certificateThumbprint` in CI                                                                                                                                                                                                                                               | job builds, smoke-tests… in order (+ runs where PowerShell 7 …)                                    |
| W2 timeout 75→40; W3 contract step removed; W10 `--bundles nsis` dropped; W14 smoke after prepare; W18 sidecar wrong triple                                                                                                                                                                                     | job builds, smoke-tests… in order (W3/W10/W18 also "smoke test runs where PowerShell 7…")          |
| W4 upload-artifact `@v4`; W12 `${{ github.sha }}` in a run; W13 `curl` in a run                                                                                                                                                                                                                                 | every action is pinned … never executes a download                                                 |
| W5 job `permissions: contents: write`; W11 `pull_request_target`; W15 `secrets.` in a step env; W20 job `environment`                                                                                                                                                                                           | job holds no secret …                                                                              |
| W6 retention 90; W7 `if-no-files-found: warn`; W8 `--authenticode` hard-coded; W16 artifact path = bundle dir                                                                                                                                                                                                   | installer is kept for thirty days…                                                                 |
| W9 smoke in `powershell`; W19 sidecar step in pwsh; W21 ubuntu runner                                                                                                                                                                                                                                           | smoke test runs where PowerShell 7…                                                                |
| S1 `'Continue'`; S2 StrictMode removed; S3 uninstall without `-Wait`; S4 `Invoke-Expression`; S5 unbalanced brace; S11 other URL; S12 `$env:GITHUB_TOKEN` printed; S19 `Set-NetFirewallProfile`; S31 second `-SkipCertificateCheck`; S32 `Format-Hex` of the key                                                | smoke.ps1 is balanced and written defensively                                                      |
| S6 uninstall precondition read as text; S8 `$Running = 3`; S9 `-ceq`→`-eq`; S10 BOM check dropped; S29 registry failure-flag check dropped                                                                                                                                                                      | service is read by numeric states and the role file by its exact text (S6 also the uninstall test) |
| S7 `finally` dropped; S14 process check; S20 `/ROLE=HOST`; S21 exit-4 install expects failure; S22 "did not stay up" weakened; S23 `Stop-Service` dropped; S24 "answers" check; S26 registry role; S27 uninstall exit unchecked; S28 rule count; S30 port-silent check; S17 recursive delete (+ defensive test) | smoke test covers an uninstall with a running host, exit 4 and data kept                           |
| S13 wait 600 s; S16 step renamed                                                                                                                                                                                                                                                                                | smoke test follows the installer's life in order, every step bounded                               |
| S15 `RemoteAddress` ≠ LocalSubnet; S25 `key.der` out of the kept list                                                                                                                                                                                                                                           | smoke test checks what the installer promises                                                      |
| S18 `#requires -Version 5`                                                                                                                                                                                                                                                                                      | smoke test runs where PowerShell 7…                                                                |

## Gates

- Prettier gate (`pnpm --dir … exec prettier --ignore-path .prettierignore --check`) proven live: a mis-formatted scratch .mjs → [warn], exit 1, deleted. `workflow.test.mjs` needed `--write` once; then `ci.yml` + `tools/standalone-release` → "All matched files use Prettier code style" (prettier has no parser for .ps1: not checked, LF only, no CR). `git diff --check` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` → only pairing-code.ts:66; no `\u0` in my files; `git status --short` empty. Rust and webview untouched (no cargo/Vitest runs).

## Anchor adaptations

None: both ci.yml fragments matched exactly once; affected.mjs/test needed no change (already done in Task 5).

## Not run / not verified

- **Windows CI itself**: the job, `tauri build … --bundles nsis`, NSIS hook compilation, `smoke.ps1`, upload were never executed here; only text/contract tests ran.
- **PowerShell**: no `pwsh`; smoke.ps1 was never parsed or run by PowerShell. The bracket balance test is a home-made tokenizer, not a parser. Unverified PowerShell facts: function names `Install`/`Uninstall`/`Step`/`Check`/`Service` not clashing, `[int](Get-Service …).Status` on a missing service under StrictMode, `Get-NetFirewall*` property shapes, `sc.exe qfailure` text (English), `Invoke-RestMethod -SkipCertificateCheck`, `Start-Process … _?=` waiting for the uninstaller, `Get-Acl … AreAccessRulesProtected`.
- The exit-4 section relies on my reading that any file named `host.restore-intent` makes `start` refuse (`restore::refuse_unfinished` only checks presence) and that the service then stays down within 30 s so `install` returns 4 and the NSIS hook warns with `/SD IDOK`. Not run. Left marker after a crash of the script is removed in `finally`.

## Concerns

1. Smoke assumes an English runner for `sc.exe` text (as the brief pins the strings); numeric alternatives are added only where the pinned strings are not required.
2. The smoke test's reinstall steps each wait for the service; total runtime on a loaded runner is untested (job budget 75 min, longest waits 120 s).
3. `uninstall.exe _?=` leaves `uninstall.exe` and the install directory behind by design; the script does not assert they are absent.
4. Upload runs on every PR (including forks): the artifact holds only the unsigned installer, evidence and SHA256SUMS; no secret reaches the job.

## Files

- /tmp/claude/wt/inf/.github/workflows/ci.yml
- /tmp/claude/wt/inf/tools/standalone-release/smoke.ps1 (new)
- /tmp/claude/wt/inf/tools/standalone-release/test/workflow.test.mjs (new)
- Evidence: /tmp/claude/impl-ust-t6/
