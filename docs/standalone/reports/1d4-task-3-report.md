# Task 3 report — the `badge` conflict names its owner (plan 1d4)

**Status:** DONE (one environment note about the sandbox, below; no concern about the change itself).
**Commit:** `9bf19c24e` — `feat(standalone): конфликт бейджа называет его владельца` (on top of `b55afa9fd`).

## What I implemented

`POST /v1/office/operators/{id}/badges` answered a badge that collides with
`operator_badges_active_phc` with `409 conflict`, `details: { constraint: "badge" }`.
It now also carries `details.operatorId` — the id of the operator who holds the
active badge with the same hash — read in the same write transaction after the
unique violation. Applied exactly as the brief wrote it:

- `host/src/routes/operators.rs`
  - `codes` added to the `markiro_proto` import (3.1);
  - `badge_taken` is now `async fn badge_taken(conn: &mut SqliteConnection, error: sqlx::Error, badge_phc: &str) -> ApiError`:
    it builds the `conflict` through `ApiError::conflict_on_unique_violation`, returns
    anything that is not `codes::CONFLICT` unchanged (that is the `internal` case),
    otherwise selects `operator_id FROM operator_badges WHERE badge_phc = ? AND revoked_at IS NULL`
    on the same connection and attaches `{ "constraint": "badge", "operatorId": <id> }`
    with `with_details`; no row -> the plain conflict, a failed read -> `ApiError::internal` (3.2);
  - `create_badge` keeps the insert's result in `inserted` (3.3) and on `Err` returns
    `badge_taken(&mut tx, error, create.badge_phc.expose()).await` (3.4). The transaction
    is dropped on that return, so a refused badge still changes nothing (revision, rows, audit).
- `host/tests/badges.rs`: `one_badge_code_belongs_to_one_operator_at_a_time` got its doc comment
  and now compares `details` whole — `{ "constraint": "badge", "operatorId": first }` — both for
  the other operator (`second`) and for the owner asking again (`first`).
- Docs: `apps/standalone/AGENTS.md` («Operators and badges») and the spec
  `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` §4.6.

Nothing else changed: no `proto/`, `src/`, `src-tauri/`, `apps/station`, no Cargo.toml / lockfile.
`details` is untyped JSON, so the wire types are untouched. The endpoint is administrator-only
(`require_admin` and `require_admin_in`), so naming the owner leaks nothing an administrator
cannot already read from `GET /v1/office/operators`.

## What I tested and the results

| Check                                                                            | Result                                                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test … -p markiro-host --test badges --offline` (in the sandbox)          | RED before the change (1 of 8), GREEN after (8 of 8)                                                                                      |
| Mutation 1 (conflict without `operatorId`)                                       | FAILS at `host/tests/badges.rs:199:9`; reverted, sha256 + `cmp` identical                                                                 |
| `cargo test … -p markiro-host --offline`, whole package, **outside the sandbox** | **22 suites, 210 tests, 0 failed, 0 ignored, 0 compiler warnings** (matches the brief)                                                    |
| `cargo check … --workspace --all-targets --offline`                              | OK, 0 warnings, 0 errors                                                                                                                  |
| `cargo fmt … --all -- --check`                                                   | clean (the new `badge_taken` signature line is exactly 100 columns, rustfmt accepts it)                                                   |
| `node_modules/.bin/prettier --check` on `apps/standalone/AGENTS.md` and the spec | clean                                                                                                                                     |
| `git diff --check` (worktree and staged)                                         | clean                                                                                                                                     |
| Cyrillic bytes in the spec edit                                                  | real UTF-8; no literal `\uXXXX` on any added line (checked with grep and by decoding the diff)                                            |
| Commit message                                                                   | subject + blank line + exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (`git log -1 --format=%B`); no other trailer |

The 22 «suites» are 21 test binaries (the lib unit tests 46, the `main.rs` unit tests 3, and 19
integration files with 161 tests) plus the doc-test run (0 tests): 46 + 3 + 161 = 210.

Not run, with the reason: `graphify update .` (root `AGENTS.md` asks for it only «when a local graph
exists»; this worktree has no `graphify-out/`), the webview tests (no webview change), anything
Windows/browser/hardware (not exercised by this task; host-only Cargo tests prove none of it).
An informational `cargo clippy -p markiro-host --all-targets` (no clippy gate exists in CI or the
workspace) reports one warning family, «very complex type used» at `host/tests/support/app.rs:336`
(pre-existing, repeated once per test binary that includes `support`), and nothing in
`routes/operators.rs` or `tests/badges.rs`.

## TDD Evidence

**RED** — `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline`
(after Step 1 only, the implementation untouched):

```text
running 8 tests
test a_badge_hashed_with_the_site_salt_is_added_and_rides_the_feed ... ok
test a_zero_padded_copy_of_an_active_badge_is_refused_not_stored_twice ... ok
test a_badge_hash_must_carry_the_site_salt_and_the_domain_iterations ... ok
test one_badge_code_belongs_to_one_operator_at_a_time ... FAILED
test a_badge_is_found_only_under_its_own_operator ... ok
test revoking_a_badge_writes_a_tombstone_and_the_badge_never_comes_back ... ok
test the_badge_salt_is_the_sites_and_only_for_administrators ... ok
test technologists_cannot_touch_badges ... ok
…
thread 'one_badge_code_belongs_to_one_operator_at_a_time' panicked at host/tests/badges.rs:199:9:
assertion `left == right` failed
  left: (409, Object {"constraint": String("badge")})
 right: (409, Object {"constraint": String("badge"), "operatorId": String("9d103e65-eb6a-4d59-a3fd-fd40fb4bf4f4")})
test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
```

Expected: exactly the brief's failure — 1 of 8, the host still answers `{constraint}` only, and the
test now demands `operatorId` (the UUID is a random per-run fixture).

**GREEN** — same command after Step 3:

```text
running 8 tests
… (all eight) … ok
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

The compile output of both runs holds no warnings.

## Mutation evidence

File: `apps/standalone/host/src/routes/operators.rs`.

- sha256 before: `931ec956e5f14f6ac3fa8237f9b62dd8e1f596b77cb0f2dd5d5740d354ba1d91`
  (a byte copy taken next to it: `cmp` identical).
- Mutation 1, as in the brief: the `Ok(Some(operator_id)) => { conflict.with_details(…) }` and
  `Ok(None) => conflict,` arms replaced by `Ok(Some(_)) | Ok(None) => conflict,`.
- Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline one_badge_code`
  -> exit 101:

  ```text
  running 1 test
  test one_badge_code_belongs_to_one_operator_at_a_time ... FAILED
  thread 'one_badge_code_belongs_to_one_operator_at_a_time' panicked at host/tests/badges.rs:199:9:
  assertion `left == right` failed
    left: (409, Object {"constraint": String("badge")})
   right: (409, Object {"constraint": String("badge"), "operatorId": String("34475867-5621-40b6-8f0c-e35ab2662946")})
  test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out
  ```

  This is the brief's expected failure (panic at `badges.rs:199:9`, `assertion left == right failed`).

- Reverse edit applied; sha256 afterwards `931ec956e5f14f6ac3fa8237f9b62dd8e1f596b77cb0f2dd5d5740d354ba1d91`
  (equal), and `cmp` against the pre-mutation copy reported byte-identical. The mutation was never
  staged or committed; the later whole-package run (210 tests) ran on the restored file.

## Files changed (commit `9bf19c24e`, 4 files, +41 / −12)

- `apps/standalone/host/src/routes/operators.rs`
- `apps/standalone/host/tests/badges.rs`
- `apps/standalone/AGENTS.md`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

## Self-review findings

- Completeness: every brief step done in order (test, RED, code, GREEN, mutation with revert proof,
  both docs, checks, commit with the brief's message and file list, explicit paths, no `git add -A`).
  All 8 «fragment -> replace» anchors matched exactly once (my helper refused to write otherwise).
- Quality: no `unwrap`/`expect`/`panic` in the new non-test code; errors go through `ApiError`;
  `badge_taken` never logs or returns the hash — the bound `badge_phc` only goes to SQL, and the
  only logged error is a failed owner read (`ApiError::internal`, cause text without values).
  The owner lookup uses the write transaction's connection (`&mut tx`), not `state.pool`, as the
  «Writes» rule requires.
- Discipline: nothing beyond the brief; no dependency, `proto/`, webview, `src-tauri` or station change.
- Testing: the test compares the whole `details` object, for both the other operator and the owner,
  so it fails when `operatorId` is missing, wrong, or when extra keys appear (mutation shown).

## Issues or concerns

1. **Sandbox note (environment, not the change).** The first attempt at the whole
   `cargo test … -p markiro-host --offline` inside the sandbox stopped at
   `changes_stream::open_streams_end_when_the_host_stops` with
   `cannot listen on 127.0.0.1:0: Operation not permitted (os error 1)`
   (`host/tests/changes_stream.rs:280`) — local port binding is off in the sandbox. Cargo stops at the
   first failing binary, so I reran the whole package outside the sandbox (as the brief's Step 7 says),
   log in `/tmp/claude/1d4-task3-host.log`; the failed in-sandbox attempt is kept in
   `/tmp/claude/1d4-task3-host-insandbox.log`. The «Cargo» note of `1d4-constraints.md` says the
   `-p markiro-host` tests bind no port; that is not quite true (this one test does), so later tasks that
   run the whole host package need the same escalation (or `sandbox.network.allowLocalBinding: true` in
   the user's settings, which the `/sandbox` command can change). `--test badges`, `check`, `fmt`,
   `clippy` all ran inside the sandbox.
2. The `Ok(None) => conflict` arm is a fail-soft branch: after a unique violation on
   `operator_badges_active_phc` the owner row is always visible in the same `BEGIN IMMEDIATE`
   transaction, so the arm is reachable only if the violation came from another unique key of
   `operator_badges` (the primary key `id`, a UUID v4 collision). The answer is then the plain `badge`
   conflict without `operatorId`. Not covered by a test (the brief asks for none, and the state is not
   reachable through the API). Task 5's dialog must, as the constraints say, fall back to
   `office.operators.badges.errors.taken` when `operatorId` is absent or not an operator of the list.
3. Pre-existing test gap, left as is: no test asserts that a refused badge conflict leaves the host
   revision and the audit trail unchanged (the validation-refusal test does assert it). The code path is
   unchanged in that respect — the transaction is dropped on the early return, so the `next_revision`
   taken before the insert is rolled back — but the invariant is only implied.
4. Scratch files live outside the repository: `/tmp/claude-501/1d4t3/` (the exact-match replace helper,
   the RED/GREEN/mutation/check/clippy logs, the pre-mutation copy of `operators.rs`) and the two logs
   under `/tmp/claude/`. The worktree is clean after the commit.
