# Plan ПЛ-Х: final fix wave report

Worktree `/tmp/claude/wt/plh`, branch `claude/plh-pallets`, from `b8cef1e25`. Scope: minors 3, 5, 6 and the m4 doc sentence of the final review. Items 1, 7 (closed), 2 (dropped), 4 and 8 (carried) untouched.

## Commits

| #   | SHA         | Subject                                                                                   |
| --- | ----------- | ----------------------------------------------------------------------------------------- |
| 1   | `f1f666a6a` | test(standalone): the old database migrates with foreign keys on, as the host opens it    |
| 2   | `0354a74b1` | test(standalone): two layouts too large together keep the shift planned (RED)             |
| 3   | `b8ad2e761` | fix(standalone): an entry whose snapshot would exceed 320 KB is a clean conflict          |
| 4   | `2a7ebfae3` | docs(standalone): the snapshot bound, the open pallet's opened_at and the rewrapped lines |

Each message carries exactly one `Co-Authored-By: Claude Opus 5.5` trailer. `git status --short` is empty after commit 4.

## What changed

1. `host/tests/facts.rs`: `PRAGMA foreign_keys = ON` after `DETACH DATABASE source`, before `MIGRATOR.run(&mut old)`. The later `foreign_key_check` is kept. The test still passes with enforcement on (`ALTER TABLE boxes ADD COLUMN pallet_id` is legal).
2. Tests (RED): `host/tests/device_shifts.rs`:
   - `two_layouts_too_large_together_keep_the_shift_planned`: 2 x 170 000-byte layouts. The entry is 409 `conflict` / `snapshot_too_large`, and the body equals `proto/fixtures/error-snapshot-too-large.json` exactly. Nothing is written: revision, audit rows, no `shift.open` row, snapshot NULL, status planned, no owner, no `opened_at`, zero participants. A disabled oversized pallet template answers `pallet_template_not_fit` first (ordering). The office then points the shift at a small pallet template (`PUT`) and the entry returns 200 with `snapshot.palletTemplate.id` set.
   - `a_snapshot_of_exactly_the_limit_opens_the_shift_and_one_byte_more_does_not`: it calibrates on one host, then uses fresh identical hosts. The stored size is exactly 327 680 (200, measured as `length(CAST(snapshot AS BLOB))`), and +1 byte is a 409 with nothing stored.
   - New fixture `proto/fixtures/error-snapshot-too-large.json`, its Rust round-trip in `proto/tests/fixtures.rs`, a row in the `test/protocol.test.ts` fixture table plus a `toMatchObject` assertion. `error-codes.json` and the shell probe are unchanged, as the review specified (it is `details.constraint`).
3. Production: `host/src/shifts.rs` gets `MAX_SNAPSHOT_BYTES = 327_680`, `snapshot_too_large()`, private `check_snapshot_len(len)` and `snapshot_text(&ShiftSnapshot)`. `enter_shift` calls `shifts::snapshot_text(&snapshot)?` after the template checks and before `next_revision`, then binds the text. Unit tests in `shifts.rs` (3): the tie to `0009`'s `<= 327680`, the boundary (OK at the limit, refused at +1 with status, code and constraint), and the byte measure (a layout with fewer characters and more bytes is refused). The doc comments at `device_shifts.rs` (module doc and create doc) are rewrapped, and the `enter_shift` doc mentions the new refusal.
4. Docs:
   - `apps/standalone/AGENTS.md`: the "open one carries up to two layouts" sentence and the snapshot sentence (320 KB, `MAX_SNAPSHOT_BYTES`, `snapshot_too_large`, checked at the entry after the templates). The m4 sentence is in the pallets paragraph. The two ragged lines (the pallet-close paragraph near 2423 and the log-test paragraph near 2553) are rewrapped to <= 80 characters. Task 7's rewrap claim was false, and this fixes it. No `+` line of the plan's AGENTS diff is over 80 characters now.
   - Pilot spec §18 «Снимок»: the `snapshot_too_large` sentence.

## RED -> GREEN

- Commit 2 on the pre-fix host: both new host tests failed. The first got `500 internal` where 409 was expected. The second reached the +1 case and got `(500, None)`. The other 23 `device_shifts` tests were green. The exact-limit case already passed, as expected (the CHECK allows 327 680).
- Commit 3: `--lib shifts` was first a compile error (RED: unresolved `check_snapshot_len`, `snapshot_text`, `MAX_SNAPSHOT_BYTES`). After the change `--test device_shifts` is 25/25 and `--lib shifts` is 4/4.

## Mutants (restored byte-identically)

Originals are under `/tmp/claude/fix-plh-final/`. The sha256 of `shifts.rs` and `device_shifts.rs` is the same before and after (`before.sha` / `after.sha`, `cmp` identical, files touched). Each mutant ran with the output in `/tmp/claude/fix-plh-final/<name>.out`.

| Mutant | One line                                                                                   | Test that failed                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | in `enter_shift`, bind plain `serde_json::to_string(&snapshot)` instead of `snapshot_text` | `two_layouts_too_large_together_keep_the_shift_planned` and `a_snapshot_of_exactly_the_limit_…` (500)                                                                         |
| M2     | `>` -> `>=` in `check_snapshot_len`                                                        | lib: `a_snapshot_of_exactly_the_bound_is_kept…` and `the_snapshot_text_is_measured_in_bytes…`; M2b: `a_snapshot_of_exactly_the_limit_…`                                       |
| M3     | `text.len()` -> `text.chars().count()`                                                     | lib `the_snapshot_text_is_measured_in_bytes_of_the_text_it_returns`                                                                                                           |
| M4     | `MAX_SNAPSHOT_BYTES` 327_680 -> 327_679                                                    | lib `the_bound_is_the_check_of_the_shifts_table`; M4b: `a_snapshot_of_exactly_the_limit_…`                                                                                    |
| M5     | constraint typo `snapshot_too_larg`                                                        | `two_layouts_too_large_together_keep_the_shift_planned` (body compared with the fixture)                                                                                      |
| MF     | fixture constraint `snapshot_big`                                                          | proto `an_entered_shift_carries_its_snapshot_and_the_list_never_does`, host `two_layouts_…`, Vitest `protocol.test.ts > read the refusals…` (fixture restored: sha identical) |

An attempted "drop the call entirely" mutant (M6) did not compile and was discarded. M1 is the real equivalent.

Commit 1 has no mutant, as the review said (it aligns the test with production).

## Gates

- `cargo fmt --check`: clean. `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked`: 0 warnings.
- Focused: `device_shifts` 25/25, `shifts` lib 4/4, `facts` migration test passes with FK on (full `facts` 57 in the workspace run), `markiro-proto --test fixtures` 47/47, `office_shifts` in the workspace run.
- ONE full unsandboxed `cargo test --workspace --offline --locked`: exit 0, 53 result lines, **812 passed, 0 failed, 0 ignored**. The review baseline was 807, so +5 is the two host tests and three lib tests.
- Vitest `test/protocol.test.ts`: 216/216. `typecheck`, `lint` and `build` of `@markiro/standalone`: exit 0.
- Prettier gate (`node_modules/.bin/prettier --ignore-path .prettierignore --check <repo-relative paths>` from the worktree root): proved live (a mis-formatted scratch JSON failed with `[warn]`, exit 1, then removed), then clean on `error-snapshot-too-large.json`, `test/protocol.test.ts`, `AGENTS.md` and the pilot spec.
- `git diff --check` clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` finds only `src/host/pairing-code.ts:66`. No `\u0` in the new Rust and JSON. The only `\u0` in `AGENTS.md` is the pre-existing `\u001d` at :503.

## Not run / concerns

- No real Windows, hardware or browser; automated checks only.
- The 2a spec (`2026-10-08-standalone-2a-shift-and-boxes-design.md`, lines 57 and 154) still says "snapshot up to 256 KB" and "not more than 320 KB". That is the 2a-era (one layout) text and not in this fix's file list, so I left it. A one-word follow-up could read "up to two layouts, 320 KB".
- ПЛ-Ц must add `snapshot_too_large` to `EntryRefusal` with its own words in `ru.json` (review section (e)); the webview mapping is not part of this wave.
- The plan document's "Отклонения при исполнении" still has a placeholder for the final wave. The controller should fill it from this report.
