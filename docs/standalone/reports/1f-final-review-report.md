# Plan 1f, part 1f1 — FINAL WHOLE-PART REVIEW (range 79f077c1d..440187498)

**Verdict: WITH FIXES** — Critical 0, Important 0, Minor 3 new (M1–M3 below), plus the 22 queued minors triaged in §(b).

No blocker. The part works as one machine: pairing guard → `copiesReady` → check → lockout → reducer → idle/post-sync. Each seam that a late answer or a re-pair could slip through has a guard, and a test kills that guard's mutant. The three fixes nobody had re-reviewed (509cf9b2a, c03e4c19a, 04baef8ad) are correct and tested; their mutants are killed (table below). What remains is one fix wave (minors, comments, tests) and owner decisions. The most important owner input: the lockout's real sustained ceiling, M1, is about ten times looser than the brief assumed.

## Evidence I produced (tree restored, `git status --short` empty at the end)

| #   | Mutant (one line)                                                                           | Focused files                | Result                                             |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| 1   | `host_probed` keeps the operator (fix c03e4c19a)                                            | shell, app                   | killed, 7 failures                                 |
| 2   | reducer drops `status.lineId !== action.lineId` (fix 04baef8ad)                             | shell, app                   | killed, 3 failures (incl. the same-batch App test) |
| 3   | `RECORD_FAILURE` loses its `WHERE` (running lockout no-op, fix 509cf9b2a)                   | floor-lockout, floor-sign-in | killed, 3                                          |
| 4   | station quiet boundary `>` → `>=`                                                           | floor-lockout                | killed, 1                                          |
| 5   | `pinAttempt` drops the post-verify `copiesReady`                                            | floor-sign-in                | killed, 1                                          |
| 6   | `operatorSignedOut` drops the session-object check (`currentOperator.current !== signedIn`) | app                          | killed, 1                                          |
| 7   | `OperatorSignIn` drops the line comparison of late answers                                  | operator-sign-in, app        | killed, 1                                          |

For each mutant I copied the file to `/tmp/claude/` first, then restored it with `cp`; `cmp` was silent and the sha256 matched before and after (shell.ts `4b3e6985…`, lockout.ts `273ba1da…`, sign-in.ts `cc52cab9…`, App.tsx `68806d18…`, OperatorSignIn.tsx `103cb8a2…`).

I ran the delayed-`setImmediate` stand (3 ms) over `floor-operator`, `operator-sign-in`, `app` and `floor-sign-in`: 4 files, 198 tests passed, with no `act(`/warning output. Both stand files were deleted afterwards.

Scope checks:

- `git diff --name-only` for host, proto, station, packages, lockfile, `package.json`, `Cargo.toml` and `Cargo.lock` is empty.
- `src-tauri` changes only in migration 0005, the `local_db.rs` comment and an assertion inside an existing test in `tests/local_db.rs` (no new test, so Cargo counts are unchanged).
- Every one of the 11 commits has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git diff --check 79f077c1d 440187498` exits 0.
- I did not re-run cargo; nothing raised a doubt that `--test local_db` would answer.

## Seams checked

1. **Sign-in as one machine.**
   - (a) **Re-pair during a session or a check.** Every re-pair path clears the operator: forget → `forgotten`, `paired`, `other_host`, rejection, `host_probed`. A check in flight is dropped three times over:
     - the screen unmounts, so `alive` is false;
     - the sign-in re-reads `copiesReady(pairing)` after hashing (PIN and badge), and `clear_copies`/the wipe makes it false;
     - the reducer compares `deviceId`.
       A same-host re-pair keeps the same operator UUIDs, so a race there would only admit the same person with the same PIN. Queued #2 is closed.
   - (b) **Timing.** Every well-formed PIN attempt that is not answered early pays one PBKDF2. The early answers:
     - `not_ready`: the same for every input;
     - station locked: the answer says so itself;
     - operator locked: an existence oracle, plan-mandated and documented (#8).
       A known number also costs about three extra IPC round-trips; this is documented. Equal timing needs a stored hash with exactly 100 000 iterations (documented, #4).
   - (c) **Lockout bypasses.**
     - Concurrent attempts are serialized.
     - A restart keeps the rows (the `openLocalDbFile` restart test).
     - A clock moved back restarts a running lockout and still counts failures; a clock moved forward shortens it (documented).
     - A success clears only the operator's own row.
     - The rate is in M1.
   - (d) **Stuck IPC.** The shell's pool has `busy_timeout` 5 s and sqlx's default `acquire_timeout` of 30 s, and `verifyPhc` (WebCrypto) always settles. A local-db call is therefore bounded at about 35 s in practice, not forever. «Офис» being disabled for that long is still worth #14.
   - (e) **Office changes.**
     - A removal arrives with the next revision-triggered sync, typically within seconds while online. The check also runs when the stub mounts, so a sign-in that raced the tombstone is signed out at once.
     - A PIN rotation does not end a session (the check looks only for presence). This is acceptable for a sign-in session.
     - The check fails open, as documented (#21).
   - (f) **Identity races.** I re-traced the sequences after 04baef8ad:
     - `device_refreshed` then `operator_signed_in` in one batch is refused (line mismatch).
     - The reverse order signs in and is then cleared with `line_changed`.
     - Two sessions of the same operator are told apart by the App copy plus the layout-effect ref. A late callback from session A cannot reach session B, because B's sign-in requires A's sign-out to have committed first, and that commit sets the ref to `null`.
     - StrictMode double effects (`source.start`, idle lock, readiness, post-sync check) are idempotent.
     - An unmount during a check sets nothing.
     - Remaining start-up note, not counted: an operator who signs in during the ≤3 s local probe is signed out silently when the probe lands. Task 4's review accepted this as fail-closed, and `AGENTS.md` names «any host probe». It would only become worth a `floorNotice` if 1f2's kiosk start-up makes the window common.
2. **Secrets.**
   - `FloorOperator` and the reducer state hold `{id, login, name, role}` only.
   - `LocalDbError` carries bare shell codes (`${command}: <code>`), and the zod `invalid_response` text names types, not values. The screen shows generic text either way.
   - `PinPad` renders no value attribute, and the readout shows dots.
   - The lockout table holds keys, counts and times.
   - There are no snapshots, and console spies exist in the sign-in, screen and stub tests.
3. **Data and migration.**
   - 0005 is a new `CREATE TABLE`; 0001–0004 are untouched.
   - Both `INSERT` paths supply `last_failure_at`; the only writer is `RECORD_FAILURE`.
   - The bind order is 4 + 7 + 2 = 13 parameters, matching the SQL.
   - The batch limit is unchanged: 30 of 32, and the guard is still one statement.
   - Rust `clear_copies` (every table) and the TS `WIPE` (copies, quarantine, `sync_state`) are consistent with the documented intent. A new pairing reached through forget does NOT inherit counters; one reached through the wipe for another pairing keeps the station row, which is harmless, plus inert `operator:<old uuid>` rows. See M3 for the flip side of forget.
4. **Scan source and screen.**
   - `preventDefault` applies to every Enter (documented, #16).
   - Ctrl/Alt keys are appended (#15). There is no timing threshold (documented).
   - Stray product codes are counted (#7; the test documents it).
   - The sync gate fires the first request at once and folds later ones. The burst test now uses a 30 s gap.
   - The lock message is static (documented).
5. **Accessibility and UX.**
   - «Офис» is reachable on every non-busy state: loading, read failure (with «Повторить»), not ready, no operators.
   - The idle activity events are `pointerdown`/`keydown`/`touchstart` on `window`, so wedge keystrokes count.
   - The 64 px items (#18) are documented.
6. **Tests.**
   - The `vi.mock` of `FloorOperatorScreen` in `app.test.tsx` passes through to the real screen; it only records `onSignOut`, so it hides nothing.
   - All seven mutants were killed, and the stand is green.
   - One test-margin issue (M2).
   - The known survivors (#3, #12) are still open.
7. **Documents.**
   - `AGENTS.md` «Operators and badges», «Reference sync», «Logs» and spec §5.3/§5.4/§5.6/§8 match the final code: decay, the no-op on a running lockout, serialization, the end conditions including `host_probed`/`office_opened`, the reducer refusals, fail-open, «a sync has begun to fill» readiness, and the wipe keeping the table.
   - No stale `hostGuard` remains in src, test, AGENTS or the spec.
   - 1f2 is named NEXT, and the unverified items are listed.
   - The stale wording is in code comments only (folded into #1/#6).
8. **Scope and process:** see Evidence.

## (a) Findings, most severe first

**M1. Minor (doc; owner input). The lockout's sustained ceiling is about 10 guesses per 70 s, not "9 per 10 min".**

- Where: `src/floor/lockout.ts:20–44` (comments), `RECORD_FAILURE` (`failures = CASE WHEN locked_at IS NOT NULL THEN 1 …`); `AGENTS.md` «Lockouts …»; spec §5.6.
- Mechanism:
  - The quiet interval only matters below the limit.
  - A patient guesser simply hits the limit: 10 failures → a 1-minute pause. When it runs out, the next failure counts as the first again, with no escalation.
  - The sustained rate is therefore about 10 per (60 s + 10 checks), roughly 500–600 per hour or 12–14 k per day, from the station alone.
  - Badge guessing is bounded only by this. Per-operator PIN guessing is additionally bounded at 5 per 5 min per operator.
- Example: for a 4-digit PIN tried across N operators (one common PIN per number, the case `STATION_LOCKOUT` names), the expected count to hit somebody is about 10 000/N. With 50 operators that is roughly 200 guesses, about 25 minutes at the station.
- The code does what the plan decided («после блокировки отсчёт начинается заново»), and the documents state each rule truthfully. But none of them states the resulting ceiling, and the brief itself reasoned with the wrong number.
- Fix (wave, docs): one sentence in the `STATION_LOCKOUT` comment, `AGENTS.md` and spec §5.6 giving the sustained ceiling.
- Owner: see (e) for escalation.

**M2. Minor (test hygiene). The idle-touch test has two 500 ms real-time margins, below the 800 ms rule.**

- Where: `test/app.test.tsx:1988–2003`.
- Mechanism: with `shouldAdvanceTime` the fake clock also runs with real time. With an idle timeout of 2 000 ms:
  - the touch at +1 500 must land before the original timer (margin 500 ms);
  - the assertion at touch +1 500 must precede the restarted timer (margin 500 ms).
- Scenario: a loaded Windows runner (see the earlier `hookTimeout` incidents) fails it spuriously.
- Fix: timeout 4 000 with elapses 2 500 / 2 500 / 1 700 (margins 1 500 / 1 500), or plain fake timers without `shouldAdvanceTime` for this test.
- The neighbouring «every event of the link» test has a 1 400 ms discriminating margin and is fine.

**M3. Minor (doc). A forget resets every lockout counter.**

- Where: `AGENTS.md` «Local database» paragraph (and spec §5.3).
- Mechanism: `clear_copies` empties `floor_sign_in_failures`, and a station on the host's PC re-pairs itself automatically (`pairingDue`).
- Scenario: whoever can reach a «Переподключить»/«Сбросить» control (device-rejected, other-host and config-error screens) wipes the station's and the operators' counts.
- These screens are not reachable from a working floor, so no code change is needed in 1f1. 1f2's kiosk exit design should know it.
- Fix: one sentence in the docs, and carry it into the 1f2 outline.

(The «complete copies» wording that survives in code comments — `sign-in.ts:37,177,285–287`, `OperatorSignIn.tsx:96` and the `copiesReady` docstring in `reference-sync.ts` — is part of queued #1/#6 below, not a new finding. So is the wrong cloud constant name in the `DUMMY_PIN_PHC` comment: the cloud's is `DUMMY_PHC`, `apps/station/src/lib/auth.ts:11`.)

## (b) TRIAGE of the queued minors

| #   | Decision                                                              | Reason                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **FIX**                                                               | The `copiesReady` docstring still says «complete … applied its last page». Also fix the same word in `sign-in.ts:37,177,285–287` and `OperatorSignIn.tsx:96`. `AGENTS.md`/spec are already right («a sync has begun to fill»).                                                                                                                                                               |
| 2   | DROP (closed)                                                         | Re-check after hashing in both paths, plus the screen guard and the reducer `deviceId`; mutant 5 killed.                                                                                                                                                                                                                                                                                     |
| 3   | **FIX**                                                               | `isPinPhc` cap and canonical-digit cases (2 000 000 iterations, `0100000`) still untested; I found no such case in `floor-sign-in.test.ts`.                                                                                                                                                                                                                                                  |
| 4   | DOC — done                                                            | `AGENTS.md` («only when the stored hash has exactly 100 000 iterations») and spec §5.6.                                                                                                                                                                                                                                                                                                      |
| 5   | **FIX (optional, cheap)**                                             | Parity test: the `LOGIN`/`PIN`/`BADGE_CODE` regexes against `operatorLoginRule`/`pinRule`/`badgeCodeRule` on a shared table of edge inputs (2/3/12/13 digits, `" 0421 "`, `\t`, 257 chars, Cyrillic). Note: the badge trims are the same `String.prototype.trim`, and U+001D is not trimmed by JS, so the GS test before the trim is sound.                                                  |
| 6   | **FIX**                                                               | The constant is now `DUMMY_PIN_PHC` (correct per plan), but its comment calls it «the cloud station's `DUMMY_PIN_PHC`»; the cloud name is `DUMMY_PHC`. One word.                                                                                                                                                                                                                             |
| 7   | CARRY — owner                                                         | See (e). The test documents today's behaviour.                                                                                                                                                                                                                                                                                                                                               |
| 8   | DOC — done                                                            | `AGENTS.md` and spec §5.6.                                                                                                                                                                                                                                                                                                                                                                   |
| 9   | DROP (done by 04baef8ad)                                              | `lineId` in the action and the reducer refusal; mutant 2 killed (including the same-batch App test).                                                                                                                                                                                                                                                                                         |
| 10  | DROP (done by Task 6)                                                 | Session-bound sign-out via the App copy and the layout-effect ref; mutant 6 killed.                                                                                                                                                                                                                                                                                                          |
| 11  | **FIX**                                                               | The reducer builds `{ id, login, name, role }` from `action.operator`, so secrecy is local to the reducer. It stays compatible with the object-identity token: still one fresh object per sign-in. Test: an action whose operator object carries an extra `pinPhc` is stored with exactly four keys. The App's `{ ...operator }` may then go, but keeping it does no harm.                   |
| 12  | **FIX**                                                               | The PIN-clear test on the changed-props path.                                                                                                                                                                                                                                                                                                                                                |
| 13  | DROP (done by Task 6)                                                 | `lineId` is required, the screen is keyed `hostId:deviceId:lineId`, and asks are coalesced by the gate.                                                                                                                                                                                                                                                                                      |
| 14  | **FIX** (controller decision; agree)                                  | Keep «Офис» enabled during a check. It is safe: unmount → `alive` false; the reducer refuses `operator_signed_in` while the office is not closed; the queue is not released. Test: hold the DB gate, press «Офис» (`onOffice` called), release, and `onSignedIn` is not called. Keep «Назад»/the keypad disabled. In practice the hang is bounded at about 35 s (seam 1d), not forever.      |
| 15  | **FIX** with a caveat                                                 | Map `ctrlKey && !altKey && key === "]"` → `\u001d`. Drop keys with `ctrlKey`/`metaKey` unless `altKey` is also set: on Windows, AltGr arrives as Ctrl+Alt, and dropping it would eat printable AltGr characters. Keep «GS as Ctrl+] in WebView2» in the not-verified list, since what `key` a real wedge produces is unconfirmed.                                                            |
| 16  | DOC — done                                                            | `AGENTS.md` and spec §5.6.                                                                                                                                                                                                                                                                                                                                                                   |
| 17  | **FIX**                                                               | `noticeDismissed` set by the first attempt. The static lock text stays documented (done).                                                                                                                                                                                                                                                                                                    |
| 18  | CARRY (1f2 / polish)                                                  | 1f2 reworks the floor (status bar, kiosk); the 64 px gaps are documented.                                                                                                                                                                                                                                                                                                                    |
| 19  | **FIX**                                                               | Rename the title at `operator-sign-in.test.tsx:627` to «documents today's behaviour, owner decision pending: …».                                                                                                                                                                                                                                                                             |
| 20  | CARRY                                                                 | Object identity works and is tested (mutant 6). Do it only together with #22 (see below).                                                                                                                                                                                                                                                                                                    |
| 21  | DOC — done                                                            | `AGENTS.md` («stays signed in until the next successful sync reads the copies») and spec §5.6. An optional retry after `SIGN_IN_SYNC_GAP_MS` stays CARRY.                                                                                                                                                                                                                                    |
| 22  | **DOC + CARRY to 2a** (I disagree with FIX in this wave)              | Refreshing name/role means rebuilding `state.operator`. Under the object-identity token that silently mints a new "session" (the idle timer restarts and the App ref changes), which is exactly the hazard Task 6's review raised. Do it in plan 2a together with an explicit session counter (#20); for now, one sentence in `AGENTS.md`: «the stub shows the name and role as of sign-in». |
| —   | Optional `line_changed` notice on the line-mismatch refusal: **DROP** | The window is tens of ms, the screen remounts clean, and the operator rescans.                                                                                                                                                                                                                                                                                                               |

New items: M1 and M3 go into the docs commit, M2 into the tests commit.

**Proposed fix wave (one fixer, six commits):**

1. `docs(standalone)`, comments and docs only:
   - #1 and #6 (all «complete» wording, `DUMMY_PHC`);
   - M1 (the sustained ceiling in `lockout.ts`, `AGENTS.md` and spec §5.6);
   - M3 (forget resets counters);
   - #22 (stub snapshot sentence);
   - the #15 residual: the WebView2 key for Ctrl+] is unverified.
2. `test(standalone)`, sign-in guards: #3 (two `isPinPhc` cases, each expecting the dummy-hash path: `wrong`, counted against the operator) and #5 (parity table).
3. `fix(standalone)`, the reducer copies the operator's four fields: #11 plus its test, with a one-line mutant.
4. `fix(standalone)`, the sign-in screen:
   - #14 «Офис» during a check, plus a test;
   - #17 `noticeDismissed`, plus a test;
   - #12 the PIN-clear test;
   - #19 the title.
     Each with its mutant.
5. `fix(standalone)`, wedge source: #15 (Ctrl+] → GS; drop Ctrl/Meta without Alt), with tests for `]`+Ctrl, `c`+Ctrl, an AltGr char and Meta.
6. `test(standalone)`: M2, widening the idle-touch margins to ≥ 800 ms.

Gates afterwards: focused files, the delay stand over `operator-sign-in`/`app`/`shell`, the package Vitest/typecheck/lint/build, prettier, `git diff --check`, the `\u04` grep. No Rust is touched.

## (c) DEVIATIONS TO RECORD (draft for «Отклонения при исполнении»)

```markdown
- Задача 1. Помимо плана: проверка `a5109dbd6` — чужой хост при состоянии без `device_id` стирает копии сразу.
- Задача 3. Попытки входа сериализованы (`oneAtATime` в `sign-in.ts`), чтобы перекрывающиеся попытки не проходили одно и то же чтение блокировки; зависшая попытка держит очередь (вызов локальной базы на деле ограничен `busy_timeout` 5 с и ожиданием пула sqlx 30 с).
- Задача 3 (исправление 509cf9b2a). Удачный вход больше не сбрасывает счётчик станции: `clearFailures` заменён на `clearOperatorFailures` (стирает только строку вошедшего оператора), а счётчик станции затухает — начинается заново, когда прошлая неудача старше `STATION_QUIET_MS` (10 минут; ровно 10 ещё считается). Для этого `LockoutPolicy` получил `quietMs`, а в ещё нигде не применённую миграцию 0005 добавлен `last_failure_at INTEGER NOT NULL`. Неудача, записанная во время идущей блокировки, ничего не меняет (`WHERE` в `RECORD_FAILURE`; часы, отведённые назад, считаются идущей блокировкой). Стирание копий синхронизацией при другом подключении таблицу неудач намеренно сохраняет; забывание устройства её очищает (а значит, сбрасывает все счётчики). В тестовой поддержке появился `openLocalDbFile` для теста перезапуска.
- Задача 4 (исправление c03e4c19a). Сеанс оператора завершают также `office_opened` (мастер первичной настройки открывает офис без `office_requested`, D4) и любая проба хоста `host_probed` (запуск, повтор, после забывания); оператор, вошедший за ≤3 с до ответа пробы при запуске, выходит без уведомления.
- Задача 5. `OperatorSignIn` отбрасывает ответ проверки после размонтирования или смены подключения/линии (`alive`, `current` в layout-эффектах); PIN очищается после каждой завершённой проверки; `scan.current` обновляется в layout-эффекте.
- Задача 6. `lineId` у `OperatorSignIn` обязателен (`string | null`), экран в `App` ключуется `hostId:deviceId:lineId`; запросы синхронизации от входа идут через шлюз `createRequestGate` (`SIGN_IN_SYNC_GAP_MS` = 2 с, первая сразу); `App` отправляет копию оператора, и обратные вызовы выхода привязаны к объекту сеанса (сеанс того же оператора отличается от следующего).
- Задача 6 (исправление 04baef8ad). `operator_signed_in` несёт `lineId` (линия начала проверки) и `address`; редьюсер отказывает при другой линии, не цеховом экране и уже вошедшем операторе; проп `signInSyncGapMs` у `App` (тесты).
- Задача 7. Документы исправлены по итоговому коду, а не по брифу: `pairingGuard` вместо `hostGuard`, «готовность — не полнота копий», затухание счётчика станции, сериализация, условия выхода, отказы редьюсера, проверка после синхронизации без блокировки работы.
- Итоговое ревью: потолок блокировки станции при терпеливом подборе — около 10 попыток в ~70 с (после блокировки счёт снова с единицы, без нарастания); числа ждут решения владельца.
```

(Add the final-wave commits when they land.)

## (d) Not verified

- Windows, WebView2 and Tauri. Nothing ran in a real window: the webview IPC to the real pooled SQLite was exercised only through `node:sqlite` and the Rust `local_db` suite.
- A real keyboard-wedge scanner: RU and EN layouts, Caps Lock, what `key` WebView2 reports for a GS sent as Ctrl+], and the Enter suffix.
- PBKDF2 time on a factory PC (equal-timing claims, how the station feels under 10 checks in a row), and touch layout/size on the line display.
- The loopback cargo suites after the fixes (`claim`, `connection`, `device`, `host_probe`, `host_probe_proxy`, `ipc`, `line`; host `changes_stream`, `hello`, `no_secrets_in_logs`, `platform`): they need an unsandboxed run, and the controller did not re-run them. The fixes touched no Rust beyond 0005 and comments, so the risk is low, but it is not verified.
- A live host and a second station: a re-pair with an operator signed in, a removal arriving through SSE, the sync gate against a real host.
- The ≤3 s start-up probe window in a kiosk boot.

## (e) Owner questions — recommendations

1. **Lockout numbers.** Keep the operator rule (5 wrong PINs → 5 min). For the station, add escalation:
   - each consecutive station lockout within the quiet interval doubles (1 → 2 → 4 → 8 → max 15 min), resetting after the quiet interval;
   - and/or raise the office-side minimum PIN length to 6, which multiplies M1's example by 100.
     Without one of these, a patient insider gets about 600 guesses an hour. Also consider surfacing «станция заблокирована» to the office in 2a (audit/event), since today nobody learns of an attack.
2. **Maintenance exit for 1f2.**
   - Do not reuse an operator credential.
   - When the host is reachable, exit through the office sign-in (an administrator).
   - Offline, use a per-device maintenance code issued in the office «Устройства». It reaches the station as a hash (like badges, a PBKDF2 PHC), has its own lockout and its own row in `floor_sign_in_failures` (decide whether forget clears it, M3), and is never shown again after issue.
   - Name the exit in the audit when online.
3. **Inactivity timeout.** Keep 10 min (cloud parity). Make it a site setting in 2a: a busy line rarely idles, while a shared station may want 3–5 min.
4. **Zero-padding of personnel numbers.** Keep exact match (host parity; no padding). Ask the host/office to refuse a new number that differs from an existing one only by leading zeros («42» vs «042»), so the ambiguity never arises. That is a host rule, plan 2a or a small host task.
5. **`set_system_awake`.** Keep the display and system awake while the station app runs in kiosk mode. The operator idle lock is the security boundary, not the screen saver, and a sleeping PC stops the line's wedge input and printing.
6. **Stray product scans counted as badge guesses.** Recommend not counting (and not hashing) scans that are valid GS1 numeric keys: EAN-8/UPC-A/EAN-13/GTIN-14 or an 18-digit SSCC (optionally with the `00` AI) with a correct check digit. Have the office's `badgeCodeRule` refuse such codes as badges, so no real badge can collide. Until then the line has a cheap DoS (ten stray scans pause sign-in for a minute), and a fixed-mount scanner makes it accidental.
