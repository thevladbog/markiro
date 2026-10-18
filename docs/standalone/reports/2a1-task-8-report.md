# Plan 2a1, Task 8 report: personnel numbers that differ only by leading zeros (В13 A)

Status: DONE. BASE 773d30508928c3aa9f89561a01228ea1222617c2, commit `69b8962ab` (`feat(standalone): a personnel number never differs from another by leading zeros alone`), trailer is the single pinned `Co-Authored-By: Claude Opus 5.5` line.

## What was done

- `host/tests/operators.rs`: the old test `personnel_numbers_are_unique_with_their_leading_zeros` was replaced with the plan's `personnel_numbers_are_unique_and_never_differ_by_leading_zeros_alone` (verbatim). I added one test beyond the plan, `the_leading_zero_check_counts_every_operator_and_answers_in_a_fixed_order`.
- `host/src/routes/operators.rs` (`create_operator`): the check runs inside the write transaction after `require_admin_in` and before `next_revision`, so a refusal takes no revision and writes no audit row. It is create-only: `OperatorUpdate` has no `login` field, so no update path can rename a login.
- `AGENTS.md` («Operators and badges»): sentence added exactly as in the plan.
- The webview was not touched: `CreateOperatorDialog.tsx` maps `constraint: "login"` to `loginTaken`.

### Deviation from the plan's code (one, deliberate)

The plan's query is `SELECT login … WHERE ltrim(login,'0') = ltrim(?,'0')` with `fetch_optional` and no ordering. Existing pairs such as `042` and `0042` are explicitly allowed to stay, so more than one row can match. The row `fetch_optional` returns is then arbitrary, and the answer's `similarLogin` could change from run to run. I made it deterministic: `ORDER BY login = ? DESC, login LIMIT 1` (the same number first, otherwise the lowest string), with the login bound twice. For all non-legacy data the behavior equals the plan's.

### Gaps in the plan's tests, filled by the extra test

The plan's test never asserts the error `code` (only `details`), never trims, never has a deactivated operator, never has a legacy pair, and never checks the technologist path. The extra test covers:

- code `conflict` plus the exact details for `" 042 "` (the number is trimmed before comparison);
- `"42"` stays a `validation_failed` on `login`, not a conflict;
- a deactivated operator still counts (`00042` is refused against the deactivated `0042`);
- a technologist posting `042` gets `forbidden` with no `details`, so the host does not reveal existing numbers;
- a legacy pair (`00042` inserted directly into SQLite next to `0042`): `0042` names `0042`, `00042` names `00042`, `042` names `00042`.

Not testable through the API and so not tested: non-ASCII digits (rejected earlier by `validate::operator_login`, already unit-tested) and over-long numbers (same). All-zero logins `000` / `0000` and interior or trailing zeros (`0420`, `0043`) are covered by the plan's test.

## RED / GREEN

- RED: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --offline --locked` gives 10 passed, 1 failed. `personnel_numbers_are_unique_and_never_differ_by_leading_zeros_alone` fails with `left: (409, {"constraint":"login"})`, `right: (409, {"constraint":"login","similarLogin":"0042"})` for `0042`. This matches the plan's expectation.
- GREEN: `--test operators --test badges` gives operators 12 passed, badges 8 passed. The plan expects 11 and 8; the extra test makes it 12.

## Mutants (all on `host/src/routes/operators.rs`, one at a time, via `cp` of a pre-mutation copy)

| #         | Mutant                                                     | Test that failed | Key line                                                                        |
| --------- | ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| M1 (plan) | `if let Some(similar) = similar.filter(\|_\| false)`       | both new tests   | `left: (200, Null, Null)`, `right: (409, "conflict", {…"similarLogin":"0042"})` |
| M2        | `trim(login,'0') = trim(?,'0')` (strip trailing zeros too) | plan test        | `0420` accepted as 409, wanted 200                                              |
| M3        | `WHERE login = ltrim(?,'0')` (no trim on the column)       | both             | `0042` gets 200                                                                 |
| M3b       | `WHERE ltrim(login,'0') = ?` (no trim on the bound value)  | both             | `0042` gets 200                                                                 |
| M4        | `similarLogin` carries the new login, not the existing one | both             | `similarLogin: "042"` vs `"0042"`                                               |
| M5b       | `constraint` in the details literal changed to `"number"`  | both             | `"constraint":"number"` vs `"login"`                                            |
| M10       | `ApiError::forbidden(...)` instead of `conflict(...)`      | both             | `403 "forbidden"` vs `409 "conflict"`                                           |
| M6        | `ORDER BY login = ? ASC, login`                            | extra test       | `042` case: `00042` vs `0042` for the exact login                               |
| M7        | `ORDER BY login = ? DESC, login DESC`                      | extra test       | `042` names `0042`, wanted `00042`                                              |
| M8        | extra `AND active = 1` (inactive operators do not count)   | extra test       | `(200, Null)` vs `(409, {…"similarLogin":"0042"})`                              |
| M9        | extra `AND login <> ?` (one placeholder too many)          | both             | `{"constraint":"login"}` only: error path                                       |

M5, which changes only the first argument of `ApiError::conflict("login", …)`, survived and is an equivalent mutant: `with_details` replaces the whole details object with the literal that follows. M5b mutates the literal and is caught. M6 and M7 are caught only by the extra test, so the ordering is pinned by it. After every mutant `cmp` against `/tmp/claude/ops_before.rs` was silent, and the final sha256 equals the pre-mutation one (`c56128238d6baea4270b640b35b03f23e1752cbba19350a47ef38331e563891e`).

## Checks

- `cargo fmt … --all -- --check`: clean.
- `cargo check -p markiro-host -p markiro-proto --all-targets --offline`: 0 warnings.
- `prettier --check apps/standalone/AGENTS.md`: clean.
- `git diff --check`: clean.
- `grep -F '\u0'` on the two Rust files: nothing.
- Full run, outside the sandbox: `cargo test -p markiro-host -p markiro-proto --offline --locked` exits 0, 34 suites ok, 0 failed. Counted from the `running N tests` lines in the saved output: host 358, proto 45.
- The plan states host 334 and proto 45 as the final count after task 9. Host 358 is higher because earlier tasks added tests beyond the plan. This task adds +1 (the extra test; the plan's test replaces the old one one-for-one).
- `git status --short` is empty after the commit.

## Self-review and concerns

- None blocking.
- The refusal also fires for an exact duplicate, which is correct: its details gain `similarLogin`, and the unique index remains the guard if the pre-check were ever bypassed.
- The race is closed: the check and the INSERT run in the same `begin_write` transaction.
- Not verified: the office form in a browser. The `loginTaken` mapping is by constraint and unchanged.
- The behavior of already-existing leading-zero pairs on the station (exact comparison) is unchanged.
