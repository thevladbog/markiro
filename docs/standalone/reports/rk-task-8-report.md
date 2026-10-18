# Plan РК, task 8 — report (the runbook, AGENTS.md, the pilot spec, the full check)

Status: DONE_WITH_CONCERNS (concerns: items the runbook states that no test and no Windows run could confirm; two inherited open items; see the end).
Worktree `/tmp/claude/wt/inf`, branch `claude/infra-rk`, base `529eb7427`. Commits:

- `c22bdc5d2` docs(standalone): the backup and restore runbook, AGENTS «Backups and restore», the pilot spec takes plan РК's refinements
- `cfddf8b15` test(standalone): the started host's office test waits for the recorded attempt, not only the copy

Each commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line; so do all 10 commits of the range `370ec784c..HEAD`. `git status --short` is empty.

## What was done

Documents were written against the code at HEAD (restore.rs, worker.rs, routes, `ru.json`, `host-link.ts`, `reference-sync.ts`) and all of rk-task-1..7 reports, rk-task-5-review and ALL ten rk-minors items. The brief's drafts were corrected wherever Tasks 5-7 changed the truth (see "Brief text that was untrue").

### `docs/runbooks/standalone-backup-restore.md` (new, 394 lines, Russian)

Sections: 1 what the host does by itself; 2 the second folder (UNC not drive letters, `\\PC\Share` never `\\?\UNC\…`, the service account, "who sees the copies", the weekly USB stick, `verify-copy`); 3 weekly check; 4 when to restore (30-day warning, what a restore does not bring back); 5 restore on the same PC; 6 restore on a new PC; **7 «Памятка о восстановлении: проверки перед "Возобновить приём данных станций"»** (the section the Task 7 dialog points to); 8 cost and limits; 9 post-restore checklist; 10 Windows-only manual test list.

Required content, where it is:

- Resume dialog text and "no station code exists yet (РК-С)": section intro and 7. Checks 1-5 are done BEFORE pressing resume: (1) every SSCC counter above the last printed number plus two block sizes, per station, boxes and pallets, with the SSCC split into extension/prefix/serial/check and a worked example (`046006820000123453` -> serial 12345; the check digit was computed); the half-rule reasoning for "two blocks"; extra caution when the summary says "not read"; (2) shift numbers; (3) revocations, depending on the summary line ("carried over" vs "was not read"); (4) devices and shifts that appeared after the copy; (5) the feed resync.
- Every office session ends at a restore; revocations may return when the previous database was not read: 7.3, 4, 5 (summary lines quoted).
- `sc stop MarkiroHost` then wait for `STATE: STOPPED` (`sc query`): 5.4, 6.2 (and why: the lock is released before the process ends).
- Interrupted restore: run the same command again; marker `host.restore-intent`, `start` refuses while it exists, the three-state table in prose, "call support" message, never delete the marker by hand: 5.6.
- ~1 % serial-range cost per restore, 100 000 rounded up to 10 000, applies to Unreadable AND Absent (the brief said "two blocks" for a new PC: wrong, fixed): 6.3, 8.
- Stations do not re-register blocks (РК-С); the station resync after a restore is best effort (cursor at or below copy-rev+1 does not notice; nor one that reconnects after later host writes): intro, 7 check 5, 8.
- All station facts and code checks get 503 `restore_pending`, `Retry-After: 60`, until an admin resumes; stations keep working offline, retry on their own backoff (2..60 s, does not read `Retry-After`), blocks/shifts/feed/office not held: 5.8.
- Password changes after the copy not carried; the copy's devices not revoked when from another host: 4, 6.4, 7.3.
- Copies hold PIN/badge hashes and pairing keys; folder ACLs are the administrator's job, second folder on another drive/USB/share, USB (FAT/exFAT has no ACL): intro and 2.
- Where copies land (`%ProgramData%\Markiro\Host\backups`), retention (24 / 14 days / 12 months, UTC, only `markiro-host-*`), `verify-copy` use, aside folders `restore-<time>` never deleted (disk space), free space not pre-checked (full disk handled afterwards as `disk_full`): 1, 2, 5, 8.
- Post-restore checklist: 9. Windows-unverified items as a manual test list (UNC timeouts, rename vs antivirus, folder flush, ACL inheritance, `sc start` refusing while the marker exists, service account rights, USB pulled mid-copy, a really full disk, WebView2 page): 10.
- Also covered from rk-minors: clock-set-back retention caveat (item 6, NOT fixed in code: documented in 1 and AGENTS), restart copies at once (7), the "copy now" 500-after-queued oddity (8), migration 0011 after 0012 (1, AGENTS), `\\?\UNC\` refused (2), hung share/process exit (10), undo via `restore restore-<time>\host.db --without-manifest` with WAL folded (5.10).

### `apps/standalone/AGENTS.md`

- Audit paragraph: the five new actions (`backup.create`, `backup.settings.update`, `host.restore`, `host.restore.resume`, `sscc.block.register`) and a note that the file SHA-256 in those rows is a checksum, not a credential hash (the "never hold hashes" sentence would otherwise be untrue).
- Fixed the sentence Tasks 1-7 made untrue in "Reference sync": "A host restored from a copy ... goes unnoticed until the feed carries an epoch (plan 5)". It now says the host answers copy-revision+1, stations whose cursor passed it restart from zero, best effort, the epoch wipe is РК-С's.
- New section "Backups and restore" (before "Marking rules"): worker/copy/schedule/second folder/retention/state/audit, the office routes and page, restore (build beside, swap, marker, floors, revision, revocations, sessions, margins, WAL fold, hidden crash hooks), known blocks, the hold layer (`Retry-After: 60`), what РК-С must still do, the migration order note, what no test shows.

### `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`

New section **19 «Уточнения плана РК»** (next free on this branch, §18 is ПЛ-Х) with a sentence naming the clash risk (ПЛ-Ц §19, ЧЗ §20, О-Ф §21 also append: renumber at merge; the references "раздел 19" in the runbook header and AGENTS section must follow). §11 got a pointer, and "6 задач, около 1,7 тыс. строк" became "исполнен в 8 задачах ... РК-С не написана". Not touched: the plans table (§12.2, task count 6, stream total 26): flagged below.

### Test-only flake fix

`host/tests/backup_start.rs::the_office_of_a_started_host_reads_its_copies` now waits for a non-null `local.lastAttempt` as well as a non-empty copy list (the worker renames the copy in before it records the attempt). Pure test change. 6 consecutive unsandboxed runs of that test passed (`/tmp/claude/rk8-flake-{1..6}.txt`) and the full workspace run passed. The flake was 1/6 before, so six greens are consistent with, not proof of, the fix; the cause is the ordering described in rk-minors 9 and in the Task 5 report.

## Brief text that was untrue and was corrected

- Runbook 5.7 "wait until stations return blocks": no station code; replaced by the SSCC checks and an explicit administrator decision.
- 5.10 "undo by deleting host.db and moving files back": replaced by the supported `restore restore-<time>\host.db --without-manifest`.
- 5 "if restore failed after the move it put it back, no restore-<time> folder": now the build-beside design (nothing changed before the swap; swap failure puts files back; power cut leaves the marker).
- 6.3 new-PC margin "two blocks": it is the unread margin (>= 100 000, rounded to 10 000, and >= two blocks).
- 1 "a copy without a manifest goes at the next start": it goes before the next copy (both folders).
- Retention "last copy of each of the 14 last days": days/months that have copies.
- AGENTS item 3's anchor (`gets 401). A block's use ...`) is the wrong place now (the file grew to 3000+ lines; that text is in the shift section): the new section was inserted before `## Marking rules` by meaning (Anchor adaptation 1). Item 2's fragment matched.
- The Task 7 UI strings were respected: «Возобновить приём данных станций», "Проверки SSCC выполнены ...", «Резервные копии», «Устройства → Подключить устройство», «SSCC → Счётчики номеров / Размеры блоков», «Отклонено хостом» / «Не отправлено» are the strings in `ru.json`.

## Anchor adaptations

1. AGENTS.md: the "Backups and restore" section placed before `## Marking rules` (the brief's anchor text no longer exists in that form). Mechanical.
2. Spec: the brief's fragment (end of §11 followed by `## 12`) was not used; the refinements became §19 as the dispatch said, and §11 got a pointer. The spec's §18 (ПЛ-Х) is already there.
3. Runbook and AGENTS text rewritten per Tasks 5-7 as listed above (semantic content, but dictated by the reports, not a plan contradiction; no NEEDS_CONTEXT).

## The full check (all on the final HEAD `cfddf8b15`, nothing run in parallel)

| Check                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --offline --locked --workspace --no-fail-fast`, ONE full unsandboxed run (`/tmp/claude/rk8/cargo-full.txt`)                                                        | exit 0, 63 `test result: ok` lines, 960 passed, 0 failed, 0 ignored, no `warning:` / `FAILED` in the output. Plan expected 44 lines / 477 for `-p markiro-host -p markiro-proto`; the whole workspace is 63 / 960 (same as Task 6's final; Task 8 adds no Rust test, only changes one) |
| Vitest, ONE full run at `--testTimeout=60000 --hookTimeout=60000` (`/tmp/claude/rk8/vitest-full.txt`)                                                                          | exit 0; 107 files, 3116 tests passed (plan 70 files / 1766 is the plan's own count; the branch has more files; Task 7 measured 107 / 3116 too)                                                                                                                                         |
| `typecheck`, `lint`, `build` (webview)                                                                                                                                         | exit 0 each, no output beyond the command echo                                                                                                                                                                                                                                         |
| `cargo fmt --all -- --check`                                                                                                                                                   | exit 0, no output                                                                                                                                                                                                                                                                      |
| `cargo check -p markiro-host -p markiro-proto --all-targets`                                                                                                                   | exit 0, 0 warnings                                                                                                                                                                                                                                                                     |
| PRETTIER GATE over every md/ts/tsx/json changed in `370ec784c..HEAD` (39 files, list in `/tmp/claude/rk8/prettier-files.txt`), run from the worktree root with `--ignore-path` | "All matched files use Prettier code style!", exit 0. Live proof: a deliberately mis-formatted scratch `apps/standalone/zz-rk8-scratch.ts` printed `[warn]` and exit 1, then deleted. (`.rs`, `.sql` and `.css` are not prettier-covered)                                              |
| `git diff --check 370ec784c..HEAD`                                                                                                                                             | clean                                                                                                                                                                                                                                                                                  |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                                                                                                    | only `src/host/pairing-code.ts:66`                                                                                                                                                                                                                                                     |
| Files that must not change in the range                                                                                                                                        | none changed except the NEW `host/migrations/0011_backups.sql`: no `Cargo.toml`/`Cargo.lock`/`package.json`/lockfile, `apps/station`, `packages/*`, `apps/api`, `src-tauri`, and no migration `0001`-`0010`/`0012`                                                                     |
| Commits                                                                                                                                                                        | 10 in the range; each ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`                                                                                                                                                                                  |

Delayed-`setImmediate` stand: not applicable (no React/effect test added in this task). Mutants for the Rust test fix: dropping the `lastAttempt` wait reproduces the race only under load, nondeterministic, no one-line mutant can be killed deterministically (the same statement as Task 3/4 reports). No new guard in code was added.

## Not verified (named separately, as the plan requires)

Everything in runbook section 10: the Windows service under a chosen account writing to another PC's share (and `LocalService` being refused), UNC paths and their timeouts, a USB drive pulled mid-copy and its letter, error codes from Windows, a really full disk (only `max_page_count` was simulated), rename against antivirus, folder flush, ACL inheritance of `restore-<time>` / staged / copy files, `sc stop`, `STATE: STOPPED` timing, `sc start` refusing while `host.restore-intent` exists, `markiro-host restore` from the administrator's console, the page in WebView2, and the teaching restore with the station sending (needs РК-С). Also the runbook's check 1 is a procedure no one has run on a real line; the "two block sizes" bound is derived from the half rule (plan 2a6) in `block-supply.ts`, not measured. The statement in the runbook that the station retries with 2..60 s backoff comes from `host-link.ts`/`nextSyncRetryMs` (tested elsewhere), but the live behaviour against a real `restore_pending` 503 (status bar text, the `HostError` mapping) has not been observed (`errors.api.restore_pending` has its string, the station floor does not use code checks yet).

## Concerns

1. **Open from rk-minors, not fixed here (no feature code in Task 8):** item 6 (a fresh verified copy could be rotated away first if the clock is set back by more than 24 newer copies): documented in the runbook and AGENTS, no code or test; item 8 (start_backup returns 500 though the copy is queued): documented. Both are for the FINAL WAVE if wanted.
2. The plans table in the spec (§12.2 row РК: 6 tasks, ~1.7k lines; §12.5 stream totals) still says 6 tasks; I changed only §11's sentence and left the tables (editing sums would be guessing at the owner's schedule).
3. The runbook has a checks procedure the dialog depends on; the owner should read the wording of section 7 and of the dialog together (Task 7 report already asks that for the dialog).
4. `rk-implementer-rules.md`'s opening paragraph (another plan's scoping) was ignored as instructed.
5. Section numbering in the spec (§19) will clash with ПЛ-Ц/ЧЗ/О-Ф at merge; the text says so and names what to renumber.
