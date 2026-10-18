# Plan I1, Task 5 report: the office says which copies carry the host identity and warns when the newest lacks it

Status: **DONE_WITH_CONCERNS**. Commit `3a1afe3fd` on `claude/m2` (BASE `3e49763f6`). `git status --short` is empty after the commit. One `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## What was done

Web view only. No Rust, `proto`, Zod or fixture change: Task 2 had already added `hostIdentity: boolean` to `BackupCopy` (Rust, fixture, Zod, `test/support/backups.ts`), so the two parity tests were not touched. Their Vitest side (`backups.test.ts`) is inside the full run.

- `backup-warnings.ts`: new warning kinds `localNoIdentity` and `secondNoIdentity`. Rule `withoutIdentity`: the NEWEST copy of the folder lacks the key (an older copy does not count). Both are tone `warn`. JSDoc updated.
- `BackupsPage.tsx`: column «Ключ хоста» (есть / нет, words, not colour). A paragraph «newPc» in the «Восстановление» card. A note under the copy table (only when there are copies).
- `ru.json`: keys `table.identity`, `identity.{yes,no,note}`, `warnings.{localNoIdentity,secondNoIdentity}`, `restore.newPc`. The duplicate-key check by parsing the JSON with a pair hook found none. No key material, hash or code appears in any text.

## Honesty of the texts (differences from the brief's wording)

The list shape carries only a boolean. In `host/src/backup/folder.rs::list` the host sets it as "the manifest names an identity AND a file of the manifest's size lies beside the copy". The key is read whole and matched to the certificate, and its hash is checked, when the copy is made (`attach`, `replicate`). The listing does not re-read it. So:

- The brief's `warnings.*NoIdentity` texts said the host "could not close the key" / "the copy lacks a key". The data cannot tell that from an older build's copy or a file that went missing, so my texts name all the causes: older host version, lost key file, and for the second folder the usual cause (FAT32/exFAT) too. They state the consequence («потребует подключить все устройства заново») and the action: for the host folder «Сделайте копию сейчас; если предупреждение не уходит, сообщите разработчику»; for the second folder, take the transfer copy from the host computer or an NTFS folder.
- New note `identity.note` under the table: «Есть» means the host read its key at copy time, matched it to the certificate and put it beside the copy; when listing it only checks that the key file is there and of the right size; integrity is checked by `markiro-host verify-copy` and by the restore itself. (There is no "verified at" timestamp in the data, so the note says "at the time of the copy" and the row already shows the copy's time.)
- The brief's `restore.newPc` is used verbatim.

## RED / GREEN

- RED (`/tmp/claude/impl-t5-red.txt`): the brief's two tests failed, 2 failed / 53 passed.
- GREEN (`/tmp/claude/impl-t5-green.txt`, `--reporter=verbose`, `backup-warnings`, `backups-page`, `backups`): 65 passed, stderr empty (0 bytes).
- Delayed-`setImmediate` stand (the plan C stand copied from its notes; both temporary files removed, tree clean): `backups-page` + `backup-warnings` 58 passed.
- Typecheck, lint, build: exit 0.
- **Full Vitest** `exec vitest run --testTimeout=60000 --hookTimeout=60000`: **148 files, 4612 tests passed**, exit 0.

Test counts: plan +2 (one in each file). Measured +2 for the brief's tests, plus 3 added by me in `backups-page.test.tsx`: the healthy page with all «есть» and the note; the second-folder warning with its tone word; no note without copies. In total +5.

## Mutants (harness `/tmp/claude/impl-i1-t5/mut.py`, log `mut.txt`; each is restored to its sha256 inside the harness, and `git status` clean afterwards)

| Id  | One-line mutant                                    | Result                                                                                                | Killed by                                                     |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| M1  | `withoutIdentity` without `!`                      | KILLED                                                                                                | 12 tests (quiet-when-healthy first)                           |
| M2  | `copies.some(!hostIdentity)` instead of the newest | KILLED                                                                                                | warns of a newest copy without the key (older-copy assertion) |
| M3  | second folder never warned                         | KILLED                                                                                                | warnings test + page second-folder test                       |
| M3b | second warned with the `local` kind                | KILLED                                                                                                | same two                                                      |
| M3c | local never warned                                 | KILLED                                                                                                | warnings test + brief page test                               |
| M4  | column always «есть»                               | KILLED                                                                                                | brief page test                                               |
| M4b | есть/нет swapped                                   | KILLED                                                                                                | brief page test + healthy-page test                           |
| M5  | note shown with no copies                          | KILLED                                                                                                | "no key note while there are no copies"                       |
| M5b | note never shown                                   | KILLED                                                                                                | healthy-page test                                             |
| M6  | `restore.newPc` paragraph dropped                  | KILLED                                                                                                | brief page test                                               |
| M7  | column React `key` renamed                         | SURVIVED, **equivalent** (the key is only React's column id; the column title and cells are asserted) | —                                                             |
| M8  | `secondNoIdentity` tone `error`                    | KILLED                                                                                                | warnings test (`warningTone` = warn)                          |

Restore proof: `cmp` of `backup-warnings.ts` against the pre-mutation copy `/tmp/claude/impl-i1-t5/bw.orig` after M8, and the harness asserts the sha256 after each mutant.

## Gates

Prettier gate proven live (scratch `.ts` failed with exit 1, deleted) and then clean on the five changed files; `git diff --check` clean; `grep -rnF '\u04'` finds only `pairing-code.ts:66`; no scratch file in the tree.

## Anchor adaptations

All anchors matched exactly once. The one JSDoc line of `backupWarnings` ("`no second folder,` дописать …") was put by meaning into the existing text. The prose around it was already wrapped at an odd place, which prettier left alone.

## Concerns

1. **The list shape cannot tell "no key" from "damaged key" or "key does not match the manifest"**, which the dispatch asked the warnings to distinguish. The host maps both to `hostIdentity: false`. Telling them apart needs a host/proto/Zod change (a state field, the code from `IdentityError::code()`), and Rust is not in this brief. The texts therefore name all causes and recommend the one action that is right for all of them (copy now). A reviewer who wants the three states must add a follow-up task touching `Manifest::copy`, `proto/src/backup.rs`, the fixture and both parity tests.
2. **`identity.note` is an addition beyond the brief.** It is the honest answer to "say when it was verified"; remove it if the owner prefers the brief's bare column (M5/M5b and the two extra tests would go with it).
3. The tone of the new warnings is `warn` as the brief's test requires; a copy with no key is serious for a restore on a new PC, but it does not break the copies themselves.
4. Browser/visual confirmation was not done (jsdom only).
