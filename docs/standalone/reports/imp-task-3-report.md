# Report: plan ИМП Task 3 - export.sql, the CLI, the CI jobs

Status: DONE_WITH_CONCERNS. Commit: a7f32d9de `feat(standalone): cloud export: export.sql against a restored copy, the CLI and its CI jobs` on claude/imp-cloud (worktree /tmp/claude/wt/imp, base 2902c3849). Owner authorisation (OWNER-DECISIONS 2026-10-11, option A) is what lets the file carry pinPhc/badgePhc/badgeSalt; nothing the CLI prints or any error names a hash, salt or code (tests below).

## What was done

- The brief's files were extracted programmatically from the brief (no retyping): `export.sql`, `cli.mjs`, `seed-cloud.sql`, `cleanup-cloud.sql`, `cli.test.mjs`, `export-sql.test.mjs`; affected.mjs, package.json script (already there from Task 1), ci.yml and affected.test.mjs edits applied per the brief (anchors matched once, no adaptation needed except: ci.yml already ran `pnpm test:standalone-export` in the standalone-windows job after Task 1; kept).
- RED: `node --test cli.test.mjs export-sql.test.mjs` without cli.mjs -> `ERR_MODULE_NOT_FOUND ... cli.mjs` (exit 1). GREEN after the brief's code: cli tests 5/5, SQL test 1/1 (Postgres), tools/ci 56.
- imp-minors addenda (items 1 and 3), all done and tested:
  - Item 1 / "surface every dropped non-zero counter": already a hard `shift_counter_unreadable` in Task 2; Task 3 adds the cross-check: `export.sql` prints `shiftNumberMaxima` (max(number_seq) per month_key, all statuses); `transform.mjs` throws `shift_counter_behind` when a month has shifts past its counter or no counter (rehearsal does not skip it; a counter equal or ahead is fine).
  - Item 3 (m4) cross-tenant prefix use: `export.sql` prints `otherTenantsSscc` (READ-ONLY, other tenants' max of next_serial-1, to_serial, box and pallet SSCC serial, only under this tenant's 9-digit prefixes, extension 0/1, format-guarded). It is NOT fed into the file (the golden file and the brief's expected CLI output / 24 notes / checksum must stay byte-identical for tasks 4-8): the CLI prints a stderr warning per row, "could repeat" when the other tenant's max >= the standalone start. Runbook line is Task 9's (see concerns).
  - m5: `affected.mjs` already sends every `apps/standalone/**` path (incl. `proto/fixtures/sscc-serials.json`) to verify_static; added a test pinning that for sscc-serials.json, the golden file and `packages/domain/src/gs1/sscc.ts`. The domain-equivalence test's bare `catch {}` is narrowed to `ERR_MODULE_NOT_FOUND` (proved: corrupt dist -> test FAILS, removed dist -> skip, good dist -> pass). verify-static now runs `pnpm turbo run build --filter=@markiro/domain` before `pnpm test:standalone-export` (the Windows job already builds it).
  - Task 2 report: `transform.mjs` now calls `assertRawShape`: every list and count `export.sql` prints must be there (`export_output_invalid`, not a TypeError/silent `undefined > 0`), also `formatVersion` 1 and raw being an object.
  - CLI: file written `wx` with mode 0600 (tested via statSync); `--help`/`-h` with the libpq connection, the 0600 rule and, for Windows, "rights are inherited from the folder: write into your user profile folder, not a shared drive; delete after the import"; after every written file (rehearsal too) stderr carries the credential-verifier warning (hashes, salt; DELETE after the import); never a hash/salt/code in any output (tests scan stdout+stderr for the golden file's salt, every PHC, `pbkdf2$` and three badge codes); psql password never in argv (fake psql records argv/env: argv has no password, libpq env arrives).
- Live-test additions beyond the brief (seed, test and cleanup grew; the first tenant's export still equals raw-cloud.json, whose only change is the two new keys; the golden file `cloud-export-file.json` is UNCHANGED, checked by git diff): other-tenant rows for each source of `otherTenantsSscc` (counter, block x2, box, pallet), an extension and a prefix that must not count, malformed SSCCs (own box/pallet, other box/pallet), a station with no block, a later-closed shift and a counterparty-issued shift of the other tenant, a revoked non-operator badge, non-operator badge/defaults/counterparty of the other tenant. Dynamic steps in `export-sql.test.mjs`: `lost` causes (default counterparty, photo), stale-station rules (seen exactly at the last close, one second earlier, blocks revoked, station revoked, no shift ever closed), read-only/REPEATABLE READ proved live (a write after export.sql's own BEGIN line fails with "read-only transaction"; `SHOW transaction_isolation`), a temp table shadowing `products` with an extra column and an unknown extra table is tolerated, a temp `products` without `print_name` makes psql fail naming it (so a missing required column fails loudly, no output), and a missing tenant yields lists that the transform turns into `tenant_not_found`.
- New static test file `test/export-sql-static.test.mjs` (no DB): exactly 3 statements (BEGIN ... READ ONLY, one WITH/SELECT, COMMIT), no write verb / side-effect function / psql meta-command in the comment- and literal-stripped script.
- Extra CLI tests: `--help`, credential warning, shared-prefix warnings with boundary (29999 vs 30000), refusals write no file (`shift_counter_behind`, `export_output_invalid`), fake-psql argv/env/exit-code/ENOENT, tenant-id validation boundary (64 ok, 65, empty, ., /, space, quotes, newline, non-ASCII), file naming without INN, summary for unknown owner/empty counters/no window/rehearsal.
- `tools/ci/test/workflow.test.mjs` gets one test pinning the two ci.yml steps (domain build before the pure run; SQL run after db:migrate with the job's DATABASE_URL).

## Anchor adaptations

- None semantic. Brief step 4 expects `tests 28 / skipped 1` for the whole tool; Task 1+2 already had 89 tests, so totals differ (below). `tools/ci` base measured 54 (plan: 47 -> 48).
- The brief's `ssccPrinted` mutant 2 text (`WHERE extension IN (0, 1) AND issuer_prefix IN (...)`) matches once; `badges` mutant 1 text `AND b.revoked_at IS NULL` occurs three times (badges, nonOperatorBadges, stale EXISTS) so mutants used occurrence indexes.
- packages/db has new migrations (to 0185); the seed inserts still match the schema (verified live).

## Tests: plan vs measured

- `pnpm test:standalone-export` WITH Postgres: tests 108, pass 108, fail 0, skipped 0 (cli 13, transform 54, sscc 38, export-sql-static 2, export-sql 1 (live)). Without a DB: 108 tests, 107 pass, 1 skipped (the live SQL test: "set STANDALONE_EXPORT_TEST_DATABASE_URL to a disposable cloud database"). Plan said 28/27+1 for the tool alone and 48 for tools/ci.
- tools/ci: `node --test tools/ci/test/*.test.mjs` run unsandboxed: 57 pass (54 at the base + 3 new: the brief's classifier test, the m5 file-selection test, the workflow-step test).
- Postgres tests that RAN: the live `export-sql.test.mjs` (1 test, many assertions) against a private podman postgres:17-alpine on 127.0.0.1:55712 migrated with `pnpm --filter @markiro/db db:migrate` (migrations to 0185 applied offline; registry not needed), and an end-to-end CLI run against the same DB (exit 0, file mode -rw-------, payload and notes equal to the golden file, second run exit 1 EEXIST, unknown tenant exit 2). Skipped: none with DB.
- Note: port 55611 (the plan's) was shared with some other process during my first runs (rows appeared and vanished between my psql calls); I switched to a private container on 55712. Both containers were removed afterwards.

## Mutants (every new guard; harness /tmp/claude/impl-imp-t3/{mut,node_mutants,sql_mutants}.py; originals compared by sha256 after each, every row restored=True)

### transform.mjs (16 mutants, all KILLED)

shape call removed; RAW_LISTS minus otherTenantsSscc / shiftNumberMaxima; list check only `undefined`; count -1 allowed; count any number; formatVersion unchecked; array accepted as raw; `last > max`; `last >= max-1`; behind skipped in rehearsal; missing counter reads 0; wrong code; counters map Infinity; wrong shape code; month key ignored. First failing tests: "an output that lacks a list or a count...", "shifts that hold numbers past their month's counter...", and the CLI refusal test.

### cli.mjs (30 mutants, 30 KILLED; one survived the first run)

Survivor C15 (usage says 0644: the text still matched /0600/ through the Windows line) -> the help test now matches "только для владельца (права 0600 на macOS и Linux)"; re-run KILLED. Others: -h not taken; help exits 1; credential warning missing / on stdout / without DELETE; overlap `>` vs `>=`; overlap never claimed; warnings not printed; matched by prefix only; mode 0644; overwrite flag; psql without ON_ERROR_STOP / -t / env / failure ignored; usage without Windows rule / password rule; refusal exit 1; ExportError not recognised; JSON.parse quoting (brief mutant 4); tenant regex {0,64}, {1,65}, dot allowed, no anchors; file name without INN fallback / slice(0,9); summary unknown owner / no-window text. Equivalent mutant noted, not run: dropping `start !== undefined &&` in `sharedPrefixWarnings` (`x >= undefined` is false anyway).

### affected.mjs (4 KILLED), ci.yml (4 KILLED)

prefix typo; only static; only api; apps/standalone generic return -> Rust only (killed by existing "Standalone native and web changes" test); domain build step removed; export step removed from static; SQL url changed; SQL step before migrations.

### export.sql (66 mutants, 66 KILLED after seed strengthening)

First run had 14 survivors (last_close of another tenant, counterparties/box-defaults/pallet-defaults/nonOperatorBadges/counterparty-issued of another tenant, revoked non-operator badge, printed-extension filter, printed/other pallet format guards, other max-vs-min); the seed gained the rows listed above; second run: all killed. Includes: every `tenant_id = :'tenant_id'` dropped one at a time (26), the four `<>` flipped, brief mutants 1-3, READ ONLY / isolation / added write (killed by both static and live tests), format guards x4, extension/prefix filters, max/min swaps, stale-station rules, `lost` causes, organization row scoping.

| #   | mutant                                    | killed by                                                              |
| --- | ----------------------------------------- | ---------------------------------------------------------------------- |
| S1  | S-tenant#0 (line 14) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S2  | S-tenant#1 (line 16) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S3  | S-tenant#2 (line 21) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S4  | S-tenant#3 (line 24) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S5  | S-tenant#4 (line 27) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S6  | S-tenant#5 (line 37) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S7  | S-tenant#6 (line 38) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S8  | S-tenant#7 (line 41) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S9  | S-tenant#8 (line 46) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S10 | S-tenant#9 (line 51) filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S11 | S-tenant#10 (line 55) filter dropped      | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S12 | S-tenant#11 (line 59) filter dropped      | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S13 | S-tenant#12 (line 73) filter dropped      | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S14 | S-tenant#13 (line 80) filter dropped      | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S15 | S-tenant#14 (line 85) filter dropped      | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S16 | S-tenant#15 (line 89) filter dropped      | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S17 | S-tenant#16 (line 95) filter dropped      | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S18 | S-tenant#17 (line 102) filter dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S19 | S-tenant#18 (line 112) filter dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S20 | S-tenant#19 (line 118) filter dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S21 | S-tenant#20 (line 145) filter dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S22 | S-tenant#21 (line 149) filter dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S23 | S-tenant#22 (line 154) filter dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S24 | S-tenant#23 (line 156) filter dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S25 | S-other#0 (line 129) <> became =          | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S26 | S-other#1 (line 132) <> became =          | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S27 | S-other#2 (line 135) <> became =          | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S28 | S-other#3 (line 138) <> became =          | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S29 | badges: revoked included                  | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S30 | nonOperatorBadges: revoked included       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S31 | stale: block revoked filter dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S32 | printed: prefix filter dropped            | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S33 | printed: extension filter dropped         | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S34 | other: prefix filter dropped              | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S35 | other: extension filter dropped           | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S36 | printed boxes: format guard dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S37 | printed pallets: format guard dropped     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S38 | other boxes: format guard dropped         | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S39 | other pallets: format guard dropped       | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S40 | other counters: next_serial not minus one | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S41 | other: max became min                     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S42 | printed: max became min                   | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S43 | blocks: max(to_serial) became min         | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S44 | blocks: max(consumed) became min          | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S45 | maxima: max(number_seq) became min        | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S46 | maxima: grouped by nothing useful         | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S47 | last close: max became min                | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S48 | active: status widened                    | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S49 | planned count: wrong status               | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S50 | counterparty-issued: inverted             | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S51 | stale: revoked device counted             | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S52 | stale: needs a close dropped              | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S53 | stale: <= instead of <                    | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S54 | stale: > instead of <                     | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S55 | stale: never-seen not stale               | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S56 | stale: block not linked to device         | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S57 | lost: counterparty cause dropped          | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S58 | lost: photo cause dropped                 | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S59 | lost: egais cause dropped                 | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S60 | lost: external ref cause dropped          | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S61 | lost: price cause dropped                 | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S62 | tenant row: not scoped                    | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |
| S63 | first line: not READ ONLY                 | export.sql is one read-only repeatable-read transaction around one SEL |
| S64 | first line: READ COMMITTED                | export.sql is one read-only repeatable-read transaction around one SEL |
| S65 | adds a write                              | export.sql is one read-only repeatable-read transaction around one SEL |
| S66 | no format version                         | export.sql reads one tenant, at one snapshot, exactly as the raw fixtu |

## Gates

- `pnpm test:standalone-export` (with and without DB), tools/ci tests unsandboxed: above. `git diff --check` clean. Prettier gate: `node_modules/.bin/prettier --ignore-path .prettierignore --check tools/standalone-export package.json .github/workflows/ci.yml tools/ci` from the worktree root -> "All matched files use Prettier code style!"; proven live with a mis-formatted scratch `.mjs` (`[warn]`), deleted. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` -> only pairing-code.ts:66. `git status --short` empty after the commit. Not run (not applicable): cargo, Vitest/typecheck/lint/build of the standalone package.

## Concerns

1. `otherTenantsSscc` is a warning on stderr, not an input to the standalone start numbers or a file note, to keep the golden file/notes (24) and checksum stable for tasks 4-8. If the owner wants the start raised automatically, that is a transform + golden change; Task 9's runbook must tell the operator to read the warning and the cloud-reseed step (cutover memo line).
2. `shift_counter_behind` stops the export (like `shift_counter_unreadable`) rather than raising the counter with a note; a cloud whose counter is behind its shifts is an anomaly to look at, and a new note code would need Task 8's `import-notes.ts`. The cloud's counter and shifts agree in the seed; real data not seen.
3. The cross-tenant box/pallet scan reads `boxes`/`pallets` of all tenants with a `substr` predicate (no index): on a large restored copy it is a sequential scan, once per export.
4. psql's own stderr is inherited (brief design); an SQL error message could quote a value of the failing expression (only SSCC-like columns are cast), never a credential.
5. The default file writer is `writeFileSync(..., {flag:"wx", mode:0o600})`: if the disk fills mid-write a partial file with verifiers could remain (not handled; brief code).
6. On Windows the 0600 mode is a no-op; the help text and warning say so; not verified on Windows. `psql` and the fake-psql test are POSIX-only (skipped on win32).
7. Used `cd` once inside Bash commands for the mutation harness runs (cwd persistence), no stray `.claude/.cc-writes` in the worktree (git status clean).
