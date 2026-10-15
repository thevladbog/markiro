# Plan 1f, Task 2 report — `src/floor/sign-in.ts`

Status: DONE_WITH_CONCERNS (concerns are notes for the controller, none blocks).
Base HEAD a5109dbd6. Commit: `015834661 feat(standalone): проверка PIN и бейджа оператора по копиям станции` (trailer: one `Co-Authored-By: Claude Opus 5.5` line, verified with `git log -1 --format=%B`).
Files: `apps/standalone/src/floor/sign-in.ts` (new, verbatim from the brief), `apps/standalone/test/floor-sign-in.test.ts` (new: the plan's 20 tests verbatim + 21 extras). `git status --short` is empty after the commit; the delayed-setImmediate stand files were created and removed.

## Test counts

- Plan: 20 tests in the new file (1423 -> 1443). Controller's expectation with Task 1's extras: 60 files / 1450.
- Measured: new file 41 tests (20 plan + 21 mine). Full package: **60 files / 1471 tests** (so baseline 59 / 1430, as stated; I derived it as 1471 - 41, I did not run the baseline separately). Both numbers differ from the plan by my 21 extras.
- typecheck 0, lint 0 (no warnings), prettier --check clean, `git diff --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.
- Vitest hygiene: verbose run stderr is 0 bytes; the file passes (41/41) under the delayed-`setImmediate` stand. Whole file takes about 1.3 s (native PBKDF2).

## RED / GREEN

- RED: `vitest run test/floor-sign-in.test.ts` -> `Failed to resolve import "../src/floor/sign-in.js"`, 1 file failed, `Tests no tests` (/tmp/claude/1f-t2/red.txt).
- GREEN with plan tests only: 1 file, 20 passed, stderr empty (green.txt). After extras: 41 passed.

## Mutants (scratch, one line each; runner /tmp/claude/1f-t2/mut.py runs the whole file per mutant, restores from a copy, compares bytes and sha256). All 38 killed; sha256 of `sign-in.ts` before == after every run (e82a390e…62e0), `cmp` byte-identical inside the runner.

Plan's five (all failed as the plan says):

| mutant                      | failing test(s)                                                         |
| --------------------------- | ----------------------------------------------------------------------- |
| P1 drop badge ambiguity     | "refuses a badge that matches two operators as ambiguous…"              |
| P2 drop product_code        | "apart before hashing", "refuses those scans…", + my hygiene test       |
| P3 no trim                  | "trimmed scan hashed with the site's salt" (+3 more)                    |
| P4 drop rev re-read         | "operator's copy changed while the PIN was being verified" (+3 of mine) |
| P5 badge quarantine dropped | "fails closed for a badge whose newer record waits in quarantine"       |

Mine (the plan's tests did NOT kill these: E1–E27, E31–E33 survived the plan's 20 tests; E28–E30 were killed by the plan, listed for completeness):

| mutant                                                                             | killed by (my extra unless noted)                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| E1 unknown number skips PBKDF2 (`operator !== null && verify…`)                    | "still pays one PBKDF2, against the dummy hash"; weak-hash; boundaries      |
| E2 ambiguous refused BEFORE the PBKDF2 (timing leak of duplicates)                 | "still pays one PBKDF2…"                                                    |
| E3 drop `isPinPhc` (low-iteration hash accepted)                                   | "does not take a hash the sync would not have accepted"                     |
| E4 PBKDF2 against first of several copies                                          | "still pays one PBKDF2…" (spy sees the copy's hash, not the dummy)          |
| E5/E6 login max 13 / min 2; E7/E8 pin max 7 / min 3                                | "verifies exactly the personnel numbers of 3-12 digits and the PINs of 4-6" |
| E9/E10 drop login / pin form check                                                 | same test (zero reads, zero verifyPhc calls for malformed input)            |
| E11 PIN path: no `copiesReady` after PBKDF2                                        | "copies stopped being this pairing's while the PIN was verified"            |
| E12 badge path: no `copiesReady` after hash                                        | "…while the code was hashed"                                                |
| E13 re-read ignores quarantine                                                     | "record went to quarantine while the PIN was verified"                      |
| E14 re-read tolerates a vanished copy                                              | "host turned off while…", "went to quarantine while…"                       |
| E15 operator quarantine matches any entity                                         | two "another entity's quarantine record that shares an id" tests            |
| E16 badge quarantine matches any entity                                            | badge variant of the same                                                   |
| E17 badge ignores operator quarantine                                              | "badge whose operator's record waits in quarantine"                         |
| E18 drop `DISTINCT` (one operator, two same-code badge records -> false ambiguous) | "two badge records carry the same code"                                     |
| E19 salt `!== 1` -> `< 1` (two ref_site rows)                                      | "site's salt is not exactly one"                                            |
| E20 Cyrillic checked before separator                                              | hygiene table (`ЬКЛ\u001d91` must be product_code)                          |
| E21 DEL (0x7f) accepted                                                            | hygiene table                                                               |
| E22/E23 code max 257 / min 0                                                       | plan test and hygiene table                                                 |
| E24 drop Cyrillic hint                                                             | plan tests and hygiene table                                                |
| E25 hash raw instead of trimmed code                                               | plan test + "hashes the trimmed code once with the site's salt" (spy args)  |
| E26 result carries the full row (pinPhc, rev leak)                                 | plan test + "what the sign-in lets out"                                     |
| E27 product scan logged via console.warn                                           | "what the sign-in lets out" (plan's console test never runs that path)      |
| E28 dummy hash at 10 000 iterations                                                | plan test                                                                   |
| E29 readiness without `copiesReady` / E30 counts quarantined                       | plan test                                                                   |
| E31 PIN lookup ignores quarantine                                                  | "still pays one PBKDF2…" (plan only reaches it through the re-read)         |
| E32/E33 no initial `copiesReady` in PIN / badge path                               | "verifies nothing while…", "hashes nothing while…"                          |

Equivalent claims: none made. Not mutated (argued, not claimed equivalent): `[0-9]` -> `\d` is the only candidate; JS `\d` is ASCII-only, with or without the `u` flag, so it would be equivalent, but I did not run it and rely on the fullwidth-digit cases in the boundary table staying green for the real code.

## Extras (21 tests, same file; mocks call through, so real PBKDF2 runs)

`vi.mock` wraps `verifyPhc` (`@markiro/domain`) and `hashBadge` (`credentials.js`) in call-through spies, so the deterministic proxy for timing equalization is "every well-formed attempt calls verifyPhc once, with the dummy hash when no copy can match". Blocks: PIN work and guards (10), badge work and guards (9, incl. hygiene table of 15 scans asserting zero SQL reads and zero hashBadge calls), what the sign-in lets out (1: JSON of 15 results free of PIN, code, hashes, salt, `rev`, keys exactly id/login/name/role; six console methods silent on every path incl. refusals), readiness with zero operators (1). Race tests use an executor wrapper that changes the local DB right after a chosen read.

## Answers to the brief's questions

- Reads under a pairing guard? No. The reads are separate queries; `copiesReady` is a read of `sync_state`, not a guard inside the same transaction. The module fails closed by: (1) `copiesReady` before any read; (2) PIN path: after PBKDF2 `copiesReady` again, then re-reads the operator's rev (missing row, quarantine or other rev -> `wrong`); (3) badge path: `copiesReady` again after the hash and query, and the operator and badge are one JOIN (atomic). A re-pair between the readiness check and the first read wipes the tables: no rows -> dummy hash -> `wrong`, never a sign-in. Residual window: a complete re-pair and re-sync landing between the second `copiesReady` and the `OPERATOR_REV` read would need the same operator id and rev under another pairing; for the same host that is the same operator, for another host the id differs. Theoretical, not closeable without a pairing guard in the query (would need a task-1-style `sync_state` clause in each SELECT); I did not change the brief's SQL.
- Hash constants: no iteration literal in the module besides the PHC string inside `DUMMY_PIN_PHC` (checked against `PHC_ITERATIONS` by test, as in the cloud); badge iterations come from `hashBadge` -> `BADGE_ITERATIONS`.
- Constant-time compare is `verifyPhc` -> `constantTimeEqual` in `packages/domain/src/crypto/phc.ts`; not changed.

## Concerns / notes

1. Executor errors: `createTauriLocalExecutor` throws `LocalDbError` with message `${command}: ${String(error)}` where `error` comes from the shell. The module lets such an error propagate (the brief says nothing else), and it is called with `login` and the badge hash as bound params. I did not check whether the Rust side ever echoes parameters in its error text; Task 5/6 must show a generic text and not log or display `error.message` (plan D3 already says so). Worth a one-line check of `src-tauri/src/local_db.rs` error strings.
2. `ref_site` has no single-row constraint; the module refuses (`not_ready`) when it holds anything but one row. Tested.
3. `E15/E16`-style behaviour: a quarantine record only blocks the operator/badge of the same entity name; tests pin it.
4. Not verified (out of scope here): the UI, the shell executor against SQLite in Tauri (tests use `node:sqlite` with the same migrations), real-device scanner timing, and a wall-clock timing comparison of known vs unknown numbers (the spy test proves equal PBKDF2 work, not equal wall time).
5. Count shift for later tasks: this file's total is 41, so later tasks' "Expected" totals are +21 over the plan's (+7 from Task 1's extras as the controller noted, +21 mine = baseline 1430 for this task, 1471 after).
