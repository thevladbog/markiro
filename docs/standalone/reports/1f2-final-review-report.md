# Plan 1f2 — final whole-part review

Range `7bb33fcf8..63507cfac` (T2 `26a997efb` + `d31df772a`, T3 `954232ced`, T4 `4071c12e2`, T5 `7cb9ddb11` + `89eedf435`, T6 `396079316`, T7 `63507cfac`).

**Verdict: WITH FIXES.** Critical 0 / Important 1 / Minor 7 (new findings). The 12 queued minors are triaged below.

The code holds up end to end. I found no trap: no sequence leaves a locked window with the close guard on and no way out except Ctrl+Alt+Del, and that one case (no host, so no office login) is documented honestly. The protected exit fails closed on every path. Name search and the status bar read only this pairing's copies. The T5 fix (`89eedf435`) is correct, and mutants confirm its tests. The one Important item is a product consequence that nobody surfaced to the owner, not a code defect. The Minors are documentation gaps, manual-checklist gaps and the queued test gaps.

## (a) Findings, most severe first

### Important

**I1. Every PC that runs the app is kiosk-locked, including the host's PC and any PC used only for the office. A technologist can never get out.**

- Where: `src/app/App.tsx:383-386` (lock whenever `session === null`), with `src-tauri/src/device.rs` (stage 1 always pairs as `DeviceKind::Station`; `DeviceKind::Office` exists in `proto` but nothing uses it). `AGENTS.md:1345` speaks of "the office PCs" on the LAN.
- Scenario 1: a small factory runs the host service on the manager's desk PC, with the app on the same PC. Whenever nobody is signed in to the office as an administrator, that desk PC sits behind a borderless, topmost, unclosable full-screen window. Alt+F4 is refused, and there is no taskbar button and no Alt+Tab entry.
- Scenario 2: a technologist uses the app on an office PC that never picks a line. After «Выйти» the window locks on «Выбор линии», and the technologist has no way out at all (the exit is administrator-only).
- The plan's planner decision ("Киоск-режим включается всякий раз, когда сессия офиса не открыта") is implemented faithfully. But neither the plan, D2 nor the docs present this as something the owner chose: the documents speak of "the station", and AGENTS mentions only that technologists work "in the locked window too".
- Fix in this wave: DOC only. Say it plainly in AGENTS «App shell» and spec §5.1, and add an owner question to «Перенесено».
- Options for the owner. (1) Accept it. (2) Lock only a device whose window is a floor station, e.g. lock only once the device has a line, or keep the line screen unlocked. (3) A per-device «киоск» switch the administrator sets in «Устройства». This touches host, `proto` and `device.json`, so it is outside 1f2. (4) A local "this PC is an office PC" flag in `device.json`, set by an administrator.
- It must be decided before the Windows trial at a customer: that trial is when someone will install the app on the host PC.

### Minor

**M1. Window mode outlives the host-side session; the webview notices only at its next call.**

- Where: `App.tsx:383-386` and `:403-441`. There is no client-side office idle timer; only `PairingCodeDialog` polls.
- Scenario: an administrator opens window mode and walks away with the office open. The host expires the session after 30 idle minutes, but nothing in the webview calls the host, so the window stays framed and closable, the office session stays on screen, and anyone on the floor can close the app or reach Windows.
- What the docs say: AGENTS («App shell») and spec §5.1 say kiosk mode returns "when its session ends", and that window mode "lives exactly as long as the administrator session". Both statements are true only once a call observes the 401.
- Fix: DOC. Write that the window locks again when the office is left or when a call finds the session expired, so an administrator who walks away leaves it open. Add an owner question to «Перенесено»: a client-side office idle lock on a station PC.

**M2. The docs never say that the owner step (Task 1) is still open and that the Windows build does not compile until it is done.**

- Where: `AGENTS.md:1671-1674` names the two features but reads as if they were present. Spec §8 says only "шагом владельца".
- I checked this in a scratch crate (`/tmp/claude/1f2-final-probe`, since deleted) with `windows-sys =0.61.2` for `x86_64-pc-windows-msvc`. The exact calls from `cover_current_monitor` type-check with the two features (`MONITORINFO: Default` included).
- Without the features the failure is obvious: `error[E0433]: could not find Graphics in Win32` and `could not find UI in Win32`. CI's `standalone-windows-build` runs `cargo test --workspace` and `tauri build`, so it would fail loudly, not silently.
- Fix: DOC, one sentence in Verification: "Task 1 (owner step) is not done; until then `standalone-windows-build` fails to compile `lockdown.rs`; do not push before it". Alternatively the owner does Task 1 before any push and the sentence is not needed. Name it either way in the final report to the user.

**M3. One of the options in the D4 owner question cannot work.**

- Where: AGENTS «App shell» (last paragraph), spec §5.3 and plan «Перенесено» item 3 suggest guarding «Подключить заново» / «Сбросить подключение» "for example to the office only".
- Why it cannot work: on `device_rejected` the host refuses this device's key, so `officeLogin` through `host_request` is refused as well (`App.tsx:316-329` routes it back to `device_rejected`). On `config_error` there is no device config to talk to the host with at all.
- Scenario: the owner picks "office only" and the station can never be repaired: a deadlock.
- Fix: DOC. Reword the question. The realistic options are: keep the buttons reachable (current); keep the lockout counters out of `clear_copies` so a forget does not reset them (the actual exposure, and only on the host's PC); and the 64 px size.

**M4. `exit_lockdown` has no guard in the shell. The docs do not state the trust boundary.**

- Where: `src-tauri/src/lib.rs:191-192`. App commands are not permission-scoped (no app manifest in `build.rs`), and `capabilities/default.json` gives only `core:default` to window `main`.
- What I checked: there is one window, the CSP is `default-src 'self'`, and devtools are off in release builds (the `tauri` features are `[]`, without `devtools`). Any script in the app's own bundle can call `exit_lockdown`.
- This is acceptable for the threat model: operators have a touch screen and a scanner, with no devtools and no URL bar. T4's review called it an observation, but it is not written down.
- Fix: DOC, one sentence in «App shell»: the role check is the webview's; the shell trusts its own bundle; release builds have no devtools.

**M5. A locked window that gets hidden cannot be found again, and relaunching the app does nothing.**

- Where: `lockdown.rs:132-136` (`set_skip_taskbar(true)`) and `lib.rs:199` (`tauri_plugin_single_instance::init(|_app, _argv, _cwd| {})`, the same as the cloud station).
- Scenario: Win+D, or a minimize through any path. A skip-taskbar window has no taskbar button and is not in Alt+Tab, and launching the app again only wakes the empty single-instance callback. Win+D again or Task Manager «Переключиться» are the only ways back. The station looks dead to the floor.
- Fix: add it to the manual Windows list now (DOC). CARRY a one-line callback fix (unminimize, show and focus `main`) to the Windows trial, since the mock cannot test it.

**M6. The manual list does not cover Windows restart, shutdown or sign-out with the window locked.**

- Where: `refuse_close_while_locked` refuses every `CloseRequested`. Whether tao raises one during session end, and whether Windows then shows "this app is preventing shutdown", is unknown.
- This matters on a factory PC that restarts for Windows Update. The docs offer «Выйти из системы» as the way out, so it has to work.
- Fix: DOC, one more item in the manual list.

**M7. A badge scanned while the name field has the focus shows up as text in that field.**

- Where: `OperatorSignIn.tsx:385-387` and `scan-source.ts:50`. This is by design and the same as the cloud.
- Scenario: the code stays on screen, up to 100 characters, until the step is left. AGENTS says only that such a badge "signs nobody in". The exposure is low (the badge itself carries the barcode), but it should be recorded.
- Fix: DOC, half a sentence. CARRY any mitigation.

### Seams checked, no finding

1. **The trap property.**
   - Startup lock: the view is `loading`, so `officeOpen` is false and `enter` runs at mount.
   - «Выйти в цех» and session expiry (`office_login` view) re-lock. `device_rejected` from inside the office re-locks too, because the view stops being `office`.
   - A failed `enter`: Rust rolls the properties back and leaves the flag off, and the webview sets `applied=null; requested=null`. The window can be closed, and the button stays hidden because `mode` is still `windowed`. That is fine: the window is ordinary.
   - A failed `exit`: the Rust flag goes off first, and the webview keeps `mode` at `locked`, so the button stays and can be retried. The guard cannot trap anyone.
   - Flag on with the window not locked is unreachable through the commands. The only way to get there is the hidden window of M5, which is "lost", not trapped.
   - StrictMode is tested (`app.test.tsx:2256`). A reload (F5) re-runs `enter` with `applied=false`, and Rust's `lock` is idempotent, so it fails closed.
   - In development `enabled=false`: no commands, and the button is hidden (`kiosk.enabled` is in `windowMode`).
   - D4 screens stay reachable by design (see M3 for the owner question).
   - With no host, office login is impossible and Ctrl+Alt+Del is the only way out. AGENTS and spec §5.1 say exactly that, including Task Manager opening underneath and «Выйти из системы» as the fallback. That is honest.
2. **The protected exit.**
   - It is administrator-only twice over: `App` gives `windowMode` only when `role === "admin"`, and the button checks the role again.
   - The role is re-read through `useOfficeMutation`, which goes through `session.call`. A 401 ends the session and re-locks. Every error shows an alert and returns, and a downgrade leaves the window locked.
   - The floor cannot reach the button: `Office` is not rendered without a session.
   - The IPC boundary is covered in M4.
3. **Name search.**
   - `ROSTER` selects `id, login, name` behind `copiesReady` and the quarantine filter, and `.map` returns those three fields only. No hash is read.
   - At least 2 letters, at most 5 results, plain JS `indexOf`.
   - It only fills the personnel number. The PIN goes through `signInWithPin` with the same lockouts.
   - The roster covers every operator of the site, not of one line (operators are not line-scoped). See (e) on enumeration.
4. **Scan source and its flag.** The flag is reset on blur, when the field stops being rendered (a layout-effect cleanup on `nameFieldShown`), and on unmount, re-key and remount, because the cleanup also runs on unmount.
   - `operator_signed_in` from the search step goes through the PIN stage first, so the field is already gone.
   - The source is App-memoized and only `OperatorSignIn` consumes it.
   - Mutants (all restored, `cmp` silent, sha256 back to `c079a2b7…95b1`):
     - Cleanup removed: FAIL, 5 tests.
     - `nameFieldShown` ignoring readiness: FAIL, the 3 "hears a badge again after …" tests.
     - `onBlur` reset removed: FAIL, «does not take a name typed into the field for a badge scan».
5. **Status bar.** It shows this pairing's copies only (`copiesReady`), an organization only when there is exactly one (none or several leave it out), no IPC text, and `HostStatusLine` on both floor views. #11 survives as queued: I re-ran it, and `WHERE id = ? OR true` gives 116/116 green.
6. **Rust.**
   - Poisoning: `is_locked` reads a poisoned lock as off (fails open toward closable), and `set` writes through `into_inner`.
   - `unlock` clears the flag before anything else. `lock` sets it last and rolls back on error.
   - Refusal codes are bare. The close guard is installed in `run` (`lib.rs:222`). `cover_current_monitor` matches the cloud's production code line for line, apart from the bare error.
   - My mutant `api.prevent_close()` → no-op makes `lockdown` FAIL (3 passed, 1 failed). Restored, sha256 `d4613243…8df3`.
   - Multi-monitor uses `MONITOR_DEFAULTTONEAREST` and is unverified. `Cargo.toml`/`Cargo.lock` are untouched.
7. **Tests as a suite.**
   - Count: 1712 = the plan's 1703 + 2 (T3) + 1 (T4) + 6 (T5 fix). Cargo: 42 suites per the ledger.
   - My mutants on `lockdown.ts` (`requested=null` reset removed: 2 FAIL), `App.tsx` (`office_login` not locking: 1 FAIL) and `WindowModeButton.tsx` (role check bypassed: 1 FAIL) were all killed and restored, with matching hashes.
   - Delayed-`setImmediate` stand over `lockdown`, `operator-search`, `floor-status-bar`, `operator-sign-in`, `office`, `floor-operator` (137 passed) and `app` (91 passed). Stand files created and deleted. A verbose run shows no `stderr |`.
   - Real-time margins: one 50 ms settle in the T5-fix tests (generous for a local read), and `vi.waitFor` polling in `lockdown.test.ts`. Acceptable.
8. **Documents.** Every statement I checked matches the code, except M1–M4 and M7 above. Queued items 2, 3, 5, 6 and 9 are in, and the manual list is complete apart from M5 and M6. CI does run the Windows test that AGENTS mentions (`ci.yml:702-703`).
9. **Scope and process.** Only allowed paths are changed (`src-tauri`: `lockdown.rs`, `lib.rs`, `tests/lockdown.rs`). No manifest or lockfile changes, no new dependency. Exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` in each of the 8 commits. `git diff --check` is clean, and `git status --short` was empty at the end.

## (b) TRIAGE of the queued minors

| #      | Item                                                                                                | Decision                               | Reason                                                                                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | T3 absence check of «Оконный режим»                                                                 | DROP (resolved)                        | T4's review proved it live (mutant R1 fails it).                                                                                                                                                                                                                                                         |
| 2      | Lock on wizard and repair screens, Task Manager underneath, technologist file chooser and downloads | DOC: done                              | In AGENTS «App shell», the manual list and spec §5.1. Confirmed.                                                                                                                                                                                                                                         |
| 3      | `.on_window_event` and the rollback survive mutants                                                 | DOC: done                              | In AGENTS Verification and the manual list. Confirmed.                                                                                                                                                                                                                                                   |
| 4      | Plan's `tests/lockdown.rs` block had the hanging loop                                               | DONE (`d31df772a`)                     | Record as a deviation (c).                                                                                                                                                                                                                                                                               |
| 5      | `notAdmin` message shown for one round trip                                                         | CARRY                                  | Plan-mandated, fails closed, documented.                                                                                                                                                                                                                                                                 |
| 6      | Focus after a successful exit falls to `body`                                                       | FIX                                    | Cheap. The root AGENTS requires visible focus. Pass `OfficeShell`'s `mainRef` focus to `WindowModeButton` as a callback (`OfficeShell.tsx:23,93` already has `tabIndex={-1}`), add one test, and update the two AGENTS sentences that now say focus falls to the body («App shell» and the manual list). |
| 7      | `kiosk.clearError()` is dead                                                                        | CARRY (keep)                           | Plan-mandated and harmless; it states ownership for a future reader of `error`.                                                                                                                                                                                                                          |
| 8      | Comment at `app.test.tsx:~2387` is wrong                                                            | FIX                                    | One-line reword ("a lifecycle that reports `enabled: false`").                                                                                                                                                                                                                                           |
| 9      | Real wedge focus/blur and search layout                                                             | DOC: done                              | In the manual list. Confirmed.                                                                                                                                                                                                                                                                           |
| 10     | Status bar reset on a failed read is untested                                                       | FIX                                    | Test: names shown, then the next read fails, then the names are gone (kills mutant C).                                                                                                                                                                                                                   |
| 11     | Line selected by id is untested (`OR true` survives)                                                | FIX                                    | Real gap. Test: two lines in the copies, the assigned one (second inserted) is named and the other is not.                                                                                                                                                                                               |
| 12     | Stale-read cancellation is untested                                                                 | FIX                                    | Test: a held read for line A, the line changes to B, B lands, then A is released; B stays (kills mutant D).                                                                                                                                                                                              |
| new I1 | Every PC is kiosk-locked                                                                            | DOC + owner question                   | See I1.                                                                                                                                                                                                                                                                                                  |
| new M1 | Window mode outlives the host-side session                                                          | DOC + owner question                   | See M1.                                                                                                                                                                                                                                                                                                  |
| new M2 | Owner step still open                                                                               | DOC (or do Task 1 before any push)     | See M2.                                                                                                                                                                                                                                                                                                  |
| new M3 | D4 "office only" option cannot work                                                                 | DOC                                    | See M3.                                                                                                                                                                                                                                                                                                  |
| new M4 | Trust boundary of `exit_lockdown`                                                                   | DOC                                    | See M4.                                                                                                                                                                                                                                                                                                  |
| new M5 | Hidden window cannot be found; relaunch does nothing                                                | DOC (manual list) + CARRY the callback | See M5.                                                                                                                                                                                                                                                                                                  |
| new M6 | Restart, shutdown or sign-out while locked                                                          | DOC (manual list)                      | See M6.                                                                                                                                                                                                                                                                                                  |
| new M7 | Badge scanned into the name field is shown                                                          | DOC + CARRY                            | See M7.                                                                                                                                                                                                                                                                                                  |

I agree with the controller's leaning. Additions: item 1 is DROP (resolved by T4), not DOC. Item 6's fix must also update the two AGENTS sentences that currently document the body focus.

**Proposed fix wave (one fixer, three commits):**

1. `test(standalone): the floor's status bar names the assigned line, forgets names on a failed read and ignores a stale read` (items 10, 11, 12). Changes `test/floor-status-bar.test.tsx` only. Each test is shown to fail against its mutant (A/C/D from T6's review), then restored by cp, cmp and sha256.
2. `fix(standalone): focus goes to the office page after leaving kiosk mode` (items 6 and 8). Changes `src/office/WindowModeButton.tsx`, `src/office/OfficeShell.tsx`, `test/office.test.tsx` or `test/app.test.tsx` (focus test) and the comment in `test/app.test.tsx`.
3. `docs(standalone): kiosk mode on every PC, its lifetime and trust boundary, the open owner step, more Windows checks` (I1, M1–M7, plus the two focus sentences from item 6). Changes `apps/standalone/AGENTS.md`, spec §5.1/§5.3, and the plan's «Перенесено» and «Отклонения при исполнении» (draft below).

## (c) DEVIATIONS TO RECORD (draft for «Отклонения при исполнении»)

- Задача 1 (шаг владельца: `Win32_Graphics_Gdi`, `Win32_UI_WindowsAndMessaging` в `src-tauri/Cargo.toml`) на момент исполнения не сделана. Задачи 2–7 выполнены без неё; код под `cfg(windows)` не компилировался ни разу (вызовы `windows-sys` проверены крейтом-пробником под `x86_64-pc-windows-msvc`), и до шага владельца задание `standalone-windows-build` падает на `lockdown.rs`.
- Задача 2: в блоке плана для `tests/lockdown.rs` защита от зависания была мёртвой (`count > 3` недостижим), поэтому страж, который никогда не пропускает закрытие, вешал набор. Исправлено коммитом `d31df772a`: закрытие запрашивается заново до предела 3, затем окно уничтожается, и такой страж валит проверку примерно за 3 с.
- Задача 3: два теста сверх плана (схлопывание повторного запроса и пропуск команды для уже применённого режима); Vitest 64 / 1674.
- Задача 4: один тест сверх плана (кнопки нет, когда сборка не запирает окно, `kiosk.enabled`); Vitest 64 / 1683.
- Задача 5: код плана оставлял флаг ручного ввода включённым, когда поле имени исчезало без `blur` (синхронизация превращала шаг в уведомление), и сканер глох. Исправлено коммитом `89eedf435`: сброс флага привязан к присутствию поля (layout-эффект по `nameFieldShown`), а `toStage` только сбрасывает набранные клавиши. Шесть тестов сверх плана; Vitest 65 / 1705.
- Задача 6: из `test/operator-sign-in.test.tsx` убран пятый `link={null}`, которого не было в плане. Итог — Vitest 66 / 1712 (план 1703 + 9 тестов сверх плана из задач 3–5); cargo — 42 набора.
- Итоговое ревью: [добавить после волны исправлений — тесты строки состояния (выбор линии по id, сброс при ошибке чтения, отмена устаревшего чтения), фокус после выхода из киоск-режима, правки документов].

Proposed additions to «Перенесено»:

- Киоск-режим включается на любом ПК с приложением, в том числе на ПК хоста и на ПК только для офиса; технолог выйти не может. Включать ли его только на станции цеха (переключатель в «Устройствах» или признак в `device.json`) — вопрос владельцу.
- Оконный режим держится, пока вебвью не узнает об истечении сессии офиса: локального таймера бездействия офиса нет. Нужен ли он на ПК станции — вопрос владельцу.
- Если окно в киоск-режиме свернуто или спрятано (Win+D), у него нет кнопки на панели задач и места в Alt+Tab, а повторный запуск приложения ничего не делает (пустой обратный вызов single-instance, как в облаке). Нужно показать, развернуть и сфокусировать главное окно; проверить в Windows.
- Бейдж, отсканированный в поле поиска по имени, виден в нём как текст (как в облаке).
- Вопрос о «забывании» переформулировать: «только из офиса» невозможно, потому что отклонённое или ненастроенное устройство не открывает сессию офиса. Реальные варианты — оставить как есть или не стирать счётчики блокировок при «забывании».

## (d) What could not be verified

- **Windows.** Window properties (frame, taskbar button, topmost, fullscreen) and `SetWindowPos(HWND_TOPMOST)` over `rcMonitor`, including a second monitor and DPI scaling. Refusal on Alt+F4, from the taskbar and from the frame. That `run` installs the guard. The rollback with a real failing property. Win+D and minimize (M5). Windows restart, shutdown and sign-out with the window locked (M6). Whether Task Manager opens underneath. Ctrl+Alt+Del, Alt+Tab and the Windows key. A WebView2 renderer crash leaving a blank locked window.
- **The owner step.** Not done. The shell has never been compiled for Windows; only a scratch `windows-sys` crate was type-checked. `on_windows_a_refused_enter_leaves_the_flag_off` has never run.
- **WebView2/Tauri behaviour.** Focus and blur of the name field with a physical wedge scanner. Whether the touch keyboard appears over a topmost full-screen window (on a touch-only station the name search depends on it). The file chooser and `<a download>` under the locked window. F5 and browser accelerator keys in release.
- **A real wedge scanner** under the EN and RU layouts and Caps Lock, and badge timing on a factory PC.
- **Layout.** The status bar and search step on a real screen and touch panel; the CSS was never looked at in a browser.
- **A live host.** `GET /v1/office/me` on a real host, session expiry during window mode, and the 30-minute host idle versus the lack of a client idle timer (M1).

## (e) Recommendations on the open owner questions

- **Kiosk exit (administrator or local maintenance code).** Keep the administrator, with no local code. A code is one more secret on a factory PC that will end up taped to the monitor.
  - The no-host case is real only on the host's own PC, and the host is a Windows service. Write the emergency path (Ctrl+Alt+Del → «Выйти из системы») into the installation guide.
  - Decide I1 first, though. If the host PC and office PCs stay kiosk-locked, the no-host case becomes "the manager's desk PC is locked while the service is down", and that may push the owner toward option (2) of I1 rather than toward a code.
- **Guarding the forget screens.** Keep them reachable. "Office only" deadlocks a rejected device (M3).
  - If the counter reset on the host's PC matters, store the lockout counters outside the tables `clear_copies` empties.
  - Make those buttons 64 px together with that change.
- **Station name on the status bar.** Defer. Organization plus line is enough on a single site. Add the device name when «Устройства» gets renaming and `device.json` carries it, as one change with a compatible format.
- **`set_system_awake`.** Port it with plan 2a, keyed to an open shift, the natural trigger. Bundle `Win32_System_Power` into the same owner edit as Task 1 if the owner prefers to touch `Cargo.toml` once; an unused feature costs nothing. Until then the installation guide should set the Windows power plan to never sleep.
- **Lockout numbers and idle time (from 1f1).** The idle time of 10 minutes is reasonable. The lockout numbers are weak against a patient person at an unattended station, and the name search now makes the roster (names with personnel numbers) trivial to list.
  - 10 failures per minute station-wide allows up to about 14,400 PIN guesses a day. Spread over 10 or more operators, no operator lockout trips (5 per 5 minutes each).
  - Against 4-digit PINs that means about one expected hit per day.
  - Recommend escalation (for example, double the station lockout after each consecutive lockout, capped at 30–60 minutes) before the first production use. This is a traceability and audit-accuracy risk (operator impersonation), not a data-exposure risk.
  - Exposing the names: it is the product's intent and a personnel number is not a secret, so no extra owner question is needed beyond the escalation.
