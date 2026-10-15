# Report: plan ИМП Task 1 — SSCC starts, rollback window, shift numbers

Status: DONE_WITH_CONCERNS (concerns below). Commit: cf08ddf07 `feat(standalone): cloud export: SSCC starts, the rollback window and shift numbers` on claude/infra-rk (worktree /tmp/claude/wt/inf, base cfddf8b15).

## What was done

- `tools/standalone-export/sscc.mjs`: the brief's module (all exports and signatures as in the brief) plus input hardening (below).
- `tools/standalone-export/test/sscc.test.mjs`: the brief's 8 tests verbatim + 29 more (37 total).
- Root `package.json`: only the script line `test:standalone-export` (`node --test tools/standalone-export/test/*.test.mjs`).
- No dependency added, no install run, no cloud access, no CI file touched (Task 3 owns CI/affected.mjs).

## Hardening beyond the brief (all keep the brief's tests green)

1. Issuer prefix must be exactly 9 digits (`/^\d{9}$/`): the 7-digit serial space (SERIAL_CAPACITY) only holds for 9-digit prefixes (cloud `deriveIssuerPrefix` and host `validate::issuer_prefix` both cut 9 digits); a 10-digit prefix would get a start the SSCC cannot hold.
2. Extension must be 0 or 1 (every function), instead of silently treating 2..9 as pallets.
3. Every input number must be null or a whole serial in range (counterNext 0..10^7, others 0..10^7-1); otherwise a `RangeError` naming the field, prefix and extension. Without it a string or NaN poisons `Math.max` and yields an unchecked start. A bad row hidden by a larger row of the same key is still refused (checked per row before merging).
4. Several rows of one (prefix, extension) key keep the LARGEST of each kind (brief's code overwrote: a non-aggregated blocks array could lose the biggest block and repeat an SSCC).
5. `maxConsumedThrough` also counts toward the issued maximum (a consumed serial above its block's end in a damaged row must not be reused).
6. Exhaustion message additionally states the would-be start and the last serial (still matches the brief's regex).
7. `planShiftNumberCounters`: a month named twice keeps the larger counter (never the smaller, never last-wins).
   Boundary semantics: issued 9 989 999 -> start 9 990 000 (ok, `cloudReseedTo` null); issued 9 990 000 or more (start would be 10 000 000) -> the export stops with `the cloud used every serial of prefix P, extension E: the next start would be N but serials end at 9999999`.

## Domain coverage (tests beyond the brief)

Rollback window/blocks to offline stations: counter moved back below a revoked block (counter 5 000, block ends 25 000, consumed 22 000 -> start 30 000); boxes printed before blocks existed; boxes and pallets counted apart; prefix with only pallets (counter 0 -> start 0, reseed 100 000) and only boxes; multiple prefixes ordered; empty tenant -> `[]`; custom windows reach `cloudReseedTo`; window leaving the prefix -> `null`; start property over issued 0..30 500 (always > issued, on the 10 000 grid, gap <= 10 000); literal window/capacity constants (owner answer П6); fixture `apps/standalone/proto/fixtures/sscc-serials.json` read by tests: independent GS1 check digit recomputed for every 9-digit case, the largest fixture serial equals SERIAL_CAPACITY-1; `@markiro/domain` `buildSscc`/`isValidSscc`/`ssccSerialCapacity` (imported from `packages/domain/dist/gs1/sscc.js`; the test SKIPS explicitly if dist is not built — it was built here, 0 skipped) confirm every fixture case, that capacity = 10^7, that serial 10^7 is out of range, and that every planned start, the last serial and every non-null `cloudReseedTo` build a valid SSCC. Shift numbers: 12 months accepted, 13 near-miss keys dropped (anchors, case, whitespace, Cyrillic), zero/negative/fractional/NaN/string/null seq dropped, duplicates keep max, sorted by key, extra fields stripped.

## RED / GREEN

- RED: `node --test tools/standalone-export/test/sscc.test.mjs` before the module -> exit 1, `ERR_MODULE_NOT_FOUND ... tools/standalone-export/sscc.mjs` (/tmp/claude/impl-imp-t1/red.txt).
- GREEN (final): `node --test tools/standalone-export/test/*.test.mjs` and `pnpm --config.verifyDepsBeforeRun=false run test:standalone-export`: tests 37, pass 37, fail 0, skipped 0, empty stderr.
- One of my own tests was wrong first (counterNext 9 500 000 gives start 9 500 000, not 9 510 000; fixed the test to counterNext 9 500 001) — the module was right.

## Mutants (64; every one killed; harness /tmp/claude/impl-imp-t1/mut.py, originals in /tmp/claude/impl-imp-t1/sscc.mjs.orig; after the run `cmp` and sha256 equal to the pre-mutation file, final line `final sha equal: True`)

The brief's four mutants are #6 (ceil->floor), #2 (>= -> >), #9 (< -> <=), #4 (drop printed). Result "KILLED(n)" counts failing tests plus their subtest lines.

| #   | one-line mutant                       | result     | first failing test                                                     | restore            |
| --- | ------------------------------------- | ---------- | ---------------------------------------------------------------------- | ------------------ |
| 0   | firstSerial swap                      | KILLED(10) | boxes start at serial 1 and pallets at 0                               | cmp + shasum equal |
| 1   | drop counter candidate                | KILLED(20) | the highest issued serial is the largest of counter − 1, a block's end | cmp + shasum equal |
| 2   | counter > first (brief 2)             | KILLED(2)  | a counter at its extension's first serial handed out nothing           | cmp + shasum equal |
| 3   | drop block candidate                  | KILLED(14) | the highest issued serial is the largest of counter − 1, a block's end | cmp + shasum equal |
| 4   | drop printed candidate (brief 4)      | KILLED(16) | the highest issued serial is the largest of counter − 1, a block's end | cmp + shasum equal |
| 5   | max -> min                            | KILLED(6)  | the highest issued serial is the largest of counter − 1, a block's end | cmp + shasum equal |
| 6   | ceil -> floor (brief 1)               | KILLED(26) | the start is one above the issued serial, rounded up to the next 10 00 | cmp + shasum equal |
| 7   | no +1 on issued                       | KILLED(18) | the start is one above the issued serial, rounded up to the next 10 00 | cmp + shasum equal |
| 8   | START_STEP 10_000 -> 1_000            | KILLED(26) | the start is one above the issued serial, rounded up to the next 10 00 | cmp + shasum equal |
| 9   | window < <= (brief 3)                 | KILLED(2)  | the cloud moves past the window, or nowhere when the window leaves the | cmp + shasum equal |
| 10  | windowOf swap                         | KILLED(14) | the cloud moves past the window, or nowhere when the window leaves the | cmp + shasum equal |
| 11  | BOX_WINDOW value                      | KILLED(6)  | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 12  | PALLET_WINDOW value                   | KILLED(4)  | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 13  | SERIAL_CAPACITY value                 | KILLED(14) | the window constants and the serial space are the owner's figures      | cmp + shasum equal |
| 14  | exhausted: >= -> >                    | KILLED(6)  | a prefix the cloud used up stops the export                            | cmp + shasum equal |
| 15  | exhausted: never throws               | KILLED(6)  | a prefix the cloud used up stops the export                            | cmp + shasum equal |
| 16  | row key without extension             | KILLED(12) | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 17  | sort ignores extension                | KILLED(6)  | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 18  | sort prefix descending                | KILLED(6)  | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 19  | windows not passed                    | KILLED(2)  | the plan's own windows reach the cloud's reseed target                 | cmp + shasum equal |
| 20  | counter overwrite                     | KILLED(2)  | several block rows of one key keep the largest, in either order        | cmp + shasum equal |
| 21  | block max overwrite                   | KILLED(2)  | several block rows of one key keep the largest, in either order        | cmp + shasum equal |
| 22  | consumed overwrite                    | KILLED(2)  | several block rows of one key keep the largest, in either order        | cmp + shasum equal |
| 23  | printed overwrite                     | KILLED(2)  | several block rows of one key keep the largest, in either order        | cmp + shasum equal |
| 24  | consumed not in issued                | KILLED(2)  | a consumed serial above its block's end still counts as issued         | cmp + shasum equal |
| 25  | printedMax ignores consumed           | KILLED(8)  | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 26  | owner wrong prefix                    | KILLED(4)  | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 27  | largest: null left wins               | KILLED(26) | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 28  | largest: null right wins              | KILLED(12) | every prefix and extension of the counters, blocks and printed codes g | cmp + shasum equal |
| 29  | no prefix check in row                | KILLED(2)  | a prefix that is not 9 digits stops the export: its serial space is no | cmp + shasum equal |
| 30  | prefix regex 9..12                    | KILLED(2)  | a prefix that is not 9 digits stops the export: its serial space is no | cmp + shasum equal |
| 31  | prefix regex unanchored start         | KILLED(2)  | a prefix that is not 9 digits stops the export: its serial space is no | cmp + shasum equal |
| 32  | prefix regex unanchored end           | KILLED(2)  | a prefix that is not 9 digits stops the export: its serial space is no | cmp + shasum equal |
| 33  | prefix accepts non-string             | KILLED(2)  | a prefix that is not 9 digits stops the export: its serial space is no | cmp + shasum equal |
| 34  | issuedMax context has wrong prefix    | KILLED(2)  | an extension digit other than 0                                        | cmp + shasum equal |
| 35  | extension 2 allowed                   | KILLED(4)  | an extension digit other than 0                                        | cmp + shasum equal |
| 36  | no extension check in issuedMax       | KILLED(2)  | an extension digit other than 0                                        | cmp + shasum equal |
| 37  | no extension check in standaloneStart | KILLED(2)  | the start of an issued serial that is no serial is refused             | cmp + shasum equal |
| 38  | no extension check in windowOf        | KILLED(2)  | an extension digit other than 0                                        | cmp + shasum equal |
| 39  | no extension check in firstSerial     | KILLED(2)  | an extension digit other than 0                                        | cmp + shasum equal |
| 40  | checkSerial: null not skipped         | KILLED(40) | the highest issued serial is the largest of counter − 1, a block's end | cmp + shasum equal |
| 41  | checkSerial: integer test -> typeof   | KILLED(6)  | a serial that is no whole number in range stops the export instead of  | cmp + shasum equal |
| 42  | checkSerial: no negative bound        | KILLED(8)  | a serial that is no whole number in range stops the export instead of  | cmp + shasum equal |
| 43  | checkSerial: max off by one           | KILLED(6)  | a serial that is no whole number in range stops the export instead of  | cmp + shasum equal |
| 44  | issuedMax counter max                 | KILLED(2)  | a serial that is no whole number in range stops the export instead of  | cmp + shasum equal |
| 45  | issuedMax no block check              | KILLED(2)  | a serial that is no whole number in range stops the export instead of  | cmp + shasum equal |
| 46  | issuedMax no printed check            | KILLED(2)  | a serial that is no whole number in range stops the export instead of  | cmp + shasum equal |
| 47  | standaloneStart no issued check       | KILLED(2)  | the start of an issued serial that is no serial is refused             | cmp + shasum equal |
| 48  | plan: no counter check                | KILLED(2)  | a bad number is refused even when a larger row of the same key would h | cmp + shasum equal |
| 49  | plan: no consumed check               | KILLED(2)  | a serial that is no whole number in range stops the export instead of  | cmp + shasum equal |
| 50  | plan: no blockMax check               | KILLED(2)  | a bad number is refused even when a larger row of the same key would h | cmp + shasum equal |
| 51  | plan: no printed check                | KILLED(2)  | a bad number is refused even when a larger row of the same key would h | cmp + shasum equal |
| 52  | plan: no context wrapper              | KILLED(8)  | an extension digit other than 0                                        | cmp + shasum equal |
| 53  | shift: keep zero                      | KILLED(4)  | shift-number counters keep every month that drew a number, by month ke | cmp + shasum equal |
| 54  | shift: no integer test                | KILLED(2)  | shift numbers: a counter that never drew a number, or holds no whole n | cmp + shasum equal |
| 55  | shift: no month test                  | KILLED(4)  | shift-number counters keep every month that drew a number, by month ke | cmp + shasum equal |
| 56  | shift: month regex unanchored start   | KILLED(2)  | shift numbers: only MONYY keys of the twelve months, anchored at both  | cmp + shasum equal |
| 57  | shift: month regex unanchored end     | KILLED(4)  | shift-number counters keep every month that drew a number, by month ke | cmp + shasum equal |
| 58  | shift: month digits \d{1,4}           | KILLED(4)  | shift-number counters keep every month that drew a number, by month ke | cmp + shasum equal |
| 59  | shift: a month missing                | KILLED(4)  | shift numbers: only MONYY keys of the twelve months, anchored at both  | cmp + shasum equal |
| 60  | shift: duplicate keeps last           | KILLED(2)  | shift numbers: a month named twice continues from the larger counter,  | cmp + shasum equal |
| 61  | shift: duplicate keeps smaller        | KILLED(2)  | shift numbers: a month named twice continues from the larger counter,  | cmp + shasum equal |
| 62  | shift: no sort                        | KILLED(2)  | shift numbers: the list is by month key and carries nothing but the ke | cmp + shasum equal |
| 63  | shift: sort descending                | KILLED(4)  | shift-number counters keep every month that drew a number, by month ke | cmp + shasum equal |

## Tests: plan vs measured

Brief: 8 tests in this file (`ℹ tests 8`). Measured: 37 (8 brief + 29 added). Plan's tool total of 28 includes later tasks; not applicable here.

## Gates

- Prettier gate run live from the worktree root with `--ignore-path .prettierignore` and repo-relative paths on `tools/standalone-export/sscc.mjs`, `tools/standalone-export/test/sscc.test.mjs`, `package.json`: "All matched files use Prettier code style!"; proven live with a scratch mis-formatted `.mjs` (exit 1, file reported), scratch deleted. (I ran `prettier --write` on my two new files once; `--check` afterwards is clean.)
- `git diff --check` clean; `grep -rnF '\u0' tools/standalone-export` empty; `git status --short` empty after the commit; no scratch in the tree.
- Not run (not applicable to this task): Vitest/cargo/typecheck/lint of the standalone package; no database; no CI (Task 3).

## Anchor adaptations

None: Task 1 creates new files; the root package.json line anchored exactly once.

## Concerns

1. `planShiftNumberCounters` (per the brief, tested by the brief) silently DROPS a counter whose key is not `MONYY` even when its lastSeq > 0; a differently-formatted cloud key would let that month's numbers repeat. The cloud writes `MONYY` (`AUG26`), so this should not occur, but the caller (Task 2 `transform.mjs`/cli) may want to surface dropped non-zero keys as a note or error. Interface left as the brief specifies.
2. Shift-number continuation relies on the cloud's `shift_number_counters` being >= every `number_seq` used in that month; the module does not look at shifts' own numbers (the export SQL, Task 3, could cross-check `max(number_seq)` per month_key).
3. The domain-equivalence test imports the built `packages/domain/dist`; in CI `test:standalone-export` (Task 3) the domain must be built first or that one test skips (explicitly, with a message); the fixture-based check-digit test is unconditional.
4. I used a single `cd` once in an early Bash call (before the prettier gate) and for the prettier/git/pnpm commands in one-command chains; no stray `.cc-writes` dir appeared in `git status`.
