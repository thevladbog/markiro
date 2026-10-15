# Plan I1 — final whole-part review (host identity in the backup copy)

Reviewed: branch `claude/m2`, range `2c726efba..9942dcf7c` (7 task commits; the merge `f10dacf70` / `26572c386` brings only the forms golden fix from integration and is ignored). Scratch worktree `/tmp/claude/wt/rv-i1` (detached at `9942dcf7c`, build state cloned from integ). Plan `docs/superpowers/plans/2026-10-11-standalone-i1-host-identity-restore.md`, rules `i1-constraints.md`, `i1-reviewer-rules.md`, all seven task reports.

## Verdict

**Needs fixes before the owner's Windows beta: 0 Critical, 3 Important, 8 Minor.**

The core is sound. The `identity_plan` matrix matches Д6. C1 `foreign` is still taken from the folder's identity BEFORE the restore. The restore epoch is a new UUID on every restore, so a same-`hostId` restore still triggers the РК-С resync. The marker covers every identity step. A failed identity step never fails or corrupts a copy, and no key byte reaches a log, an error or the CLI. The three Important items are:

1. A real race in the key-file write: the key goes into whatever the path names after the guard ran, not into the file the guard closed. On Windows the key can leak through a read handle opened before `icacls` (second folder).
2. Rotation and cleaning stop for good on an `.identity` the current service account cannot delete. This is a Windows reliability problem after a service-account change or on a new PC.
3. The runbook does not say that a device revoked after the copy now reconnects by itself to a new-PC restore. Its own instruction to re-revoke «до запуска станций» cannot be followed.

All three are small fixes (≤ 4 commits). The owner's Windows test then exercises the final code.

## (a) Findings, most severe first

### Important

**I-1. The key is written by path after the guard ran, so it can land in a file the guard never closed.** `host/src/backup/identity.rs:339-371` (`put_file`) does three steps:

1. `create_private(&partial, true)` and drop the handle.
2. `guard.protect(&partial)`, which runs `icacls` by path.
3. Reopen `&partial` by path (`OpenOptions::write().truncate()`, following links) and write the key.

Two attacks follow, both in a second folder where other accounts have rights:

- **Windows (the target platform):**
  - Rust's std opens files with `FILE_SHARE_READ|WRITE|DELETE`. The partial is born with the folder's inherited ACL. The default ACL of a non-system NTFS drive root (`D:\Copies`, the runbook's own example) gives Users read and Authenticated Users modify. A share often gives Everyone read.
  - Another local user (e.g. the operator account on a «хост и станция» PC) watching the folder with `ReadDirectoryChangesW` can open a READ handle on the empty partial during the tens of milliseconds before `icacls` finishes. A DACL change does not revoke an open handle, so that user then reads the key the host writes into it.
  - A user with delete rights can also replace the partial with a file they own before `icacls` runs. `/grant:r *S-1-3-4:F` (OWNER RIGHTS) then grants that user full control, and the host writes the key into their file.
- **Unix:** an account that can write the folder can replace the partial with a symlink between step 1 and step 3, and the key is written through it.

The module doc and runbook §2 claim the key «never sits in a file with the folder's inherited access» and is closed «до записи ключа». That holds for the DACL, not for these handles.

- **Fix (no new dependency):**
  - Keep the handle from `create_new` and write the key through it; do not reopen.
  - On Windows, create it with `std::os::windows::fs::OpenOptionsExt::share_mode(0)`. No one else can then open it for data or delete or rename it while the host holds it.
  - Close it, then rename.
- **Why `icacls` should still work:** `icacls` (SetNamedSecurityInfo) opens with `READ_CONTROL|WRITE_DAC`, which share modes do not govern, so it should still succeed. This must be confirmed on Windows; if it fails, every identity is left out and the office shows «нет», which the owner's test sees at once.
- **Test:** a guard that, inside `protect`, renames the partial away and plants a symlink to a file in another directory. Assert that the planted target never receives a key byte and that the copy then has no identity (or a damaged one), never a leaked one.

**I-2. A device revoked after the copy reconnects by itself to a new-PC restore, and the runbook's re-revoke instruction cannot be followed.**

- **Before I1:** a new PC meant a new certificate, so a device revoked after the copy (a stolen tablet, a dismissed station) could not reach the restored host.
- **Now:**
  - The copy's device keys are valid again: `history_known = false` on a new PC, so revocations are not carried.
  - The certificate is the same.
  - The runbook's preferred path gives the new PC the old IP (§6 step 7).
  - As soon as `sc start` runs (§6 step 8 → §5 step 8), that device reconnects and pulls the reference feed (operators with PIN and badge verifiers, products, templates). It can also take SSCC blocks; only facts are held.
- **What the runbook says:** check 3 (`docs/runbooks/standalone-backup-restore.md:461-464`) says to re-revoke «до запуска станций». Stations are never stopped, and §5/§6 start the service before §7. §6 «Что теряется…» (line 351) only points to check 3.
- **What the spec says:** §26 does not mention it.
- **Fix (docs):** in §6, before step 7's «лучше всего — адрес старого», add:
  - if anything was revoked after the copy (or you do not know), give the new PC another address first;
  - start the service and re-revoke from an office PC moved by «Сменить адрес хоста»;
  - only then give the new PC the old IP.
  - Reword check 3's «до запуска станций» to «до того, как станции увидят хост (на новом ПК — до перевода на адрес старого)».
  - Add one line to spec §26 «Что теряется и с ключом».

**I-3. An `.identity` the service cannot delete stops rotation and cleaning for good (Windows).** The identity file is the only copy file with an explicit, non-inherited ACL: SYSTEM, Administrators, OWNER RIGHTS. An account that is not its owner, not an admin and not SYSTEM, and has only Modify on the folder (no `FILE_DELETE_CHILD`), cannot delete it. This happens in two realistic ways:

- (a) Runbook §2 recommends switching the service from `LocalService` to `.\markiro-backup` for the share. Every earlier local `.identity` is owned by `LocalService` and closed to the new account.
- (b) A new PC in a domain writes to the same share as another computer account than the old one.

What the code then does:

- `folder::rotate` (`host/src/backup/folder.rs:113-121`) removes the manifest, then returns `Err` on the identity before it removes the `.db`.
- The next `clean` removes the `.db` but returns `Err` on the orphan identity.
- For the second folder, `clean` failing makes `result` an `Err` (`worker.rs:555`). Every later second-folder copy fails: a sticky «вторая папка — ошибка».
- For the local folder, the error is a warning, but `clean` stops at that file. The listed copies are not refreshed while `rotate` keeps failing.
- The test `rotation_stops_at_an_identity_it_cannot_remove_and_keeps_the_copies_it_keeps` pins this behaviour as intended (Task 2 mutant F07).

The cost is a factory-continuity regression to avoid leaving a protected orphan file, which is no more exposed than the protected files that stay anyway.

- **Fix:**
  - `rotate` removes manifest, database, then identity.
  - A failure to remove an `.identity` or its `.partial` in `rotate` and `clean` is logged (path and io error only) and never fails the call.
  - Adjust that test to assert the database is gone and the run continues.
  - Runbook §2 and §10 item 11: after a service-account change or a new PC, older `.identity` files may stay; an administrator deletes them.

This was reasoned from code and the existing test fixture; Windows did not run it.

### Minor

- **m-1 (FIX).** `host/src/restore.rs:2402` prints «Офис → «Изменить адрес хоста»». The real control is «Сменить адрес хоста» (`ru.json`, `HostAddressDialog.tsx`, used by the docs). On an office PC the screen is «Вход в офис», not «Офис». Suggested text: `… change the host address on each device («Сменить адрес хоста»)`. The summary test checks only the prefix up to the certificate.
- **m-2 (FIX).** `Made::unchanged` (`restore.rs:1586-1588`) still says «The interrupted restore found first had finished: only its marker was removed». Since I1, finishing may also have put the copy's identity in place. Make the text say «it was completed (its marker removed)».
- **m-3 (FIX test or CARRY).** Mutant K05 survived: removing `remove_identity_staging(paths)` from the swap-failure branch where every file went back (`restore.rs:1865`) passes every test. The staged key copy then outlives the refusal in `identity.partial/` until the next restore. It is protected like `tls/key.der`, but the guard is untested. An existing swap-failure test can assert that `identity.partial` is absent.
- **m-4 (CARRY, documented).** An orphan `identity.partial/` after a cut before the marker survives host starts; only the next restore removes it. The host start could remove it when no marker is present.
- **m-5 (DOC).** Runbook §6 (line 313) and spec §26 (line 1416) list «подмена» among what the damaged-identity check catches. The manifest is unsigned, so a substitution that rewrites the manifest's `sha256`/`fingerprint` too is not caught. Such a substitution only yields a host the stations reject (they pin the real certificate), so the risk is a DoS, not impersonation. Say «повреждение или подмена без правки манифеста».
- **m-6 (DOC).** Runbook §2 (lines 134-136) says only FAT32/exFAT sticks lose the key's protection. NTFS ACLs on a removable drive do not protect against whoever holds it either: any administrator of any PC, or another OS. Say «любую флешку с `.identity` — в сейф».
- **m-7 (DOC).** «Отменить восстановление» (§5 step 10) after a new-PC restore with the key puts back the installer's database but not the replaced identity, which stays in `restore-<время>\identity`. Say so, or tell the engineer to call support.
- **m-8 (CARRY).** `verify-copy` prints the `…: ok (…)` line before it fails on a damaged identity (non-zero exit, `DAMAGED` on stderr). A script that reads only stdout sees «ok».

### Checked and found right (no finding)

- **`identity_plan`:** the 90-case table's oracle is written from Д6, not from the code. My mutants K03 (arm order: `None` before `Keep`), K04 (a folder without a database counted as established) and K06 (the folder identity never read) were all killed.
- **C1 / Д7:** `foreign` uses `existing` (read before any identity move). `history_known = Read && initialized && !foreign` is unchanged. The implementer's M01/M30-M32 were killed. On a new PC the counters stand at least 100 000 above the copy.
- **РК-С interplay:**
  - `raise_in` sets `restore_epoch = Uuid::new_v4()` on every restore (`restore.rs:2303`), so the same `hostId` with a new epoch still makes the station rebuild references from zero and return its blocks.
  - The revision is copy+1, and the epoch covers a station cursor above it.
  - `change_address` keeps `device.json` except `host_address`, so after it the station's flow is the same-PC flow. The e2e test drives the hold, the known blocks and the resume.
- **Crash safety:**
  - Staging happens before the marker; the marker carries `identity: true` (`serde(default)`).
  - The install order is key, certificate, `host.json`, with a skip-if-moved check. K02 (certificate before key) was killed.
  - `keep_replaced` goes through a synced `.partial`.
  - The post-install whole read keeps the marker on failure.
  - `finish_interrupted` runs before `host.json` is read (M04 killed), and the rollback removes the staging. K01, K08 and K09 were killed.
  - The «aside folder extension» (made for a replaced identity even without a database) is additive and safe. K07 (always make one) survives as equivalent.
- **SAN / new address:** the shell's `FingerprintVerifier` (`src-tauri/src/tls.rs:55-80`) ignores the server name and the time and compares only SHA-256(DER). Any IP or name of the new PC works without reissuing the certificate.
- **No key material in output:** the `Debug` of `HostIdentity` and `TlsIdentity` is custom. Parse errors give line and column only, and base64 errors have fixed texts. The CLI, summary and refusals are checked by tests for a 24-character key fragment.
- **Copies:** a failed identity step never fails a copy or removes another copy's files. The implementer's C01/F12/F13 were killed, and so were my K12 (guard refusal ignored) and K13 (replicate without the SHA-256 compare).

### What the e2e test (Task 6) does not prove

- A different IP rather than a different loopback port.
- DHCP handing the old IP to the new PC.
- The firewall port from `host.json`.
- The Windows ACLs of `.identity`.
- The shell's own link task, `host_claim` and the WebView2 status bar reacting to the new epoch after `change_address`.
- An office PC in WebView2.
- A revoked-after-copy device returning (I-2).

All but I-2 are stated in runbook §10 items 9 and 11 and spec §26 «Не проверено».

## (b) Triage of every Minor and report concern, and the fix wave

| #   | Source            | Item                                                                                 | Decision       | Reason                                                                                       |
| --- | ----------------- | ------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------- |
| 1   | review            | I-1 key written by path after the guard (Windows read-handle / swap race)            | **FIX**        | security; small change; must be what the owner tests                                         |
| 2   | review            | I-2 revoked-after-copy device reconnects; check 3 «до запуска станций» impossible    | **FIX (DOC)**  | the document now misleads on a security step                                                 |
| 3   | review            | I-3 undeletable `.identity` stalls rotate/clean                                      | **FIX**        | continuity; Windows-realistic after the runbook's own account change                         |
| 4   | T7 c1, review m-1 | host summary «Изменить адрес хоста»                                                  | **FIX**        | one string                                                                                   |
| 5   | review m-2        | «only its marker was removed» stale                                                  | **FIX**        | one string                                                                                   |
| 6   | review m-3        | K05: staged identity removal on a fully rolled-back swap untested                    | **FIX** (test) | cheap assertion in an existing test                                                          |
| 7   | T4 c2, review m-4 | orphan `identity.partial/` survives starts                                           | CARRY          | documented (runbook §5 step 6, spec §26); protected like `tls/key.der`                       |
| 8   | review m-5        | «подмена» overclaim (manifest unsigned)                                              | DOC            | wording                                                                                      |
| 9   | review m-6        | NTFS stick ACL no protection                                                         | DOC            | wording                                                                                      |
| 10  | review m-7        | cancel after a new-PC restore leaves the copy's identity                             | DOC            | one sentence                                                                                 |
| 11  | T3 c2, review m-8 | `verify-copy` prints «ok» before failing                                             | CARRY          | exit code and stderr are right; runbook says «завершается с ошибкой»                         |
| 12  | T1/T2/T3/T4       | Windows `icacls`, OWNER RIGHTS, AV rename, FlushFileBuffers unverified               | CARRY          | owner's Windows test (runbook §10 item 11); add I-1/I-3 checks to it                         |
| 13  | T1 c2             | Unix reopen race                                                                     | FIX            | it is I-1                                                                                    |
| 14  | T1 c3, T3 c4      | no constant-time compare, key not zeroized                                           | DROP           | hash not secret; matches existing `TlsIdentity`                                              |
| 15  | T1 c4             | refusal codes for `read_beside`                                                      | DROP           | done in Task 3 (`read_beside_coded`)                                                         |
| 16  | T1–T7             | `i1-implementer-rules.md` describes a floor plan                                     | DROP           | process note for the controller; no code effect                                              |
| 17  | T2 c1             | «hold» read as `hostIdentity`                                                        | DROP           | nothing to do                                                                                |
| 18  | T2 c2             | stray identity of a random tag; equal-named replica overwritten with equal bytes     | DROP           | harmless                                                                                     |
| 19  | T2 c3             | replica already there, guard now refuses: old `.identity` stays, manifest names none | CARRY          | listed «нет», removed with the copy by rotation (after the I-3 fix, without stalling)        |
| 20  | T2 c4             | `clean` only safe with no copy in flight                                             | DROP           | existing rule                                                                                |
| 21  | T3 c1             | `established` semantics                                                              | DROP           | verified in Task 4 and by K04/M05-M07                                                        |
| 22  | T3 c3             | same `hostId`, other certificate: refusal names the id twice                         | DROP           | correct, rare                                                                                |
| 23  | T4 c1             | finishing run's summary loses the first run's revocation line                        | DROP           | documented (runbook §5 step 6, §6 step 6, AGENTS, spec §26)                                  |
| 24  | T4 c4             | M10/M20 equivalent                                                                   | DROP           | confirmed equivalent by reading                                                              |
| 25  | T4 dev 2          | aside folder made for a replaced identity without a database                         | DROP (accept)  | additive, never loses the only identity; record as a deviation                               |
| 26  | T5 c1             | list cannot tell «no key» from «damaged»                                             | CARRY          | documented («Не сделано»); needs a proto field                                               |
| 27  | T5 c2             | `identity.note` beyond the brief                                                     | DROP (accept)  | honest; record as a deviation                                                                |
| 28  | T5 c3             | tone `warn`                                                                          | DROP           | brief's choice                                                                               |
| 29  | T5 c4, T7         | no WebView2 check                                                                    | CARRY          | runbook §10 item 10                                                                          |
| 30  | T6 c1             | «revision monotonic» meaning                                                         | DROP           | РК behaviour; epoch covers it                                                                |
| 31  | T6 c2, c3         | epoch reaction of the shell link task; loopback only                                 | CARRY          | runbook §10 items 9 and 11                                                                   |
| 32  | T6 c4             | tamper (b) not malformed DER                                                         | DROP           | junk/short-key cases are in the identity unit tests                                          |
| 33  | T7 c3             | no manual instruction to remove `identity.partial`                                   | CARRY          | «спросите разработчика»; next restore removes it                                             |
| 34  | T7 step 8         | РК-С plan file absent from the tree                                                  | DROP           | deviation only                                                                               |
| 35  | review            | K07 (aside always when installing), K11 (clean keyed to `.db`) survive               | DROP           | equivalent: `would_orphan_host_data` forbids the case; the same pass removes the `.db` first |

**Fix wave (4 commits):**

1. `fix(standalone): the host identity is written through the handle the guard closed`. `identity.rs` `put_file`:
   - keep the `create_new` handle and write through it, with no reopen;
   - on Windows, `share_mode(0)` on that handle;
   - add a test with a guard that swaps the partial for a symlink inside `protect` (no key byte at the planted target);
   - update the module doc and runbook §2 / spec §26 wording («никто не может открыть файл, пока хост его пишет»);
   - add to §10 item 11: «копия ключа во второй папке на NTFS делается («есть»), при `share_mode(0)` `icacls` проходит».
2. `fix(standalone): an identity the service cannot delete never stops rotation or cleaning`. `folder.rs`:
   - `rotate` removes manifest, database, then identity;
   - an identity (or identity `.partial`) removal error is logged and skipped in `rotate` and `clean`;
   - adjust `rotation_stops_at_an_identity_it_cannot_remove…` (the `.db` is gone, the call returns `Ok`) and add a `clean` case;
   - runbook §2 and §10 item 11: older `.identity` files after a service-account change or new PC.
3. `fix(standalone): restore texts name the real button and what a finished interrupted restore did`:
   - m-1 (summary string);
   - m-2 (`Made::unchanged`);
   - m-3 (assert no `identity.partial` after a fully rolled-back swap).
4. `docs(standalone): a device revoked after the copy returns to a new-PC restore by itself`:
   - I-2 (runbook §6 step 7 order, check 3 wording, spec §26 line);
   - m-5, m-6, m-7.

The usual gates follow: cargo fmt, focused `--test restore`, `--test backup_copy`, `--test backup_worker`, `--lib`, prettier on the three markdown files, `git diff --check`.

## (c) Отклонения при исполнении (для раздела плана)

- Задача 1: защита файла ключа усилена сверх брифа:
  - файл `<имя>.identity.partial` создаётся исключительно (`create_new`, `0600`), закрывается охранником ещё пустым, и только потом в него пишется ключ;
  - старый `.partial` удаляется заранее;
  - чтение ограничено 64 КиБ (`MAX_IDENTITY_BYTES`);
  - `IdentityError::code()` даёт стабильные коды `identity_unreadable` / `identity_invalid`;
  - тестов модуля 18 вместо 7.
    Финальное ревью нашло, что ключ дописывается по пути после закрытия (гонка с открытым дескриптором на Windows и подменой ссылкой на Unix); исправление — запись через тот же дескриптор (`share_mode(0)` на Windows).
- Задача 2: сверх брифа 8 тестов `backup_copy` и 2 `backup_worker`. Якорь фикстуры `backup-state.json` найден по `sha256`, а не по имени файла. Ротация останавливалась на удостоверении, которое нельзя удалить; финальное ревью переводит это в предупреждение журнала (ротация и очистка не застревают).
- Задача 3:
  - `CopyIdentity::Damaged(String)` заменён на `Damaged(IdentityDamage { code, reason })`, ради стабильных кодов;
  - в `identity.rs` добавлен `read_beside_coded` (`read_beside` — обёртка над ним), хотя бриф этот файл не называл;
  - временные `#[cfg_attr(not(test), allow(dead_code))]` сняты в задаче 4;
  - добавлена таблица на 90 сочетаний с оракулом по Д6 и тест настоящего бинаря `verify-copy`.
- Задача 4:
  - помощник теста `installed()` берёт блокировку, как `start`;
  - папка `restore-<время>` создаётся и тогда, когда базы нет, а удостоверение каталога заменяется (Д8 говорил «если папка есть»);
  - добавлены точки обрыва `IdentityStaged`, `IdentityKeySaving`, `IdentityCertificate`, `IdentityInPlace`, а `finish_interrupted` получает `crash`;
  - `keep_replaced` копирует через синхронизированный `.partial` с переименованием;
  - после установки удостоверение должно прочитаться целиком, иначе маркер остаётся;
  - подготовленное удостоверение удаляется до маркера при откате;
  - тестов `--test restore` +13 вместо +5, `--lib` +2.
- Задача 5:
  - тексты `localNoIdentity` / `secondNoIdentity` называют все причины (прежняя версия, пропавший файл, FAT32/exFAT), потому что список не отличает «нет ключа» от «ключ испорчен»;
  - добавлена пояснительная строка `identity.note` под таблицей;
  - тестов Vitest +5 вместо +2.
- Задача 6:
  - сквозной тест расширен: удержание фактов, регистрация блоков, «Возобновить», вход офиса заново после смены адреса;
  - добавлены пять отрицательных случаев (копия без ключа, копия другого хоста, три вида порчи);
  - тестов 7 вместо 2;
  - «новый адрес» в тесте — другой порт петли, не другой ПК.
- Задача 7:
  - в документах используется настоящая надпись кнопки «Сменить адрес хоста», а не «Изменить адрес хоста»; строка сводки хоста исправляется финальным ревью;
  - файла плана РК-С `2026-10-11-standalone-rk-s-station-restore.md` в дереве нет, шаг 8 пропущен;
  - спецификация на ветке кончалась разделом 24, поэтому раздел 26 дописан в конец (раздела 25 нет);
  - сверх брифа исправлены устаревшие места памятки и спецификации: шапка, раздел 7, раздел 8 «Не реализовано», перекрёстные ссылки, §22.
- Финальное ревью добавило в памятку:
  - на новом ПК устройство, отозванное после копии, подключается само: сначала отзыв заново под другим адресом, потом адрес старого ПК;
  - проверка подмены ключа не ловит подмену с правкой манифеста;
  - права NTFS на флешке не защищают ключ;
  - отмена восстановления на новом ПК не возвращает прежнее удостоверение.

## Evidence

- **Worktree:** `git worktree add --detach /tmp/claude/wt/rv-i1 9942dcf7c`. Build state was cloned from integ (`cp -c -R -P`, 96 s), then `cargo build --workspace --tests --offline --locked` succeeded (exit 0).
- **Baseline:** `cargo test -p markiro-host --test restore --test backup_copy --test backup_worker --lib` passed: lib 114, backup_copy 40, backup_worker 17, restore 50, 0 failed (`/tmp/claude/rv-i1-base.log`).
- **Mutants:** the harness is `/tmp/claude/rv-i1-mut/mutate.py`, with logs in `/tmp/claude/rv-i1-mut/logs/` and the summary in `/tmp/claude/rv-i1-mut/run1.txt`. Each mutant was applied to a pristine copy and restored, and the sha256 was asserted after each one. Final hashes: `restore.rs` c41ea3aabd34…, `folder.rs` ab4d7b84c7bd…, `identity.rs` 42f9c854c621…; the `restore.rs` hash equals the Task 4/6 reports. Files were touched after the restore, and `git status --short` is empty.

| Id  | Mutant                                                  | Result                                                              |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| K01 | no `remove_identity_staging` after `finish_interrupted` | KILLED (an_identity_staged_before_a_cut_goes_with_the_next_restore) |
| K02 | certificate renamed before the key                      | KILLED (a_restore_cut_off_twice_inside_the_identity…)               |
| K03 | `None => Install` before the `Keep` arm                 | KILLED (both identity_plan tables)                                  |
| K04 | `established` counts a folder without a database        | KILLED (an_identity_without_a_database_is_kept_aside…)              |
| K05 | fully rolled-back swap keeps the staged identity        | **SURVIVED** → m-3                                                  |
| K06 | folder identity never read                              | KILLED (3 tests)                                                    |
| K07 | aside folder whenever installing                        | SURVIVED, equivalent                                                |
| K08 | replaced identity not kept aside                        | KILLED (3 tests)                                                    |
| K09 | main run never installs the staged identity             | KILLED (3 tests)                                                    |
| K10 | report forgets the replaced host                        | KILLED (3 tests)                                                    |
| K11 | `clean` keys orphan identities to the `.db`             | SURVIVED, equivalent (same pass removes the `.db` first)            |
| K12 | guard refusal ignored                                   | KILLED (3 tests)                                                    |
| K13 | `replicate` without the SHA-256 compare                 | KILLED (identity unit tests)                                        |

- **Read:** the full diff of `identity.rs`, `restore.rs`, `copy.rs`, `folder.rs`, `worker.rs`, `tls.rs`, `main.rs` and the webview; `install.rs` (service `LocalService`, data-folder ACL); shell `device.rs::change_address` and `tls.rs::FingerprintVerifier`; runbook §2, §5-§7 and §10; spec §26; the AGENTS and install-runbook diffs.
- **Not run:** Windows (`icacls`, `share_mode`, OWNER RIGHTS, AV, shares), the shell e2e `--test restore_identity` (loopback, unsandboxed; the implementer's 7/7 with 15 mutants stands), Vitest (the webview diff was read, and the Task 5 mutants covered it), and the full cargo workspace (per instructions).
