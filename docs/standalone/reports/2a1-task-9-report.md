# Plan 2a1, Task 9 report

Status: DONE_WITH_CONCERNS (concerns are minor, listed at the end).
BASE = 69b8962ab, commit = `366e87f06` "test(standalone): the process log holds no shift snapshot; the stage 2a spec takes plan 2a1's refinements" (trailer: one `Co-Authored-By: Claude Opus 5.5` line, as the repo pins).

## What was done

1. `host/tests/no_secrets_in_logs.rs`: the four plan edits applied verbatim (doc comment; shift walk: lines -> `PUT /v1/device/line` -> product -> `POST /v1/office/shifts` -> `enter` -> device list -> SSCC block -> office GET -> office close; `SELECT snapshot FROM shifts`; final `snapshots.iter().any(contains "layout-marker-office-2")`). Anchor 4 differs only by the trailing blank line the markdown block carries (file ends with `}\n`); nothing else differed.
   Addition beyond the plan (controller's "hunt mutants" request): the walk enters the shift a SECOND time as the owner (re-entry path serves the stored snapshot back) and asserts the response carries the layout. Without it a log line on the re-entry path would pass (the plan's walk enters once).
2. `host/tests/device_shifts.rs`: new end-to-end test `a_shift_the_office_closes_reads_closed_to_its_owner_and_no_station_reenters_it`: station on a line enters (status active, listed active, `closedAt` null) -> clock +5 min -> office `GET` for `rev`, `POST /v1/office/shifts/{id}/close` -> owner's `GET /v1/device/shifts` lists the shift with `status: closed`, `closedAt` == the close instant (differs from `openedAt`), same `openedAt`/`ownerDeviceId`/`number` -> a colleague station of the same line (never entered) does not list it -> re-entry by owner and by colleague is 409 `conflict` / `{constraint: shift_status, status: closed}`.
3. `apps/standalone/AGENTS.md` ("Logs") and the new §15 of `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (13 refinements) per the plan; the spec anchor again differed only by the trailing blank line.

## RED / GREEN

Production code is untouched, so both new tests pass at once (the plan says so). Evidence:

- `no_secrets_in_logs`: 1 passed (before and after adding the re-entry); the mutants below show it is a real guard.
- `device_shifts` new test: first run FAILED at `device_shifts.rs:1273` with `office session expired` (my test advanced the clock 2 h, past the office session TTL; a test bug, not host). Changed to 5 min -> `device_shifts`: 15 passed.

## Mutants (all restored; `cmp` silent, sha256 identical to the pre-mutation hash: device_shifts.rs `aaad9757...efef`, office_shifts.rs `4fbe0cb6...89d7`; shifts.rs restored with cmp + hash diff at the time, `git status` clean afterwards)

| #   | Mutant (one line)                                                                                                 | Test that failed                                                                                                                                                                                          | Key line                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| M1  | plan's: `tracing::info!(snapshot = %serde_json::to_string(&snapshot)...)` before `next_revision` in `enter_shift` | `no_secrets_in_logs::secrets_never_reach_the_process_log`                                                                                                                                                 | `no_secrets_in_logs.rs:686: the process log contains layout-marker-office-2`                    |
| M2  | `tracing::info!(snapshot = %text, "shift re-entered")` in the re-entry (`Some(text)`) arm                         | same                                                                                                                                                                                                      | same message (this one would PASS with the plan's single entry; it is why I added the re-entry) |
| M3  | `tracing::warn!("template {template_name} {spec}")` in `shifts::snapshot`                                         | same                                                                                                                                                                                                      | same message                                                                                    |
| A   | list drops the closed branch (`... OR s.closed_at >= ?3` -> `OR ?3 IS NULL`)                                      | new test (`"the owner still lists the closed shift"`, :1287) and `a_station_sees_the_open_shifts_of_its_line_and_those_it_entered` (:166)                                                                 |                                                                                                 |
| B   | office close stamps `closed_at` with `opened_at` instead of now                                                   | new test, `:1289` `closedAt` left `...14:13:20Z` vs right `...14:18:20Z`                                                                                                                                  | the closed instant is checked against the manual clock                                          |
| D   | `enter_shift` stops refusing closed shifts (`if false && status == Closed`)                                       | new test (:1298: left `(200, Null, Null)`, right `(409, "conflict", {constraint: shift_status, status: closed})`) + `a_shift_takes_one_station_of_its_line_and_never_opens_once_closed` (:741) + one more |                                                                                                 |
| E   | the line branch of the list also shows `closed` shifts                                                            | new test `:1294` (colleague sees the closed shift) and `a_station_sees_the_open_shifts...` (:177)                                                                                                         |                                                                                                 |

Note on the requested "close not writing `closed_at`" mutant: migration 0009 has `CHECK ((status = 'closed') = (closed_at IS NOT NULL AND closed_by_kind IS NOT NULL))`, so such a mutant cannot even commit (DB refuses); mutant B (wrong value written) covers the link at the test level instead.

## Checks

- `cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline` 0 warnings (exit 0).
- `cargo test --workspace --offline --locked` (outside the sandbox, ~70 min wall): every result line `ok`, 0 failed, 0 warnings. Counts as measured: host 359 tests (30 binaries; brief says 334), proto 45 (2 binaries; brief 45), shell 115 (13 binaries; brief 115) = 519 tests, plus the three doc-test suites (0 tests each). Brief: 46 suites / 494 tests. Difference = host +25: the extra tests of earlier tasks and fixes, and +1 of mine in `device_shifts.rs` (15 now).
- Vitest `@markiro/standalone`: 67 files, 1744 tests passed; `typecheck` and `lint` exit 0. No `build` (brief does not ask).
- `prettier --check` on all json/ts/md files of `5ea7da950..HEAD`: clean. `git diff --check` (and over the whole plan range): clean. `grep '\u04'` in src/test: only `src/host/pairing-code.ts:66`; `\u0` in Rust/JSON of host and proto: only the pre-existing `proto/fixtures/pairing-codes.json` lines; none in what I wrote.
- Plan-range diff (`5ea7da950..HEAD --stat`): `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml`, `apps/station`, `packages/*`, migrations 0001-0008 untouched; only new migration 0009; shell only `src-tauri/src/host_probe.rs`; webview only `errors.ts`, `protocol.ts`, `ru.json` and two tests. `git status --short` empty after the commit.

## Not verified (as the plan lists)

New routes are used by nobody yet (screens in 2a3, 2a5-2a8); snapshot with a real domain layout through the station not run (tests send tiny layouts; `labelTemplateSpecSchema` check is plan 2a5); protocol 2 not tried on a live pair "stage-1 host - 2a station" and back (evidence: probe tests + `protocol_guard`); CI jobs `standalone-rust` / `standalone-windows-build` need a push; Windows service/WebView2 out of scope.

## Concerns

- Doc-tests of `markiro_standalone_lib` (shell crate; `rustdoc --crate-type staticlib` over tauri) are very slow and, run alone, hung for minutes at "Doc-tests markiro_standalone_lib" (0 tests; unrelated to this task). The first full workspace run did finish with exit 0 (the harness reported completion code 0), but its own trailing `exit` line was not written to my log and the doc-test stage looked stuck for ~10 min; I killed the stray rustdoc processes I had spawned afterwards. A CI run with `--workspace` pays this cost; consider `--lib --bins --tests` or `--no-doc-tests` for the shell crate.
- A tooling note: `shasum | diff -` printed "Operation not permitted" inside the sandbox; I verified restoration with `cmp` and explicit hash comparison instead.
- `no_secrets_in_logs.rs` is the only test that sees the log at `info`/`warn` level; a `debug!` mutant would be filtered by the subscriber level (not checked).
- The 2-h clock advance in my first draft exposed that office sessions expire inside 2 h on the manual clock; unrelated, no action.
