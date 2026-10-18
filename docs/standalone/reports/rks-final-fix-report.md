# РК-С final fix wave — report

Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `f19f855ba`. Six commits, each with
exactly one `Co-Authored-By: Claude Opus 5.5` line; explicit `git add`; tree clean afterwards.

| #   | Commit      | Subject                                                                                                                    |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `27124981d` | fix(standalone): the outbox waits for the link's online status, so a restored host's epoch is known before any record goes |
| 2   | `c8087d83d` | fix(standalone): a connection whose hello cannot be read does not come online                                              |
| 3   | `70d2a02cf` | feat(standalone): the restore obligation keeps which blocks the host refused and why                                       |
| 4   | `71c589db0` | fix(standalone): the stuck line counts from the reconciliation, not from a reopened record's creation                      |
| 5   | `4f4c14d4a` | feat(standalone): forgetting a pairing that still owes a restored host its blocks says so first                            |
| 6   | `4a2fbb583` | docs(standalone): РК-С final wave in the runbook, AGENTS and the pilot spec                                                |

21 files, +890 / −184. `host/`, `proto/`, manifests, lockfile and the plan document untouched.

## 1. I-1 — the outbox waits for `online` (`src/app/host-link.ts`, `test/host-link-restore.test.ts`)

- `factSender` returns without a failure unless the link's latest status is `online`
  (`if (!online && !watchFailed) return;`, after the `factsHeld` gate, before `noteEpoch`).
- `watchFailed` is set only in `watch`'s rejection handler: no status will ever come, so the outbox
  goes as before.
- Going online sends the outbox: `if ((watching && !wasOnline) || (factFailures > 0 && factRetry === null)) factSender.trigger();`.
  `watching` (set when `watch` resolved) keeps the status delivered inside `watch` from triggering a
  second run besides the `everything()` that follows it — without it a failed first send was
  retried at once (15 `host-link-facts` tests failed on that draft; that is mutant F4 below).
- RED (`/tmp/claude/impl-rks-fw/c1-red.txt`): the reviewer's scenario reproduced exactly:
  `AssertionError: changes 0, facts, blocks, blocks answered, changes 0, facts: expected 1 to be greater than 3`;
  the local-write-while-connecting test sent 1 time. GREEN: 23/23 in the file; the six link/app suites
  406/406.
- Tests added (4): facts after `blocks answered` with `connecting` first; a local write while
  `connecting` and while `offline` sends nothing and goes once `Online` arrives (no revision);
  the `watch`-failure path still sends; a repeated online status does not knock before the retry's
  wait. No existing `host-link-facts` test needed sending while not online (all start `ONLINE`).

## 2. I-2 — a failed `hello` read ends the attempt (`src-tauri/src/connection.rs`, `src-tauri/tests/connection.rs`)

- `restore_epoch` → `Result<Option<String>, LinkError>`; `follow` returns `(error, false)` on `Err`
  before opening the stream (backoff, `Offline` with the error).
- Mapping: transport failure → `request_error` (so a changed certificate is still
  `certificate_mismatch`, now detected at the `hello` read; `a_rejected_key_and_a_changed_certificate_are_reported`
  still passes); non-200, no body, `classify_hello` error (foreign product, incompatible protocol,
  unreadable epoch) → `stream_refused`. No new wire code, so no webview/i18n contract change.
- Old hosts: a 200 without `restoreEpoch` → `Ok(None)` (`serde(default)`); lib test over the real
  fixtures `hello.json` (no field) and `hello-future.json` (later protocol, extra fields); the real
  never-restored host in `a_paired_device_comes_online_and_hears_every_revision` still comes online.
- Integration test `a_host_whose_hello_does_not_read_keeps_the_link_offline`: the host's
  `site.restore_epoch` set to `X'FF'` (not UTF-8; `7` was decoded leniently by sqlx), so `hello` 500s
  while the stream and key are fine. RED on the base `connection.rs`: no `Offline` within 10 s (it
  came online). GREEN: `Offline` with `stream_refused`, never `Online`, ≥ 2 more attempts.
- Focused: `--lib connection` 14 passed (was 13), `--test connection` (unsandboxed) 9 passed (was 8).
- Behaviour note: a host that becomes protocol-incompatible after pairing now stays offline with
  `stream_refused` instead of opening the stream.

## 3. m2 + m14 — refused-block codes in `0009` (shell migration, `restore-reconcile.ts`, tests)

- Precondition checked: `0009_restore_epochs.sql` exists only in `91a49c1f4` (on the unpushed
  `claude/floor-2a7`, no remote branch, no tag) and in the scratch commit `7c10393c9` (in no branch);
  no standalone release tags exist. So `0009` was edited in place, not made `0010`.
- Column `refused_blocks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(refused_blocks))`.
  `NOTE_SQL` resets it with `refused`; `SETTLE_SQL` writes `[{id, code}]` in send order;
  `STATUS_SQL` reads it; `readRestoreStatus` returns `refusedBlocks` (Zod-parsed). Nothing new on
  screen (`FloorStatusBar` only uses `due`/`refused`).
- Pins: `test/floor-schema.test.ts` (column list, a new JSON-list rule test; plan pins unchanged in
  shape, texts re-agreed) and `src-tauri/tests/local_db.rs` (`RESTORE_STATUS`/`RESTORE_SETTLE`
  texts; the 0008→0009 upgrade test asserts `refused 0, refused_blocks "[]"` and that `'['` is
  refused; its doc no longer claims a shift — the reviewer's m14).
- `restore-reconcile.test.ts`: every `readRestoreStatus` assertion now pins `refusedBlocks` (with the
  actual codes/ids where refused), plus "the same epoch noted again keeps the codes".
- RED: 8 failing (6 in `restore-reconcile`, 2 in `floor-schema`), then the text-agreement test until
  the Rust consts were updated. GREEN: 59/59; `--test local_db` 29/29.

## 4. m1 — stuck line from the reconciliation (`src/floor/outbox-status.ts`)

- New `RECONCILED_AT_SQL` read in `readDeliveryStuck` (parallel with `HEAD_RECORD_SQL`, which is
  unchanged): `waitedMs` counts from `max(created_at, reconciled_at)`; `sinceLastAttemptMs` is `null`
  when `sent_at < reconciled_at`. Pairing-scoped; an owed obligation (`reconciled_at NULL`) clamps
  nothing. `attempts` is left as the record's total (not asked; noted below).
- The new read is pinned on both SQLites (floor-schema restore plan loop and text-agreement list,
  now 7 statements; `local_db.rs` `RESTORE_RECONCILED_AT`, the reads array 82 → 83).
- Tests (3) in `test/floor-outbox-status.test.ts`. RED: 1 failing (the reconcile case); GREEN 13/13.

## 5. m3 — forget warns while blocks are owed (`App.tsx`, `screens.tsx`, `ru.json`, `app.test.tsx`)

- Before `deviceApi.forget` the webview asks `restoreDue` for the paired pairing; owed → the
  device-rejected / other-host screen shows `shell.restoreOwed.body` and a destructive
  «Сбросить, не вернув блоки»; only that confirms (`forget(false, true)`). The unsent question
  (`unsent_facts`) comes after as before (`forget(true, true)` skips the owed check). A failed read
  does not trap the device (`.catch(() => false)`); the warning is bound to the screen it was asked on
  (like the unsent count) and cleared before the forget goes. `config_error` has no pairing, so no
  check.
- New ru.json keys: `shell.restoreOwed.body`, `shell.restoreOwed.confirm`; duplicate-key script
  (`object_pairs_hook`): none.
- Tests (5). RED: 2 failing (timeouts finding the warning). GREEN: `app.test.tsx` 151/151.

## 6. Docs (runbook, AGENTS, spec §24, `blocksNote` + its pin, `BackupsPage` comment, `protocol.ts` doc)

- m4 runbook §4 stale «оно в плане 2a8» → retention is there and a restore resends that window.
- m5 «Вернула» = the host answered the first part, even refusing all of it; refusals only on the
  station's bar — `ru.json` `blocksNote` + `test/backups-page.test.tsx` pin, `BackupsPage.tsx` doc
  comment, runbook check 5 and §8, AGENTS «Left open», §24.
- m6 check 5: a host error that never resolves → tell the developer; codes `block_overlap`,
  `block_mismatch`, `prefix_unknown`, `range_invalid`; where the codes are kept.
- m8 + owner-requested sentence: check 4 — a station paired after the copy loses on ANY restore,
  same PC included, what §6 lists; take its numbers before re-pairing; SSCC safe only if the
  previous database was read, else check 1 mandatory. Also in AGENTS (I1 paragraph) and §24.
  Nothing else about I1 changed (owner decision still open).
- m9 AGENTS «item 9, second run» → «third run».
- m10 runbook §6 bullet now quotes the real `shell.unsent.body` and «Сбросить всё равно».
- m11 check 4 and §8: records of a shift closed after the copy are refused for good.
- m12 open-shift wording (runbook §6, AGENTS, §24).
- m13 the refused line stays until the next restore (check 5, §8, AGENTS, §24).
- I-2 docs: AGENTS «Connection to the host», §24 «Где станция берёт эпоху», runbook check 5's last
  paragraph rewritten; I-1 in AGENTS, §24 «Обязательство», runbook §5 step 8.
- «Left open» / «Не сделано»: removed the failed-`hello` window, codes, forget and stuck-line items;
  added the persistent host error on the blocks and the closed-shift rejections; §24 gains
  «Сброс подключения при долге» and «Строка «ждёт отправки»».
- `src/host/protocol.ts` `restoreEpoch` doc no longer says "absent when that read failed".
- Not edited: the plan document's «Перенесено» 4 (the rules forbid editing the plan; it still says
  the failed read does not stop the stream — the controller should record the deviation).

## Mutants (harness `/tmp/claude/impl-rks-fw/mut.py`, log `/tmp/claude/impl-rks-fw/mut/mutants.txt`)

Each: copy to `/tmp/claude/impl-rks-fw/mut/before-<id>`, mutate, run, copy back, `filecmp` + SHA-256
equal (`restored=True` for all); `.rs`/`.sql` touched after restore, and the focused cargo targets
were re-run green after the last Rust/SQL restore.

| ID  | Mutant (one line unless noted)                                         | Result                | Killed by (first)                                                             |
| --- | ---------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| F1  | drop the online gate                                                   | KILLED                | sends no record until the link is online… ; keeps a local write while…        |
| F2  | gate on `state !== "offline"` (3 small edits: a scratch `offlineSeen`) | KILLED                | same two                                                                      |
| F3  | no trigger on going online (`false && !wasOnline`)                     | KILLED                | keeps a local write while connecting or offline…                              |
| F4  | trigger also before `watch` resolved (drop `watching &&`)              | KILLED                | 15 `host-link-facts` tests (double knock)                                     |
| F5  | trigger on every online status (`watching                              |                       | `)                                                                            | KILLED | does not knock again on a repeated online status… |
| F6  | no `watch`-failure exception                                           | KILLED                | still sends when the shell's link cannot be watched                           |
| R1  | failed `hello` read → `None`, stream opens (fail-open)                 | KILLED (unsandboxed)  | `a_host_whose_hello_does_not_read_keeps_the_link_offline`                     |
| R2  | non-200 → `Ok(None)`                                                   | KILLED                | `the_epoch_comes_only_from_a_hello_that_reads`                                |
| R3  | no body → `Ok(None)`                                                   | KILLED                | same                                                                          |
| R4  | unreadable/foreign → `Ok(None)`                                        | KILLED                | same                                                                          |
| R5  | every transport error → `Unreachable`                                  | KILLED (unsandboxed)  | `a_rejected_key_and_a_changed_certificate_are_reported`                       |
| R6  | epoch required (old host fails)                                        | KILLED                | `…predates_restores_reads_without_an_epoch`, `the_epoch_comes_only…`          |
| C1  | `NOTE_SQL` keeps `refused_blocks`                                      | KILLED                | starts over with a later epoch…                                               |
| C2  | settle writes `"[]"`                                                   | KILLED                | stops using every block the host refused… (+3)                                |
| C3  | `readRestoreStatus` returns `[]`                                       | KILLED                | same (+3)                                                                     |
| C4  | code not kept (`code: null`)                                           | KILLED                | same (+3)                                                                     |
| C5  | drop `CHECK (json_valid…)` — Node                                      | KILLED                | keeps the refused blocks and their codes as a JSON list…                      |
| C5r | same — shell SQLite                                                    | KILLED                | `migration_0009_keeps_the_rows_of_a_database_of_0008`                         |
| C6  | column nullable — Node                                                 | KILLED                | fixes every column… ; keeps the refused blocks…                               |
| C7  | base migration (no column) — shell                                     | KILLED                | `migration_0009…`, `the_floors_repeating_reads_search_an_index`               |
| D1  | no wait clamp                                                          | KILLED                | counts from the reconciliation after a restore…                               |
| D2  | send before the reconcile counts                                       | KILLED                | same                                                                          |
| D3  | always from the reconcile (no `max`)                                   | KILLED                | counts a record written after the reconciliation…                             |
| D4  | a send after the reconcile dropped                                     | KILLED                | counts from the reconciliation…                                               |
| D5  | read not pairing-scoped (`OR`)                                         | KILLED                | is not clamped by an obligation still owed, nor by another pairing's…         |
| E1  | never warn                                                             | KILLED                | warns before it forgets… (+2)                                                 |
| E2  | owed confirm asks again                                                | KILLED                | warns before it forgets… ; asks about the blocks first…                       |
| E3  | unsent confirm re-asks the blocks                                      | KILLED                | asks about the blocks first and about the records…                            |
| E4  | failed read traps (`catch → true`)                                     | KILLED                | forgets at once when the restore is settled, or the obligation cannot be read |
| E5  | warning not bound to its screen                                        | KILLED                | does not carry the warning about the blocks over…                             |
| E6  | warning not cleared before the forget                                  | KILLED                | asks about the blocks first…                                                  |
| E7  | other-host screen without the notice                                   | SURVIVED, then KILLED | added "warns the same on the screen of another host…"                         |

E7 was a real gap (first two runs: the new test did not exist / `-t` filter missed it); the added
test kills it. The redundant `keepUnsent ||` in the owed check was removed rather than left as an
unkillable guard (`confirmRepair` already passes `blocksAnswered = true`).

## Gates

- typecheck, lint, build (webview, final rebuild before cargo): 0.
- Live prettier gate: scratch `apps/standalone/src/zz.ts` and `docs/runbooks/zz.md` → `[warn]`, exit 1,
  then deleted; changed files of every commit → «All matched files use Prettier code style!».
- Verbose runs, stderr 0 bytes: c1 (2 files, 49), c3 (5 files, 183), c4 (3 files, 93), c5
  (`app.test.tsx`, 151), c6 (2 files, 49).
- Delayed-`setImmediate` stand (3 ms; scratch files deleted, `git status` clean): host-link
  restore+facts 49/49, floor-status-bar+outbox-status 60/60, app 151/151, backups-page 43/43.
- Full Vitest `--testTimeout=60000 --hookTimeout=60000`: **148 files, 4607 passed**, stderr 0 bytes
  (before: 4594; +13 = 4 host-link-restore, 1 floor-schema, 3 floor-outbox-status, 5 app). Load ~125.
- `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto -p markiro-standalone
--all-targets` 0 warnings.
- Focused cargo: `--lib connection` 14, `--test connection` 9 (unsandboxed), `--test local_db` 29.
- Final full `cargo test --workspace --offline --locked` (unsandboxed): **71 `test result` lines,
  1124 passed, 0 failed** (before 1122; +2).
- Both parity tests green: Node 3.53 (`floor-schema` «serve the reconciliation…» and «are pinned on
  the shell's SQLite with the reconciliation's own statements») and shell 3.46
  (`the_floors_repeating_reads_search_an_index`).
- `git diff --check f19f855ba..HEAD` clean; `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`;
  `git status --short` empty.

## Concerns

1. The plan's «Перенесено» 4 still describes the failed-`hello` behaviour as accepted; the plan is
   off-limits to me — record the deviation (I-2 implemented) in «Отклонения при исполнении».
2. A host that becomes protocol-incompatible after pairing now keeps the link offline
   (`stream_refused`) instead of opening the stream; and a certificate change is now reported from
   the `hello` read (same code).
3. The stuck line keeps the record's total `attempts` after a reconcile (the pre-restore send
   counts in «попыток отправки»); only the wait and the last attempt were clamped, as asked.
4. The outbox still goes without a status when `watch` itself failed (kept deliberately, documented).
5. Not run: Windows, WebView2, a real `markiro-host restore`, two stations, printers; `graphify update`
   not run in the scratch worktree.
