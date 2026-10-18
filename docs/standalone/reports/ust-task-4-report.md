# УСТ Task 4 report — webview: office PC without kiosk mode, home «Вход в офис», «Сменить адрес хоста»

Status: DONE_WITH_CONCERNS (webview only; the real shell and Windows were not exercised; two deliberate additions beyond the brief, listed below).
Commit: `ccfd04bba` feat(standalone): an office PC is never kiosk-locked and its home is the office sign-in; the host's address can change (branch `claude/infra-rk`, on `ec005105a`). Worktree clean after the commit. No manifest, lockfile, Rust or host file touched. Evidence under `/tmp/claude/impl-ust-t4/`.

## What I did

Brief as written: `device.ts` (`installRoleSchema`, `InstallRole`, `DeviceApi.installRole`/`changeAddress`, code `address_other_host`), `shell.ts` (`address_changed` action, reducer case for the same host and device only, `office_login` home for a device of kind `office`), `HostAddressDialog.tsx` (new), `OfficeLogin.tsx` (`onBack: (() => void) | null`, `hostAddress`, `onChangeAddress`, the dialog), `office-session.tsx` (`exitTo`), `OfficeShell.tsx` («Выйти» vs «Выйти в цех»), `App.tsx` (role state, kiosk gated on the role, `changeAddress`, props), `ru.json` (`office.login.address.*`, `office.header.signOut`, `errors.device.address_other_host`), and the brief's tests for `device`, `shell`, `app` (old `shell` tests changed deliberately, below).

### Additions beyond the brief (trust-domain attention)

1. **A host or station PC stays locked even when its disk holds an office pairing.** The brief's `officePc = role === "office" || kind === "office"` would leave a PC whose installer role is `host`/`station` unlocked if a stale office `device.json` is on its disk (the data survives an uninstall). Now `officePc = role === "office" || (role !== "host" && role !== "station" && kind === "office")`: the status kind counts only where the shell gave no role. Tests: `keeps a host|station PC locked even when its disk holds an office pairing`.
2. **An office-role PC never shows the floor or the line choice, whatever pairing its disk holds.** Without it, an office PC with a stale station pairing would show the operator sign-in unlocked (kiosk off because of the role, view `floor` because of the kind). `App` replaces `floor`/`floor_operator`/`line_select` with the office sign-in when `role === "office"`. Tests: `shows no floor on an office PC whose disk holds a station pairing`, `shows no line choice on an office PC either`.
3. `invalid_request` from `device_change_address` (the shell refusing the spelling of an address, Task 3 concern 3) is mapped to the plain `office.login.address.invalid` text instead of «Приложение сформировало недопустимый запрос.». Test: `tells a malformed address the shell refused in plain words`.
4. Success message «Адрес хоста изменён» sits in a persistent `aria-live="polite"` container with a `role="presentation"` Alert (the BackupsPage pattern); the focus returns to «Сменить адрес хоста» (Modal restores it; tested after `focus()`, as `fireEvent.click` does not focus).
5. Further tests beyond the brief: kiosk waits for a pending role answer and locks a station when it arrives; a station PC paired with a remote host keeps «В цех» / «Выйти в цех» and the address change; the dialog clears the earlier complaint on the next try, clears the spelling error when a sendable address is refused by the host, and opens empty again; «Отмена» changes nothing; the typed address is not in the error `changeAddress` raises (no URL echoed into messages/logs).

### Trust-domain checks

- The role comes from `deviceApi.installRole()` (`install_role`, shell) only: not from a URL, local storage or a prop; an unreadable/invalid answer is `null` = station = locked.
- The window is not locked before the role is known (as the brief wants), is locked for `null`, `host`, `station`, never for an office PC.
- `exitTo`/«Выйти» and the missing «В цех» follow `officePc`; the reducer never signs an operator in on a device of kind `office` (`nextShellView` is `office_login` there, and `operator_signed_in` accepts only floor views).
- The station's existing office entry («Офис» → «В цех», «Выйти в цех», «Оконный режим») is unchanged.
- The key still never reaches the page; `changeAddress` sends only the address; `DeviceError` messages carry the command and the shell's bare code, never the address.
- Certificate mismatch at a new address: the shell answers `address_other_host`, shown as «…отвечает другой хост: его сертификат не совпадает…»; a `key_rejected` answer goes to the device-rejected screen via `deviceRejection`.

## RED / GREEN

- Baseline (3 files): 309 passed (`base.txt`).
- RED after the brief's tests only: `12 failed | 310 passed (322)` — device 2, shell 6, app 4, as the brief says (`red.txt`: `installRole is not a function`, `office_login` vs `floor`, etc.).
- GREEN: 3 files 334 passed (brief 242 on its older tree; this tree has 2a5, so counts differ). The +14 over baseline in the first green run (323) = device 3 (one `it.each` row for the new code), shell 4, app 7; my extra tests added 11 more.
- Gates: `tsc` 0, `eslint` 0, `vite build` 0, prettier gate (proved live with a mis-formatted scratch file that failed, then deleted; `prettier --write` fixed one line in `App.tsx`; final check clean on `src`/`test`), `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`.
- Verbose run of the three files: stderr 0 bytes, no `act(...)` warnings (`verbose2.err`).
- Delayed-`setImmediate` stand (3 ms, brief's files; deleted after use): 334 passed twice (before and after my last test edit), `delay.txt`, `delay2.txt`.
- ONE full run `vitest run --testTimeout=60000 --hookTimeout=60000`: `107 files, 3141 tests passed`, exit 0 (`full.txt`). No timeout flake in the office suites this time.

## Test totals: plan vs measured

Plan: device 32, shell 112, app 98, total 1758 over 67 files (older tree, before 2a5). Measured on this tree: device 39, shell 156, app 139 (334 in the three files, from 309 before the task; +25 = brief's 13 + the `address_other_host` code row + my 11 extra), whole package 107 files / 3141 tests.

## Old tests changed deliberately

- `shell.test.ts` `has a station without a line choose it, unless the office is open or opening`: a device of kind `office` without a line now shows `office_login`, no longer `floor`.
- `shell.test.ts` `signs in a device of the office or the handheld kind without a line` replaced by `signs in a handheld without a line, and nobody on an office PC` (the handheld part is unchanged, the office kind is now refused).
- `shell.test.ts` operator-survival table gained the required `address_changed` rows (the compiler demands one per action).
- `app.test.tsx` `fakeDevice` gained `installRole` (default `null`) and `changeAddress`.

## Mutants (script `/tmp/claude/impl-ust-t4/mutate.py`, log `mutants.log`; each file copied to `/tmp/claude/impl-ust-t4/orig/` first, restored, `cmp` + sha256 equal, `touch`ed; all `restored=True`)

Runs: the covering file(s); `app.test.tsx -t 'plan УСТ'`; `shell.test.ts`/`device.test.ts` whole.

| #          | One-line mutant                                                                                                  | Killed by                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| M1         | kiosk effect without `!officePc` (brief)                                                                         | `never locks an office PC…`, `shows no floor on an office PC whose disk holds a station pairing`                         |
| M2         | kiosk effect without `roleKnown` (brief)                                                                         | `never locks…`, `keeps the window unlocked until the shell has named the role…`, `shows no floor…`                       |
| M25        | `roleKnown = true`                                                                                               | same three                                                                                                               |
| M3         | `status.kind === "office"` home removed (brief)                                                                  | `gives an office PC the office sign-in…`, `has a station without a line…`, `signs in a handheld… nobody on an office PC` |
| M4         | `unreachable` mapping replaced by `invalid_request` (brief)                                                      | `keeps the dialog open and explains…`, `clears the earlier complaint…`, `tells a malformed address…`                     |
| M4b        | `invalid_request` mapping dropped                                                                                | `tells a malformed address the shell refused in plain words…`                                                            |
| M5 / M5b   | header always «Выйти в цех» / `exitTo` always `floor`                                                            | `never locks an office PC…`, `shows no floor…`                                                                           |
| M6         | `address_changed` ignores the device id (brief)                                                                  | `takes the host's new address only for its own pairing`                                                                  |
| M6b        | `address_changed` ignores the host id                                                                            | same                                                                                                                     |
| M26        | `address_changed` accepts any status when unpaired                                                               | same                                                                                                                     |
| M7         | stale office pairing counts on a host/station PC                                                                 | `keeps a host PC locked…`, `keeps a station PC locked…`                                                                  |
| M8         | office-role floor override off                                                                                   | `shows no floor on an office PC…`, `shows no line choice…`                                                               |
| M9         | «Назад» always shown (`onBack` never `null`)                                                                     | `never locks…`, `shows no floor…`                                                                                        |
| M10        | address block always shown (host on this PC too)                                                                 | `offers no address change for the host on this computer`                                                                 |
| M11        | `key_rejected` not routed to the rejected screen                                                                 | `treats a key the host no longer accepts…`                                                                               |
| M12        | role error leaves the role unknown (no lock)                                                                     | `locks a station whose role the shell could not tell`                                                                    |
| M22        | answered role ignored (always `null`)                                                                            | host/station locked tests, `shows no floor…`, `shows no line choice…`                                                    |
| M13        | role schema accepts any string                                                                                   | `reads the installer's role, and null in a development build`                                                            |
| M23        | `install_role` called with arguments                                                                             | same                                                                                                                     |
| M14        | `device_change_address` sent without the address                                                                 | `moves the pairing to the host's new address`                                                                            |
| M21        | `address_other_host` missing from the codes                                                                      | `moves the pairing…`, `keeps the typed address out of what a refused address change raises`                              |
| M15 / M15b | live region removed / alert not `presentation`                                                                   | `announces the new address in a live region…`                                                                            |
| M16        | dialog sends the raw text, not the parsed address                                                                | `moves the pairing to the host's new address from the office sign-in` and two more                                       |
| M17        | spelling error never cleared (initially survived; test strengthened with a sendable address refused by the host) | `clears the earlier complaint with the next try…`                                                                        |
| M18        | earlier failure not cleared on submit                                                                            | same                                                                                                                     |
| M19        | dialog not closed on success                                                                                     | `moves the pairing…`, `announces…`, `clears…`                                                                            |
| M20        | success message not set                                                                                          | same                                                                                                                     |

M6c (drop the `status === null` guard) was not run: its anchor matches twice (`device_refreshed` has the same shape); M26 covers the unpaired-state branch.

## Anchor adaptations

- `shell.test.ts`: fragments applied by meaning where the tree had `ANNA_SESSION` and different surroundings (fragment 3 inserted before the `operator_signed_in` comment; fragment 4's old test shape is the tree's `ANNA_SESSION` version; the new test keeps those names).
- `app.test.tsx`: `fakeDevice`'s tail and the end of the file differ (the tree has more tests after the kiosk describe); fragment 1 anchored on `refresh`'s block and the new `describe` appended at the end of the file.
- `App.tsx` fragment 3/4 (split across effects and callbacks) applied by meaning: the second effect (`installRole`) and the `changeAddress` callback are separate blocks placed after the device-status effect and before `retryProbe`; their bodies are the brief's. Fragment 5 spans the tree's kiosk effect with the comment text merged. `prettier --write` reformatted one line of `officePc`.
- All other fragments (`device.ts`, `shell.ts` reducer/view, `OfficeLogin`, `office-session`, `OfficeShell`, `ru.json`, the dialog) matched exactly once.

## Self-review

- `officePc` now depends on `role` and the status; the role is read once at start (a reinstall with another role restarts the app anyway).
- The reducer's `address_changed` keeps operator, line, link and sync as they are (same host, same device); the shell tells the link about the new address.
- The success message is a plain `ok` Alert in a live region; the dialog's failure alert keeps the default `role="alert"` like `WriteFailureAlert`.
- No new dependency; `zod` is already a webview dependency.

## Concerns

1. Windows and a real shell/webview were not exercised: kiosk mode per role, `install_role` over real IPC, the dialog under the borderless topmost window of a station (the dialog is reachable from a station only via «Офис», where the window is still locked unless an administrator left it).
2. An **unpaired office PC** whose host answers on 127.0.0.1 (the host service is not installed with the office role, so this is a misconfiguration) would still run `pairLocally` automatically; the shell refuses it (Task 3, `invalid_request`) and the pair-failed screen only offers «Повторить». Not changed here (a role-aware pairing screen is new UI).
3. A station-role PC with a stale office pairing stays locked and shows the office sign-in as its home (the reducer's view follows the status kind); only an administrator can get out via «Оконный режим» and «Сбросить подключение» is on the repair screens. Safe for the floor, but the PC cannot work until re-paired.
4. `S3` of Task 3 (the shell reads `installation.json` in `run`'s setup closure) remains the only link no test covers; a real app start closes it.
5. The shell's CORS/Windows items from the minors file (NSIS hook writes exactly `{"role":...}`; BOM) are Task 5's.

## Files changed

`apps/standalone/src/{app/App.tsx,app/shell.ts,app/HostAddressDialog.tsx (new),host/device.ts,i18n/ru.json,office/OfficeLogin.tsx,office/OfficeShell.tsx,office/office-session.tsx}`, `apps/standalone/test/{app.test.tsx,device.test.ts,shell.test.ts}`.
