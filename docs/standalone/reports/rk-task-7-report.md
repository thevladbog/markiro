# РК Task 7 report: «Резервные копии» page and the warnings on «Обзор»

Worktree `/tmp/claude/wt/inf`, branch `claude/infra-rk`, base `d4ee75011`. Commit `529eb7427`
"feat(standalone): «Резервные копии» in the office and the warnings on «Обзор»".
Status: DONE_WITH_CONCERNS (concerns at the end; nothing blocks).

## What was done

Brief steps 1–17 applied, then rebuilt around the mandatory addenda (rk-minors items 8–10).

New (webview only; no Rust, no manifest, no new dependency):

- `src/office/backups/backup-format.ts` — `formatWhen(instant, zone?)` (organization's zone, this PC's when none or unknown), `formatSize(bytes, t)` (units in ru.json).
- `backup-warnings.ts` — `backupWarnings`, `warningTone`, `warningToneKey`, `warningText(warning, format)`, `failureReason`.
- `backup-dir.ts` — `directoryProblem(text)`: `device` (`\\?\…`, `\\.\…`, either slash, `\\?\UNC\…` included), `parent` (a `..` part), `notAbsolute` (drive path or `\\PC\Share` only).
- `backup-polling.ts` — `pollDelay` and `useBackupPolling` (own scheduling loop: next read after the last one ends; 1 s for 10 reads, 2 s for 20, then 5 s while a copy runs, 60 s idle; failed reads double the wait 2 s…30 s and never undercut the usual one; paused while `document.visibilityState === "hidden"`, one read at once on return, none if one is in flight; unmount clears the timer and a read ending afterwards schedules nothing).
- `backup-time.ts` — `useBackupTime(enabled)`: organization's profile → zone, note (`localTimeZone` / `localTime`) when this PC's zone is used, `ready`.
- `BackupWarnings.tsx`, `SecondDirForm.tsx`, `BackupsPage.tsx`; `OfficeOverview.tsx` (`OverviewBackups`).
- Modified: `host/api.ts`, `office/{access,nav,office-query,routes}`, `i18n/ru.json`, `app/shell.css` (see deviations), `test/support/office.tsx`.
- Tests: `test/support/backups.ts`, `backup-dir`, `backup-format`, `backup-warnings`, `backup-polling`, `backups-page`.

Addenda (items 8–10 and the dispatch list):

- Folder path errors in plain words: client rule mirrors the host's `second_dir` (length, control characters via `plainTextRule`, device path, `..`, not a full path), each with its own text; the `\\?\UNC\…` text says to use `\\PC\Share` (also in the field hint); host `backup_dir` conflicts map every `BACKUP_DIR_PROBLEMS` reason (test `it.each`) plus an `unknown` fallback; a bare host `validation_failed` on `secondDir` has its own text. The field gets `aria-invalid`/`aria-describedby` from `Input`.
- Resume dialog tells the truth: the page no longer claims how many stations "gave their blocks back" (no station code exists, РК-С). Dialog text: "do not resume before the SSCC checks", "the host cannot say how many stations returned their blocks", the risk, `since` and `epoch`; the confirm button stays disabled until an explicit checkbox ("Проверки SSCC выполнены. Я возобновляю приём, зная, что станции не возвращали свои блоки."), reset on every opening; a host refusal shows inside the dialog, which stays open. Hold card shows `since`/`epoch`, stations with last-seen time, and a note that stations do not return blocks yet.
- 409 `backup_running` → info text "Копия уже делается", state re-read, button shows "Копия делается…", no error alert.
- Technologist: sees everything; the copy button, second-folder form and resume are absent, each replaced by a sentence saying only an administrator may do it.
- Live regions: one polite region on the page (and on «Обзор») present and empty before any warning; alerts inside use `role="presentation"`; a visually hidden "Ошибка:"/"Внимание:" names the tone; the status alerts in cards sit in their own polite regions; the hold table keeps text labels.
- Times in the organization's zone (profile read; page waits for it; fallback to this PC's zone with an explicit note). «Обзор» reads the profile only when a restore hold has a time to print.
- Polling as described above; a failed refresh keeps the last state on screen with a warning and "Повторить".
- «Сделать копию сейчас» success text only for a copy newer than the request (host clock from the 202 answer), not for an hour-old success.

## Deviations from the brief (semantic, all from the addenda)

1. `held` warning/`warningText`: `reconciled` dropped (kind is `{kind,since,stations}`); text no longer says "Блоки вернули станций: N из M". Brief tests changed accordingly.
2. Hold table has no "Блоки SSCC / Вернула / Ещё нет" column; `confirmAll`/`confirmWaiting` texts replaced by the dialog above. Restore card's "after" text no longer says stations re-send their blocks.
3. Page shows `PageLoading` until the organization's profile settles (brief page showed cached state at once); test helper `openBackups` waits for the first card heading.
4. Polling is the own loop (brief used `refetchInterval` on a cached-state read); 60 s idle polling added.
5. `app/shell.css` gained `.backup-alerts` (grid gap; `:empty` is taken out of the grid flow with `position:absolute`, so an always-present empty live region leaves no 16 px gap in the office grid). Not in the brief's file list; not looked at in a real browser.
6. Page text for the `\\?\…`, `..`, relative path cases and the host-refused case are new keys under `office.backups.dirRules`.

## Anchor adaptations (mechanical)

- `test/support/office.tsx`: the `updateTemplateDefaults … ...overrides` anchor no longer exists (2a3 added methods after it); the four stubs are inserted before `...overrides` after `sendFacts`.
- `host/api.ts`: the interface/factory anchors (`updateTemplateDefaults` as the last member) moved; methods appended after `sendFacts` (interface) and `closeShift` (factory).
- `office/access.ts` (after `planShifts`), `office-query.ts` (after `templateDefaults`, `shifts` keys follow), `routes.tsx` (final child after `users`), `nav.ts`, `ru.json` (nav sections/`users`, inserted by key): same place by meaning.
- `OfficeOverview.tsx`: file rewritten whole (equals the brief's fragments plus the changes above).

## 2a3 tests changed deliberately

None changed. `test/support/office.tsx` only gained default stubs (`getBackups` healthy; the other three `unexpected`). All office suites that open «Обзор» (office, products, templates, template-defaults, template-editor, users…) pass unchanged; healthy copies render nothing and `getOrg` is not called there.

## RED / GREEN

RED (`src/office/backups` moved away, then restored and `diff -r` clean): `Error: Failed to resolve import "../src/office/backups/backup-dir.js"` (also `backup-format`, `backup-polling`, `backup-warnings`) → 5 files failed, no tests (`/tmp/claude/rk7-red.txt`).
GREEN: `vitest run test/backup-dir.test.ts test/backup-format.test.ts test/backup-warnings.test.ts test/backup-polling.test.tsx test/backups-page.test.tsx` → 5 files, 85 tests passed.

## Tests

|                    | plan (brief)                                                           | measured                                                                                                      |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| new files          | `backup-warnings` 7, `backups-page` 9 (+ `backups.test.ts` already in) | `backup-dir` 26, `backup-format` 3, `backup-warnings` 9, `backup-polling` 12, `backups-page` 35 (85 in total) |
| full webview suite | 1766 (plan) / base 3031 + 85                                           | 107 files, 3116 tests                                                                                         |

Full run (normal): 3113 passed, 3 failed — all in `template-editor.test.tsx` (5 s timeouts under load average 75–90): "explains a template it cannot open…", "marks «Шаблоны» in the menu…", "does not ask once the changes are typed back…". Alone with `--testTimeout=60000`: 97/97 pass; alone with the default timeout: 95/97 (the same two timed out at 5.2 s, ~1 s each when run by name); under the delayed-`setImmediate` stand the whole suite gave 3114 passed / the same two timeouts, and the three pass by name under the stand. Treated as the known load class of that file, not caused by this task (they are 1 s tests alone).

Delayed-`setImmediate` stand (scratch setup replacing `setImmediate` with `setTimeout(…, 3)`, plus a scratch config; proved live with a probe test that failed without and passed with the stand; both files and the probe deleted): all new files and the whole suite as above.

Gates: `typecheck` 0, `lint` 0 (run with the stand files removed), `build` ok, prettier gate (live: a deliberately mis-formatted scratch file failed it, then deleted; all changed files clean), `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`, new/changed test files verbose run with empty stderr, `git status --short` empty after commit.

## Mutants (restore proven: `cmp` with a copy under `/tmp/claude/impl-rk-t7/` and equal sha256 after each)

| Mutant (one line)                                      | Killed by                                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| M1 stale `>` → `>=`                                    | backup-warnings: "warns of no copy, a copy older than 26 hours…"                                                            |
| M2 no `noSecond` warning                               | same                                                                                                                        |
| M3 host dir reason not shown under the field           | backups-page: "saves the second folder, and shows why the host refused one"                                                 |
| M4 page does not poll (`enabled: false`)               | backups-page: "makes a copy now and follows it…"                                                                            |
| M5 «Обзор» shows nothing                               | backups-page: "warns on «Обзор» and leads to the page"                                                                      |
| M6 resume needs no acknowledgement                     | backups-page: "makes an administrator confirm the resume in words that tell the truth…"                                     |
| M7 held not an error tone                              | backup-warnings: "warns of a copy running…" / held test                                                                     |
| M8 technologist may manage                             | backups-page: technologist test                                                                                             |
| M9 «don't copy» sends the old folder                   | backups-page: "stops copying into the second folder"                                                                        |
| M10 failure wait uncapped                              | backup-polling: "doubles the wait after every failed read…"                                                                 |
| M11 failure wait may undercut the usual                | same                                                                                                                        |
| M12 polls while hidden (schedule after hidden)         | survived first run → added test "schedules nothing after a read that ends while the window is hidden…" → killed             |
| M13 read after unmount schedules again                 | "stops for good when the page unmounts, even with a read in flight"                                                         |
| M14 unmount leaves the timer                           | "reads a running copy again each second…" (timer count)                                                                     |
| M15 return from hidden during a read starts a second   | "does not start a second read when the window returns during one"                                                           |
| M16 `..` matched inside a name                         | backup-dir: "takes E:\a..b"                                                                                                 |
| M17 device path not named                              | backup-dir: device cases                                                                                                    |
| M18 zone ignored                                       | backup-format: "writes an instant in the zone it is given"                                                                  |
| M19 warnings keep the alert role                       | backups-page: "announces the warnings in one polite region…"                                                                |
| M20 old success counts as the new copy                 | backups-page: "does not call an hour-old success…"                                                                          |
| M21 409 read as an error                               | backups-page: "shows the running copy, not an error…"                                                                       |
| M22 «Обзор» reads the profile always                   | backups-page: "warns on «Обзор»…" (`getOrg` not called)                                                                     |
| M23 refresh failure not shown                          | backups-page: "keeps the page and says the state did not refresh…"                                                          |
| M24 `..` refine dropped                                | backups-page: "refuses the folder `E:\a\..\b`…"                                                                             |
| M25 resume error not shown in the dialog               | backups-page: "keeps the dialog open and shows why the host refused the resume"                                             |
| M26 acknowledgement kept between openings              | backups-page: "asks again for the confirmation every time…"                                                                 |
| M27 technologist not told why no resume                | backups-page: "shows a technologist the hold with no way to resume…" (first attempt was a syntax error, redone with `null`) |
| M28 profile not waited for (`ready: true`)             | survived first run → added "shows no time until it knows the organization's zone" → killed                                  |
| M29 idle page polls every second                       | backup-polling: "reads an idle page once a minute"                                                                          |
| M30 held warning carries a returned-blocks count again | backup-warnings: held test                                                                                                  |
| M31 «Обзор» does not wait for the profile              | survived-by-construction → added "shows the warning of a held restore on «Обзор» only when it can write its time…" → killed |

## Self-review / concerns

- No station code exists (РК-С): the UI says so and relies on the administrator's confirmation. The runbook (Task 8) must contain the "SSCC checks" section the dialog points to ("по памятке о восстановлении"); wording of the checkbox and dialog is mine and should be read by the owner.
- The `.backup-alerts:empty` CSS trick and the whole page were exercised only in jsdom, not in WebView2; visual spacing, focus order and screen-reader announcements are unverified.
- `background` polling pause relies on `document.visibilityState`; whether WebView2 reports `hidden` for a minimised/covered window was not checked.
- The page now blocks on the organization profile; with a slow/failed profile it falls back to this PC's zone after the failure, not after a timeout.
- The retry in a failed refresh uses `backups.refetch()` and counts as a normal read (no backoff reset beyond the next scheduled one).
- Host side items from rk-minors 8 (202/500 after a DB read failure) are not touched by this task.
- Template-editor timeouts above are load-related; I did not touch them.
