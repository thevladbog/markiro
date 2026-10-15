# Plan 1f2, Task 7 report: documents and the manual Windows checklist

Status: DONE. BASE 3960793164bcf1580bb17f8311197ae40bcc914a. Commit `63507cfac docs(standalone): kiosk mode, the name search and the floor's status bar` (one `Co-Authored-By: Claude Opus 5.5` trailer, verified with `git log -1 --format=%B`). `git status --short` is empty afterwards.

## What was done

Docs only; two files changed (`apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`). The plan file, code, `.superpowers/` (except this report) are untouched. The brief's text was checked against the committed code of Tasks 2-6 and corrected; every name in the new text was grepped in `src` / `src-tauri` (no_window, window_failed, refuse_close_while_locked, readOperatorRoster, readFloorPlace, setManualTextEntryActive, cover_current_monitor, clear_copies, «Оконный режим», «Найти себя по имени», «Никто не вошёл», `standalone: <command> failed`, `on_windows_a_refused_enter_leaves_the_flag_off`): all found.

### AGENTS.md

- «Operators and badges»: new bullet on the name search (reads `readOperatorRoster` at open and after every sync, two letters in any alphabet, five names by name then id with the personnel number, 3-12 digit numbers only, only fills in the number, «Назад» returns to the search). It also states Task 5's fix 89eedf435: the manual-entry flag is given back by a layout-effect cleanup tied to the name field's presence (so a field that vanishes without a blur cannot leave the scanner deaf) and `toStage` only drops the pending keys.
- «Operators and badges», closing paragraph: "«Офис» and «Повторить» below 64 px / Part 1f2 is next" replaced by "every sign-in button is 64 px, `test/operator-sign-in.test.tsx` checks every step", plus the unverified wedge focus/blur and the layout of the search step and status bar. The earlier sentence about the forget buttons ("plan 1f2's way out must keep it in mind") now says kiosk mode leaves those screens reachable on purpose.
- «App shell»: `HostStatusLine` sentence says the floor's copy lives in the status bar; new paragraphs for the status bar (`FloorStatusBar`, `readFloorPlace`, archived line still named, no device name, labelled `section`) and for kiosk mode (Rust `lockdown.rs`: flag only after all properties held, rollback, unlock always clears the flag first, `refuse_close_while_locked` installed by `run`, bare codes; `lockdown.ts` lifecycle: serial, dedup, nothing in development, a hung command holds later ones; `App`: locks whenever no office session is open, which includes the first-run wizard and repair screens; the office opens locked; «Оконный режим» only for an administrator, only while locked, never where the build does not lock; confirm dialog, re-read `GET /v1/office/me`; after a demotion the button and dialog simply disappear and the header shows the technologist role, the message lasting one round trip; focus falls to the page body after a successful exit; leaving the office locks again; a role lost after the window opened does not lock it before the session ends; technologists use the file chooser and `<a download>` in the locked window; no local maintenance code; no host means no way out but Ctrl+Alt+Del, Tauri catches neither it nor Alt+Tab nor the Windows key, Task Manager may open underneath; failed enter is logged by name and retried). Last paragraph: the device-rejected / other-host / config-error screens in kiosk mode, the forget that empties copies and counters, the loopback re-pair, and that these shell-screen buttons are of ordinary size (confirmed in `src/app/screens.tsx`).
- «Logs»: kiosk failures are logged by the command's name alone (`standalone: enter_lockdown failed`).
- «Verification»: "(later) kiosk mode" -> "kiosk mode"; new bullet on `tests/lockdown.rs` (mock runtime accepts every property and never calls a builder's window-event handler; no sockets, runs in the sandbox; the close-guard tests re-request close up to a bound then destroy the window, so a guard that never lets go fails instead of hanging, i.e. commit d31df772a; what stays green when broken: the `.on_window_event` registration in `run`, the `enter_lockdown` rollback, the `cfg(windows)` code, which needs the `windows-sys` features and compiles only in `standalone-windows-build`); and a manual Windows list (see below).

### Manual Windows checklist (in «Verification»; nothing of it has been run)

Locks at start / after «Выйти в цех» / after the session ends; also on the wizard and repair screens (queued item 2); Alt+F4, taskbar and frame refuse to close (the only check that `run` installs the guard, item 3); topmost, whole monitor over the taskbar, second monitor; a failed enter leaves a closable window (the rollback, item 3); «Оконный режим» offered to an administrator not a technologist, asks first, brings back frame and taskbar button, focus falls to body (item 6), restart locks, leaving the office locks, demotion while the dialog is open (item 5); Ctrl+Alt+Del / Task Manager under the window (item 2); technologist's file chooser and download in the locked window (item 2); real wedge scanner under EN/RU/Caps Lock, real focus/blur of the name field in WebView2 (item 9), product code on the sign-in screen, sign-in time; layout of the search step and status bar, 64 px controls, on-screen keyboard.

### Spec

The six fragments of the brief, rewritten against the final code, plus two more: §5.3's sentence "выход из киоска плана 1f2 должен это учитывать" (now: the screens stay reachable on purpose, whether to guard them is an owner question) and §5.6's "не проверено" paragraph (manual checks for the wedge scanner in the search field and the layout). §5.1 carries the same kiosk facts as AGENTS.md (wizard/repair screens locked, demotion, technologist file chooser/downloads, Task Manager); §5.2 adds the bare codes and the guard; §5.6 describes the search and the status bar; §8 points to the 1f2 plan.

## Deviations from the brief's text

- «Operators and badges» bullet extended with the Task 5 fix; the brief's version only said "leaving the field, the step or the screen gives the scanner back".
- The brief's Verification bullet said the tests run "in the sandbox" only; the final text adds the bounded-loop behaviour of the close-guard tests and the list of things the mock cannot reach.
- The brief says `set_system_awake` is "not ported yet"; kept that (owner decision), without adding the `Win32_System_Power` feature.
- The brief placed the kiosk paragraphs only in «App shell»; AGENTS.md's earlier forget paragraph ("must keep it in mind") and the spec's §5.3 sentence were also updated, since they referred to 1f2 as future.
- Items 4, 7, 8, 10, 11, 12 of `1f2-minors.md` are plan/test details, not documentation topics; not written down (item 4 is for the controller's «Отклонения при исполнении», items 10-12 are test gaps for «Перенесено»).

## Checks

- `node_modules/.bin/prettier --check` on both files: clean. `git diff --check`: clean.
- AGENTS.md: no added line longer than 80 characters (checked by character count with Python; `awk length` counts bytes and over-reports on Cyrillic).
- No `\u04` introduced (docs only). No code, test, manifest or lockfile touched; no cargo or vitest run (docs only).

## Concerns

- Spec §5.1 is a long paragraph of Russian prose (~15 lines) and the Windows list in AGENTS.md is long; trim if the owner prefers.
- The Windows checklist is a list of things to check, not results; none of kiosk mode has been run on Windows (Task 1's `Cargo.toml` features also remain the owner's step).
