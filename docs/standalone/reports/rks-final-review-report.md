# РК-С FINAL whole-part review: the station after a restore of the host

Branch `claude/floor-2a7`, worktree `/tmp/claude/wt/flr`. HEAD `f19f855ba`, base `f5b1707f1`. Five commits (Tasks 1–5: `0b2bb9c0c`, `91a49c1f4`, `c1da39169`, `6e8b48b5f`, `f19f855ba`), 32 files, +3 175 / −97. Each commit ends with exactly one `Co-Authored-By: Claude Opus 5.5` line. `host/`, `proto/`, manifests and the lockfile are untouched. `git diff --check` over the range is clean. `git status --short` was empty before and after the review. Every scratch file was deleted, and every mutant was restored byte-identically.

## Verdict

**WITH FIXES (one wave).** Critical 0, Important 3, Minor 14.

- **I-1 (new, FIX).** The C6 guarantee is fail-open before the link's first `Online`. The outbox goes to the host before the station has learned a new epoch. I demonstrated this with a scratch test. After the office resumes, a box closed from a block issued after the copy then gets a permanent `sscc_not_issued`.
- **I-2 (plan-mandated, FIX recommended).** A connection whose `hello` read fails still comes `Online` without an epoch, and it sends meanwhile. The plan accepted this in «Перенесено» 4. It has the same consequence as I-1 and costs about 10 lines in the shell.
- **I-3 (I1, CARRY to the owner).** A new-PC restore loses the old pairing's work. The docs now state this honestly and make check 1 mandatory. It is still a spec §11 gap until the owner picks an option.

The rest of the part holds together:

- **Task 1.** `hello` is read with the pinned client before every stream. The epoch arrives with the first `Online`, and forget and a link swap clear it. Old hosts without `restoreEpoch` parse fine: `serde(default)` gives `None`, and the stream goes on.
- **Task 2.** Already approved. I re-checked its seam to Task 3:
  - the epoch is written before `restoreDue` is asked;
  - the reopen happens once per epoch, through `SETTLE` with `expectedChanges: 1`;
  - after a crash between retiring blocks and settling, the obligation stays open and every block is sent again;
  - `0009` is tested over a real `0008` database.
- **Task 3** had no per-task review, so I reviewed it adversarially:
  - the `restoreDue` gate works once the epoch is known;
  - the `factsHeld` gate gives one request a minute and no hot loop. Every other trigger is silent during that minute, and going offline clears the gate;
  - the shared `noting` write is correct; a failed write is forgotten and written again;
  - I found no deadlock (offline/online flaps, no blocks, refused blocks, `no_restore`, forget, pairing change), apart from the deliberate C6 stall on a host error that never resolves, which the status bar shows.
- **Task 4.** The texts no longer lie. One small over-claim remains (m5).
- **Task 5.** The docs match the code on 60 s, 64, 30 days, `RESEND_WINDOW_MS == RETENTION_MS` and 24/12 tables. The runbook describes I1 under option (3) and makes check 1 mandatory. A few stale or imprecise lines remain (m4, m6, m8, m9, m12).

---

## (a) Findings, most severe first

### Critical: none.

### Important

**I-1. The outbox reaches the host before the station knows the host was restored (C6 fail-open at link start and while not online). FIX.**

- **Where:** `src/app/host-link.ts:377-386`, the sender, plus `factsNow`/`everything`.
- **Mechanism:**
  - The gate is `await noteEpoch(); if (await restoreDue(...)) return;`, and `noteEpoch` writes only the in-memory `epochSeen`, which comes from an `Online` status.
  - A pairing that has not yet seen the new epoch has no obligation row, so `restoreDue` is false and `sendFactBatch` runs.
  - The sender is not gated on the link state. `everything()` runs when `watch` resolves, whatever the first status was. `requestFacts()` runs after every local write (scan, box close), also while the link is `connecting` or `offline`.
  - The shell's `host_request` does not depend on the link (`lib.rs:101`). It reaches the host whenever the network does.
- **Evidence:** a scratch test (a copy of the `host-link-restore` harness, deleted afterwards) mounts the link with first status `connecting`, then sends `Online` + `restoreEpoch`. The order of what reached the host was `["changes 0","facts","blocks","blocks answered","changes 0","facts"]`: facts went BEFORE the blocks.
- **When it bites:** a host that was restored and already resumed by the office, and a station that was not online at that moment. Examples:
  - a station PC switched off over the restore, which boots afterwards. Its first `everything()` races the shell's `hello` + stream;
  - a station whose network was down. The link's backoff is up to 30 s, and `hello` can take up to 10 s, while any scan triggers a send.

  The resume dialog deliberately lets an administrator resume with stations that have «Не вернула», so this is an expected situation, not an exotic one.

- **Consequence:** a `box_closed` from a block issued after the copy gets `sscc_not_issued`. `fact_receipts` keeps the rejection forever (`host/src/facts/mod.rs:217-236`, «та же запись — та же квитанция»). The later reconcile reopens and resends it and gets the same rejection, so the box is lost from the host's books for good. This is the exact case C6 exists to prevent. The probability is low, but the consequence is in the Critical class. The docs claim that "no record goes meanwhile" (`AGENTS.md`, §24 «Обязательство», runbook step 8).
- **Fix (webview only, Task 3 files):**
  - In `factSender`, before `noteEpoch`, return without a failure unless the link's latest status is `online`. Keep today's behaviour only when `watch` itself failed (no events, so no epoch knowledge is possible).
  - Trigger `factSender` on every transition to `online`. The first revision after a reconnect already triggers `everything`, but do not rely on it.
  - Tests:
    - the scratch scenario above must give `facts` after `blocks answered`;
    - a `requestFacts()` while `connecting`/`offline` sends nothing, and it goes once `Online` arrives;
    - the `watch`-failure path still sends.
  - Mutants: drop the gate; gate on `!== "offline"`.
  - Existing `host-link-facts` tests that send under a non-online first status must be re-read; none should need sending while offline.

**I-2. A failed `hello` read lets the connection come `Online` without an epoch, and the outbox goes. Plan-mandated («Перенесено» 4, constraint C3 "Неудачное чтение поток не останавливает"); FIX recommended.**

- **Where:** `src-tauri/src/connection.rs:263` and `:298-317` (`restore_epoch` → `None` on any failure; `follow` opens the stream regardless).
- **Consequence:** the same as I-1, for a whole connection, until the next reconnect. A host keeps its stream for days, so "next connection" can be much later.
- **Fix:**
  - `restore_epoch` returns `Result<Option<String>, LinkError>`. A transport error, a non-200 or an unreadable `hello` ends the attempt (backoff, `Offline` with an error) instead of opening the stream.
  - Compatibility holds:
    - hosts that predate `restoreEpoch` answer a 200 `hello`; `classify_hello` is `Compatible` and the epoch is `None`;
    - a host that fails `classify_hello` would not have paired;
    - `hello` is unauthenticated and always 200 on a healthy host.
  - Together with I-1, `Online` then means "the epoch of this host is known".
  - Tests: a lib test on the mapping (503, `None` body, foreign product, unreadable epoch → `Err`; a 200 without the field → `Ok(None)`), plus an integration test that the link stays offline against a host answering `hello` with 503, if cheap.
  - Docs: `AGENTS.md` «Connection to the host» and «Left open», §24 «Где станция берёт эпоху» and «Не сделано», runbook check 5 (the paragraph "Станция, которая прочитала эпоху неудачно…"), plan «Перенесено» 4.
  - If the controller keeps the plan's choice, CARRY, and the docs stay as they are. They already say so honestly.

**I-3. I1: a restore on a NEW PC loses the old pairing's work. CARRY to the owner (OWNER-DECISIONS «РК-С I1»); documented in AGENTS, runbook §6 and §24; not a defect of this code.**

What is lost, restated precisely:

- The new host has another `hostId` and certificate. The old pairing's pinned client can never connect to it, so it never sees the epoch, never returns blocks and never resends.
- **(1) Records acknowledged after the copy** by the dead host are lost to the host silently:
  - the station holds them as accepted;
  - the forget guard counts only `acked_at IS NULL`;
  - retention is pairing-scoped (`DUE_SHIFTS_SQL` by `host_id, device_id`), so they are not purged; they stay on disk unused.
- **(2) Unsent records** make `device_forget` refuse with `unsent_facts` until the engineer confirms `keepUnsent`. They then stay on disk for ever, and no path sends them. If one did, the host would reject them: shifts created after the copy are unknown, and blocks belong to the old device id.
- **(3) The open shift:**
  - if it was opened after the copy, the new host does not know it at all;
  - if it was opened before, the host knows the shift under the old device, but none of its post-copy boxes;
  - either way, the labelled boxes are absent from the host's reports and exports.
- **(4) Blocks issued after the copy** are never registered. SSCC uniqueness rests on two things:
  - the host's margin (`history_known = false` → counters ≥ copy + 100 000, rounded to 10 000, and ≥ 2 blocks);
  - runbook check 1, which is now mandatory.

  The new pairing never prints from old blocks, and `floor_boxes_sscc` uniqueness stops the station repeating its own old serials.

- **(5) Office:** the copy's device rows and the new pairings all read «Не вернула», so "0 из M" is normal.

What could make it worse, checked:

- Retention does not purge the old pairing's rows.
- The forget refusal still fires.
- C5 on the new pairing reopens nothing of the old one.
- **One aggravation is undocumented:** the same loss hits, on ANY restore (same PC too), every station paired after the copy. The copy does not know its device, its key is refused, and it must re-pair. There SSCC is safe when the previous database was read (counters above everything it issued), but records and the open shift are lost the same way. Runbook check 4 says only "подключается заново" (m8).

Cheapest mitigations, judged:

- **Refusing forget while records are stranded:** it already refuses until confirmed, and an outright refusal would trap a station that must re-pair. **No.**
- **A status-bar line counting other pairings' unsent records:** operators cannot act on it, and under owner option (1) it is moot; under (2) it becomes a progress line. **CARRY to the owner's choice.** If wanted, put it on the office/device page or the forget screen, not the floor bar.
- **A mandatory drain step:** already in runbook §6 step 1 (planned replacement), with numbers recorded before re-pairing (step 2), and check 1 mandatory. **Done.**

Nothing more should be built before the owner decides. Option (1) (identity in the copy) makes the whole РК-С design apply unchanged. Its cost is that the TLS key lives in the backup folders.

### Minor

**m1. The stuck line counts weeks after a reconcile and any failure that is not the hold. FIX (queued).**

- `HEAD_RECORD_SQL` (`src/floor/outbox-status.ts:58`) reads the reopened record's original `created_at`, and its old `sent_at`. `stuckIsRestore` hides it only while `held` or `due`. After the settle, a network blip during the resend shows «ждёт отправки уже 29 сут, последняя — 29 сут назад».
- Fix without touching the pinned SQL: `readDeliveryStuck` also reads the pairing's `reconciled_at` (a `STATUS_SQL`-like read). Then:
  - `waitedMs` counts from `max(created_at, reconciled_at)`;
  - `sinceLastAttemptMs` is `null` when `sent_at < reconciled_at`.
- Test plus mutant.

**m2. M4: which blocks were refused, and why, is not kept. FIX (queued), before `0009` ships.**

- Add `refused_blocks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(refused_blocks))`. `NOTE` resets it, and `SETTLE` writes `[{id, code}]`. `readRestoreStatus` exposes it, which support needs.
- Pins and text agreement in `test/floor-schema.test.ts` (Node 3.53) and `src-tauri/tests/local_db.rs` (shell 3.46). The 0008 → 0009 upgrade test asserts the column.
- Editing `0009` is safe only because it has never run outside dev/test databases. A database that applied the old `0009` fails the sqlx checksum. If any test station has it, use `0010` instead.

**m3. M5: forget does not warn while blocks are owed. FIX (queued).**

- The obligation is `Disposable`, and on a same-host re-pair the post-copy blocks are never registered.
- The unsent guard may not fire: before the settle, the reopened records are not unsent yet.
- Cheapest: the webview reads `restoreDue` for the current pairing before a forget. It shows `shell.restoreOwed` (why it matters, and to wait for the line «станция возвращает…» to go) beside the existing destructive confirmation. A Rust `restore_owed` guard mirroring `unsent_facts` is stronger, but it changes the shell's error contract.
- Update runbook §8 «Сброс подключения при долге» and the §24/AGENTS «not done» bullets.

**m4. Stale runbook §4 line 136-137 «В коде станции на этой ветке такого хранения ещё нет (оно в плане 2a8)». FIX DOC (queued).** Retention (2a8) is merged. Say that the station keeps acknowledged records 30 days, and that a restore resends that window.

**m5. «Вернула» over-claims "accepted". FIX words.**

- The host marks the station on any successful request, "whatever became of each" block (`known_blocks.rs:255-266`), including one where it refused every block. The texts say «когда хост принял первую часть её блоков».
- Where: `ru.json` `office.backups.hold.blocksNote`, the runbook check 5 («приняв первую часть»), `AGENTS.md` «the first part … it takes», §24 «на первой принятой части», and the `BackupsPage.tsx` doc comment («first accepted part»).
- Say «получил (ответил на) первую часть — даже если какие-то блоки отклонил». Add that refusals show only on the station's status bar.

**m6. Runbook check 5 is imprecise in two places. FIX DOC.**

- «строка держится, пока хост не ответил; если держится долго — нет связи с хостом»: it also stays while the host answers the route with an error that never resolves (`KnownBlocksMismatchError`, a 4xx, a `conflict` other than `no_restore`). Add «или хост отвечает ошибкой — сообщите разработчику».
- The refusal reasons list only overlap and an unknown prefix. Add `block_mismatch` (the host holds that block id in another shape) and `range_invalid`.

**m7. Survivors of my mutants. DROP, both effectively equivalent.**

- K08: the `reconcileFailures = 0` reset is unpinned. Its only effect is one extra local `DUE_SQL` read per reconnect after a past failure.
- K14: the `held` line would follow a successful restore read. The code does not couple them; a pin would need a failing `readRestoreStatus` with `held`.

**m8. Runbook check 4 omits the I1-like loss for devices paired after the copy, on any restore. FIX DOC.** Point from check 4 to the §6 subsection: record numbers before re-pairing, and post-copy records and the open shift are lost. SSCC is safe only when the previous database was read; otherwise check 1 is mandatory.

**m9. `AGENTS.md` «Verification» says «a restore on a new PC … (item 9, second run)». FIX DOC.** In the runbook, the second run is "network off" and the new PC is the THIRD run.

**m10. The runbook quotes forget text that does not exist. FIX DOC.**

- §6 «Что теряет…» bullet 2 quotes «На этом устройстве есть данные смен, которые ещё не ушли на хост…».
- The real text (`ru.json` `shell.unsent.body`) is «На этом компьютере не отправлено на хост записей смен: N. После сброса подключения они останутся на диске этого ПК…». The button is «Сбросить всё равно».

**m11. M6 (Task 2 review) is not documented: records of a shift CLOSED after the copy turn into permanent rejections. FIX DOC.**

- The reopen resends them; the host does not know the shift and answers `unknown_shift`/`not_entered`, which it keeps for ever.
- Check 4 covers only a shift «у которой идёт» (in progress).
- Add one sentence to check 4 and §8: that is more honest than the silent «accepted» before, and such records cannot be resent.

**m12. The open-shift bullet of runbook §6 (and AGENTS/§24) says «смена … новому хосту неизвестна». FIX DOC.** True only for a shift opened after the copy. A shift opened before it is known (under the old device), but its post-copy boxes are not. Reword.

**m13. The `restoreRefused` line stays until the next restore, with no way to acknowledge it. DOC.** Say so in runbook check 5 and §24. Then it is not read as a fresh problem days later.

**m14. Test doc comment `migration_0009_keeps_the_rows_of_a_database_of_0008` says the database «holds a shift», but no `floor_shifts` row is inserted (Task 2 M7, still open). FIX (in m2's commit).**

Seen and not counted:

- An `Offline`/`Connecting` status keeps the last epoch in its JSON (the struct is not cleared on reconnect). This is harmless: the webview reads it only on `online`, and the Rust doc says «as the connection that came online last read it».
- Two epochs noted within one in-flight write could commit out of order (a pooled shell). That needs two restores inside one local write.
- The strict `z.uuid()` would drop a status whose epoch is not a UUID; the host writes `Uuid::new_v4()`.
- "0 из 0 станций" in a dialog with no stations is truthful.
- `K06` (no `cancelFactRetry` in `stopAll`) is equivalent: the scheduler is stopped.

---

## (b) TRIAGE

| #   | Item (source)                                                             | Decision                                     | Reason                                                                                         |
| --- | ------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | I-1 sender before epoch known (this review)                               | FIX                                          | permanent `sscc_not_issued` possible; scratch-proven; webview-only                             |
| 2   | I-2 failed `hello` → Online without epoch (plan «Перенесено» 4)           | FIX (recommended; controller may keep CARRY) | same consequence as I-1; about 10 lines in the shell; compatible with old hosts                |
| 3   | I1 new-PC restore (OWNER-DECISIONS «РК-С I1», T2 review I1, rk-minors 11) | CARRY (owner)                                | needs an identity or host decision; docs honest; check 1 mandatory                             |
| 4   | addenda T1: spec section §24                                              | DROP (done)                                  | §24 written; §11/§22 pointers say 24; numbering note matches the file                          |
| 5   | addenda T2 / T4: no-blocks station not shown as failure                   | DROP (done) + CARRY host                     | `blocksNote`, `confirmNoBlocks`, runbook §7/§8, §24; host follow-up (empty list / `hasBlocks`) |
| 6   | addenda T2: unsent count jumps after reconcile                            | DROP (done)                                  | runbook step 8 and §8                                                                          |
| 7   | addenda T2/T4: runbook I1 + check 1 mandatory                             | DROP (done)                                  | §6 subsection, check 1 «на новом ПК обязательна всегда», checklist                             |
| 8   | addenda T2: M4 refused-codes column in `0009`                             | FIX (m2)                                     | unshipped migration; cheaper now than as `0010`                                                |
| 9   | addenda T2: M2 optimistic «Вернула» documented                            | DROP (done) + FIX words (m5)                 | documented; wording over-claims "accepted"                                                     |
| 10  | addenda T2: M3 30-day window documented                                   | DROP (done)                                  | runbook §8, AGENTS, §24                                                                        |
| 11  | addenda T3: forget-while-owed (M5)                                        | FIX (m3)                                     | cheap; same-host re-pair otherwise silently drops the obligation                               |
| 12  | addenda T3: status-bar line for records stranded under an old pairing     | CARRY (owner)                                | depends on the I1 option; not a floor-bar item                                                 |
| 13  | addenda T3: `HEAD_RECORD_SQL` stuck line                                  | FIX (m1)                                     | misleading weeks; fix in `readDeliveryStuck`, pinned SQL unchanged                             |
| 14  | addenda T3: adversarial check of Task 3                                   | DROP (done)                                  | done here: I-1 found; the hold gate, `noting` and 60 s are correct (K03–K05, K13 killed)       |
| 15  | addenda T4: runbook lines ~16/232/341                                     | DROP (done)                                  | rewritten                                                                                      |
| 16  | addenda T4: ПЛ-Ц/РК numbering                                             | DROP (done)                                  | 19/22 unchanged                                                                                |
| 17  | T2 review M1 (no-blocks, host)                                            | CARRY (host stream Б)                        | host and proto off-limits; plan «Перенесено» 2                                                 |
| 18  | T2 review M2 (send newest first)                                          | CARRY (planner/owner)                        | the brief pins the order; docs state the optimism; newest-first would make the mark meaningful |
| 19  | T2 review M3 (reopen by shift)                                            | CARRY                                        | only for copies older than 30 days, which the runbook already calls dangerous                  |
| 20  | T2 review M4                                                              | = item 8                                     |                                                                                                |
| 21  | T2 review M5 (stuck, counts, forget)                                      | = items 13, 6, 11                            |                                                                                                |
| 22  | T2 review M6 (closed post-copy shifts → rejections)                       | FIX DOC (m11)                                | not in the docs                                                                                |
| 23  | T2 review M7 (AGENTS count; test comment)                                 | count DROP (done); comment FIX (m14)         |                                                                                                |
| 24  | T1 report concern: one extra `hello` per connection, up to 10 s           | DROP                                         | accepted by design C3                                                                          |
| 25  | T2 report concern 6: one long reopen transaction                          | CARRY                                        | once per restore; to measure on the pilot                                                      |
| 26  | T3 report concern 4: delivery up to 1 min after the hold ends             | DROP                                         | matches `Retry-After`                                                                          |
| 27  | T4 report concern 1: ambiguous «Не вернула»                               | = item 17                                    |                                                                                                |
| 28  | T5 report concern 3: runbook line ~136                                    | FIX (m4)                                     |                                                                                                |
| 29  | T5 report concern 1: runbook written for option (3)                       | CARRY (owner)                                | rewrite on the owner's choice                                                                  |
| 30  | rk-minors 11                                                              | = item 3                                     |                                                                                                |
| 31  | rk-minors 12 (infra summary line, CREATOR OWNER, C2 flush)                | CARRY                                        | not РК-С scope; unchanged                                                                      |
| 32  | rk-minors 13 (section numbers)                                            | DROP (done)                                  |                                                                                                |
| 33  | m6, m8, m9, m10, m12, m13 (this review)                                   | FIX DOC                                      | stale or imprecise lines                                                                       |
| 34  | m7 (K08, K14 survivors)                                                   | DROP                                         | equivalent in effect                                                                           |

### Proposed fix wave (ONE fixer, six commits, explicit paths, one trailer each)

1. **`fix(standalone): the outbox waits for the link's online status, so a restored host's epoch is known before any record goes`** (I-1).
   - Files: `src/app/host-link.ts`, `test/host-link-restore.test.ts`, plus `test/host-link-facts.test.ts` if a test relied on sending while not online.
   - Content: the gate, the trigger on going online, and the `watch`-failure exception.
   - Tests: the W1 scenario (`connecting` first → facts after `blocks answered`); a local write while `offline`/`connecting` sends nothing and goes once online; the watch-failure path sends.
   - Mutants: no gate; gate `!== "offline"`; no trigger on online.
   - Prove it with the delayed-`setImmediate` stand.
2. **`fix(standalone): a connection whose hello cannot be read does not come online`** (I-2; skip if the controller keeps «Перенесено» 4).
   - Files: `src-tauri/src/connection.rs` (lib test on the mapping), `src-tauri/tests/connection.rs` (a host answering `hello` 503 keeps the link offline, if cheap).
   - Run focused `--lib connection` and unsandboxed `--test connection`.
3. **`feat(standalone): the restore obligation keeps which blocks the host refused and why`** (m2 + m14).
   - Files: `src-tauri/migrations/0009_restore_epochs.sql`, `src/local/restore-reconcile.ts` (`NOTE_SQL`, `SETTLE_SQL`, `STATUS_SQL`, `readRestoreStatus`), `test/restore-reconcile.test.ts`, `test/floor-schema.test.ts` (pins + text agreement), `src-tauri/tests/local_db.rs` (pins + text agreement + 0008→0009 upgrade asserts the column; comment fix).
   - Precondition: confirm no installation applied `0009`; otherwise make it `0010`.
4. **`fix(standalone): the stuck line counts from the reconciliation, not from a reopened record's creation`** (m1).
   - Files: `src/floor/outbox-status.ts` (`readDeliveryStuck` clamps), `test/floor-status-bar.test.tsx` and/or `test/outbox-status.test.ts`.
   - Tests: reconcile, then a non-held failure → the wait counts from `reconciled_at`, and the last attempt is unknown.
   - Mutant: no clamp.
5. **`feat(standalone): forgetting a pairing that still owes a restored host its blocks says so first`** (m3).
   - Files: `src/app/App.tsx`, `src/app/screens.tsx`, `src/i18n/ru.json`, `test/app.test.tsx`.
   - Mutant: warning never shown.
6. **`docs(standalone): РК-С final wave in the runbook, AGENTS and the pilot spec`** (m4, m5 words incl. `ru.json` `blocksNote` + its test pin + the `BackupsPage.tsx` comment, m6, m8, m9, m10, m11, m12, m13).
   - Also update the «Left open» / «Не сделано» lists for commits 1–5: W1 and the failed-`hello` window fixed, codes kept, forget warns, stuck line fixed.
   - Files: `docs/runbooks/standalone-backup-restore.md`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (§24), `src/i18n/ru.json`, `test/backups-page.test.tsx`, `src/office/backups/BackupsPage.tsx`.
   - Put the `ru.json`/test part in commit 5 if the fixer prefers code and docs apart.

Final gates after the wave:

- Vitest package suite, typecheck, lint and build.
- Focused shell `--lib connection`, `--test connection` (unsandboxed) and `--test local_db`.
- One `cargo test --workspace` unsandboxed, by the controller.
- The prettier gate, live-proved; `git diff --check`; `cargo fmt --check`.

---

## (c) Deviations for «Отклонения при исполнении» (draft, in Russian)

- **Задача 1.** Сверх брифа два теста:
  - очистка эпохи при «Забыть» (утверждение в `the_online_status_names_the_epoch_of_a_restored_host`);
  - `a_link_swapped_for_another_host_does_not_inherit_the_epoch` — смена связи без прохода через «не подключено».

  `--test connection` — 8 тестов (план 7). Якоря кода совпали все.

- **Задача 2.**
  - Миграция — `0009` (номера `0007`/`0008` заняты 2a7 и ПЛ-Ц).
  - Строки `floor_restore_epochs` в `TABLE_CLASSES` и в списках таблиц тестов вставлены по алфавиту после `floor_print_jobs` (якорь брифа сдвинули таблицы печати и паллет).
  - Тексты SQL вынесены в экспортируемые константы (`NOTE_SQL` … `SETTLE_SQL`); их планы закреплены на обоих SQLite (Node 3.53, оболочка 3.46), есть тест совпадения текстов TS и Rust.
  - В `REOPEN_SQL` добавлено `AND outcome IS NOT NULL`. По CHECK таблицы `outbox` это не меняет ни одной строки, зато поиск идёт по `outbox_settled`.
  - Сверх брифа:
    - тест обновления базы `0008 → 0009`;
    - 17 тестов в `restore-reconcile`;
    - тесты связи со сроком хранения: `RESEND_WINDOW_MS === RETENTION_MS`; смена с повторно открытыми записями не удаляется; блоки и обязательство переживают проход.
  - Счёт: `local_db` — 29, Vitest пяти файлов — 243 (план 236).
  - Ревью задачи: 0/1/7; I1 вынесено владельцу.
- **Задача 3.**
  - Вместо `epochNoted` брифа — общая запись эпохи `noting`: одна запись на эпоху для отправки и сверки, неудавшаяся запись забывается и пишется снова.
  - Добавлен затвор удержания `factsHeld`: пока идёт минута хоста, ни одна другая причина отправки к хосту не обращается; затвор снимается таймером и уходом связи.
  - Строка «самая старая запись ждёт…» молчит, пока хост держит записи или блоки ещё должны хосту.
  - Тестов в четырёх файлах — 108 (план 90).
  - Отдельного ревью задачи не было; итоговое ревью нашло окно до первого статуса «на связи» (I-1).
- **Задача 4.**
  - Добавлены `blocksNote` с оговорками о станции без блоков и об отметке на первой части, новая строка окна `confirmNoBlocks`.
  - `confirmCount` — во множественных формах (`_one/_few/_many/_other`).
  - 8 тестов сверх брифа, 43 теста в файле страницы (план 35).
- **Задача 5.**
  - Раздел спецификации — §24, а не §22: §22 — РК, §23 — УСТ. Дописан в конец файла; ссылки в §11 и §22 ведут на §24.
  - Счёт таблиц в `AGENTS.md` пересчитан по смыслу: 24 таблицы, 12 `Disposable`.
  - Дополнительно переписана устаревшая строка «Backups and restore» («No station code keeps count of returned blocks»).
  - Текст памятки (шаги 8–10, проверка 5) внесён по смыслу, согласован с действующим `confirmCheck`.
  - Описано I1 по варианту (3) и обязательная проверка 1 для нового ПК.
  - Полный прогон cargo и Vitest в задаче 5 не повторялся (только документы).
- **Счёт тестов.** Числа плана сняты на копии без 2a7, ПЛ-Ц, 2a8, ЧЗ, О-Ф, ИМП и УСТ. Фактически:
  - Vitest — 148 файлов, 4594 теста (после задачи 4);
  - cargo `--workspace` — 71 строка `test result`, 1122 теста (после задачи 2).

  Известный отказ по тайм-ауту `template-editor` под нагрузкой; отдельно файл проходит.

- **Итоговое ревью.** Найдены:
  - окно отправки до первого статуса «на связи» (I-1);
  - неудачное чтение `hello` (I-2, «Перенесено» 4);
  - очередь финальной волны: коды отклонённых блоков в `0009`, предупреждение при сбросе с долгом, строка «ждёт отправки» после сверки, устаревшие строки памятки.

  Что из этого исправлено — пишет волна правок.

---

## Evidence

**Scratch demonstration of I-1.** `apps/standalone/test/zz-rks-race.test.ts` was a copy of `test/host-link-restore.test.ts` plus one case and was deleted afterwards. With first status `{state:"connecting"}`, then `Online` + `restoreEpoch`, the logged order was `ORDER W1 ["changes 0","facts","blocks","blocks answered","changes 0","facts"]`, and the assertion "facts after blocks answered" failed. A second scratch case, a local write while offline, was not completed: the harness id collided on `unsentScans`. The mechanism is the same ungated `factsNow`, read in code at `host-link.ts:471`.

**Mutants of my own.** Harness `/tmp/claude/fr-rks/mut.py`, log `/tmp/claude/fr-rks/mut/mutants.txt`. Each run copied the file first, then restored it and checked `filecmp` and SHA-256 equal (`restored=True` for all). Rust files were touched after restoring; the `connection.rs` SHA-256 `51ef2e0e…` was identical before and after.

| #   | Mutant                                              | Result                                   | Killed by (first)                                                                          |
| --- | --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| K01 | no `factSender.trigger()` after a reconcile         | KILLED                                   | gives the blocks back first… / across a restart… / tells the status bar…                   |
| K02 | `restoreDue` asked only when `epochSeen !== null`   | KILLED                                   | sends no record while the blocks are owed, across a restart…                               |
| K03 | offline keeps the fact retry and the hold           | KILLED                                   | waits while the link is down… / asks again at once when the link comes back…               |
| K04 | hold waits 30 s                                     | KILLED                                   | waits a minute… / once a minute…                                                           |
| K05 | hold gate effectively removed                       | KILLED                                   | asks the host held for the facts once a minute, whatever else asks                         |
| K06 | `stopAll` without `cancelFactRetry`                 | SURVIVED (equivalent: scheduler stopped) | —                                                                                          |
| K07 | no reconcile retry on return online                 | KILLED                                   | does not knock while the link is down, and asks at once when it is back                    |
| K08 | `reconcileFailures` not reset on success            | SURVIVED (m7, one extra local read)      | —                                                                                          |
| K09 | restore status not re-read on `outboxVersion`       | KILLED                                   | 3 status-bar tests                                                                         |
| K10 | plural `count: returned`                            | KILLED                                   | confirm-resume; counts «0 из 1 станции»                                                    |
| K11 | feed ignores `from_zero`                            | KILLED                                   | reference-sync ×2; link order test                                                         |
| K12 | `no_restore` returns without settling               | KILLED                                   | owes nothing more… ×2                                                                      |
| K13 | no `outbox_changed` after a new epoch               | KILLED                                   | tells the status bar at once…                                                              |
| K14 | `held` line needs a restore read                    | SURVIVED (m7, uncoupled in code)         | —                                                                                          |
| K15 | settle time from `new Date()` not `now()`           | KILLED                                   | 3 restore-reconcile tests                                                                  |
| R-A | Rust: `restore_epoch` without `skip_serializing_if` | KILLED                                   | lib `statuses_and_revisions_serialize_to_the_webview_shape`                                |
| R-B | Rust: `Online` publishes no epoch                   | KILLED (unsandboxed `--test connection`) | `the_online_status_names_the_epoch_of_a_restored_host`, `a_link_swapped_for_another_host…` |

The baseline `--lib connection` (sandboxed) gave 13 passed.

**Read for this review:**

- the whole of `src/app/host-link.ts`, `src/local/restore-reconcile.ts`, and the diffs of `connection.rs`, `protocol.ts`, `reference-sync.ts`, `api.ts`, `0009`, `FloorStatusBar.tsx`, `ru.json`, `BackupsPage.tsx`;
- the runbook, AGENTS and §24 diffs;
- `src/host/connection.ts` (`watch` delivers the current status before resolving);
- `src-tauri/src/connection.rs` `hold`/`follow` (backoff 1 → 30 s);
- `lib.rs` `host_request` (independent of the link);
- `host/src/facts/mod.rs` (rejected receipts kept);
- `host/src/routes/known_blocks.rs` (1–64 blocks; marks on any successful request);
- `host/src/restore.rs` (epoch `Uuid::new_v4`);
- `src/floor/outbox-status.ts` (`HEAD_RECORD_SQL`);
- `src/local/retention.ts` (pairing-scoped);
- `src/app/screens.tsx` and `ru.json` `shell.unsent`;
- `TABLE_CLASSES` (12 / 11 / 1);
- spec headings (§18–§24);
- plan «Перенесено» 1–6.

**Not run:**

- the full cargo workspace (load; per instructions) and the full Vitest suite (no code change by me);
- Windows, WebView2, a real `markiro-host restore`, two stations, real printers.

The docs already say none of these was ever exercised.
