# Plan 1e1, Task 1 report: catalog in the host model (migration 0008) and the product-group lookup

Status: DONE_WITH_CONCERNS (the concerns are notes, nothing is broken; see the last section).

- Base: `e2480a1ad34d4e86812bba9674167f671a7e9b88` (HEAD at the start, tree clean).
- Commit: `3273a235cd0aa467ac19fa072ef181f570f12a27` (`3273a235c`) `feat(standalone): каталог в модели хоста — миграция 0008 и справочник товарных групп ЧЗ`. One commit on top of the base; message from a file (`git commit -F`), exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (`git log -1 --format=%B | grep -c Co-Authored-By` gives 1), as the rules file pins.
- After the commit `git status --short` is empty. The commit holds exactly the ten paths of the brief's `git add` line, nothing else.

## What was done

The brief was applied verbatim and in order. Every "fragment ... replace with ..." anchor matched exactly once at the start of its step (fixtures.rs import block, the test insertion point, `proto/src/lib.rs`, `routes/mod.rs`, `server.rs`, `AGENTS.md`, the spec). For the spec I replaced only the changed lines of the brief's two larger fragments (the `org_profile` template-columns sentence and the `chz_product_groups` bullet); the resulting text is the brief's "replace with" text.

1. Step 1 (tests, failing): `proto/fixtures/product-group.json`; `proto/tests/fixtures.rs` (import block, `a_product_group_fixture_round_trips`); `host/tests/product_groups.rs` (3 tests).
2. Step 2: RED runs (below).
3. Step 3: `host/migrations/0008_catalog.sql` (51 group rows copied from cloud `0099`, `label_templates`, `products` with the generated `status`, `category_template_defaults`, three `org_profile` columns, 7 indexes); `ProductGroup` in `proto/src/lib.rs`; `pub mod products;`; `routes/products.rs::list_product_groups`; the route `GET /v1/office/product-groups` in `server.rs`.
4. Step 4: GREEN runs (below).
5. Step 5: `apps/standalone/AGENTS.md` section "Catalog and label templates"; spec §4.3 (the `org_profile` sentence, the `chz_product_groups` bullet).
6. Step 6: gates, mutants, schema probes, commit.

## RED (before the implementation)

Command: `rtk proxy cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test product_groups --offline` (inside the sandbox). Exit 101, `0 passed; 3 failed`:

- `the_host_holds_the_clouds_product_groups_row_for_row`: `called Result::unwrap() on an Err value: Database(SqliteError { code: 1, message: "no such table: chz_product_groups" })` (product_groups.rs:43).
- `product_groups_need_an_office_session`: `left: (404, Null)`, `right: (401, String("session"))` (product_groups.rs:76).
- `every_office_role_lists_the_product_groups_by_code`: `{"error":{"code":"not_found","message":"no route for GET /v1/office/product-groups"}}`, `left: 404`, `right: 200` (product_groups.rs:61).

Command: `rtk proxy cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`. Exit 101: `error[E0432]: unresolved import markiro_proto::ProductGroup` at `proto/tests/fixtures.rs:11:18`, `could not compile markiro-proto (test "fixtures")`.

Both are the shapes the plan predicted.

## GREEN (after the implementation)

- `-p markiro-host --test product_groups`: `3 passed; 0 failed`.
- `-p markiro-proto`: 4 unit tests, 29 fixture tests (28 earlier and the new `a_product_group_fixture_round_trips`), 0 doc tests; all passed.
- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline` outside the sandbox, run twice (once before the mutant work, once after it with the scratch file deleted and every mutant restored, immediately before the commit): exit 0, 26 test binaries, `246 passed; 0 failed; 0 ignored`. Split: host 213, proto 33.
- The same full command inside the sandbox stops in `changes_stream` (`open_streams_end_when_the_host_stops`: `cannot listen on 127.0.0.1:0: Operation not permitted (os error 1)`), which is the sandbox, not the code; the rules file lists that suite as outside-sandbox only.

Plan numbers vs measured: the plan says 246 in total (before the plan 242: host 210, proto 32; the plan adds 3 host tests and 1 proto test). Measured: 246 in total, host 213 (210 + 3), proto 33 (32 + 1). No difference.

## Gates (before the commit)

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: exit 0.
- `rtk proxy node_modules/.bin/prettier --check apps/standalone/proto/fixtures/product-group.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: "All matched files use Prettier code style!", exit 0 (run through `rtk proxy` so the output is the real one).
- `git diff --check`: exit 0.
- `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`: exit 0, 0 warnings.
- Literal `\u0` escapes: `grep -cF '\u0'` gives 0 in all eight written or edited files and in the commit message file.

## Mutants (every new guard)

Each mutant is one scratch change to one file, applied by `/tmp/claude-501/1e1t1/mutant.py` (outside the tree). The script keeps a copy of the file, requires the anchor to occur exactly once, runs the cargo test, restores the file from the copy, and prints the sha256 before and after plus a byte comparison against the copy. Every row below printed `restored_identical=True cmp=True`. The sha256 values shown are the first 16 hex characters; before and after are equal for every row of the same file.

Host mutants run `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test product_groups --offline`; proto mutants run `-p markiro-proto --test fixtures`.

| #   | File and one-line mutant                                                                                                  | Test(s) that failed                                                                                                                          | Key line                                                                                                                         | Restore proof (sha256 before = after) |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| M1  | `products.rs`: `_context: OfficeContext` becomes `_context: crate::auth::AuthDevice` (device key only, no office session) | `product_groups_need_an_office_session` (the other two pass)                                                                                 | `left: (200, Null)`, `right: (401, String("session"))`, product_groups.rs:76                                                     | `856a74ce4e2e4977`                    |
| M2  | `products.rs`: `ORDER BY code` becomes `ORDER BY code DESC`                                                               | `every_office_role_lists_the_product_groups_by_code`                                                                                         | the list starts with code 59 (pyrotechnics) where the cloud order starts with 1 (lp), product_groups.rs:62                       | `856a74ce4e2e4977`                    |
| M2b | `products.rs`: `ORDER BY code` becomes `ORDER BY alias`                                                                   | `every_office_role_lists_the_product_groups_by_code`                                                                                         | the list starts with alias `alcohol` (code 11), product_groups.rs:62                                                             | `856a74ce4e2e4977`                    |
| M2c | `products.rs`: drop `ORDER BY code` entirely                                                                              | none: all 3 pass (EQUIVALENT mutant, see the finding below)                                                                                  | exit 0                                                                                                                           | `856a74ce4e2e4977`                    |
| M3  | `products.rs`: insert `_context.require_admin()?;` as the first statement (a role check the technologist fails)           | `every_office_role_lists_the_product_groups_by_code`                                                                                         | `{"error":{"code":"forbidden","message":"the administrator role is required"}}`, `left: 403`, `right: 200`, product_groups.rs:61 | `856a74ce4e2e4977`                    |
| M4  | `server.rs`: route path `/v1/office/product-groups` becomes `/v1/office/product-group`                                    | `product_groups_need_an_office_session`, `every_office_role_lists_the_product_groups_by_code` (the DB-only drift test passes)                | `left: (404, Null)`; `no route for GET /v1/office/product-groups`, `left: 404`, `right: 200`                                     | `404da906b745fe8f`                    |
| M5  | `0008_catalog.sql`: delete the line `(8, 'milk', 'Молочная продукция'),`                                                  | `the_host_holds_the_clouds_product_groups_row_for_row` (product_groups.rs:46) and `every_office_role_lists_the_product_groups_by_code` (:62) | `assertion left == right failed`: the host list lacks code 8                                                                     | `721442214bac3b3b`                    |
| M6  | `0008_catalog.sql`: `(2, 'shoes', ...)` becomes `(2, 'shoe', ...)`                                                        | the same two                                                                                                                                 | host row `(2, "shoe", ...)` against the cloud's `shoes`                                                                          | `721442214bac3b3b`                    |
| M7  | `0008_catalog.sql`: `(19, 'antiseptic'` becomes `(18, 'antiseptic'`                                                       | the same two                                                                                                                                 | code 18 against the cloud's 19                                                                                                   | `721442214bac3b3b`                    |
| M7b | `0008_catalog.sql`: `'Молочная продукция')` becomes `'Молочная продукция.')`                                              | the same two                                                                                                                                 | name differs by one character                                                                                                    | `721442214bac3b3b`                    |
| M8  | `proto/src/lib.rs`: `ProductGroup`'s `rename_all = "camelCase"` becomes `"SCREAMING_SNAKE_CASE"`                          | `a_product_group_fixture_round_trips`                                                                                                        | `product-group.json: missing field CODE`, fixtures.rs:39:73                                                                      | `b0dc60aaefbbaaeb`                    |
| M9  | `proto/fixtures/product-group.json`: `"milk"` becomes `"milka"`                                                           | `a_product_group_fixture_round_trips`                                                                                                        | `left: (8, "milka")`, `right: (8, "milk")`, fixtures.rs:440:5                                                                    | `821dddec2b1e3dcb`                    |

Finding (M2c, not killable): dropping `ORDER BY code` leaves all three tests green. It is a semantically equivalent mutant: `code INTEGER PRIMARY KEY` is the rowid, so a plain scan walks the rows in code order. `EXPLAIN QUERY PLAN` on the host's own SQLite shows `SCAN chz_product_groups` with and without the `ORDER BY` (no temporary b-tree), so no test can observe the difference while the table keeps that primary key. I did not change the test (the brief gives it verbatim and no stronger observable assertion exists); the `ORDER BY` states the contract and would start to matter if the table were ever rebuilt with another key. M2 and M2b show the ordering assertion itself is live.

Not covered by a mutant: the cloud-side direction of the drift test (a new or changed row in `packages/db/migrations/0099_chz_product_groups.sql`). Editing `packages/*` is forbidden here. The same equality plus `assert_eq!(cloud.len(), 51, ...)` guards it, and M5 to M7b show the comparison is live from the host side.

## Schema probes (scratch, not committed)

The brief's tests cover the lookup only; the plan tests the other new tables in tasks 2 to 5. To catch a plan defect early I ran a scratch Rust test (`host/tests/scratch_catalog_schema.rs`, deleted afterwards, `ls apps/standalone/host/tests | grep -c scratch` gives 0) against the host's own SQLite (the `admin()` pool, `foreign_keys` on). 81 probes, all as the plan designs:

- Objects: the four tables and the seven indexes equal the brief's "Produces" list; `products_active_gtin14` is `UNIQUE ... WHERE archived = 0`; `org_profile` has the three new columns, and the organization row that existed before reads NULL in all three.
- Foreign keys: `products` to the group NO ACTION, to both templates `SET NULL`; `org_profile` to templates NO ACTION (three); `category_template_defaults` to group and template. `PRAGMA integrity_check` is `ok`, `foreign_key_check` is empty.
- Lookup: duplicate code, duplicate alias and a NULL name are refused; 51 rows.
- `label_templates`: name 1 to 200 characters (200 Cyrillic letters accepted, 201 refused, empty and blank refused); unknown purpose, `enabled` and `stock` outside 0/1 refused; `category_codes` NULL or a non-empty array (`[]`, `{}`, `null`, non-JSON refused); `spec` an object of at most 262 144 BYTES (exactly 262 144 accepted, 262 145 refused, a Cyrillic spec of 262 152 bytes but far fewer characters refused, so the check counts bytes); `stock` defaults to 0.
- `products`: `gtin14` must be 14 ASCII digits (12, 13, 15 digits, a letter, empty, a trailing space and Arabic-Indic digits refused); name and print name rules; capacities and shelf life greater than 0, with no upper bound in the table (the ceilings stay in `validate.rs`, as the plan says); `archived` 0/1; unknown group or template refused.
- Generated `status`: `active` only with a group and both capacities, `draft` otherwise; completing a draft turns it `active`; INSERT or UPDATE of `status` is refused.
- GTIN uniqueness: a second active product with the same GTIN refused; free after archiving; several archived products share a GTIN; un-archiving into a taken GTIN refused.
- `ON DELETE SET NULL`: deleting a template clears that slot of a product and leaves the product's `rev` unchanged (32 stays 32). This matches the plan's note that the host must clear the references itself with a new revision, and that `SET NULL` is only the last line.
- Category defaults: primary key, purpose CHECK, group and template foreign keys, NOT NULL; deleting a template that is a category default or the organization's default is refused by the foreign key.

One failure on the first scratch run was my own wrong expectation (ids sort `p-big` before `p-d1`); I fixed the scratch assertion, the migration was not touched.

## Files changed (10, 281 insertions, 4 deletions)

- `apps/standalone/host/migrations/0008_catalog.sql` (new, 131 lines)
- `apps/standalone/host/src/routes/products.rs` (new, 28)
- `apps/standalone/host/src/routes/mod.rs` (+1), `apps/standalone/host/src/server.rs` (+4)
- `apps/standalone/host/tests/product_groups.rs` (new, 80)
- `apps/standalone/proto/src/lib.rs` (+12), `apps/standalone/proto/tests/fixtures.rs` (+8, -1), `apps/standalone/proto/fixtures/product-group.json` (new, 1 line)
- `apps/standalone/AGENTS.md` (+9), `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (+7, -3)

Not touched: migrations 0001 to 0007, `apps/station`, `packages/*`, `apps/standalone/{src,test,src-tauri}`, manifests, the lockfile, the plan, `.superpowers/` (except this report). No new crates, no `pnpm install`.

## Self-review

- The migration is the brief's text; `the_host_holds_the_clouds_product_groups_row_for_row` proves its 51 rows equal the cloud file's rows (code, alias, name), and M5 to M7b show the comparison fails on a missing, changed or renamed row.
- The handler takes `OfficeContext` and does no role check (every office role reads); M1 and M3 pin both the session requirement and the absence of a role check.
- `ProductGroup.code` is `u32` in the protocol while the test compares `i64` values read through sqlx; the handler decodes `INTEGER` into `u32` and the 51 rows pass, including the maximum code 59.
- The route sits behind the existing `protocol_guard` like every `/v1/office/*` route; no feed code, no write route, no audit row is added (the brief adds none for Task 1).
- Docs: the AGENTS section and the two spec edits equal the brief's replacement text.
- `git status --short` is empty; no scratch file remains (the mutant helper and the outputs live under `$TMPDIR`, outside the tree).

## Concerns (notes)

1. M2c is an equivalent mutant (explained above); no test change could kill it.
2. The sandbox blocks loopback binding, so the full `-p markiro-host` run only works outside it (as the rules file says); the plan's single-suite commands ran inside the sandbox. `sandbox.network.allowLocalBinding: true` would allow the full run inside it.
3. `graphify update .` was not run: this worktree has no `graphify-out/graph.json` (`graphify query` answered "graph file not found"), although the PreToolUse hooks claimed one exists. The AGENTS rule says to run it only when a local graph exists.
4. The local `rtk` wrapper shortened or rewrote some output (for example `git diff --cached --stat` printed an "ok 10 files changed" prefix, and a `wc -l` of `git diff --cached --name-only` printed 13 although exactly 10 files were staged). Every number in this report comes from `rtk proxy` output, files under `$TMPDIR`, a small Python script that totals the cargo results, or `git show --name-only`.
5. The system reminder in my session suggests a different `Co-Authored-By` model name; I followed the rules file and the task brief, which pin `Claude Opus 5.5`.

## Fix round 1 (controller ruling on the review's Important 1)

Status: DONE_WITH_CONCERNS (notes only).

- Commit: `a87028fe1086a66dbe2a2a63d88c20c1af81f46c` (`a87028fe1`) `fix(standalone): ревью задачи 1 плана 1e1 — защита от расхождения справочника групп видит и другие облачные миграции`. One new commit on top of `3273a235c` (no amend), message from a file, exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line. It holds exactly three paths: `apps/standalone/host/tests/product_groups.rs` (+248, -2), `apps/standalone/AGENTS.md` (+8, -3), `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (+5, -2); 261 insertions, 7 deletions. Nothing under `packages/` or `tools/` was touched, and no scratch file was created under `packages/` (the unit test uses a directory in the system temp dir). `git status --short` is empty after the commit.

### What changed

1. `host/tests/product_groups.rs`, std-only (no new crates, no `regex`):
   - `WRITE_PHRASES` (the ten phrases of the ruling), `normalized(sql)` (comments stripped, lower case, `"`, backtick and `public.` removed, whitespace runs collapsed), `writes_groups(sql)` (a `for` loop over `match_indices("chz_product_groups")` that checks the phrase and one space before the name and that no `[a-z0-9_]` character follows it, or the text ends) and `migrations_writing_groups(dir, except)` (the `.sql` files of `dir` in name order, minus `except`).
   - `a_migration_that_writes_the_groups_is_found`: the ruling's synthetic directory (`0001_other`, `0002_reference`, `0003_comments`, `0004_insert`, `0005_update`, `0006_suffix` and the exempt file named like the exception); the first assertion is exactly `["0004_insert.sql", "0005_update.sql"]`. The directory is a `Scratch` guard (`markiro-<test name>-<pid>` under `std::env::temp_dir()`) removed on drop, so also when an assertion fails; no `markiro-a_migration…` directory is left in either temp dir after the runs.
   - `no_other_cloud_migration_writes_the_product_groups`: the helper on `packages/db/migrations` with `except = "0099_chz_product_groups.sql"`; on failure `cloud migration(s) {list:?} write chz_product_groups: the host keeps its own copy — add a host migration with the same change and extend this test`. It passes today (empty list): `0103`, `0107`, `0111` and `0137` only reference the table.
   - The doc comment above `cloud_groups()` now says the rows are read from the one source `0099`, that `0099` is frozen so a later change can only arrive as a NEW migration, and that `no_other_cloud_migration_writes_the_product_groups` fails when one does.
2. `apps/standalone/AGENTS.md`, "Catalog and label templates": the sentence "reads that file and compares the rows, so the copies cannot drift" is replaced by: the test compares the host's rows with that file and fails when any other cloud migration writes the table, so a cloud migration that changes the lookup cannot go unnoticed once the standalone jobs run; those jobs run when standalone files or the shared domain or ui packages change, a cloud-only change does not schedule them (`tools/ci/affected.mjs` maps `packages/db/**` to the station jobs), so the guard fires at the next standalone run. The section's other sentences are kept. I checked the claim in `tools/ci/affected.mjs`: `sharedJobs.domain` and `sharedJobs.ui` include `standaloneJobs`, `sharedJobs.db` does not, and `apps/standalone/**` maps to them.
3. Spec §4.3, the `chz_product_groups` bullet: "поэтому копии не разойдутся" is replaced by the same in Russian (the test also fails when another cloud migration writes the table; it runs in the standalone jobs, which a cloud-only change does not start, so the next run of those jobs catches it). The rest of the bullet is kept. Prettier is clean on both documents.

### Where I went beyond the letter of the ruling (please check)

- A block comment leaves one space instead of nothing (SQL treats a comment as whitespace, so `INSERT/**/INTO` is still a write); a line comment keeps its line break. Both are only more conservative than "strip".
- `WRITE_PHRASES` is a `&[&str]` without a length in its type, so dropping a phrase is a one-line mutant that compiles.
- The ruling's synthetic directory leaves 8 of the 10 phrases and several normalization rules unguarded (a mutant dropping `delete from` or `alter table` would pass), and the rules file asks for a failing mutant per rule. So the same test function has a second scenario in a second `Scratch` directory: one file per other statement kind (delete, truncate, truncate table, alter, create, create if not exists, drop, drop if exists), a name at the very end of the text, backticks, CRLF, comments inside a statement (`INSERT/* a note */INTO -- another` and `DELETE FROM--all`), and look-alikes that must NOT be found (`chz_product_groups2`, `chz_product_groupsx`, a `.txt` file). It stays inside `a_migration_that_writes_the_groups_is_found`, so the file has the ruling's five tests and the totals match the brief's 248.
- The AGENTS and spec sentences say "a cloud migration that changes the lookup", not "a change of the cloud lookup": the guard reads migrations only. A best-effort grep for a runtime writer (`insert(`, `update(`, `delete(` on `chzProductGroups` and raw `INSERT INTO`, `UPDATE`, `DELETE FROM chz_product_groups` over `apps packages tools deploy`, minus `0099`) finds none outside the host's own files, as the review says.

### Evidence

TDD: with a stub `migrations_writing_groups` returning an empty list and the final tests in place, `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test product_groups --offline` gave exit 101, `4 passed; 1 failed`: `a_migration_that_writes_the_groups_is_found` at product_groups.rs:154: `left: []`, `right: ["0004_insert.sql", "0005_update.sql"]`. The repo-level test passes with the stub because an empty list is what it expects (vacuous by nature); its guard is mutants (e) and `b` below. With the real helper, the same command passes: `5 passed; 0 failed`.

Mutants: 29, each one scratch change to `product_groups.rs` by `/tmp/claude-501/1e1t1f1/mutants_f1.py` (outside the tree), which requires the anchor to occur exactly once, runs the command above, restores the file from a copy and prints sha256 before and after plus a byte comparison. Every row printed `restored_identical=True cmp=True`; the file sha256 was `fdec00d185be2c57bb15c73c3072a914a4263b84c18a9a095c0fc08342220c88` at the start and the end of each of the four batches, and `shasum -a 256` of the committed file gives the same value. "A" is the first assertion of the unit test (the ruling's directory), "B" its second (one file per statement kind); extra and missing are names in the helper's list against the expected list.

| Mutant (one line)                                                       | Failed test and assertion      | Key line                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| (a) drop the `insert into` phrase                                       | unit A                         | missing `0004_insert.sql`                                                                            |
| (b) do not skip `except`                                                | unit A and the repo-level test | extra `0099_chz_product_groups.sql`; message names `["0099_chz_product_groups.sql"]`                 |
| (c1) `/*` no longer starts a comment                                    | unit A                         | extra `0003_comments.sql`                                                                            |
| (c2) `--` no longer starts a comment                                    | unit A                         | extra `0003_comments.sql`                                                                            |
| (d) the identifier-character check always passes                        | unit A                         | extra `0006_suffix.sql`                                                                              |
| (e) repo-level `except` becomes `"nonexistent.sql"`                     | repo-level test                | `cloud migration(s) ["0099_chz_product_groups.sql"] write chz_product_groups: …`                     |
| drop `update`                                                           | unit A                         | missing `0005_update.sql`                                                                            |
| drop `delete from`                                                      | unit B                         | missing `10_delete.sql`, `18_end_of_text.sql`, `22_line_comment_alone.sql`                           |
| drop `truncate`                                                         | unit B                         | missing `11_truncate.sql`                                                                            |
| drop `truncate table`                                                   | unit B                         | missing `12_truncate_table.sql`                                                                      |
| drop `alter table`                                                      | unit B                         | missing `13_alter.sql`                                                                               |
| drop `create table`                                                     | unit B                         | missing `14_create.sql`                                                                              |
| drop `create table if not exists`                                       | unit B                         | missing `15_create_if_not_exists.sql`                                                                |
| drop `drop table`                                                       | unit B                         | missing `16_drop.sql`                                                                                |
| drop `drop table if exists`                                             | unit B                         | missing `17_drop_if_exists.sql`                                                                      |
| a digit is not an identifier character                                  | unit B                         | extra `30_digit.sql`                                                                                 |
| `_` is not an identifier character                                      | unit A                         | extra `0006_suffix.sql`                                                                              |
| a letter is not an identifier character                                 | unit B                         | extra `31_letter.sql`                                                                                |
| the end of the text does not end a name                                 | unit B                         | missing `18_end_of_text.sql`                                                                         |
| no lower-casing                                                         | unit A                         | missing `0004_insert.sql`, `0005_update.sql`                                                         |
| double quotes kept                                                      | unit A                         | missing `0004_insert.sql`                                                                            |
| backticks kept                                                          | unit B                         | missing `19_backticks.sql`                                                                           |
| `public.` kept                                                          | unit A                         | missing `0004_insert.sql`                                                                            |
| whitespace runs not collapsed                                           | unit A                         | missing `0005_update.sql`                                                                            |
| a block comment leaves no space                                         | unit B                         | missing `21_comments_inside.sql`                                                                     |
| a line comment eats its line break                                      | unit B                         | missing `22_line_comment_alone.sql`                                                                  |
| the phrase may be anywhere before the name (`contains` for `ends_with`) | unit A and the repo-level test | extra `0002_reference.sql`; repo-level names `0103`, `0107`, `0111` and `0137`, which only reference |
| no sort                                                                 | unit A                         | `["0005_update.sql", "0004_insert.sql"]` (the directory order on this machine is not name order)     |
| no `.sql` filter                                                        | unit B and the repo-level test | extra `32_notes.txt`; repo-level panics `read …/packages/db/migrations/meta: Is a directory`         |

Gates: `cargo fmt --check` exit 0; `cargo check --all-targets --offline` for host and proto exit 0 with 0 warnings; prettier on both documents "All matched files use Prettier code style!"; `git diff --check` exit 0; no literal `\u0` escape in the three files or the message. An informational `cargo clippy -p markiro-host --tests --offline` exits 0; its only warning (`type_complexity` in `host/tests/support/app.rs:336`) is old and is repeated per test binary, nothing comes from the new code (the standalone CI job does not run clippy).

Totals: `product_groups` 5 tests passed. `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --offline` outside the sandbox (loopback binding): exit 0, 26 test binaries, `248 passed; 0 failed; 0 ignored`, host 215 (213 and the 2 new tests), proto 33. The brief expected 248; measured 248.

### Concerns (notes)

1. The CI gap itself stays: `tools/ci/affected.mjs` still sends a cloud-only change to the station jobs, so the guard fires at the next standalone run. The ruling carries that to the plan's «Перенесено»; the documents now say so.
2. The guard is text based and exact on the ruling's list. It does not match other spellings of a write (`ALTER TABLE ONLY` or `IF EXISTS`, `UPDATE ONLY`, `INSERT INTO ONLY`, `COPY`, `MERGE`), and a `--` or `/*` inside a string literal counts as a comment, so a write after such a literal on the same line would be missed. None of this occurs today: the real-directory run flags nothing, and the table's name appears in exactly five cloud migrations (`0099` and the four foreign-key references in `0103`, `0107`, `0111`, `0137`, one line each). Extend `WRITE_PHRASES` if a hand-written migration ever uses another form.
3. The review's two corrections to the earlier M2c remarks (the `ORDER BY` is not decorative for a narrower select, and `PRAGMA reverse_unordered_selects=ON` would kill that mutant) are accepted; no action was requested and none was taken. Minor 2 of the review (no committed tests for the DDL guards) is not part of this round and is unchanged.
4. The two new tests write under the system temp dir (removed on drop) and read `packages/db/migrations` by the path from `CARGO_MANIFEST_DIR`, like `cloud_groups`; both CI jobs check out the full repository.
