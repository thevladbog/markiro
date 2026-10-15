# Report: plan ИМП Task 2 - the transfer file, remarks, checksum (`transform.mjs`, golden file)

Status: DONE_WITH_CONCERNS (concerns at the end). Commit: 2902c3849 `feat(standalone): cloud export: the import file, its notes and its checksum` on claude/imp-cloud (worktree /tmp/claude/wt/imp, base 2c726efba). An earlier attempt had stopped with NEEDS_CONTEXT on the standing rule about credential-bearing fields; this run proceeds under the owner's authorisation (OWNER-DECISIONS.md, 2026-10-11, option A): the file carries `payload.operators[].pinPhc`, `payload.badges[].badgePhc` and `payload.badgeSalt`, as the brief specifies.

## What was done

- Created `tools/standalone-export/{phc,canonical,transform}.mjs`, `test/transform.test.mjs`, `test/fixtures/raw-cloud.json` and `apps/standalone/proto/fixtures/cloud-export-file.json`. The `transform.mjs` body was extracted programmatically from the brief (no retyping), then the addenda were applied on top.
- The golden checksum in the brief (`sha256:9716b9df...45c5`) is reproduced byte for byte by `buildExportFile(raw-cloud.json, exportedAt 2026-10-09T18:30:00.000Z)`; the test compares the whole file (`deepEqual`) and recomputes the checksum.
- Addenda from `imp-minors.md` item 2 (all done, all tested):
  - m1: `ExportError("shift_counter_unreadable", ...)` when a raw shift-number counter that is not exactly `lastSeq === 0` is not carried by `planShiftNumberCounters` (bad key such as `Sep26`, string / null / NaN / fractional / negative `lastSeq`, also a garbage row sharing a key with a valid one). The message names the month keys (not secret) and a count.
  - m2: `RangeError` from `sscc.mjs` becomes `ExportError("sscc_input_invalid")` (with `cause`), the plain `Error` stays `sscc_exhausted`.
  - m3: `windowOf` in `sscc.mjs` requires a safe positive integer, else `RangeError("the rollback window ...")`; one test in `sscc.test.mjs`.
- Owner-authorisation handling rules, all enforced by tests: no hash, salt, digest or plaintext code in notes, `source`, `cutover` or any `ExportError` message / `blockers` (test "a refusal names no hash, salt or code, and neither do the notes"); the whole file text and the golden file text contain none of the badge codes and no `badgeCode` / `badgeHash` key; tests use synthetic data only (the brief's fixtures); no secret appears in a test name or in an assertion message (the PHC refusal test reports an index, not the string).
- Not in this task (carried to Task 3, which owns `cli.mjs`): writing the file with owner-only permissions (mode 0600 where the OS supports it), and the CLI warning that the file contains credential verifiers and must be deleted after the import. `transform.mjs` writes nothing and logs nothing.

## Anchor adaptations

- The tree already contains Task 1 (`sscc.mjs`, root script `test:standalone-export`); no anchor in Task 2 touches existing files except the two small edits to `sscc.mjs` / `sscc.test.mjs` (m3), which anchored once.
- `phc.mjs` was checked against the current host `secrets.rs::parse_phc` (leading zero, 10 000..1 000 000, canonical base64, 16/32 bytes): identical rules. `apps/api/src/lib/badge-salt.ts::hashBadgeWithSalt` still exists; `packages/domain` exports did not move anything this task uses.
- The brief says Step 2 fails with `Cannot find module canonical.mjs`; I wrote `phc.mjs` and `canonical.mjs` first, so the RED run failed on `transform.mjs` (`ERR_MODULE_NOT_FOUND ... transform.mjs`, /tmp/claude/impl-imp-t2/red.txt). Same failure class.
- The golden product name: the brief's raw name has 205 characters and the golden 200; I typed the golden's by hand once at 201, caught by the deepEqual and fixed to `"Вода " + "я"*195`. Final raw 205 / golden 200 equal the brief's counts (checked with a script).

## RED / GREEN

- RED: `node --test tools/standalone-export/test/transform.test.mjs` before `transform.mjs` -> exit 1, `ERR_MODULE_NOT_FOUND`.
- GREEN after the verbatim module: 14 brief tests pass (golden equal on the first run after the name fix).
- RED for m3: the new window test failed (38 tests, 1 fail) before the `windowOf` check; green after.
- Final: `pnpm --dir /tmp/claude/wt/imp --config.verifyDepsBeforeRun=false run test:standalone-export` -> `tests 89, pass 89, fail 0, skipped 0`, empty stderr (domain-equivalence test in `sscc.test.mjs` ran, `packages/domain/dist` is built). `node --test` of the same files gives the same.

## Tests: plan vs measured

Plan (Task 1 + Task 2 files): `ℹ tests 22` in the brief's Step 4 (8 + 14). Measured: 89 = `sscc.test.mjs` 38 (37 from Task 1 + 1 for m3) + `transform.test.mjs` 51 (14 brief + 37 added). `export-sql` / `cli` tests belong to Task 3. Postgres-backed tests: none exist yet (Task 3); `STANDALONE_EXPORT_TEST_DATABASE_URL` was not set and nothing here needs it.

## Mutants

302 one-line mutants over `transform.mjs`, `phc.mjs`, `canonical.mjs`, `sscc.mjs` (harness /tmp/claude/impl-imp-t2/mut.py, originals in /tmp/claude/impl-imp-t2/orig/). Every mutant was applied to exactly one match, the two test files were run, the file was restored from the copy and its sha256 compared with the pre-run sha256 (assertion in the harness; final line `all files restored: sha equal`; `git status` clean after the commit). The brief's four mutants are see "badge: trimmed code keeps old hash (brief 1)" (`badge: trimmed code keeps old hash`), see "phc: badge under any salt (brief 2)" (`phc: badge under any salt`), see "clean: needs 2 blockers (brief 3)" (`clean: needs 2 blockers`), see "spec depth >= (brief 4)" (`spec depth >=`) in the table.
Result: 288 killed on the first run; 14 survived; 11 were killed after adding tests (the new tests are in the commit); 3 are equivalent mutants (explained). All 302: no live survivor.

## Gates

- Tests: above. `git diff --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`. `\u0...` in `tools/standalone-export`: only the intended control-character escapes in tests (`\u0000`, `\u0085`, `\u007f`, `\u00a0`).
- Prettier gate: `node_modules/.bin/prettier --ignore-path .prettierignore --check tools/standalone-export apps/standalone/proto/fixtures/cloud-export-file.json package.json` from the worktree root -> "Checking formatting... All matched files use Prettier code style!"; proven live with a mis-formatted scratch `.mjs` (reported `[warn]`), scratch deleted. I used `prettier --write` on the new test and module files (the harness-built files were already formatted; `raw-cloud.json` and the golden file were unchanged by it).
- Not run (not applicable): cargo, Vitest/typecheck/lint/build of the standalone package (no Rust, no TS touched), Postgres tests, CI changes (Task 3).

## Self-review

- The checksum is over the canonical JSON of the whole file minus `checksum`; the office (Task 7) must compute the same text. The golden file is the shared witness.
- Free text follows the host rule (`\p{Cc}` -> space, trim, code points); the line-name uniqueness suffix cuts by code points and re-trims.
- A raw `lastSeq` of exactly 0 is the only row of the counters that may be absent from the output; anything else not carried stops the export.
- The test for "no secrets in refusals" covers six refusal codes; messages of RangeErrors from `sscc.mjs` carry only prefix / extension / number.

## Concerns

1. Carried to Task 3 (not mine): owner-only file permissions and the CLI warning about credential verifiers; also `export.sql` cross-checks from `imp-minors.md` 1 and 3 (max `number_seq` per month, cross-tenant prefix maxima, `affected.mjs` for the SSCC fixture, domain build in CI).
2. `transform.mjs` trusts the shape of `raw` (it is `export.sql`'s own output): a missing array (`raw.badges`, `raw.lines`, ...) would throw a TypeError rather than an `ExportError`. The brief's code does the same; Task 3's SQL always emits every array. Hardening was not added.
3. Three equivalent mutants (printName / role `null` comparisons, `isBadgePhcUnder` null check) remain by nature; they are listed in the table.
4. I used one `cd` inside two Bash commands (mutation harness / node one-liner); `git status` shows no stray `.cc-writes`. The local `rtk` wrapper makes plain `diff` print the whole file; I used `rtk proxy diff` for diffs.

## Mutant table

| #   | one-line mutant                               | result                  | first failing test                                                               |
| --- | --------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| 0   | plainText: control char -> empty              | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 1   | plainText: no control test                    | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 2   | plainText: no trim of replaced                | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 3   | plainText: cut one too late                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 4   | plainText: cut one too early                  | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 5   | plainText: no trim after cut                  | KILLED                  | free text loses control characters and is cut to the host's length in code point |
| 6   | plainText: length in UTF-16 units             | KILLED                  | free text loses control characters and is cut to the host's length in code point |
| 7   | plainText: cut only above max+1               | KILLED                  | free text loses control characters and is cut to the host's length in code point |
| 8   | depthOf: array adds no level                  | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 9   | depthOf: object adds no level                 | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 10  | depthOf: arrays ignored                       | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 11  | innOf: accepts 11 digits                      | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 12  | innOf: accepts 9 digits                       | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 13  | innOf: no trim                                | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 14  | innOf: start unanchored                       | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 15  | innOf: end unanchored                         | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 16  | prefixesOf: no trim                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 17  | prefixesOf: repeat not skipped                | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 18  | prefixesOf: 3 digits ok                       | KILLED                  | GS1 prefixes of 4 to 12 digits stay trimmed; a repeat is silent; other values ar |
| 19  | prefixesOf: 13 digits ok                      | KILLED                  | GS1 prefixes of 4 to 12 digits stay trimmed; a repeat is silent; other values ar |
| 20  | prefixesOf: start unanchored                  | KILLED                  | GS1 prefixes of 4 to 12 digits stay trimmed; a repeat is silent; other values ar |
| 21  | prefixesOf: end unanchored                    | KILLED                  | GS1 prefixes of 4 to 12 digits stay trimmed; a repeat is silent; other values ar |
| 22  | prefixesOf: limit check >                     | KILLED                  | at most ten distinct GS1 prefixes of 4–12 digits stay                            |
| 23  | prefixesOf: limit 11                          | KILLED                  | at most ten distinct GS1 prefixes of 4–12 digits stay                            |
| 24  | prefixesOf: note holds the trimmed value      | KILLED (after new test) | a dropped GS1 prefix is noted as the cloud held it, blanks and all               |
| 25  | prefixesOf: null list crashes                 | KILLED                  | GS1 prefixes of 4 to 12 digits stay trimmed; a repeat is silent; other values ar |
| 26  | countOf: 0 allowed                            | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 27  | countOf: max excluded                         | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 28  | countOf: any number                           | KILLED                  | a capacity that is no whole number is cleared with a note; an empty one needs no |
| 29  | bound: box capacity 100_001                   | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 30  | bound: box capacity 99_999                    | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 31  | bound: pallet capacity 10_001                 | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 32  | bound: pallet capacity 9_999                  | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 33  | bound: shelf life 3_651                       | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 34  | bound: shelf life 3_649                       | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 35  | bound: spec bytes +1                          | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 36  | bound: spec bytes -1                          | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 37  | bound: spec depth 65                          | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 38  | bound: spec depth 63                          | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 39  | spec depth >= (brief 4)                       | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 40  | spec bytes >=                                 | KILLED                  | a layout deeper than 64 levels or larger than 256 KB is left out; one at the bou |
| 41  | spec size in characters                       | KILLED                  | a layout is measured in UTF-8 bytes, as the host measures it                     |
| 42  | spec: no null test                            | KILLED                  | a template needs a name and an object layout; a name is plain text               |
| 43  | spec: no object test                          | KILLED                  | a template needs a name and an object layout; a name is plain text               |
| 44  | spec: arrays accepted                         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 45  | spec: too-large checked before deep           | KILLED (after new test) | a layout that is both too deep and too large is reported as too deep             |
| 46  | fits: disabled allowed                        | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 47  | fits: purpose ignored                         | KILLED                  | a template default must fit its slot: purpose, switch, product group and existen |
| 48  | fits: group-limited always true               | KILLED                  | a default the slot would refuse is left out with a note                          |
| 49  | fits: unlimited needs a category              | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 50  | fits: null category fits limited              | KILLED                  | a default the slot would refuse is left out with a note                          |
| 51  | fits: wrong group                             | KILLED                  | a template default must fit its slot: purpose, switch, product group and existen |
| 52  | shift number: pad 2                           | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 53  | shift number: pad 4                           | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 54  | shift number: always /S                       | KILLED                  | an active shift is numbered as the cloud numbers it; either kind of blocker stop |
| 55  | shift number: never /S                        | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 56  | tenant check removed                          | KILLED                  | no file without a tenant, a profile, a 13-digit GLN or an organization name      |
| 57  | profile check removed                         | KILLED                  | no file without a tenant, a profile, a 13-digit GLN or an organization name      |
| 58  | gln: no trim                                  | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 59  | gln: 13-14 digits                             | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 60  | gln: end unanchored                           | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 61  | gln: start unanchored                         | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 62  | org name: 201                                 | KILLED                  | an organization name loses control characters and is cut at 200 characters       |
| 63  | org name: 199                                 | KILLED                  | an organization name loses control characters and is cut at 200 characters       |
| 64  | org name: empty accepted                      | KILLED                  | no file without a tenant, a profile, a 13-digit GLN or an organization name      |
| 65  | clean: rehearsal ignored                      | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 66  | clean: needs 2 blockers (brief 3)             | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 67  | clean: never refuses                          | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 68  | clean: blockers not attached                  | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 69  | clean: blockers not noted                     | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 70  | clean: devices before shifts                  | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 71  | clean: active shifts ignored                  | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 72  | clean: stale devices ignored                  | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 73  | clean: rehearsal flag false                   | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
| 74  | clean: rehearsal default true                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 75  | org: text_changed note removed                | KILLED                  | an organization name loses control characters and is cut at 200 characters       |
| 76  | org: inn note on null too                     | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 77  | org: inn note never                           | KILLED                  | an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN             |
| 78  | org: tz length 65                             | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 79  | org: tz length 63                             | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 80  | org: tz empty ok                              | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 81  | org: tz no plus                               | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 82  | org: tz any characters                        | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 83  | org: tz end unanchored                        | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 84  | org: tz start unanchored                      | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 85  | org: tz no trim                               | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 86  | org: tz fallback other                        | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 87  | org: tz note removed                          | KILLED                  | a time zone of 1-64 allowed characters stays; any other becomes Moscow with a no |
| 88  | line: name 101                                | KILLED (after new test) | names are cut at the host's length in code points, with a note                   |
| 89  | line: name 99                                 | KILLED                  | a repeated line name is cut so that the numbered name still fits 100 characters  |
| 90  | line: empty kept                              | KILLED                  | a line name is plain text; an empty one is dropped; a repeat gets the first free |
| 91  | line: key case-sensitive                      | KILLED                  | a line name is plain text; an empty one is dropped; a repeat gets the first free |
| 92  | line: stored key case-sensitive               | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 93  | line: numbering from 1                        | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 94  | line: numbering from 3                        | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 95  | line: suffix not budgeted                     | KILLED                  | a repeated line name is cut so that the numbered name still fits 100 characters  |
| 96  | line: suffix over-budgeted                    | KILLED                  | a repeated line name is cut so that the numbered name still fits 100 characters  |
| 97  | line: no trim before suffix                   | KILLED                  | a repeated line name is cut so that the numbered name still fits 100 characters  |
| 98  | line: suffix w/o space                        | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 99  | line: rename compared with trimmed            | KILLED                  | a line name is plain text; an empty one is dropped; a repeat gets the first free |
| 100 | line: rename note holds new name as from      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 101 | line: id lost                                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 102 | cp: notes counted only when kept              | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 103 | cp: notes never counted                       | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 104 | cp: no gln trim                               | KILLED                  | a counterparty needs a 13-digit GLN and a name; its notes are counted even when  |
| 105 | cp: name 201                                  | KILLED                  | a counterparty needs a 13-digit GLN and a name; its notes are counted even when  |
| 106 | cp: gln regex 12                              | KILLED (after new test) | a counterparty GLN of 12 or 14 digits drops it; one without an INN is kept witho |
| 107 | cp: empty name kept                           | KILLED                  | a counterparty needs a 13-digit GLN and a name; its notes are counted even when  |
| 108 | cp: reason always gln                         | KILLED                  | a counterparty needs a 13-digit GLN and a name; its notes are counted even when  |
| 109 | cp: text_changed note removed                 | KILLED                  | a counterparty needs a 13-digit GLN and a name; its notes are counted even when  |
| 110 | cp: inn note on null too                      | KILLED (after new test) | a counterparty GLN of 12 or 14 digits drops it; one without an INN is kept witho |
| 111 | cp: prefix note without id                    | KILLED                  | GS1 prefixes of 4 to 12 digits stay trimmed; a repeat is silent; other values ar |
| 112 | cp: notes note always                         | KILLED                  | a counterparty needs a 13-digit GLN and a name; its notes are counted even when  |
| 113 | cp: inn lost on kept row                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 114 | tpl: name 201                                 | KILLED (after new test) | names are cut at the host's length in code points, with a note                   |
| 115 | tpl: empty name kept                          | KILLED                  | a template needs a name and an object layout; a name is plain text               |
| 116 | tpl: text_changed removed                     | KILLED                  | a template needs a name and an object layout; a name is plain text               |
| 117 | tpl: enabled forced                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 118 | tpl: groups dropped                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 119 | tpl: purpose forced                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 120 | def: null id gets a note                      | KILLED                  | a template default must fit its slot: purpose, switch, product group and existen |
| 121 | def: org slot ignores purpose                 | KILLED                  | a default the slot would refuse is left out with a note                          |
| 122 | def: org slot with category                   | KILLED                  | a default the slot would refuse is left out with a note                          |
| 123 | def: category fit ignores group               | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 124 | def: category fit ignores purpose             | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 125 | def: category unknown template kept           | KILLED                  | a template default must fit its slot: purpose, switch, product group and existen |
| 126 | def: category note removed                    | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 127 | def: org note removed                         | KILLED                  | a default the slot would refuse is left out with a note                          |
| 128 | def: sort by purpose desc                     | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 129 | def: sort by code desc                        | KILLED                  | a template default must fit its slot: purpose, switch, product group and existen |
| 130 | def: sort missing                             | KILLED                  | a template default must fit its slot: purpose, switch, product group and existen |
| 131 | def: pallets before boxes                     | KILLED                  | a template default must fit its slot: purpose, switch, product group and existen |
| 132 | def: org box default from pallet slot         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 133 | def: org pallet default from box slot         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 134 | prod: lost counted only for kept              | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 135 | prod: lost not summed                         | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 136 | prod: lost sort desc                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 137 | prod: lost note removed                       | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 138 | prod: gtin 13 ok                              | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 139 | prod: gtin end unanchored                     | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 140 | prod: gtin start unanchored                   | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 141 | prod: empty name kept                         | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 142 | prod: reason always gtin                      | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 143 | prod: name 201                                | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 144 | prod: name note removed                       | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 145 | prod: printName 201                           | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 146 | prod: empty printName kept                    | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 147 | prod: printName null becomes empty            | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 148 | prod: printName note removed                  | KILLED                  | a product needs a 14-digit GTIN and a name; its text is plain; lost fields are c |
| 149 | prod: printName note on null                  | EQUIVALENT              | EQUIVALENT: printName null yields null, so the comparison is already false       |
| 150 | prod: cleared note on null                    | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 151 | prod: cleared note never                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 152 | prod: box capacity unbounded                  | KILLED                  | a capacity or a shelf life is kept up to the host's bound and cleared past it    |
| 153 | prod: pallet capacity uses box bound          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 154 | prod: shelf life unbounded                    | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 155 | prod: box template as pallet                  | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 156 | prod: pallet template as box                  | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 157 | prod: template check off                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 158 | prod: dropped-template note removed           | KILLED                  | tools/standalone-export/test/transform.test.mjs                                  |
| 159 | prod: archived forced false                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 160 | prod: group dropped                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 161 | op: login 2 digits ok                         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 162 | op: login 13 digits ok                        | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 163 | op: login 12 digits refused                   | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 164 | op: login 3 digits refused                    | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 165 | op: login start unanchored                    | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 166 | op: login end unanchored                      | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 167 | op: login any digit class                     | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 168 | op: pin not checked                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 169 | op: name not checked                          | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 170 | op: pin before login                          | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 171 | op: name before pin                           | KILLED                  | an operator login is 3-12 digits; the first failing rule names the reason        |
| 172 | op: name 101                                  | KILLED                  | an operator name and role are plain text within the host's length                |
| 173 | op: name 99                                   | KILLED                  | an operator name and role are plain text within the host's length                |
| 174 | op: name note removed                         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 175 | op: role 121                                  | KILLED                  | an operator name and role are plain text within the host's length                |
| 176 | op: role 119                                  | KILLED                  | an operator name and role are plain text within the host's length                |
| 177 | op: empty role kept                           | KILLED                  | an operator name and role are plain text within the host's length                |
| 178 | op: role note removed                         | KILLED                  | an operator name and role are plain text within the host's length                |
| 179 | op: role note on null                         | EQUIVALENT              | EQUIVALENT: role null yields null, so the comparison is already false            |
| 180 | op: active ignores credential                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 181 | op: active ignores employee                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 182 | op: active either                             | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 183 | op: pin rewritten                             | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 184 | op: dropped note id lost                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 185 | badge: operator not required                  | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 186 | badge: operator note removed                  | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 187 | badge: salt kept when invalid                 | KILLED                  | a salt that is not 16 canonical bytes is replaced; without a badge none is made  |
| 188 | badge: salt 15 bytes                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 189 | badge: salt made without badges               | KILLED                  | a salt that is not 16 canonical bytes is replaced; without a badge none is made  |
| 190 | badge: salt never made                        | KILLED                  | a tenant without a salt gets a new one, and every badge is hashed under it       |
| 191 | badge: salt of 15 bytes                       | KILLED                  | a salt that is not 16 canonical bytes is replaced; without a badge none is made  |
| 192 | badge: salt note removed                      | KILLED                  | a tenant without a salt gets a new one, and every badge is hashed under it       |
| 193 | badge: code not trimmed                       | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 194 | badge: code 257 ok                            | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 195 | badge: code 255 max                           | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 196 | badge: empty code ok                          | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 197 | badge: space refused                          | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 198 | badge: tilde refused                          | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 199 | badge: DEL ok                                 | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 200 | badge: tab ok                                 | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 201 | badge: start unanchored                       | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 202 | badge: end unanchored                         | KILLED                  | a badge code must be 1-256 printable ASCII characters after trimming             |
| 203 | badge: code note removed                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 204 | badge: trimmed code keeps old hash (brief 1)  | KILLED                  | a current hash of a code with blanks around it is hashed again from the trimmed  |
| 205 | badge: always rehash                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 206 | badge: hash never checked                     | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 207 | badge: rehash hashes untrimmed                | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 208 | badge: rehashed not counted                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 209 | badge: duplicate kept                         | KILLED                  | two badges of one code keep the first and drop the second as a duplicate         |
| 210 | badge: duplicate not remembered               | KILLED                  | two badges of one code keep the first and drop the second as a duplicate         |
| 211 | badge: duplicate note removed                 | KILLED                  | two badges of one code keep the first and drop the second as a duplicate         |
| 212 | badge: rehash note always                     | KILLED                  | a salt that is not 16 canonical bytes is replaced; without a badge none is made  |
| 213 | badge: label 101                              | KILLED                  | a badge label loses control characters; one left empty becomes null              |
| 214 | badge: empty label kept                       | KILLED                  | a badge label loses control characters; one left empty becomes null              |
| 215 | badge: label dropped                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 216 | badge: code leaks                             | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 217 | badge: non-operator note always               | KILLED                  | a badge of a dropped operator is dropped; a badge counts toward nothing else     |
| 218 | badge: non-operator note never                | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 219 | sscc: organization owner wrong prefix         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 220 | sscc: counterparty by wrong slice             | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 221 | sscc: unknown owner as organization           | KILLED                  | an SSCC owner is the organization, a counterparty of the file, or unknown        |
| 222 | sscc: owner without name                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 223 | sscc: windows not passed                      | KILLED                  | the rollback windows come from the options and reach the cutover and the notes   |
| 224 | sscc: everything is exhausted                 | KILLED                  | a prefix, an extension or a serial the export cannot read is not reported as use |
| 225 | sscc: everything is invalid input             | KILLED                  | no file without a tenant, a profile, a 13-digit GLN or an organization name      |
| 226 | sscc: cause lost                              | KILLED                  | a prefix, an extension or a serial the export cannot read is not reported as use |
| 227 | sscc: message changed                         | KILLED                  | a prefix, an extension or a serial the export cannot read is not reported as use |
| 228 | sscc: window note removed                     | KILLED                  | the rollback windows come from the options and reach the cutover and the notes   |
| 229 | sscc: window note always                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 230 | sscc: counterparty note always                | KILLED                  | notes about SSCC of counterparties, planned shifts and non-operator badges appea |
| 231 | sscc: counterparty note never                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 232 | sscc: planned note always                     | KILLED                  | notes about SSCC of counterparties, planned shifts and non-operator badges appea |
| 233 | sscc: planned note never                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 234 | shift: unreadable never refused               | KILLED                  | a shift-number counter that drew numbers but cannot be carried over stops the ex |
| 235 | shift: any bad row ignored                    | KILLED                  | a shift-number counter that drew numbers but cannot be carried over stops the ex |
| 236 | shift: kept rows refused                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 237 | shift: zero refused                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 238 | shift: negative harmless                      | KILLED                  | a shift-number counter that drew numbers but cannot be carried over stops the ex |
| 239 | shift: wrong code                             | KILLED                  | a shift-number counter that drew numbers but cannot be carried over stops the ex |
| 240 | shift: count wrong                            | KILLED                  | a shift-number counter that drew numbers but cannot be carried over stops the ex |
| 241 | shift: keys not named                         | KILLED                  | a shift-number counter that drew numbers but cannot be carried over stops the ex |
| 242 | shift: counters dropped from payload          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 243 | file: counters nextSerial = issued            | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 244 | file: format                                  | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 245 | file: version                                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 246 | file: tool                                    | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 247 | file: tenant id lost                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 248 | file: raw tenant name                         | KILLED                  | an organization name loses control characters and is cut at 200 characters       |
| 249 | file: window boxes                            | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 250 | file: window pallets                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 251 | file: cutover counters lost                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 252 | file: checksum not computed                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 253 | file: exportedAt lost                         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 254 | file: default windows swapped                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 255 | file: default random                          | KILLED                  | a salt that is not 16 canonical bytes is replaced; without a badge none is made  |
| 256 | file: organization INN lost                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 257 | file: bad prefixes kept                       | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 258 | phc: non-string accepted                      | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 259 | phc: parts count                              | KILLED (after new test) | a PHC string the host would refuse (new test)                                    |
| 260 | phc: algorithm                                | KILLED (after new test) | a PHC string the host would refuse (new test)                                    |
| 261 | phc: hash name                                | KILLED (after new test) | a PHC string the host would refuse (new test)                                    |
| 262 | phc: leading zero                             | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 263 | phc: non-digit count                          | KILLED (after new test) | a PHC string the host would refuse (new test)                                    |
| 264 | phc: min iterations 9999                      | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 265 | phc: min iterations 10001                     | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 266 | phc: max iterations 1000001                   | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 267 | phc: max iterations 999999                    | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 268 | phc: min check dropped                        | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 269 | phc: max check dropped                        | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 270 | phc: salt 15 bytes                            | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 271 | phc: digest 31 bytes                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 272 | phc: salt unchecked                           | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 273 | phc: digest unchecked                         | KILLED (after new test) | a PHC string the host would refuse (new test)                                    |
| 274 | phc: non-canonical base64                     | KILLED                  | a PIN hash moves byte for byte, and one the host would refuse drops its operator |
| 275 | phc: length unchecked                         | KILLED                  | a badge hash is kept only when it is a valid one under the salt with the domain' |
| 276 | phc: decode non-string                        | KILLED                  | a tenant without a salt gets a new one, and every badge is hashed under it       |
| 277 | phc: badge iterations                         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 278 | phc: badge under any salt (brief 2)           | KILLED                  | a tenant without a salt gets a new one, and every badge is hashed under it       |
| 279 | phc: badge under any iterations               | KILLED                  | a badge hash is kept only when it is a valid one under the salt with the domain' |
| 280 | phc: badge unparsed accepted                  | EQUIVALENT              | EQUIVALENT: parsed null still fails `parsed?.iterations === 100000`              |
| 281 | phc: hash digest bytes                        | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 282 | phc: hash algorithm                           | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 283 | phc: hash salt as text                        | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 284 | phc: hash string iterations                   | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 285 | canon: keys unsorted                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 286 | canon: arrays sorted                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 287 | canon: spaces                                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 288 | canon: checksum field included                | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 289 | canon: other field dropped                    | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 290 | canon: hash algorithm                         | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 291 | canon: prefix                                 | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 292 | canon: utf8 encoding                          | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 293 | canon: nested objects unsorted                | KILLED                  | the raw fixture becomes the golden file the office and the host read             |
| 294 | window: sign unchecked                        | KILLED                  | a rollback window that is no positive whole number stops the export              |
| 295 | window: integer unchecked                     | KILLED                  | a rollback window that is no positive whole number stops the export              |
| 296 | window: zero allowed                          | KILLED                  | a rollback window that is no positive whole number stops the export              |
| 297 | window: never refused                         | KILLED                  | a rollback window that is no positive whole number stops the export              |
| 298 | window: other extension checked               | KILLED                  | the cloud moves past the window, or nowhere when the window leaves the prefix    |
| 299 | order: name before GLN                        | KILLED                  | the checks run in order: tenant, profile, GLN, name, a clean cloud, then the ser |
| 300 | order: profile before tenant                  | KILLED                  | the checks run in order ...                                                      |
| 301 | order: clean check after SSCC (check removed) | KILLED                  | an active shift or an unsynced station stops the export, unless it is a rehearsa |
