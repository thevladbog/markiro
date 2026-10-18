# Plan ОЧ, Task 7 — report

Status: DONE. Commit `852856087` on `claude/m1` (/tmp/claude/wt/m1), base `cb896ae38`. Tree clean after the commit.

## What was done

- Protocol: `KnownBlocksRequest.more: bool` (`#[serde(default, skip_serializing_if = "std::ops::Not::not")]`). Default when absent = **false = the last part** (an older station that never sends `more` is handled exactly as today: the host marks it on that request). The last part never writes the field, so an older host still reads what a new station sends. Fixture `known-blocks-request-more.json`; Zod `more: z.boolean().optional()` with `.max(64)` KEPT (addendum), strict.
- Host `POST /v1/device/sscc/blocks/known`: 0–64 blocks; an empty part is refused (400 `blocks`) only when `more`; a part with `more` registers its blocks like any other (revision, audit) but does NOT mark `devices.known_blocks_epoch`; the mark is written on the part without `more` only (UPDATE unchanged, idempotent `IS NOT`).
- Station `reconcileRestore`: builds the parts first (64 each, one empty part for a pairing without blocks), `more: true` on all parts but the last (key omitted on the last). A failed/lost answer on any part rejects and the pairing stays owing; the next run re-sends all parts and the host answers `known` for blocks it took.
- Office: `blocksNote` text per brief ("последнюю часть …", empty-station sentence); `BackupsPage.tsx` comment only.

## Idempotency / data integrity

Lost answer on last part: host may already have marked the station; station stays owing, re-sends all parts, host answers `known`, no new revision/audit/block rows (host test `a_run_sent_again_after_a_lost_last_answer_...`, station test `does not settle when the answer to the last part is lost...`). Lost answer on a non-last part: nothing marked yet, retry safe. Station is never marked before the last part arrives.

## RED / GREEN

- RED (`/tmp/claude/impl-och-t7/red-vitest.txt`, `red-proto.txt`): vitest 5 failed / 80 passed (backups schema test, 4 restore-reconcile); proto test did not compile (`no field more`).
- GREEN: proto `backup` 6 passed; host `known_blocks` 17 (13 + 4 new), `restore_hold` 33, `restore` 9; focused vitest (backups, restore-reconcile, host-link-restore, backups-page, floor-status-bar, api) 243 passed, stderr 0 (`grep -c "stderr |"` = 0); delayed-setImmediate stand on 5 files: 163 passed.
- Full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 152 files, 4721 passed (base 4718, +3). typecheck 0, lint 0, build 0.
- Full `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: rc 0, 71 binaries, 1134 passed, 0 failed, 0 warnings (ХП measured 1126; expected >=1130). `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings.
- Prettier gate live-proved (scratch file -> `[warn]`, rc 1, deleted); changed files clean. `git diff --check` clean. `grep '\u04'`: only `pairing-code.ts:66`.

## Mutants (script `/tmp/claude/impl-och-t7/mut.py`, log `mut.log`, outputs/backups in `bk/`; all `restored=True` = sha256 identical + cmp; Rust files touched)

| id  | one-line mutant                          | killed by                                                             |
| --- | ---------------------------------------- | --------------------------------------------------------------------- |
| H1  | host marks even with `more` (`if false`) | host: part-with-more-registers-and-marks-nothing, last-part-only test |
| H2  | host marks only with `more` (inverted)   | 6 host tests incl. old-station, only-known-blocks                     |
| H3  | empty part with `more` accepted          | last-part-only test                                                   |
| H4  | empty last part refused                  | last-part-only test, `a_station_without_blocks_...`                   |
| H5  | bound 65                                 | largest-size test, `only_a_station_after_a_restore_is_heard`          |
| P1  | proto `more` without `serde(default)`    | 17 host tests (requests without the field)                            |
| P2  | proto `more` always serialised           | `known_blocks_round_trip_and_the_request_is_strict`                   |
| Z1  | Zod without `more`                       | backups.test, reconcile sends                                         |
| Z2  | Zod `more` required                      | backups.test + 3 files                                                |
| Z3  | Zod `more` accepts strings               | backups.test (`more: "yes"`)                                          |
| Z4  | Zod without `.max(64)`                   | backups.test                                                          |
| S1  | station `more` on every part             | 10 tests (reconcile + host-link-restore)                              |
| S2  | station `more` on none                   | 4 reconcile tests                                                     |
| S3  | `more = index > 0`                       | 4 reconcile tests                                                     |
| S4  | no empty part for no blocks              | 6 reconcile tests                                                     |
| S5  | `more: false` always written             | 6 tests (incl. key-absence test)                                      |
| S6  | `more` off by one (`length - 2`)         | 4 reconcile tests                                                     |

## Files

`proto/src/backup.rs`, `proto/fixtures/known-blocks-request-more.json` (new), `proto/tests/backup.rs`, `host/src/routes/known_blocks.rs`, `host/tests/known_blocks.rs`, `src/host/backups.ts`, `src/local/restore-reconcile.ts`, `src/i18n/ru.json`, `src/office/backups/BackupsPage.tsx` (comment), `test/backups.test.ts`, `test/restore-reconcile.test.ts`, `test/backups-page.test.tsx`.

## Anchor adaptations

- Step 0: ХП had already made the host accept 0–64 and the station send one empty request (`do…while`), the `(vec![], "blocks")` case was already removed, and `restore-reconcile`/`host-link-restore`/`floor-status-bar` tests already expect the empty request; only `more` was added. The `do…while` was replaced by the brief's chunk list (equivalent semantics).
- `knownBlocksRequestSchema`: `.max(64)` kept (addendum) although the brief's fragment omits it; `test/backups.test.ts` already pinned 64/65.
- i18n: key `confirmNoBlocks` no longer exists (ХП renamed it `confirmNotReturned`, broader text pinned by tests); kept it, only `blocksNote` replaced with the brief's text. `test/host-link-restore.test.ts` unchanged (the "not called" cases are the never-restored/settled-epoch ones the brief says to leave).
- No other Rust literal of `KnownBlocksRequest` exists (host/proto/src-tauri) apart from deserialisation; no `more: false` literals needed.
- Pre-existing `local_db.rs` migration-version assertion untouched (no migration here).

## Concerns

- Mixed fleets: an older station sending several parts without `more` is marked after its first part (today's behaviour); only a new station gets the last-part guarantee.
- Not exercised: a real Windows restore with host+station over LAN.
