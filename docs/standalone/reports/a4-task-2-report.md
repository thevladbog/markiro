# А4 Task 2 report — host: migration 0016, organization logo routes, protocol and client

Status: DONE_WITH_CONCERNS. Branch `claude/prt` (base a2be24573). Commit: see `git log -1` on the branch (feat(standalone): the organization's print logo on the host and migration 0016 (plan А4, task 2)).

## What was done

- `host/migrations/0016_pallet_sheets_logo.sql` verbatim from the brief (`org_logo`, `pallet_sheet_templates`, `org_profile.default_pallet_sheet_template_id`, `shifts.pallet_sheet_template_id` + index + two triggers).
- `GET/PUT/DELETE /v1/office/org/logo` (`routes/org_logo.rs`, `server.rs`), `validate::mono_logo`, audit actions (`org.logo.set/clear`, `pallet_sheet.*`), proto `OrgLogo/OrgLogoState/OrgLogoPut` (+ two fixtures, parity test), Zod schemas, `HostApi.getOrgLogo/putOrgLogo/deleteOrgLogo`, `officeKeys.orgLogo`, fake HostApi members.
- Tests: `host/tests/org_logo.rs` (13), 2 unit tests in `validate.rs`, proto parity test, protocol fixtures (2 new), `api.test.ts` (3 cases + 2 tests).

## Decisions where the dispatch and the brief differ (brief/constraints А4-6 followed)

- Revision bump: the dispatch asked for "exactly one bump per change"; the brief and constraint А4-6 say the logo takes NO revision (not in the station feed; a shift freezes it in its snapshot, task 4). Followed the brief; a test pins that `host_revision` is unchanged by set/replace/clear. If stations must see logo changes through the feed, that is a separate protocol change (feed entity + station copy) outside this brief.
- No ETag / sha256 / deterministic bytes: the brief has none; the stored text is the canonical base64 the client sent (the host re-checks canonical spelling).
- No image parsing on the host: the office sends already-thresholded bits. So there is no SVG/PNG/format sniffing on the host; the "SVG with a script and an external href" test sends it as `pixelsBase64` (and a PNG file's bytes) and checks refusal (`validation_failed`, field `pixelsBase64`, nothing stored or audited). Image decoding/size cap/MIME whitelist live in task 1's `decodeLogoFile` (webview; an SVG is rasterised via an `<img>`, no script runs).
- Body limit: the host sets no per-route limit; axum's default JSON ceiling (2 MiB) applies to every route and is far above the largest logo (87 384 base64 chars for 1024x512; host bound 90 000). Tested: the largest logo is accepted and read back whole; 90 001 chars refused ("at most 90000 characters"); a 1 MiB text refused by the logo's own bound (so the ceiling does not truncate); a 3 MiB body refused 400 "length limit exceeded" with nothing stored/audited. No `DefaultBodyLimit` added.

## Anchor adaptations

- Validation errors in this tree are `400 validation_failed` (`ApiError::validation`), not 422 as the brief's test text says; asserts use 400 + `error.details.field`.
- Audit asserts use `admin.row(...)`/`audit_trail` exact equality (actor office_user, target `org_profile`/`1`, details `{width,height}` / `{}`).
- Rust `fixtures.rs` imports were reformatted by rustfmt (import list reflowed).
- No test listed schema tables (`grep sscc_counters` found only restore.rs, unrelated), `foundation` compares the migration count with `MIGRATOR` (passes). No audit action list test exists.
- No `no_secrets_in_logs` change: the route file has no `tracing::` call; the walk's facts-file count (17) is unchanged (green in the full run).
- `delete` was already imported in `server.rs`.

## Migration gaps (0013–0015 absent here)

New test `a_database_with_0016_takes_a_lower_migration_late`: migrate everything except 0011 (0016 applied with 0013–0015 absent), store a logo, then run the full migrator: 0011 applies late (success), 0016 keeps its data. Plus `a_database_without_0016_takes_it_and_starts_with_no_logo`. (The earlier `backup_schema` 0011-after-0012 test is untouched and green.) 0013–0015 will apply late the same way when their streams merge; they must not touch `org_logo`/the new columns.

## RED / GREEN

- RED: `cargo test -p markiro-host --test org_logo` before the route was mounted: 9 failed, 2 passed (the table-CHECK test and the ceiling test, which passed on 404/400; the ceiling test was strengthened afterwards to pin the exact refusal) (`/tmp/claude/impl-a4-t2-red.txt`).
- GREEN: org_logo 13/13, foundation 12/12, validate unit 40/40 (2 new), proto fixtures, `vitest` protocol+api 441 passed (stderr 0 bytes), full `vitest` 154 files / 4771 passed (stderr empty; plan baseline Task 1: 4762), `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: 1173 passed, 0 failed, 0 ignored, 0 warnings. `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings; typecheck, lint, build 0; prettier gate live (scratch file made it exit 1, deleted); `git diff --check` clean; `\u04` grep only `pairing-code.ts:66`; tree clean after commit.

## Mutants (scratch, `/tmp/claude/impl-a4-t2/mutate.py`; originals in `/tmp/claude/impl-a4-t2/orig/`; each restore verified by sha256 + byte compare, files `touch`ed; final sha256 of all 7 files equals the pre-mutation sha) — 45 mutants, 44 killed

| #       | Mutant                                                                                                  | Killed by                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01/M02 | text bound `>` -> `>=` / `+1`                                                                           | validate unit `exact_bounds` (90000/90001 chars messages)                                                                                                        |
| M03-M06 | width/height upper bound +1, lower bound 0                                                              | same (edges 1, 1024, 1025, 512, 513)                                                                                                                             |
| M07     | canonical re-encode dropped                                                                             | SURVIVOR, equivalent: base64 0.22 STANDARD already rejects non-canonical trailing bits and missing padding (kept as defence in depth; the branch is unreachable) |
| M08/M09 | byte count accepts too many / too few                                                                   | `exact_bounds`, `a_mono_logo_is_checked_to_the_bit`                                                                                                              |
| M10/M11 | padding mask one bit too wide / short                                                                   | both unit tests                                                                                                                                                  |
| M12     | padding of byte 0 of a row instead of the last                                                          | both unit tests                                                                                                                                                  |
| M13     | only the first row's padding checked                                                                    | both unit tests (second-row padding bit)                                                                                                                         |
| M14     | `unused = 8 - w % 8` (whole-byte width)                                                                 | `exact_bounds` (shift overflow panic on width 8)                                                                                                                 |
| M15     | padding check dropped                                                                                   | both unit tests                                                                                                                                                  |
| M16     | URL-safe alphabet                                                                                       | `exact_bounds` ("-_-_" refused)                                                                                                                                  |
| M17     | put: `mono_logo` call dropped                                                                           | route tests (refused logo stored; ceiling/bound/largest)                                                                                                         |
| M18/M19 | in-tx `require_admin_in` dropped in put / delete                                                        | `an_administrator_turned_off_after_the_extractor_passed_writes_nothing`                                                                                          |
| M20/M21 | both role checks dropped in put / delete                                                                | technologist test + turned-off test                                                                                                                              |
| M22     | GET administrators only                                                                                 | `a_technologist_reads_but_does_not_change_the_logo`                                                                                                              |
| M23     | set audited as the clear action                                                                         | sets/replaces/clears + quiet no-op                                                                                                                               |
| M24     | audit details carry the bits                                                                            | exact-row test + `the_audit_trail_never_holds_the_logo_bits`                                                                                                     |
| M25     | clear audited when nothing was cleared                                                                  | `clearing_no_logo_is_a_quiet_no_op...`                                                                                                                           |
| M26     | upsert -> plain insert (replace fails)                                                                  | sets/replaces/clears, largest                                                                                                                                    |
| M27     | answer carries a made-up `updatedAt`                                                                    | sets/replaces/clears (response == GET == row)                                                                                                                    |
| M28     | clear audit target type                                                                                 | exact-row test                                                                                                                                                   |
| M29     | DELETE route not mounted                                                                                | technologist, turned-off, quiet no-op, no-session                                                                                                                |
| M30-M36 | table CHECKs: `id = 1`, width 1..1024 (both ends), height 1..512 (both ends), text 4..90000 (both ends) | `the_table_holds_one_bounded_row`                                                                                                                                |
| M37     | proto PUT body not `deny_unknown_fields`                                                                | `org_logo_fixtures_round_trip`                                                                                                                                   |
| M38     | same, seen through the route                                                                            | `a_refused_logo_changes_nothing...` (unknown field)                                                                                                              |
| M39     | Zod PUT body not `.strict()`                                                                            | protocol.test "rejects an unknown field, like the host"                                                                                                          |
| M40     | Zod logo not nullable                                                                                   | api.test (delete, none-as-null)                                                                                                                                  |
| M41     | Zod `updatedAt` not a datetime                                                                          | api.test "rejects a logo answer..."                                                                                                                              |
| M42-M45 | client: PUT->POST, DELETE path, PUT without body, GET without office token                              | api.test CASES                                                                                                                                                   |

Not mutated (reasoned): the 2 MiB axum ceiling is not our code; `require_admin()` early check alone is equivalent in outcome to the in-tx check for a technologist (both 403), covered through M20/M21 where both are removed.

## Concerns

1. Revision/feed: stations do not learn of a logo change through the change feed (brief A4-6 design); a station sees it in the next shift snapshot (task 4). The dispatch text suggested a revision bump; confirm this is intended.
2. The host accepts any bit pattern of the right size (a PNG file's bytes of the exact stride x height length with zero padding would be stored as ink dots); that is harmless to print but the host cannot tell a picture from noise. Image validation is the webview's (task 1/5).
3. M07 equivalent branch kept per brief.
4. Windows/hardware/real-webview behaviour not exercised; `graphify update .` not run.
5. `rtk` was not an issue; no stdout totals taken via pipes.
