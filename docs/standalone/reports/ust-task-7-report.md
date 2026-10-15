# УСТ Task 7 report — documents, and the infra stream's full check

Status: DONE_WITH_CONCERNS (documents only; nothing in them was ever run on Windows, and the runbook says so).
Commit: `310bfed51` docs(standalone): the installer, the service and the site's network for IT; the office PC is never kiosk-locked (branch `claude/infra-rk`, on `1972a0ebd`). Worktree `/tmp/claude/wt/inf` clean afterwards. Evidence under `/tmp/claude/impl-ust-t7/`.

## What I did

Read the dispatch, the rules, the constraints, the brief, `ust-minors.md` and all six УСТ reports, then opened the code at HEAD for every statement the documents make: `host/src/{install,main,config,logging,service,db,install_windows,restore,lib}.rs`, `src-tauri/windows/installer-hooks.nsh`, `tauri.installer.conf.json`, `tauri.conf.json`, `tools/standalone-release/{prepare,sign-overlay}.mjs`, `smoke.ps1`, `.github/workflows/ci.yml`, `src/i18n/ru.json`, `HostAddressDialog.tsx`, `host-search.ts`, `App.tsx`, the shell's `installation.rs`/`device.rs`, the РК runbook and the pilot spec.

Files changed (three, one commit):

- `docs/runbooks/standalone-install.md` (new, 491 lines): the memo for IT and the manual list.
- `apps/standalone/AGENTS.md`: the kiosk paragraph (brief's fragment 1), the new section «Installer and service» (fragment 2), the «Verification» bullet (fragment 3).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: new §20 «Уточнения плана УСТ».

## Pilot spec section number

Taken: **§20**, the next free one on THIS branch (it ends at §19, plan РК). Clashes with other branches, written into the section itself: §19 is also ПЛ-Ц, §20 is also 2a8 and ЧЗ, §21 is also 2a7 and О-Ф, §22 is РК-С. To keep the renumbering at merge cheap, the runbook and `AGENTS.md` refer to the section by its title («Уточнения плана УСТ»), not by number. (The РК section's own text says «§19» in the РК runbook header and in the spec; I did not touch those.)

## The runbook: what I took from the brief and what I corrected against the code

Kept the brief's skeleton; every requirement of the dispatch and of `ust-minors.md` is covered:

- exit code 4 / restore advice (own section «Установка с предупреждением (код 4) и восстановление»), `sc stop MarkiroHost` and waiting for `STATE: STOPPED`, `restore` may meet «locked» once and is repeated, `stop-service` between two failure restarts returns at once and Windows restarts the host within 60 s; in a silent install the installer still returns 0, so check `sc query`;
- the NSIS hook writes exactly `{"role":"host|station|office"}`, lower-case literal; roles and `/ROLE=` values; `/ROLE=HOST` accepted and written lower-case; silent install without a role fails with code 2; role never changes on reinstall;
- upgrade stops the service and keeps data; uninstall keeps data; a failed `uninstall`/`stop-service` in the hook is only logged, so the runbook has a «check after uninstall» step (`sc query` 1060, `Get-NetFirewallRule`, `sc delete`, `Remove-NetFirewallRule`);
- firewall rule scope (name, display name, TCP, Private+Domain, `LocalSubnet`, no `-Program`, port from `host.json` at install time);
- data-directory ACLs by SID and WHY (hashes of passwords/PINs/badges, badge salt, device-key hashes in `host.db` and the copies; the TLS private key; this is why `print-fingerprint` and `restore` need an administrator), and the `icacls` without `/T` caveat;
- an office PC is never kiosk-locked and cannot pair as a station (`host_local_pair` refused); a station/host-role PC with a stale office pairing stays locked until re-paired (exit via «Оконный режим»); an office-role PC never shows the floor even with a stale station pairing; the unpaired-office-PC-with-a-host-on-127.0.0.1 dead end («Повторить» only) and its way out;
- the host address change: IP or name typed as for pairing, kept only as `https://host[:port]`; pinned certificate, `address_other_host`, `key_rejected`, what to do when the certificate really changed;
- unsigned local builds vs CI: neither is signed today; signing in CI would need a protected release process that does not exist (I did not describe it as available); SmartScreen and antivirus notes, including the `-EncodedCommand` heuristic risk;
- the manual Windows list (service manager, `icacls`, firewall rule, `Get/Set-NetConnectionProfile`, Russian locale, `CREATE_NO_WINDOW`, absolute paths, NSIS hooks, `smoke.ps1`, uninstall with a running host, role file with/without BOM and `current_exe()` in `Program Files`, stale pairing cases, two PCs over Wi-Fi, kiosk on the station, printing and scanners, the exit-4 path on a real service, the Tauri «already installed» page);
- cross-references: РК runbook (`docs/runbooks/standalone-backup-restore.md`, sections 2, 5, 6); ИМП is stated as PARKED.

Corrections to the brief's draft (all found by opening the code; the brief's text was wrong or unverifiable):

1. «Устройства → Новый код» does not create a pairing code: the button is «Подключить устройство» (`ru.json`: `office.devices.add`); «Новый код» only regenerates inside the dialog. Fixed, and the dialog's contents (code 10 chars, expiry, fingerprint, addresses) are described from `ru.json`.
2. The brief pointed to `docs/runbooks/standalone-cloud-cutover.md`. That file does not exist and the ИМП plan is parked: only `tools/standalone-export/sscc.mjs` (the SSCC arithmetic, `pnpm test:standalone-export`, 37 tests) exists. The runbook says so and warns not to promise a data transfer; step 6 of the host install says the host starts from an empty database.
3. «Журналы за 14 дней» → `logs\host.<date>.log`, the 14 most recent daily files (`logging.rs`).
4. The data-directory list was incomplete: added `backups\`, `host.lock`, `host.restore-intent`.
5. The address dialog takes `192.168.1.20[:45710]` or a name, not `https://…`; the `https://host[:port]` rule is what the shell keeps.
6. The service line «`sc qfailureflag` TRUE» is kept; added that an administrator `sc stop` is not a failure.
7. The brief said the installer asks to close the app and that «уже установлено» asks the role again; those are facts of the Tauri NSIS template, which is not available here (no `tauri-bundler` source in the cargo registry). The runbook marks them «не проверялось».
8. Found while reading `install_windows.rs`: `configure` calls `change_config` with the account `LocalService` on every install, so **an upgrade resets the service account**. The РК runbook (section 2) recommends a different account for writing the second copy folder over the network; the runbook and `AGENTS.md` now say it must be set again after each update. This is a real interaction between plans УСТ and РК, listed under Concerns.
9. Found: a `Timeout` (service not Running within 30 s, e.g. a slow migration) is exit 1 and fails the installation although the service stays registered; the runbook says to run the installer again with the same role.
10. Found: in a silent install the network-profile question is not asked (`${IfNot} ${Silent}`); only logged. Written.
11. Added from `AGENTS.md`: a locked kiosk window on the host PC at first run (way out: wizard + administrator + «Оконный режим», or Ctrl+Alt+Del), single-instance callback is empty (relaunch does nothing), all stations of the site must be protocol 3 (ПЛ-Х section), DPAPI key is per Windows user.
12. Rules for the outside: «исходящих соединений нет» is stated as read from the code (no updater plugin, CSP/`connect-src`), not measured.

## AGENTS.md: anchors

- Fragments 1, 2, 3 each matched exactly once. Fragment 1 additionally got a sentence about the role winning over the pairing (the stale-pairing rules of Task 4), and the paragraph just before it («`App` enters kiosk mode whenever no office session is open») got «(on every PC but an office PC, below)» so it does not contradict the new text (a small semantic fix beyond the brief).
- «Installer and service» is longer than the brief's: it adds the data-dir creation, rollback, exit codes (0/1/4; 0/3/1; 2), the lower-case role literal and the «file with another key makes a locked station» consequence, the account-reset-on-reinstall fact, absolute `System32` paths, `host_origin`, the refused `host_local_pair`, the failed hook only logged, and that the NSIS template facts and `makensis` were never available.
- Anchor note from the brief: ИМП has not added a section to this branch's `AGENTS.md`; «Installer and service» sits before «Office pages».

## Full check of the infra stream (HEAD `310bfed51`; all outside the sandbox where needed)

| Check                                                                                                           | Result                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` (ONE run) | exit 0; **67** `test result` lines, **1019 passed, 0 failed, 0 ignored**, 0 `warning:` (`cargo.txt`). Equals Task 3's measurement; Tasks 4–6 touched no Rust. Plan said 49 suites / 554 tests on its older base. |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                         | clean                                                                                                                                                                                                            |
| `cargo check --offline --locked --workspace --all-targets`                                                      | exit 0, **0 warnings** (`check.txt`)                                                                                                                                                                             |
| Vitest, ONE full run, `--testTimeout=60000 --hookTimeout=60000`                                                 | **107 files, 3141 tests passed**, exit 0, no unhandled errors / `act` warnings in the output (`vitest.txt`); equals Task 4. Plan said 67 files / 1758 (older base). No timeout flake this time.                  |
| `pnpm test:standalone-export`                                                                                   | **37** tests, 37 pass                                                                                                                                                                                            |
| `pnpm test:standalone-release:contract`                                                                         | **48** tests, 48 pass (plan said 17; Tasks 5 and 6 added tests beyond the brief)                                                                                                                                 |
| `node --test tools/ci/test/*.test.mjs`                                                                          | **47** tests, 47 pass                                                                                                                                                                                            |
| `tsc` typecheck, `eslint`, `vite build` of `@markiro/standalone`                                                | exit 0 each (the build prints only Vite's chunk-size notice)                                                                                                                                                     |
| Prettier over every `md/ts/tsx/json/mjs/yml` file in `git diff --name-only 370ec784c..HEAD`                     | 110 files in the range, **63 prettier-covered + `shell.css` = 64 checked**, `All matched files use Prettier code style!`, rc 0 (`prettier.txt`)                                                                  |
| `git diff --check` (worktree) and `git diff --check 370ec784c..HEAD`                                            | silent                                                                                                                                                                                                           |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                                     | only `src/host/pairing-code.ts:66`                                                                                                                                                                               |
| `git status --short`                                                                                            | empty                                                                                                                                                                                                            |

Vacuous-clean checks:

- Prettier gate proven live: a mis-formatted scratch `.ts` inside `apps/standalone/src` made the same command print `[warn]` and exit 1; deleted. A first attempt of mine produced no output at all (a broken `xargs` pipeline) and was NOT counted; the proof above is the second, direct one.
- The 64 files were not silently ignored: `prettier --file-info` for each one reports `ignored: false` (0 ignored of 64).
- Not covered by prettier, so not checked by it: `tools/standalone-release/smoke.ps1`, `apps/standalone/src-tauri/windows/installer-hooks.nsh`, `.gitignore`, Rust (`cargo fmt` covers it), the one SQL file.
- First prettier run on the new runbook failed (table alignment); fixed with `prettier --write` on that new file only. `AGENTS.md` and the spec passed unchanged.
- Test counts are NOT vacuous: `cargo.txt` was counted with a script over `test result` lines, not `grep | awk`.

## Not run / not verified (explicit)

- Nothing in the runbook, the NSIS hooks, `smoke.ps1`, `install_windows.rs`, the `cfg(windows)` code of `main.rs`/`service.rs`, the signing overlay with a certificate, or the CI job has run on Windows or in GitHub. No `makensis`, no `pwsh`, no Tauri NSIS template were available.
- The two statements the runbook takes from the Tauri template (the installer offers to close a running app; the «already installed» page and its effect on the role) are marked unverified in the text.
- The sqlx migration behaviour of an old host over a newer database (runbook: «не проверялось») is the library's default, not tested here.
- `prettier` does not cover `.ps1`/`.nsh`; `smoke.ps1` was only parsed by the home-made bracket tokenizer in `workflow.test.mjs`.
- S3 of Task 3 (the line in `run` that passes `installation::read_beside_executable()`) is still killed by no test; mentioned in spec §20 and the manual list.

## Concerns

1. **Account reset on upgrade vs plan РК.** `install` rewrites the service configuration including the account, so any account chosen for the network copy folder is lost at the next update. Documented as a manual step; a product fix (keep the existing account on upgrade) would be a code change in `install_windows.rs`/`install.rs` for a later task.
2. The runbook is long (491 lines) and honest about «unverified»; its order of steps (host first, then office, then a further station) assumes the pairing screens as `ru.json` describes them. A real run may find differences.
3. Numbering of §20 will clash at merge (listed above); the references are by title so only the heading number and the line «Номер раздела…» in §20 need a touch.
4. The plan's deviations section («Отклонения при исполнении») was not touched, as instructed (controller territory).
5. The brief's expected `\u04` and `git status` conditions hold; the plan's «Итоговая проверка» uses `7cf28790e`; the range used here is `370ec784c..HEAD` as the dispatch says.
