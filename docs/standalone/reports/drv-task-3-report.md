# ДРВ Task 3 report — webview wrapper: the driver's answers in `PrintResult`

Status: DONE. Commit: `1b099398d` feat(standalone): the webview reads the shell's driver printing answers (plan ДРВ task 3), branch `claude/prt` (base 4aa67cb1a). Webview-only; no Rust/manifest/lockfile change.

## What was done

- `src/hardware/hardware.ts`: `PrintResult` widened (`receipt?`, `PrintResultCode`) with the doc paragraph; added `windowsPrintReceiptSchema`, `WINDOWS_DRIVER_CODES`, `windowsPrintOutcomeSchema`, `windowsJobObservationSchema` (all strict), `DRIVER_FAILED_CODES`, `DriverFailedCode`, `PrintResultCode`, `WindowsPrinting`, `windowsPrintResult`, `createTauriWindowsPrinting` (brief code).
- `src/floor/print/print-jobs.ts`: `FAILED_CODES` += `queue_unavailable`, `geometry_mismatch`, `driver_not_started`; `UNKNOWN_CODES` += `driver_unknown`; `settleOutcome` maps `outcome_unknown`/`driver_unknown` to `unknown` (doc comments extended). No migration (`error_code` has no CHECK).
- `test/windows-printing.test.ts` (new): brief's 7 tests plus 38 more (45 total).

## RED / GREEN

- RED: `vitest run test/windows-printing.test.ts` -> 7 failed, `createTauriWindowsPrinting is not a function` (`/tmp/claude/impl-drv-t3/red.log`).
- GREEN: the four files the brief names -> 165 passed; typecheck 0.
- Final gates: typecheck 0, lint 0, build 0; focused verbose (windows-printing, hardware, hardware-tauri, floor-print-jobs) 4 files / 204 tests, stderr 0 bytes; full Vitest `--testTimeout=60000 --hookTimeout=60000`: 149 files / 4653 tests passed, stderr 0 bytes; `git diff --check` clean; `grep '\u04'` only `src/host/pairing-code.ts:66`; prettier gate live (scratch mis-formatted file failed with exit 1 and was deleted; the three changed files pass); `git status --short` empty after commit.

## Discipline implemented

- Every Rust answer kind maps to exactly one `PrintResult` kind: the `switch (error.code)` is exhaustive with a `default` that assigns `error.code` to `never` (compile error on a new code without a mapping) and still returns `driver_unknown` at runtime. The test table `BEFORE_START` is `Record<WINDOWS_DRIVER_CODES, PrintResult>` so a new code also breaks the test file's compile. Checked by typecheck (see mutants m5, dropcase, newcode).
- Unknown outcome never retry-safe: `delivery_unknown` (any code), unparseable shape, mismatched receipt, IPC throw -> `driver_unknown` -> job `unknown`. Test-parametrised over every code x phase.

## Mutants (scratch one-line; `/tmp/claude/impl-drv-t3/mutate.py`; originals in `/tmp/claude/impl-drv-t3/orig/`; every restore sha256-identical to `sha-orig.txt` and `cmp`-verified, files touched; log `mut3.log`: 49 mutants, 48 killed by Vitest, 1 by tsc)

| Guard                                                                                                                                                                | Mutant                                                                                                      | Killed by                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| receipt queue / documentName non-empty                                                                                                                               | `.min(1)` dropped (x2)                                                                                      | refuses a receipt with an empty queue or document name (added after first run survived)          |
| receipt jobId positive / int                                                                                                                                         | `.positive()` or `.int()` dropped                                                                           | bad-receipt table (0, -3, 1.5)                                                                   |
| receipt / failure / outcome(ok,failed) strict                                                                                                                        | `.strict()` dropped (4)                                                                                     | extra-key cases                                                                                  |
| failure phase enum                                                                                                                                                   | `z.string()`                                                                                                | unknown-phase case                                                                               |
| failure code enum                                                                                                                                                    | `z.string()`                                                                                                | tsc: `string` not assignable to `never` (runtime-equivalent: default branch is `driver_unknown`) |
| observation strictness, statusFlags nonneg/int, states                                                                                                               | each dropped (5)                                                                                            | observation good/bad table, edges test                                                           |
| `DRIVER_FAILED_CODES`                                                                                                                                                | geometry dropped                                                                                            | exact-list assertion (added; first run survived)                                                 |
| sameJob                                                                                                                                                              | queue check dropped; document check dropped; undefined accepted                                             | receipt-mismatch tests; "receipt" key absent assertion (added; first run survived)               |
| unparseable answer                                                                                                                                                   | -> `not_sent`                                                                                               | no-known-shape table                                                                             |
| success mismatch                                                                                                                                                     | -> `sent`; receipt dropped; -> `outcome_unknown`                                                            | receipt tests                                                                                    |
| delivery_unknown                                                                                                                                                     | phase ignored; receipt dropped/unchecked; -> `driver_not_started`                                           | per-code x phase tests                                                                           |
| five mappings                                                                                                                                                        | each swapped (6 mutants incl. driver_failure -> unknown/not_sent)                                           | BEFORE_START parametrised                                                                        |
| supports                                                                                                                                                             | `=== true` loosened; catch -> true                                                                          | non-true answers; throwing call                                                                  |
| encode failure                                                                                                                                                       | -> `driver_unknown`; call not suppressed                                                                    | edges (broken iterator, call not called)                                                         |
| IPC throw                                                                                                                                                            | -> `not_sent` / `driver_not_started`                                                                        | never-throws test                                                                                |
| print args                                                                                                                                                           | payload key / wrong queue compared                                                                          | call-args and receipt-match tests                                                                |
| observation                                                                                                                                                          | catch -> absent; parse failure -> absent; mangled args                                                      | observation tests                                                                                |
| `settleOutcome`                                                                                                                                                      | driver_unknown -> failed; outcome_unknown -> failed; unknown code rewritten                                 | settles-a-job tests                                                                              |
| code lists                                                                                                                                                           | drop `queue_unavailable` / `driver_not_started` from FAILED_CODES; drop `driver_unknown` from UNKNOWN_CODES | settle tests (+ tsc)                                                                             |
| tsc-only extras: drop `case "driver_failure"` -> TS2322 never; add `new_code` to `WINDOWS_DRIVER_CODES` -> TS2322 never and missing-property in the test's `Record`. |

## Anchor adaptations

- Added `never` check in the `default` of the switch (brief had none) and an `assertion` that `settleOutcome` tests use `kind: "answered"` (the actual `SendOutcome` kind; a first draft with `"done"` type-failed and was fixed). Brief anchors in `print-jobs.ts`/`hardware.ts` matched exactly once; no semantic difference.

## Test totals

Plan: 7 tests in the new file. Measured: 45. Full suite 4653 (149 files).

## Concerns

- Zod parity with Rust covers the five fixture keys only; TS side cannot prove `Failure`/`Observation` variants not in the fixture (e.g. `identity_mismatch`) match Rust serde output; they are parsed from literals.
- i18n texts for the new codes (`floor.print.codes.queue_unavailable` etc.) are Task 6; until then `LabelPanel`/`WorkstationSetup` would show a missing key for these codes, but nothing produces them before Task 5.
- `graphify update .` not run.
