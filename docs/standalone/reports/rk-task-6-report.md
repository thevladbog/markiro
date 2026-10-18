# Plan РК, task 6 — report (host side of the restore epoch: hold of facts, known blocks, resume)

Status: DONE_WITH_CONCERNS (concerns: the extension interpretation, resume has no "all stations back" guard by design, station side РК-С absent, Windows/LAN not exercised).
Commit: `d4ee75011` feat(standalone): after a restore the host holds the facts, a station gives back its blocks, the office resumes (branch claude/infra-rk, on 6fc8536ff). Worktree clean after the commit. No station code, no proto/Zod/manifest/migration change.

## What was done

Brief applied: `routes/known_blocks.rs` (new), `routes/backups.rs::resume_facts`, `routes/mod.rs`, `server.rs` (`restore_hold` layer over the whole router, routes `POST /v1/device/sscc/blocks/known` and `POST /v1/office/backups/resume`), `audit.rs` (`HOST_RESTORE_RESUME`, `SSCC_BLOCK_REGISTER`), tests `known_blocks.rs` and `restore_hold.rs` (the brief's 7 + 4 verbatim, plus 12 more).

### Additions beyond the brief (all on purpose)

1. **rk-minors item 1 (mandatory).** Zod bounds the block extension to 0-9, Rust `extension: u8` does not; a block with an extension above 9 is now `refused` `range_invalid` (before the counter lookup, so it is not reported as a merely missing counter). Past a byte (256) serde already rejects the request (400, tested, nothing written). Interpretation noted under concerns.
2. **`Retry-After: 60`** on the `restore_pending` 503 (`server::RESTORE_RETRY_AFTER_SECS`). Body unchanged (`error-restore-pending.json`: code, message, `details.since`). The brief's layer sent no header. Nothing in the station reads it yet.
3. Extra tests that kill one-line mutants the brief's tests let live: every part of a stored block must match (prefix, extension, from, to, and the DEVICE: another station's block is `block_mismatch`); duplicate block in one request is taken once (`registered` then `known`, one revision, one audit row) and an overlapping second block is refused; a pallet block raises the pallet counter only; the hold answers any method on a held path and leaves the feed (`/v1/changes`) and near-miss paths alone; a station's blocks do NOT end the hold (reconciled flag flips, hold stays, `reconciled` counted in the resume audit row); the hold lives in the database (a fresh `AppState` over the same pool is held); `Retry-After` and content type.

### SSCC integrity checklist (the dispatch's list)

- A registered block raises the counter strictly above its end: `next_serial = to + 1` only when lower (`AND next_serial < ?1`), per prefix and extension; boxes/pallets independent (tested). Last serial (`capacity - 1`) fits (counter = capacity, the existing exhausted semantics).
- Idempotent: same block twice (also in one request) = `known`, nothing written, no revision, no audit.
- Another device's block / changed prefix / extension / serials under a known id = `block_mismatch`; an id the station once used as a request id = `block_mismatch`; overlap with any block, revoked included = `block_overlap`.
- The hold is released ONLY by `POST /v1/office/backups/resume` (administrator role re-checked inside the write transaction; technologist forbidden; a user turned off after the extractor gets 401). Station registrations never release it. Resuming without a hold changes nothing and writes no row. The override is explicit (a dedicated route), audited (`host.restore.resume` with `since`, `epoch`, `stations`, `reconciled`), and documented in the module/handler docs; runbook text is Task 8's (below).
- The hold never blocks the office: only `/v1/device/facts` and `/v1/device/codes/*` are held; `/v1/office/*`, `hello`, `changes`, blocks, shifts stay up (tested: office me, hello with `restoreEpoch`, issue block, feed).
- Crash safety: the hold is `site.facts_held_since`, set by the restore transaction (Task 5) and cleared by one transaction that also writes the audit row; the layer reads it from the database per request and fails closed (a read error is a 500, never a pass-through).
- No secrets in logs: the new route and layer log nothing; errors echo no input.

## RED / GREEN

- RED (`/tmp/claude/impl-rk-t6/red1.txt`, `red2.txt`): `known_blocks` E0432 `unresolved import markiro_host::routes::known_blocks`; `restore_hold` 3 failed, 1 passed (as the brief says). My extra tests, run on the brief's code (`red3.txt`, `red4.txt`): `an_extension_no_serial_can_carry…` got `prefix_unknown` x3 instead of `range_invalid`; `a_held_answer_tells_the_station_when_to_ask_again` had no `retry-after`; the other new tests passed on the brief's code (they pin existing behaviour and kill mutants).
- GREEN: `--test known_blocks --test restore_hold --test backup_routes --test sscc_blocks`: 11 + 8 + 13 + 19 passed (brief says 7 / 4 / 7 + sscc_blocks; backup_routes has 13 in this tree).
- ONE final unsandboxed `cargo test --offline --locked --workspace --no-fail-fast`: exit 0, 63 `test result` lines, **960 passed, 0 failed** (Task 5 fix round: 61 / 941; +19 = my tests; the +2 result lines are the two new test binaries).
- `cargo fmt --all -- --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings; `git diff --check` clean; `\u04` only `src/host/pairing-code.ts:66`; no `\u0` in the Rust files; prettier gate proven live (mis-formatted scratch `.ts` -> "Checking formatting…", exit 1, deleted); no prettier-covered file changed. No webview file changed (Vitest, typecheck, lint, build and the delayed-`setImmediate` stand: not applicable).

## Mutants

`/tmp/claude/impl-rk-t6/mut.py`, log `mutants.txt`; each file copied to `/tmp/claude/impl-rk-t6/mut/<name>.bak`, mutated, tested, restored, `cmp` silent, sha256 equal, `touch`ed (`restored=True` for all 31). Brief M1-M12 and mine X1-X19, all killed:

| #        | Mutant                                   | Killed by                                                                           |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| M1       | overlap `<=`/`>=` -> `<`/`>`             | a_revoked_block_still_holds…                                                        |
| M2       | blocks heard without a restore           | only_a_station_after_a_restore_is_heard                                             |
| M3       | counter may go back                      | a_block_below_the_counter…                                                          |
| M4       | no station re-check in the transaction   | a_station_revoked_while_it_waited…                                                  |
| M5       | marked station not committed             | a_station_that_sends_only_known_blocks…                                             |
| M6       | commit wakes nobody                      | a_station_gives_back_the_block…                                                     |
| M7       | code checks not held                     | a_held_host_answers…                                                                |
| M8       | nothing held                             | 5 tests incl. a_held_host_answers…                                                  |
| M9       | everything held                          | 5 tests incl. an_administrator_resumes_the_facts_once                               |
| M10      | resume leaves the hold                   | an_administrator_resumes_the_facts_once                                             |
| M11      | resume without admin re-check            | an_administrator_turned_off_after_the_extractor…                                    |
| M12      | audit `stations` 0                       | an_administrator_resumes… and a_station_that_gave_its_blocks_back…                  |
| X1       | extension bound 9 -> 200                 | an_extension_no_serial_can_carry…                                                   |
| X2       | extension bound 9 -> 1                   | that test and a_block_the_host_cannot_take…                                         |
| X3       | `same` ignores the device                | a_block_of_the_host_is_the_stations_only_if_every_part… (brief tests let this live) |
| X4/X5/X6 | `same` ignores prefix / extension / from | same test                                                                           |
| X7       | `same` ignores to                        | same test and a_block_the_host_cannot_take…                                         |
| X8       | request-id-taken check off               | a_block_the_host_cannot_take…                                                       |
| X9       | Retry-After 61                           | a_held_answer_tells_the_station_when_to_ask_again                                   |
| X10      | Retry-After under another header         | same                                                                                |
| X11      | empty block list accepted                | only_a_station_after_a_restore_is_heard                                             |
| X12      | 65 blocks accepted                       | same                                                                                |
| X13      | block id not validated                   | same                                                                                |
| X14      | station marked with `""`, not the epoch  | a_station_that_sends_only_known_blocks…                                             |
| X15      | `reconciled: true` always                | a_station_that_gave_its_blocks_back…, an_administrator_resumes…                     |
| X16      | audit `reconciled` always 0              | a_station_that_gave_its_blocks_back…                                                |
| X17      | hold read from `restore_epoch`           | 4 tests                                                                             |
| X18      | counter set to `to`, not `to + 1`        | 4 tests                                                                             |
| X19      | stored `request_id` not the block id     | a_station_gives_back_the_block… (stored row compared)                               |

Not killable by a test (stated): the layer's fail-closed 500 on a database error (needs fault injection); the exact value 60 is pinned, but not that a real station honours it.

## Test totals: plan vs measured

Plan: known_blocks 7, restore_hold 4. Measured: known_blocks 11, restore_hold 8 (backup_routes 13 here, plan 7: Tasks 3-4 grew it). Workspace 63 result lines / 960 passed.

## Files changed

`apps/standalone/host/src/routes/{known_blocks.rs (new), backups.rs, mod.rs}`, `apps/standalone/host/src/{server.rs, audit.rs}`, `apps/standalone/host/tests/{known_blocks.rs, restore_hold.rs}` (new).

## Anchor adaptations (mechanical)

- `routes/mod.rs`: the brief's anchor list (`counterparties … office_shifts`) differs in this tree (`facts`, `codes`, … exist); `pub mod known_blocks;` inserted alphabetically after `facts`.
- `server.rs` step 7: the brief's anchor (the blocks route followed directly by `/v1/changes`) differs (`facts` and `codes` routes sit between); the `/v1/device/sscc/blocks/known` route added right after `/v1/device/sscc/blocks`.
- All other fragments (backups.rs x2, server.rs x3, audit.rs x2) matched exactly once. `Retry-After` required `HeaderValue`, `RETRY_AFTER`, `IntoResponse` imports in `server.rs`, and the layer now returns `Ok(held_response)` instead of `Err(ApiError)`.

## For Task 8 (runbook / AGENTS.md / spec)

1. Resume is the administrator's decision, not a guard: the host holds facts and code checks (503 `restore_pending`, `Retry-After: 60`, `details.since`) until "Возобновить приём" (`POST /v1/office/backups/resume`), whatever stations did. Registering blocks never releases it. Resume with a station that has not given its blocks back is allowed (a station on a dead computer never will); the audit row `host.restore.resume` records `stations` and `reconciled`. After resume, a fact naming a block the host lost is refused for good (receipts are kept) — so resume only when the office list shows every station `reconciled` or the missing ones are known dead. Until plan РК-С exists no station returns blocks, so the runbook must say: do not resume before the SSCC checks of the runbook, and expect `reconciled` to stay 0.
2. Audit table: add `sscc.block.register` (actor device; target `sscc_block`/block id; details `issuerPrefix, extension, fromSerial, toSerial`) and `host.restore.resume` (administrator; `site`/`1`; `since, epoch, stations, reconciled`); known and refused blocks write no row; the response of `known` blocks is the answer, nothing is stored except `devices.known_blocks_epoch`.
3. Wire: `POST /v1/device/sscc/blocks/known` answers 200 with one result per block even when refused; `conflict`/`no_restore` before any restore; `range_invalid` also for an extension above 9. Station side (РК-С) must: send all held blocks after `hello.restoreEpoch` changes, treat `refused` as "these serials may not be used" and surface it, honour `Retry-After`, and keep unsent facts queued on `restore_pending`.
4. rk-minors items 2/3/5/9 are Task 5/8 matters; this task adds nothing to them. Item 9 runbook texts (revocations, STOPPED, interrupted restore, margins, РК-С) are unchanged by this task.

## Self-review

- The layer is path-only (all methods); a future route on a held path is held. It reads one row per held request outside any write transaction (WAL: no wait for a writer), so `codes` keeps its latency budget.
- `resume_facts` needs `state.backups`; without it the route is `not_found`. `crate::start` always sets it; only a bare test state lacks it.
- A revision is taken when any block is registered even if the counter was already above it (the brief's "one revision if anything registered"); harmless wake-up.

## Concerns

1. **Extension interpretation.** rk-minors item 1 says "range_invalid for an extension outside the counters". The counters exist for 0 and 1 only (CHECK), but the brief's own test pins extension 2 to `prefix_unknown`. I implemented: digit above 9 (what Zod forbids) -> `range_invalid`; 2-9 -> `prefix_unknown` (a valid digit without a counter). If the owner meant "anything but 0/1 is `range_invalid`", it is a one-line change of `MAX_EXTENSION` to 1 plus the brief's test row for extension 2.
2. Resume has no explicit "I know N stations have not returned blocks" confirmation (the proto/Zod contract of Task 1 is body-less). The override is explicit as a dedicated administrator action and audited, but a UI confirmation naming the unreconciled stations belongs to Task 7.
3. Station side is absent (РК-С): nothing calls `blocks/known`, nothing honours `Retry-After` or `restore_pending` yet; the station's behaviour on 503 for facts is unverified against this layer.
4. Not exercised: Windows, LAN, a real station, the service; only in-process router tests.
5. `backup_start::the_office_of_a_started_host_reads_its_copies` (known flake from Task 5's notes) passed in the final workspace run.
