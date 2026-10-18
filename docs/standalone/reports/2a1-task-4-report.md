# Plan 2a1, Task 4 — report

Status: DONE_WITH_CONCERNS (one addition beyond the brief: a 5th host test; see Concerns).
BASE 89b9c17cf8f7c50c27d9680f0ed640bceaab1eb4. Commit: `7d2efbca0 feat(standalone): a station's shifts and its own new shift; protocol 2` (trailer exactly one `Co-Authored-By: Claude Opus 5.5` line; `git status --short` empty after).

## What was done

Steps 1-5 of the brief in order, every anchor matched exactly once (scripted edits assert count == 1; the `proto/tests/fixtures.rs` `use` block was replaced whole). Code of `host/src/routes/device_shifts.rs`, the proto types, route registration, `PROTOCOL_VERSION` 2 (proto + webview mirror), the shell probe test lines and `protocol.test.ts` are the plan's, verbatim. Only addition: test `a_station_create_takes_every_field_it_names` in `host/tests/device_shifts.rs` (a station create with `boxCapacity` 6, `plannedQty` 1200 and a counterparty; asserts the station's answer and the office view). `cargo fmt` then reflowed the long counterparty JSON line of that test only.

## RED (before Step 3 code)

Logs in `/tmp/claude/2a1t4/red-*.txt`.

- `--test device_shifts`: 4 of 4 FAILED (routes 404).
- `--lib server`: 2 of 3 FAILED (`a_missing_header_is_refused_with_details`, `a_supported_version_passes`).
- `--test claim`: `a_device_in_the_network_pairs_with_a_code_typed_in_any_case` FAILED (protocol 1 stored).
- outside sandbox `--test hello --test platform --no-fail-fast`: `hello_answers_over_tls_with_the_pinned_certificate` and `hello_needs_no_protocol_header` FAILED.
- `-p markiro-proto`: `error[E0432]: unresolved imports markiro_proto::DeviceShift, DeviceShiftCreate, DeviceShifts`.
- `-p markiro-standalone --lib host_probe`: `a_host_older_than_this_app_is_rejected` FAILED (5 passed, 1 failed).
- Vitest `test/protocol.test.ts`: 1 failed (`hello`), 185 passed.
  All as the brief expects.

## GREEN

- `--test device_shifts --test claim`: 4 -> 5 (with my extra test) and 9 passed.
- `--lib server`: 3 passed. `-p markiro-proto`: 5 unit + 37 fixture = 42 passed (brief: 5 + 37).
- outside sandbox: `--test hello --test platform`: 5 and 7 passed; `-p markiro-standalone --lib host_probe`: 6 passed.
- Vitest `test/protocol.test.ts`: 186 passed; `--reporter=verbose`: stderr 0 bytes, 186 checkmarks; delayed-`setImmediate` stand (`/tmp/claude/stand.sh`, files removed by it): 186 passed.
- Full `cargo test -p markiro-host -p markiro-proto --offline --locked` outside the sandbox: exit 0, 33 result lines all `ok`, 0 failed, 373 passed = host 331 + proto 42. Brief: host 325, proto 42. Host 331 = 326 (measured before this task: Task 3 total 325 + its fix-round test) + 5 (4 plan + 1 mine); the brief's 325 does not include earlier tasks' extra tests.
- Package gates: `typecheck` 0, `lint` 0, `test` 67 files / 1744 tests passed (the first full run hit one 5 s timeout in `products-page.test.tsx` while the cargo full run was compiling in parallel; that file alone: 20 passed, and the full run repeated alone: all green). `cargo fmt --check` clean, `cargo check -p markiro-host -p markiro-proto --all-targets --offline` 0 warnings, prettier clean on the 6 changed JSON/TS/MD files, `git diff --check` clean, `\u0` greps: only `src/host/pairing-code.ts:66`.
- Not run: `build` of the webview (no change to the shell dist beyond the one-line constant; a prior dist existed and `-p markiro-standalone` compiled/ran with it) and the whole shell test suite (the brief names only `host_probe`).

## Mutants

Each: file backed up to `/tmp/claude/2a1t4/bak/<id>`, mutant applied, command run, file restored; the harness (`/tmp/claude/2a1t4/mut.py`) checked `cmp` against the backup and the sha256 prefix: all restored, same hash (device_shifts.rs 4e0c2038fbc4, server.rs 197ba9163729, proto lib.rs b7ef3f048b64, protocol.ts 422205dd512c). Outputs `/tmp/claude/2a1t4/mut-<id>.txt`. "T" = a_station_… test names abbreviated.

| #   | Mutant (one line)                                          | Test that failed                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | plan M1: list drops `AND s.status IN ('planned','active')` | a_station_sees_the_open_shifts_…                                                                                                                                                                                             |
| M2  | plan M2: `repeated.filter(\|_\| false)`                    | a_station_creates_a_shift_on_its_line_once_per_request                                                                                                                                                                       |
| M3  | GET without `require_station`                              | only_a_station_reads_and_creates_shifts                                                                                                                                                                                      |
| M4  | POST without `require_station`                             | only_a_station_reads_and_creates_shifts                                                                                                                                                                                      |
| M5  | `CLOSED_DAYS` 30 -> 31                                     | a_station_sees_…                                                                                                                                                                                                             |
| M6  | `closed_at >= ?3` -> `>`                                   | a_station_sees_…                                                                                                                                                                                                             |
| M7  | entered active shift needs `closed_at >= cutoff`           | a_station_sees_…                                                                                                                                                                                                             |
| M8  | product name always `p.name` (snapshot ignored)            | a_station_sees_…                                                                                                                                                                                                             |
| M9  | counterparty name always `c.name`                          | a_station_sees_…                                                                                                                                                                                                             |
| M10 | `ORDER BY s.production_date DESC`                          | a_station_sees_…                                                                                                                                                                                                             |
| M11 | participant filter `sp.device_id = sp.device_id`           | a_station_sees_…                                                                                                                                                                                                             |
| M12 | `requestId` not validated                                  | a_station_create_follows_the_plan_rules_on_its_own_line                                                                                                                                                                      |
| M13 | repeat lookup ignores `created_by`                         | a_station_creates_a_shift_on_its_line_once_per_request                                                                                                                                                                       |
| M14 | archived line not checked                                  | a_station_create_follows_…                                                                                                                                                                                                   |
| M15 | `line_conflict` constraint renamed                         | a_station_create_follows_…                                                                                                                                                                                                   |
| M16 | request `boxCapacity` ignored                              | a_station_create_takes_every_field_it_names (mine)                                                                                                                                                                           |
| M17 | request `plannedQty` dropped                               | a_station_create_takes_every_field_it_names (mine)                                                                                                                                                                           |
| M18 | request `counterpartyId` dropped                           | a_station_create_takes_every_field_it_names (mine)                                                                                                                                                                           |
| M19 | counterparty not checked                                   | a_station_create_follows_…                                                                                                                                                                                                   |
| M20 | box template fit not checked                               | a_station_create_follows_…                                                                                                                                                                                                   |
| M21 | audit detail `lineId` shows the product id                 | a_station_creates_… (audit_trail)                                                                                                                                                                                            |
| M22 | origin recorded as `Office`                                | a_station_creates_…                                                                                                                                                                                                          |
| M23 | `plannedQty` bound not checked                             | a_station_create_follows_…                                                                                                                                                                                                   |
| M24 | `boxCapacity` bound not checked                            | a_station_create_follows_…                                                                                                                                                                                                   |
| M25 | `productionDate` not validated                             | a_station_create_follows_…                                                                                                                                                                                                   |
| M26 | audit action recorded as `shift.update`                    | a_station_creates_…                                                                                                                                                                                                          |
| S1  | `.post(create_device_shift)` unregistered                  | 3 tests (create, plan rules, every field)                                                                                                                                                                                    |
| S2  | `PROTOCOL_VERSION` back to 1                               | server::tests::a_supported_version_passes, a_missing_header_is_refused_with_details (claim/hello/platform not in that run: the `server` filter excludes them; they were RED on the unchanged constant in the pre-change run) |
| P1  | `DeviceShiftCreate` loses `deny_unknown_fields`            | proto device_shift_fixtures_round_trip_and_a_station_names_no_line                                                                                                                                                           |
| P2  | `DeviceShiftCreate.request_id` gets `#[serde(default)]`    | same proto test                                                                                                                                                                                                              |
| T1  | webview `PROTOCOL_VERSION` back to 1                       | protocol.test.ts > hello                                                                                                                                                                                                     |

M16-M18 survived the plan's tests (no host test created with those fields); that is why the extra test exists; it kills them. No mutant survives now.

## Files changed

`apps/standalone/host/src/routes/device_shifts.rs` (new), `host/src/routes/mod.rs`, `host/src/server.rs`, `host/tests/device_shifts.rs` (new), `host/tests/{claim,hello,platform}.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/{device-shifts,device-shift-create}.json` (new), `proto/fixtures/hello.json`, `src-tauri/src/host_probe.rs` (test lines only), `src/host/protocol.ts` (one constant), `test/protocol.test.ts`, `AGENTS.md`. Cargo.toml, Cargo.lock, package.json, lockfile, migrations untouched.

## Self-review

- Interfaces for Task 5: `line_conflict`, `list_device_shifts`, `create_device_shift` are `pub`; `read` and `require_station` are private in the plan's code (same module, where Task 5 adds entry), as the plan wrote them; test helpers `device_id`, `select_line`, `device_call`, `listed`, `open_directly`, `close_directly`, `snapshot`, `device_shift`, `device_create`, `REQUEST`, `device_row` exist in `tests/device_shifts.rs`.
- Task 5 note: the plan says task 5 uses those helpers from `tests/device_shifts.rs` (same file), so no `support` move was needed.

## Concerns

- Host total differs from the brief's 325 (measured 331, see above): +1 Task 1, +2 Task 2 fix, +1 Task 3, +1 Task 3 fix, +1 mine.
- One flaky 5 s timeout seen once in `test/products-page.test.tsx` under parallel cargo load, unrelated to this task; green alone and in the repeated full run.
- A local `rtk` wrapper printed `[rtk: Operation not permitted (os error 1)]` once; no effect on results.
- Two of my helper invocations used `cd` (inside a heredoc/Python snippet, returning to the root at once) before I noticed the rule; no stray `.claude/.cc-writes` was found in the tree (`git status` clean).

## Fix section (review findings 1, 2, 3, 5)

Base `7d2efbca0`. Production code untouched; tests only in `host/tests/device_shifts.rs`, plus one clause in `AGENTS.md` (wrapped at 80, prettier clean).

- Finding 1: `snapshot()` now carries GTIN `04600682000020` (not the product's `...013`); the busy view asserts `productGtin14`.
- Finding 2: `a_station_creates_a_shift_on_its_line_once_per_request` posts a second request id from the same station: new id, `OCT26-002/S`, revision 5; the other station's create becomes `OCT26-003/S`.
- Finding 3: `only_a_station_reads_and_creates_shifts` loops the refusal over `office` and `handheld` (handheld paired through `/v1/office/pairing-codes` + `/v1/pairing/claim` from LAN; local-pair refuses handheld). The device kinds are exactly station, office, handheld.
- Finding 5: AGENTS.md clause «while that shift exists ... a retry after the office deleted it plans a new shift».
- Finding 4 (stale protocol-1 samples) left queued, as instructed.

| Mutant (one line, scratch in `routes/device_shifts.rs`) | Test that failed                                       | Key line                                      | Restore proof                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------ |
| A: list GTIN `p.gtin14 AS product_gtin14`               | a_station_sees_the_open_shifts_...                     | left `04600682000013`, right `04600682000020` | sha `4e0c2038...c6e7c` equal before/after, `cmp` against /tmp/claude/ds_src.rs |
| B: repeat lookup `(create_request_id = ? OR 1)`         | a_station_creates_a_shift_on_its_line_once_per_request | `OCT26-001/S` vs expected `OCT26-002/S`       | same                                                                           |
| F: `device.kind != DeviceKind::Office`                  | only_a_station_reads_and_creates_shifts                | `handheld GET`: left 200, right 403           | same                                                                           |

Counts: `--test device_shifts` 5 passed (same test count; assertions added). fmt, `cargo check -p markiro-host -p markiro-proto --all-targets` (0 warnings), prettier, `git diff --check` clean.
