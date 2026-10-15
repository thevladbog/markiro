# plan ПЛ-Х, Task 1 — report

Status: DONE_WITH_CONCERNS (concerns are only count drift, one equivalent mutant, one anchor adaptation; see below).
Commit: `e93cc55c6` feat(standalone): protocol 3, an SSCC's serial read by its extension as the domain builds it, the pallet receipt codes (one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`). Worktree /tmp/claude/wt/plh, branch claude/plh-pallets, base 1095d4af4. `git status --short` is empty after the commit.

## What was done

Steps 1, 3, 5, 7 of the brief, in order (step 1 tests and fixtures, RED, step 3 implementation, GREEN, docs, mutants, checks, commit). Anchors for steps 1 and 3 were applied by a small scratch script (`/tmp/claude/impl-plh-t1/apply.py`, outside the tree), which requires each «до» fragment to occur exactly once. `check_fragments.py` reported all step 1/3/5 fragments ok except the first AGENTS.md one (below); the NO MATCH lines for mutation anchors are expected (they exist only after step 3).

### Anchor adaptations

1. `apps/standalone/AGENTS.md`, «Protocol» paragraph (brief step 5.1): the text had drifted since the plan was written. It now reads «Raise `PROTOCOL_VERSION` for an incompatible change, a new fact kind or a new `data` field of a fact included (see Facts); the host keeps accepting the previous version. It is 2 since plan 2a1, …». Applied by meaning: only the version sentence was rewritten («It is 3 since plan ПЛ-Х (pallets; 2 since plan 2a1), with `MIN_PROTOCOL_VERSION` still 1: the host takes the stations of stage 1 and of stage 2a, and a station that knows pallets finds a host of stage 1 or 2a too old (`host_too_old` at the probe)»). The plan's sentence «A new fact kind or a new field of a fact's `data` raises it too …» was NOT added, because the drifted text already says it (and the «Facts» paragraph, line ~2274, repeats it). The rest (the «Facts» paragraph, 5.2) matched exactly. Not semantic, so no NEEDS_CONTEXT.
2. Nothing else drifted.

### Additions beyond the brief

- `host/tests/fact_rules.rs`: a fourth «not an SSCC» text, `"1460068200000000é"` (18 bytes, a two-byte letter across byte 17). Reason: the brief's three texts never split a char at byte 17, so a mutant `sscc.len() >= 17 && sscc[..17] == …` (R4b below) would survive the brief's own test on non-ASCII input; the 16-char text kills `sscc[..17]` alone but not a length-guarded slice. The list is `cargo fmt`-formatted (one per line) and its comment merged.
- No other test changes. The brief's step 1 already covers each guard; extra mutants below were checked against it and all but one equivalent mutant are killed.

## RED evidence (after step 1, before step 3; outputs in /tmp/claude/impl-plh-t1/red*.txt)

- `-p markiro-host --test fact_rules`: `error[E0432]: unresolved import markiro_host::facts::rules::names_serial`, exit 101.
- `-p markiro-proto`: unittests 5 passed; fixtures `41 passed; 2 failed` — `hello_fixture_round_trips`, `the_fact_code_fixtures_list_every_receipt_and_reason_code` (as the plan states).
- `-p markiro-host --lib --test claim --test platform`: lib `56 passed; 2 failed` (`server::tests::a_supported_version_passes`, `a_missing_header_is_refused_with_details`), claim `8 passed; 1 failed` (`a_device_in_the_network_pairs_with_a_code_typed_in_any_case`), platform `5 passed; 2 failed` (`hello_needs_no_protocol_header`, and `a_second_host_on_the_same_data_directory_is_refused`, which fails inside the sandbox on the bind (`Operation not permitted`) and passes unsandboxed — see GREEN).
- `-p markiro-standalone --lib host_probe`: `5 passed; 1 failed` (`a_host_older_than_this_app_is_rejected`).
- Vitest `test/fact-rules.test.ts test/protocol.test.ts`: `1 failed | 301 passed (302)`, the failure is `protocol schemas parse the shared Rust fixtures > hello`. (`hello` test not run as part of RED for `hello.rs`: that suite binds 127.0.0.1; ran only in GREEN, unsandboxed.)

## GREEN evidence (counts as the plan states vs as measured)

| Run                                      | Plan           | Measured                                                                                           |
| ---------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| host `--lib`                             | 57             | 58 (base drift: +1 beyond the plan's base)                                                         |
| host `claim`                             | 9              | 9                                                                                                  |
| host `fact_rules`                        | 13             | 13 (also 13 after the extra text; the extra text is inside the existing test)                      |
| host `facts`                             | 36             | 56 (base drift: 2a2 tasks 5–8 etc. added tests; every one passes with the new `names_serial` call) |
| host `platform` (unsandboxed)            | 7              | 7 (in the sandbox 6 + the bind failure above)                                                      |
| host `hello` (unsandboxed)               | 5              | 5                                                                                                  |
| `-p markiro-proto`                       | 5 and 43       | 5 and 43                                                                                           |
| `-p markiro-standalone --lib host_probe` | 6              | 6                                                                                                  |
| Vitest `fact-rules` + `protocol`         | 300 (92 + 208) | 302 (base drift); 2 files passed, `--reporter=verbose` stderr empty (0 bytes, 0 `stderr            | ` blocks) |

Full package Vitest (`pnpm … test`): `2 failed | 2274 passed (2276)`, 81 files — the two failures are `test/shifts-page.test.tsx` and `test/template-editor.test.tsx` 5 s timeouts under load ~115–140 (suites the notes name as heavy); neither touches protocol. Re-run alone: `shifts-page` 34/34 pass; `template-editor` timed out again alone at the default 5 s (load 141) and passes 97/97 with `--testTimeout=60000` (a command-line flag, no config change). Both numbers are reported. The delayed-`setImmediate` stand is not applicable: both changed test files are pure data/parsing tests with no React or effects.

Static checks: `cargo fmt --all -- --check` clean (it caught my one-line `for text in [...]`, fixed); `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `cargo clippy` over the same has 41 warnings, all in files this task does not touch (`validate.rs`, `tests/support/app.rs`, `tests/bootstrap.rs`, …; none in `rules.rs`, `box_closed.rs`, `fact_rules.rs`, `lib.rs`); `pnpm typecheck`, `pnpm lint` exit 0; `prettier --check` on the changed TS/JSON/MD clean; `git diff --check` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` only `src/host/pairing-code.ts:66`; `grep -nF '\u0'` on the Rust/JSON files written: nothing.

## Mutant table

Each mutant: file copied to /tmp/claude/impl-plh-t1/bak-*, one-line edit, test run, restored from the copy; the harness `/tmp/claude/impl-plh-t1/mut.py` computed `shasum -a 256` before/after and ran `cmp` (all rows: restore ok, hashes equal). Outputs in `/tmp/claude/impl-plh-t1/mut-*.txt`.

| #             | Mutant (one line)                                                                                                | Test that failed                                                                                                                         | Key line                                                        | Restore |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------- |
| R1 (brief М1) | rules.rs: `body == format!("{extension}…")` → `body[1..] == format!("{issuer_prefix}…")` (extension not checked) | `fact_rules::an_sscc_names_its_extension_prefix_and_serial_as_the_domain_builds_it`                                                      | panic at tests/fact_rules.rs:85 (the `1 - extension` assertion) | ok      |
| R2 (М2)       | rules.rs: `.get(..17)` → `.get(..18)`                                                                            | same test                                                                                                                                | panic at fact_rules.rs:84                                       | ok      |
| R3 (М3)       | rules.rs: `let width = 16 - issuer_prefix.len();` → `let width = 7;`                                             | same test                                                                                                                                | panic at fact_rules.rs:84 (prefix of 7 and 12 digits)           | ok      |
| R4 (extra)    | rules.rs: `.get(..17).is_some_and(…)` → `sscc[..17] == …` (panics on short text)                                 | same test                                                                                                                                | panic at rules.rs:85:16                                         | ok      |
| R4b (extra)   | rules.rs: `sscc.len() >= 17 && sscc[..17] == …` (panics on a split char)                                         | same test, killed ONLY by the added `"1460068200000000é"` text                                                                           | panic at rules.rs:85:36                                         | ok      |
| R5 (extra)    | rules.rs: drop the `serial < serial_capacity(prefix)` conjunct                                                   | none — SURVIVES (exit 0)                                                                                                                 | n/a                                                             | ok      |
| R6 (М4)       | box_closed.rs: `rules::names_serial(&closed.sscc, 0,` → `, 1,`                                                   | `facts`: 18 tests FAILED (e.g. `a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared`)                            | plan said 13; measured 18 (base has more box tests)             | ok      |
| R7 (М5)       | lib.rs: drop `PALLET_STATE` from `ALL`                                                                           | `fixtures::the_fact_code_fixtures_list_every_receipt_and_reason_code`                                                                    | panic at proto/tests/fixtures.rs:895                            | ok      |
| R8 (extra)    | lib.rs: `NO_PALLETS = "no_pallet"` (value typo)                                                                  | same test                                                                                                                                | fixtures.rs:895                                                 | ok      |
| R16 (extra)   | fact-receipt-codes.json: drop `"pallet_state"`                                                                   | same test                                                                                                                                | fixtures.rs:895                                                 | ok      |
| R9a           | lib.rs: `PROTOCOL_VERSION` 3 → 2                                                                                 | `fixtures::hello_fixture_round_trips`                                                                                                    | fixtures.rs:58                                                  | ok      |
| R9b           | same mutant, host `--lib`                                                                                        | `server::tests::a_supported_version_passes`, `a_missing_header_is_refused_with_details`                                                  | server.rs:475, 487                                              | ok      |
| R9c           | same mutant, shell                                                                                               | `host_probe::tests::a_host_older_than_this_app_is_rejected`                                                                              | host_probe.rs:139 (the protocol-2 host must be `HostTooOld`)    | ok      |
| R9d           | lib.rs: `PROTOCOL_VERSION` 3 → 4                                                                                 | `a_missing_header_is_refused_with_details` (maxProtocol 3), `an_out_of_range_or_garbled_version_is_refused` (4 refused)                  | server.rs:487, 497                                              | ok      |
| R10           | lib.rs: `MIN_PROTOCOL_VERSION` 1 → 2                                                                             | `a_missing_header_is_refused_with_details`, `a_supported_version_passes` (1 still taken)                                                 | server.rs:486, 477                                              | ok      |
| R11a          | sscc-serials.json: one case's extension 1 → 0                                                                    | `fact_rules` same test                                                                                                                   | fact_rules.rs:84                                                | ok      |
| R11b          | same mutant                                                                                                      | Vitest `builds the SSCC of extension +0, prefix '460068200' and serial 40`                                                               | domain `buildSscc` disagrees                                    | ok      |
| R12a          | sscc-serials.json: drop the 7th case                                                                             | `fact_rules` same test                                                                                                                   | fact_rules.rs:78 (`cases.len() == 7`)                           | ok      |
| R12b          | same mutant                                                                                                      | Vitest `holds 5 box digests, 6 close cases, 22 instants and 7 SSCCs`                                                                     | count                                                           | ok      |
| R13           | sscc-serials.json: one check digit `…409` → `…419`                                                               | Vitest `builds the SSCC of extension 1, prefix '460068200' and serial 40` (Rust side deliberately passes: the check digit is never read) | domain mismatch                                                 | ok      |
| R14           | protocol.ts: `PROTOCOL_VERSION` 3 → 2                                                                            | Vitest `protocol schemas parse the shared Rust fixtures > hello`                                                                         | version mirror vs hello.json                                    | ok      |

R5 is an equivalent mutant, not a test gap: for a serial ≥ the prefix's capacity, `format!("{serial:0width$}")` has more digits than `width`, so `extension + prefix + serial` is longer than the 17-byte body and can never be equal to it; the conjunct is redundant (kept as the brief's code, and as a cheap early exit before the allocation).

Guards without a Rust-only mutant, with what covers them: hello-future / error-with-details fixture edits are fixture-vs-fixture (`hello_ignores_fields_added_by_newer_hosts`, `envelope_decides_compatibility_before_the_rest` use the edited fixtures; R9a/R9c cover the constant side).

## Files changed (19)

apps/standalone: `AGENTS.md`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/{sscc-serials (new),fact-receipt-codes,hello,hello-future,error-with-details}.json`, `host/src/facts/{rules,box_closed}.rs`, `host/src/server.rs`, `host/tests/{fact_rules,claim,hello,platform}.rs`, `src-tauri/src/host_probe.rs`, `src/host/protocol.ts`, `test/{fact-rules,protocol}.test.ts`. No manifest, lockfile, applied migration or other app touched.

## Self-review / concerns

- `names_serial` computes `16 - issuer_prefix.len()` before the capacity guard: a prefix longer than 16 would underflow (debug panic). The snapshot's prefix is validated at 7–12 digits elsewhere, and `validate::serial_capacity` has the same shape; not changed (brief's code verbatim).
- `box_closed.rs` still imports `validate` (used elsewhere in the file); check shows 0 warnings.
- Test counts differ from the plan only through base drift (lib 58 vs 57, facts 56 vs 36, Vitest 302 vs 300); all differences are on suites that pass.
- The platform suite's `a_second_host_on_the_same_data_directory_is_refused` needs a real bind and fails in the sandbox; the plan lists `platform` among sandbox-safe suites, which is not true for this test. Unsandboxed: 7/7.
- Not exercised: Windows, a real station/cloud, hardware (host-only plus Vitest).
