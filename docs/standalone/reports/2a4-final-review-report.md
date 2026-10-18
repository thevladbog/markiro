# Plan 2a4 — final whole-part review (tasks 1–9)

Worktree `/tmp/claude/wt/2a4-shell`, branch `claude/2a4-shell`, base `16b41f435`, HEAD `c39e0c04c` (14 commits). Paths below are relative to `apps/standalone/` unless they start with `docs/` or `.github/`.

### Verdict

**WITH FIXES.** Critical 0, Important 1, Minor 16.

The integrity chain holds. Nothing in the shell or in the wrapper can turn an unknown print outcome into a retry-safe one. The data-loss rules of `device_forget` hold too: the count and the clear share one transaction, a set-aside never deletes, and only a corrupt database is ever moved. The IPC names, arguments, results, events and refusal codes match the plan's «Контракт для 2a5–2a7». What differs is listed in (c).

The one Important item is documentation. The text describing `host_request`'s `timeout` is wrong for limits under 2 s, which includes the 300 ms code check of plan 2a6. The rest is a small fix wave of cheap Rust and webview items plus carries.

---

## (a) Findings, most severe first

### Important

**I1. The docs say `timeout` only follows a connected request; for limits under 2 s that is false.**

- Where:
  - `AGENTS.md:964-968` («Network»: "A request that was connected and runs past the limit … answers `timeout`. A host that does not accept the connection within the client's own 2 s … is `unreachable` even with a limit").
  - `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md:949-951` (§17: «только для запроса, который уже соединился»).
  - `src-tauri/src/lib.rs:90-91` and `src/host/client.ts:70-72` ("running past it answers `timeout`", which is too absolute in the other direction).
  - The test name `src-tauri/tests/host_request_timeout.rs:87` `a_host_that_never_accepts_the_connection_is_unreachable_not_a_timeout`. Its silent listener _does_ accept TCP and never answers TLS. The name only holds because the limit there is 5 s.
- Scenario: `lost` (`src-tauri/src/host_client.rs:152-160`) answers `timeout` whenever the caller's `request.timeout(limit)` fires first. Connecting and the TLS handshake count, because reqwest's total timeout is not a connect error.
  - So with plan 2a6's 300 ms check, a host that is off, behind a firewall that drops packets, or stuck in TLS answers `timeout`, not `unreachable`.
  - Only a limit above 2 s lets the client's own connect limit fire first and answer `unreachable`.
  - The repository's own test `a_request_past_its_own_limit_fails_with_timeout` (`host_request_timeout.rs:61-81`) proves it: silent host, 300 ms, `Timeout`.
  - A closed port answers `unreachable` at once.
- Impact today: plan 2a6 treats `timeout` and `unreachable` the same (`2a6 plan:5449`), so no code is wrong. But this is the reference text plans 2a5–2a8 read, and its central sentence states the opposite of what the 300 ms caller gets.
- Fix (docs and one test name):
  - "`timeout` when the caller's limit ends the request first, connecting and the TLS handshake included; `unreachable` when the client's own 2 s connect limit ends it first, which only a limit above 2 s allows; a refused connection is `unreachable` at once."
  - Rename the test to `a_limit_above_the_clients_connect_limit_leaves_a_hung_handshake_unreachable`.

### Minor

**M1. The `.manage(...)` lines of `run()` are covered only by compilation** (queued 11; T8 m6).

- Where: `src-tauri/src/lib.rs:291` (scanner manager, in `setup`) and `:300-301` (lockdown and awake, on the builder).
- I verified a cheap structural test with a scratch file (`tests/zz_review_manage.rs`, removed afterwards; `git status` empty):
  - A mock app that called `manage_hardware(app.handle())` after `build()` answered `get_scanner_connections` → `{revision: 0, scanners: []}` and `set_system_awake(false)` → `null`.
  - The same app without it answered Tauri's «state not managed for field `state` on command `get_scanner_connections`…» and the same for `set_system_awake`.
  - A closure given to `mock_builder().setup(...)` did **not** run on the mock runtime: my first attempt failed for that reason. The shared function must therefore be called directly, not through `setup`.
- Fix: production commit `pub fn manage_state<R: Runtime>(app: &AppHandle<R>, dir: &Path) -> watch::Receiver<Option<Arc<HostLink>>>`.
  - It manages `DeviceState`, `LocalDbState`, `ConnectionState`, the scanner manager, `LockdownState` and `SystemAwakeState`, and returns the link.
  - `run()`'s `setup` calls it and then spawns `supervise`.
  - In `tests/ipc.rs`, `mock_app_with` and the lockdown mock stop managing these states themselves, because `Builder::manage` panics on a duplicate. A new IPC test calls `manage_state(app.handle(), tmp)` and asserts that `app.try_state::<T>()` is `Some` for all six types, plus the two answers above.

**M2. The COM path's `not_sent`/`outcome_unknown` split has no test** (T7 m2; mutant T7-M1 survives).

- Where: `src-tauri/src/printer.rs:240-243`. A refactor that makes a COM write failure `not_sent` would make a doubled label "safe" to reprint, and every suite would stay green.
- Fix together with M3: extract `fn send_all(w: &mut impl Write, bytes: &[u8]) -> Result<(), PrintFailure>` for TCP and COM after the open. Unit-test it with a fake writer:
  - an error on the first write;
  - an error after a partial write;
  - `Interrupted` then success;
  - `Ok(0)` → `WriteZero`;
  - a failing flush.

  Every case is `outcome_unknown` except the retried `Interrupted`.

**M3. Under Winsock the 5 s write limit may bound the whole label, and the doc says otherwise** (T7 m1).

- Where: `src-tauri/src/printer.rs:105-108` ("a write that moves some bytes starts the wait afresh") and `:228-229`.
- Scenario: a healthy but slow printer and a multi-MiB label can get `outcome_unknown` on Windows. That invites a reprint, which doubles the label. It is unverified on Windows.
- Fix: `send_all` writes in 64 KiB chunks, so each `send()` has its own 5 s on every OS, and the doc becomes true. Keep the large-label item in the manual list.

**M4. Name resolution has no time bound, and the doc says "at once"** (T7 m3).

- Where: `src-tauri/src/printer.rs:163-170`.
- Scenario: in an offline plant, a printer configured by name waits the Windows resolver (10 s or more) on every print. The answer is still a correct `not_sent`, but slow.
- Fix (the controller leans FIX):
  - Resolve on a helper thread and wait at most the connect budget (`recv_timeout`), then `not_sent`. The connect gets what is left of the budget. A leaked resolver thread ends by itself.
  - Add a `resolve_with` seam with a sleeping fake resolver to test it.
  - Correct the doc. At minimum, fix the doc and keep "prefer an IP address" in AGENTS.

**M5. No test pins that, without `timeoutMs`, the client's own 10 s request limit reads as `unreachable`.**

- My mutant MU1 drops `limit.is_some() &&` (`src-tauri/src/host_client.rs:155`). It **survived** `--lib`, `host_request_timeout` and `ipc`, all green.
- With the mutant, a connected request with no limit that runs past 10 s answers `timeout`. Stage 1 screens would then show «Хост не ответил вовремя» instead of «Нет связи с хостом», against the planner's decision.
- Fix (test only): in `host_request_timeout.rs`, call `send_within(.., None)` on `/v1/changes/stream` (headers arrive, the body never ends). Expect `Unreachable` after 10 s or more, under a 20 s `tokio::time::timeout`. It costs 10 s in a parallel suite. That suite's doc at `:151-152` already says "10 s, not waited for here".

**M6. A failed refresh keeping the stored name is untested** (queued 3; T3 mutant C survives).

- Fix (test only), in `tests/line.rs`:
  - `an_unreachable_host_leaves_the_line_alone` also asserts the status's and the file's `deviceName`.
  - `a_refresh_with_a_key_the_host_does_not_know_is_rejected` seeds `device_name: Some(..)` and asserts it is kept.
  - Then fix AGENTS «Device key» ("the test … checks the line only").

**M7. The webview does not reject a non-integer `timeoutMs`** (queued 1).

- Where: `src/host/client.ts:96`.
- `300.5` comes back as `unreachable` carrying Tauri's text. `NaN` or `Infinity` would serialize to `null`, so the request would silently run with no limit. That half is inferred from JSON and not run.
- Fix (webview production): throw `HostError({ kind: "transport", code: "invalid_request" })` before `call` when `timeoutMs !== undefined && !Number.isInteger(timeoutMs)`. Add a Vitest case for `300.5`, `NaN` and `Infinity`. Update AGENTS `:965-968` and spec §17 («Вебвью не проверяет…»).

**M8. Stale comments in production files** (queued 13 and 14; T8 m1).

- `src-tauri/src/power.rs:190`: «The app closing … lets the computer sleep». `App::run` exits through `process::exit`, so the state is never dropped at exit.
- `src-tauri/src/power/windows.rs:4`: «task 8» should be «tasks 6 and 7».
- `src-tauri/src/scanner.rs:9-12`: "never altered, merged or split … arrives whole or not at all". Noise merges into the next scan, and the first frame after an open may be a tail. AGENTS already says so.

**M9. Shell and webview shapes are pinned by two independent literals.**

- Where: `src/hardware/hardware.ts:45-62` and `src-tauri/src/scanner.rs:202-214`.
- Scenario: a field added to `ScannerSnapshot` in Rust updates the Rust literal. The strict `scannerSnapshotSchema` then drops every status event without a word (documented at AGENTS «Hardware»), and the setup screen freezes.
- Fix (test only), following `src-tauri/tests/fixtures/local-sql.json`:
  - A fixture `src-tauri/tests/fixtures/hardware-shapes.json` holding a snapshot with both statuses and a `UsbPrinter`.
  - A Rust unit test: `serde_json::to_value(sample) == fixture`.
  - A Vitest case: `scannerSnapshotSchema.parse` and `usbPrinterSchema.parse` of the same file.

**M10. Cyrillic is written as escapes in a Rust test, against the plan's «Русский текст в коде — буквами».**

- Where: `src-tauri/src/scanner/runtime_tests.rs:876,896,907,911`.
- Line 766 (`"\u{421}OM3"`, a deliberate homoglyph) is justified: keep it, with a comment.

**M11. Doc nits in production comments.** `src-tauri/src/lib.rs:90-91` (see I1). `src-tauri/src/host_client.rs` is fine.

**M12. A corrupt database with a non-corruption read error is counted as 0 (fail-open).**

- Where: `src-tauri/src/local_db.rs:541-544` (`Ok(false) | Err(_) => Ok(0)`).
- `outbox_exists` maps every error to `StatementFailed`, so a busy or I/O error on the read-only probe of a corrupt file reads as "nothing to send". The file is then moved without `keepUnsent`. Nothing is deleted, but the link is lost without the confirmation В7 asks for.
- Nothing is at risk before plan 2a5 adds `outbox`, and nothing else holds the file (single instance).
- Fix: keep the SQLite code, so that only `SQLITE_CORRUPT`/`SQLITE_NOTADB` count as 0 and anything else becomes `Err` → `unsent_facts` (confirmable). Reasoned, not run. CARRY to 2a5.

**M13. `print_bytes` has no overall deadline** (T7 owner question; the implementer's concern). A trickling printer, a COM port at 9600 baud or a blocking spooler keeps the webview's promise pending. 2a7 must bound it on the awaiting side and answer `outcome_unknown`. Documented. CARRY 2a7.

**M14. The one-way `device.json` change and the newer-migration rule are not in plan УСТ or its runbook** (seam 5).

- AGENTS and spec §17 say it. УСТ (П13 «обновление переустановкой») never says that installing an _older_ build over a newer one is unsupported.
- Consequences of such a downgrade: the older shell reads the new `device.json` as `config_unreadable`. Its forget answers `storage` while the database has a newer migration. The station is stuck until it is upgraded again.
- CARRY УСТ: refuse a downgrade in NSIS (version compare), or state it in the runbook. List `standalone-station.db.unreadable-*` in the data inventory (`%LOCALAPPDATA%\app.markiro.standalone`): those files keep unsent records and PIN/badge hashes, and uninstall must not delete them.

**M15. Spec section numbering will conflict at merge.**

- `claude/2a3-office` appends `## 16. Уточнения плана 2a3` at line 923, and this branch appends `## 17. Уточнения плана 2a4` at the same line.
- The text will conflict. Resolve it by keeping §16 then §17; no cross-reference uses the numbers.
- The plan still says «§16» at lines 14, 104, 157 and 6309. Record this in (c).

**M16. A forget racing a pairing.**

- Where: `device_forget` reads `state.status()` before taking the pairing lock (`lib.rs:171-176`).
- A forget started while unpaired (guard `Ignore`), with a claim that completes in between, would clear the new pairing's copies and then remove its `device.json`. No facts exist in that window.
- Only concurrent webview calls can cause it. Plan 2a5's screen must disable pairing and forget controls while either runs. CARRY 2a5 (note only).

### Checked and sound (no finding)

- **Integrity chain.**
  - `printBytes` never throws (`hardware.ts:164-180`). Encoding failure gives `invalid_payload` without a call. Any non-exact-code rejection, `Error` objects included, gives `outcome_unknown`.
  - Shell: `not_sent` before the first write, `outcome_unknown` from the first write on, on every path (`printer.rs:208-247`, `spooler.rs:79-116`). A dead send thread is `outcome_unknown` (`printer.rs:266-277`; my MU6 → `not_sent` was killed by `a_send_thread_that_dies_is_outcome_unknown`).
  - A completed connect is never retried on another address.
  - IPC refusals are bare codes everywhere except Tauri's own argument-deserialization text (documented). That text reads as `outcome_unknown`, the safe direction.
- **Data loss.**
  - Count and clear share one `BEGIN IMMEDIATE`.
  - `keepUnsent` empties only `Disposable` tables.
  - `Other` open failures answer `storage` even with `keepUnsent` (my MU5, «`keepUnsent` unlocks `Other`», was killed by `a_database_that_fails_to_open_for_another_reason_is_never_set_aside`).
  - A set-aside never deletes: it refuses a taken name and a split set, rolls back on failure and leaves traces on stderr.
  - The database is cleared or moved before `device.json` is removed.
- **Locks and threads.**
  - No lock is held across another subsystem: the scanner state lock covers only emits, the pairing lock only device I/O, and the set-aside mutex only the move.
  - `close_scanners` cancels workers, which exit within one 200 ms read, 10 ms gate poll or at once.
  - Managed state is never dropped at exit (`process::exit`). Windows closes handles and ports with the process (unverified).
  - The blocking pool is not at risk: one send at a time per address.
- **CI and manifests.**
  - `ci.yml` only adds `libudev-dev` to «Install Linux webkit and serial deps» of `standalone-rust`.
  - `Cargo.lock` gains exactly 79 lines: seven new packages (`io-kit-sys`, `libudev`, `libudev-sys`, `mach2`, `nix`, `serialport`, `unescaper`) and `serialport` in the shell's dependency list. No version moved.
  - No later commit touches a manifest, the lockfile, CI, `host`, `proto`, `apps/station`, `packages/*` or `package.json`.

---

## (b) TRIAGE

| #                      | Item                                                                                                      | Decision                                                   | Reason / group                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| q1                     | non-integer `timeoutMs` in `client.ts` (= T2 m1)                                                          | **FIX**                                                    | M7; webview production plus test; group W3                                                       |
| q2                     | one-way `device.json` (= T3 m1)                                                                           | **DOC** done (AGENTS «Device key», §17) + **CARRY УСТ**    | M14                                                                                              |
| q3                     | failed refresh keeps name (= T3 m2)                                                                       | **FIX**                                                    | M6; test only; W1                                                                                |
| q4                     | `.min(1)` on `deviceName` (= T3 m3)                                                                       | **CARRY** owner/2a5                                        | unreachable today; if ever needed, normalise in Rust                                             |
| q5                     | sender reads only the current pairing                                                                     | **CARRY 2a5**                                              | a requirement                                                                                    |
| q6                     | confirm control for `unsent_facts`                                                                        | **CARRY 2a5**                                              | plan 2a5 has it                                                                                  |
| q7                     | screen count uses the same predicate                                                                      | **CARRY 2a5**                                              | also handle "count unknown" (corrupt, uncountable outbox answers `unsent_facts` with no count)   |
| q8                     | window between clear and `device.json` removal                                                            | **DOC** done (`device_forget` doc, AGENTS) + **CARRY 2a5** | screen only with no open shift and the writer stopped                                            |
| q9                     | `Other` never set aside, even with `keepUnsent`                                                           | **CARRY owner**                                            | deliberate; a confirmed forget for it would be an extension                                      |
| q10                    | read-only probe may create `-shm`                                                                         | **DOC** done                                               | —                                                                                                |
| q11                    | `.manage` awake (= T6 m1, T8 m6)                                                                          | **FIX**                                                    | M1; production W2 plus test W1                                                                   |
| q12                    | Windows awake branch tolerant (= T6 m2)                                                                   | **DOC** done + **CARRY owner** Windows CI                  | optionally `println!` the outcome so `--nocapture` shows it                                      |
| q13                    | `power.rs:190` overclaim (= T6 m3)                                                                        | **FIX**                                                    | M8; W1 (test-module comment)                                                                     |
| q14                    | `power/windows.rs:4` stale reference (= T6 m4)                                                            | **FIX**                                                    | M8; W2                                                                                           |
| q15                    | awake lease survives reload (= T6 m5)                                                                     | **CARRY 2a7**                                              | `setSystemAwake(false)` at webview start                                                         |
| T2 I1                  | connect limit read as `timeout`                                                                           | done                                                       | 6c6be1836                                                                                        |
| T2 m2, m3              | test comment, `Unreachable` doc                                                                           | done                                                       | 094f969c1, 6c6be1836                                                                             |
| T4 m1                  | FK guard                                                                                                  | done                                                       | `no_table_has_a_foreign_key` (T5)                                                                |
| T4 m2                  | why `floor_sign_in_failures` is `Disposable`                                                              | **CARRY 2a5**                                              | 2a5 Task 1 fragment adds the comment                                                             |
| T4 m3                  | busy-checkpoint test                                                                                      | done                                                       | T5                                                                                               |
| T5 I1, m1, m2, m4, nit | corrupt-only set-aside, race margin, mutex test, traces                                                   | done                                                       | 62ad27674, 6205e2a9a, dd352f166                                                                  |
| T5 m3                  | window                                                                                                    | = q8                                                       |                                                                                                  |
| T7 m1                  | Winsock write limit                                                                                       | **FIX**                                                    | M3; chunked `send_all`; W2                                                                       |
| T7 m2                  | COM classification test                                                                                   | **FIX**                                                    | M2; W1 plus W2                                                                                   |
| T7 m3                  | name resolution bound                                                                                     | **FIX**                                                    | M4; W2 (bounded resolve plus doc); fallback: doc only                                            |
| T7 m4                  | silent first address takes the budget                                                                     | **DOC** done (AGENTS) / **DROP** code                      | rare on plant LANs                                                                               |
| T7 m5                  | `EnumPrintersW` race                                                                                      | **CARRY** Windows manual round                             | Windows-only code with no runtime test; doc'd                                                    |
| T7 m6                  | malformed IPC gets Tauri text                                                                             | **DOC** done / **DROP**                                    | the wrapper always sends both; safe direction                                                    |
| T7 m7                  | `invalid_payload` > 32 MiB                                                                                | done (AGENTS, §17)                                         | record in (c)                                                                                    |
| T7 m8                  | load-sensitive exact count                                                                                | **DROP**                                                   | 4 runs at load 60–90 green, plus the implementer's 24 busy loops; widening weakens the assertion |
| T7 m9                  | partial spooler job (`AbortPrinter`)                                                                      | **CARRY owner**                                            |                                                                                                  |
| T7 owner Qs            | TCP success is not a receipt, reset prefix, over-conservative classifications, deadline, COM flow control | **CARRY owner / 2a7 / `@markiro/domain`**                  | M13                                                                                              |
| T8 m1                  | scanner doc overclaim                                                                                     | **FIX**                                                    | M8; W2                                                                                           |
| T8 m2                  | inter-byte discard, oversize counter                                                                      | **CARRY owner / 2a7**                                      | behaviour beyond the spec                                                                        |
| T8 m3                  | lossy UTF-8 means U+FFFD is unreadable                                                                    | **DOC** done + **CARRY 2a5/2a6/2a7**                       |                                                                                                  |
| T8 m4                  | port syntax, `\\.\COM3`                                                                                   | **CARRY owner**                                            | hardening                                                                                        |
| T8 m5                  | frame cut by a lost port leaves no trace                                                                  | **CARRY 2a7** (diagnostics, with T8 m2)                    | doc'd                                                                                            |
| T8 note                | cloud `absorb_chunk` defect in `apps/station`                                                             | **CARRY owner**                                            | separate cloud task                                                                              |
| new                    | I1 timeout doc                                                                                            | **FIX**                                                    | W4 docs plus W1 test rename                                                                      |
| new                    | M5 no-limit 10 s test                                                                                     | **FIX**                                                    | W1                                                                                               |
| new                    | M9 shape fixture                                                                                          | **FIX**                                                    | W1 (test only)                                                                                   |
| new                    | M10 Cyrillic escapes                                                                                      | **FIX**                                                    | W1                                                                                               |
| new                    | M12 fail-open probe                                                                                       | **CARRY 2a5**                                              | before `outbox` exists nothing is at risk                                                        |
| new                    | M14 downgrade                                                                                             | **CARRY УСТ**                                              |                                                                                                  |
| new                    | M15 §16/§17                                                                                               | **DOC** (deviations, merge note)                           |                                                                                                  |
| new                    | M16 forget/pair race                                                                                      | **CARRY 2a5**                                              | UI note                                                                                          |

**Proposed wave (ONE fixer, four commits, tests apart from production):**

- **W1 `test(standalone)`**:
  - the `manage_state` structural IPC test (RED: it does not compile until W2);
  - `send_all` unit tests with a fake writer;
  - the no-limit 10 s → `unreachable` test;
  - the name kept after a failed refresh (two tests);
  - the hardware shape fixture (Rust plus Vitest);
  - the test rename (I1);
  - the `power.rs:190` comment;
  - Cyrillic letters in `runtime_tests.rs`.
- **W2 `fix(standalone)` Rust production**:
  - `manage_state` used by `run()`, with the duplicate `.manage` calls dropped from the mocks (they belong to W1's test file; put them in W2 if the RED order needs it);
  - chunked `send_all` for TCP and COM, with the `Timeouts` doc corrected;
  - bounded name resolution and its doc;
  - `power/windows.rs:4`, `scanner.rs:9-12`, `lib.rs:90-91`.
- **W3 `fix(standalone)` webview**: integer check of `timeoutMs` in `client.ts`, with its Vitest case. Put the test in W1 if a strict tests-first order is wanted.
- **W4 `docs(standalone)`**:
  - AGENTS «Network» (I1, q1);
  - «Hardware» and «Verification»: the `.manage` gap closed, so "three things" becomes two; chunked writes; the resolution bound;
  - «Device key» (q3);
  - spec §17, the same items;
  - `2a4-minors.md`.
- Gates:
  - the shell crate outside the sandbox;
  - `cargo fmt --check` and `clippy -D warnings`;
  - the Windows probe (recipe below) for `printer.rs`;
  - focused Vitest, typecheck and lint;
  - prettier;
  - `git diff --check`;
  - the `\u04` grep.

---

## (c) DEVIATIONS TO RECORD (draft for «Отклонения при исполнении»)

<!-- prettier-ignore -->
```markdown
- Задача 1 — как в плане: `serialport =4.9.0`, `base64` для всех ОС, восемь признаков `windows-sys` (с комментариями в `Cargo.toml`), `libudev-dev` в `standalone-rust`; дифф `Cargo.lock` +79 строк — ровно семь пакетов (`io-kit-sys`, `libudev`, `libudev-sys`, `mach2`, `nix`, `serialport`, `unescaper`), ни одна версия не сдвинулась.
- Задача 2. Исправление ревью: собственный предел клиента на соединение (2 с вместе с TLS) — `unreachable` и при `timeoutMs`, если сработал раньше предела вызывающего (`!error.is_connect()`, 6c6be1836); при пределе меньше 2 с молчащий или недоступный хост — `timeout`, отказ в соединении — сразу `unreachable`. Добавлены тесты: тело без конца — `timeout`; предел 5000 мс против молчащего хоста — `unreachable`; границы `timeoutMs` литералами; литералы кода и текста `timeout` в `test/errors.test.ts`. `host_request_timeout` — 5 тестов (план 3).
- Задача 3. Добавлены четыре теста: обрезка имени на обоих путях подключения, старый `device.json` через `DeviceState`, переименование через `device_select_line`.
- Задача 4. Закрытый шов `clear_classed(classes, guard)` и его модульный тест (все записи `TABLE_CLASSES` — `Disposable`, иначе мутант «стирать все классы» не ловится); строки `ref_org`/`ref_site` в тесте очистки.
- Задача 5. Подсчёт неотправленного — внутри `clear_classed`. Тест прав доступа плана разделён (база в каталоге только для чтения, `device.json` — в записываемом). Добавлены: отказ занятому имени переноса, тест `no_table_has_a_foreign_key` (внешних ключей нет вообще, строже «между классами»), тест занятой контрольной точки. Исправления ревью (62ad27674, 6205e2a9a, dd352f166): в сторону переносится только повреждённая база (`OpenFailure::Corrupt`: `SQLITE_CORRUPT`/`SQLITE_NOTADB`, в том числе из миграции); база, не открывшаяся по иной причине, — `storage` и с `keepUnsent`; повреждённая читается только для чтения и проходит тот же охранник (`outbox`, которую не удалось сосчитать, — `unsent_facts`, тогда как в открытой базе — `storage`); тест гонки — `multi_thread`, 1000 мс; тест двух одновременных переносов; следы в stderr; разорванный набор (`set_is_split`) отвергается.
- Задача 6. `PowerRequestState::answer`/`is_awake`, публичный `SystemAwakeState::is_awake`, тесты сброса состояния и голого кода отказа; `SystemAwakeState` управляется в `mock_app_with`.
- Задача 7. Порядок вызовов спулера — обобщённый `print_raw_via<S: Spooler>` с записывающей подделкой на всех ОС; `MAX_PAYLOAD_BYTES` 32 МиБ — `invalid_payload` значит и «больше 32 МиБ»; `invalid_target` — и для имени длиннее 253/256 символов; соединение перебирает все адреса имени в одном бюджете 5 с; швы `run_blocking`/`list_with`. Неверная форма вызова (нет `target`, нагрузка не строкой) отклоняется текстом Tauri, вебвью читает её как `outcome_unknown`.
- Задача 8. `Framer` вместо `split_lines`/`absorb_chunk`: кадр длиннее 4096 байт отбрасывается целиком до терминатора (облачная копия отдаёт хвост как скан; `apps/station` не тронут); `MAX_SCANNERS` 32, имя порта до 256 символов, управляющие символы отвергаются; `configure_scanners` принимает `Option<Value>` (пропущенный аргумент — `invalid_scanners`); `list_serial_ports` — асинхронная команда; шов `emit_sink`; каждый `configure_scanners` публикует снимок, даже неизменный.
- Задача 9. Раздел спецификации — §17, не §16: §16 занимает план 2a3 (ветка `claude/2a3-office`, та же точка вставки — при слиянии оставить оба по порядку); в тексте плана «§16» в строках 14, 104, 157 и 6309. Фрагменты документов переписаны по итоговому коду. Обёртка сама отвечает `invalid_payload` на байты, которые не удалось закодировать; сбой подписки — `HardwareError("unknown")`; добавлен `test/hardware-tauri.test.ts` (умолчания `invoke`/`listen`). `createTauriHardware(call?, subscribe?)` принимает внедрение. Пункты Rust из ревью задач 6 и 8 оставлены финальной волне.
- Счёт (итог ветки): оболочка — 240 тестов в 13 целях (библиотека 120, `claim` 5, `connection` 6, `device` 15, `host_probe` 2, `host_probe_proxy` 1, `host_request_timeout` 5, `ipc` 25, `line` 16, `local_db` 26, `lockdown` 4, `printer` 15; план — 162); Vitest — 69 файлов, 1871 тест по отчёту задачи 9 (дерево уже несло 1754; план — 68/1776).
- Код под `cfg(windows)` (`printer.rs`, `printer/spooler.rs`, `power.rs`, `power/windows.rs`, `scanner.rs`, `scanner/runtime.rs`, `lockdown.rs` с модульными тестами) проверен `cargo check` и `cargo clippy --tests -D warnings` под `x86_64-pc-windows-msvc` крейтом-пробником вне репозитория; оболочка целиком под Windows не собиралась (`aws-lc-sys` требует Windows SDK).
- (Итоговое ревью) финальная волна: <заполнить по исполнению — W1–W4>.
```

---

## (d) What could not be verified

- **Windows, all of it.**
  - `standalone-windows-build` has never run on this code.
  - The full shell crate for Windows (`lib.rs`, `local_db`, `device`, DPAPI in `secret_store`, `tls`), because `aws-lc-sys` needs the Windows SDK.
  - `cargo test --workspace` on `windows-latest`, including the tolerant awake branch of `tests/ipc.rs`.
  - At runtime:
    - RAW spooler jobs;
    - a stopped spooler → `spooler_unavailable`;
    - `EnumPrintersW` with connections;
    - `PowerCreateRequest`/`powercfg /requests`;
    - COM printers and scanners (200 ms timeout, unplugging, `available_ports`, `serial_unavailable`);
    - Winsock `SO_SNDTIMEO`;
    - the rename of a set-aside under locks and antivirus;
    - WebView2 event delivery;
    - the two `.manage` lines until M1 lands.
  - My probe is type-checking only: `/tmp/claude/rev-2a4-final/probe`, symlinks to the real modules, `#![deny(warnings)]`, windows-sys 0.61.2 with Task 1's features, plus tauri, serialport and base64. It covers `printer`, `spooler`, `power`, `power/windows`, `scanner`, `scanner/runtime` and `lockdown`. `cargo check` and `cargo clippy --tests -D warnings` for `x86_64-pc-windows-msvc` both exit 0.
- **Real hardware:**
  - a Zebra or TSC over TCP, COM and USB;
  - paused or out-of-paper printers (TCP success is not a receipt);
  - real COM scanners;
  - DNS behaviour in an offline plant.
- **Inferred only:**
  - `NaN`/`Infinity` `timeoutMs` through Tauri;
  - I1's dead-host case. Reasoned from reqwest's total-timeout error, with the silent-handshake case proven by the existing test; a SYN-blackholed host was not run.
  - M12's busy probe.
- **Full Vitest suite.** Not re-run: the machine load was 60–90. Task 9 reports 13 load timeouts in unrelated React files, green with larger timeouts. I ran the 5 relevant files.

---

## (e) What later plans must know

**Plan 2a5:**

- **The sender.** The fact sender reads only the current pairing's `outbox` rows (q5). Rows kept by `keepUnsent` are never sent, and they inflate the `AnyPairing` count after a later `config_unreadable`.
- **The forget screen:**
  - the confirm control calls `forget({ keepUnsent: true })`;
  - the count comes from the same predicate as the shell's;
  - it handles "count unknown": a corrupt database whose outbox cannot be counted answers `unsent_facts`, while in an open database the same case answers `storage`;
  - it is offered only with no open shift and the writer stopped;
  - pairing and forget controls are disabled while either runs (M16).
- **Fragments built on plan text.** The 2a5 fragments were built on plan 2a4's text without the fix rounds. When replacing the scratch `OUTBOX`, the corrupt-database tests also create outboxes in raw files: `ipc.rs` `a_corrupt_database_*` and `with_an_unreadable_pairing_a_corrupt_*`, and `local_db.rs` `a_database_that_did_not_open_is_counted_without_being_changed`.
- **Other inherited items:**
  - decide M12 when `outbox` exists;
  - the `floor_sign_in_failures` comment (2a5 Task 1);
  - `deviceName` is nullable; status bar fallback.

**Plan 2a6:**

- A 300 ms check gets `timeout` for a dead, filtered or hung host and `unreachable` for a refused port (I1). Treat both as "no answer" (the plan already does).
- A scan containing U+FFFD is unreadable, never a badge.
- Scans emitted during a webview reload are lost.
- The first frame after a port opens may be a tail, and noise merges into the next scan.
- `\\.\COM3` and `COM3` are two entries, so take names from `list_serial_ports`.
- If W3 is not done, pass integer literals only.

**Plan 2a7:**

- **Every send:**
  - bound `printBytes` on the awaiting side, with timeout → `outcome_unknown` (M13);
  - one send at a time per address;
  - record "print started" before calling, because a webview reload mid-print loses the answer, and recovery must read that as `outcome_unknown`.
- **Power:** call `setSystemAwake(false)` at webview start.
- **Printer settings:**
  - prefer IP addresses (until M4);
  - `invalid_payload` also means > 32 MiB;
  - COM printers use no flow control.
- **Owner questions to settle:**
  - TCP success is not a receipt (status query `~HS`/TSPL is a domain decision);
  - `AbortPrinter` after a failed write;
  - a reset prefix per label;
  - scanner diagnostics (oversize counter, inter-byte discard, cut-frame trace);
  - `workstation_settings` as `TableClass::Workstation`.

**УСТ:**

- A downgrade is unsupported: the installer refuses it or the runbook says so (M14).
- The data inventory names `standalone-station.db.unreadable-*` (unsent records and hashes; never deleted).
- The manual Windows list in AGENTS «Verification» is the acceptance list for the pilot PCs.

**Owner:**

- q9: a confirmed forget for a non-corrupt unopened database;
- T7 m9 and the receipt questions;
- T8 m2/m4;
- the cloud `absorb_chunk` defect (`apps/station/src-tauri/src/scanner/runtime.rs`) as a separate task;
- forward compatibility of `device.json` (`deny_unknown_fields`).

---

## Evidence

- **Shell crate, outside the sandbox:** `cargo test --offline --locked -p markiro-standalone --no-fail-fast` exit 0. Lib 120, claim 5, connection 6, device 15, host_probe 2, host_probe_proxy 1, host_request_timeout 5, ipc 25, line 16, local_db 26, lockdown 4, printer 15, no skip lines (`/tmp/claude/rev-2a4-final/full1.txt`).
- **Flakiness:** `--lib --test printer --test local_db --test ipc --test host_request_timeout` three times more at load average 76–92, all green (`rep1..3.txt`).
- **Static checks:**
  - `cargo fmt --check` 0;
  - `cargo clippy --all-targets -D warnings` 0;
  - Windows probe check and clippy 0 (`probe-check.txt`, `probe-clippy.txt`);
  - `pnpm … typecheck` 0;
  - prettier clean on the 7 changed TS/MD files;
  - Vitest `hardware`, `hardware-tauri`, `client`, `device`, `errors`: 5 files, 174 passed;
  - `git diff --check 16b41f435 HEAD` clean;
  - the `\u04` grep finds only `src/host/pairing-code.ts:66`;
  - each of the 14 commits has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **My mutants:** one line each. The file was copied to `/tmp/claude/rev-2a4-final/orig/` first and restored after each run, with `cmp` silent and sha256 unchanged every time.

  | #   | Mutant                                                    | Result                                                                          |
  | --- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
  | MU1 | `host_client.rs:155` drop `limit.is_some() &&`            | **SURVIVED** (M5)                                                               |
  | MU2 | `printer.rs:192` each address gets the full budget        | killed: `the_addresses_share_one_connect_timeout`                               |
  | MU3 | `scanner/runtime.rs:177` scans from a stale worker id     | killed: `removal_suppresses_delayed_read_and_replacement_waits_for_handle_drop` |
  | MU4 | `hardware.ts:194` `<=` → `<`                              | killed: `watchScanners > keeps only newer snapshots…`                           |
  | MU5 | `lib.rs:194` `keepUnsent` unlocks an `Other` open failure | killed: `a_database_that_fails_to_open_for_another_reason_is_never_set_aside`   |
  | MU6 | `printer.rs:273` dead send thread → `not_sent`            | killed: `a_send_thread_that_dies_is_outcome_unknown`                            |

  sha256 after restore: `host_client.rs` eccb1b4c…, `printer.rs` fb4558c8…, `runtime.rs` 17126783…, `lib.rs` 83439ab5…, `hardware.ts` b7402484….

- **Structural-test probe:** `tests/zz_review_manage.rs` (scratch, removed) passed as described in M1.
- `git -C /tmp/claude/wt/2a4-shell status --short` is empty at the end.
