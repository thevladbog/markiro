# ДРВ Task 5 report — sending through the driver: runtime, jobs, print again

Status: DONE_WITH_CONCERNS. Commit `beb9042a4` (branch claude/prt, base 8ced48d64). Webview/TS only: no Rust, fixtures, manifests or lockfile touched, so no cargo run / parity tests were required.

## What was done

- `print-runtime.ts` replaced by the brief's file (`send(jobId, target, bytes, mode)`, `checkWindowsJob`, `supportsWindowsDriver`, `windows`/`newDocumentId` options, in-memory newest-send receipt). `print-jobs.ts`: `sendLabelJob` passes `printerMode(printer)`. `print-resolution.ts`: `sameRender` compares `printerMode`; doc comment extended. `App.tsx`: `windowsPrinting` prop, `createTauriWindowsPrinting()` default, runtime built with `{ windows }`.
- Tests: `test/floor-print-driver.test.ts` (brief's 7 tests + 13 more = 20), one new App-wiring test in `test/app.test.tsx` (FloorApp mock also records the `printing` runtime).

## Print discipline (what the tests pin)

- Unknown outcomes (`driver_unknown`, timeout, rejected IPC) -> job `unknown`; a recovery after it moves 0 jobs and sends nothing; the Windows queue check is read-only (job stays `unknown`, attempts 1, one print).
- Job left `sending` by a restart: recovery skips it while the runtime holds it, then turns it `unknown/interrupted` with no send; `checkWindowsJob` on the fresh runtime is `no_receipt`; `identity_mismatch`/`unavailable`/`absent` observations are passed through only as observations, never as a job state.
- Print again: unknown driver job without reason -> `UnresolvableJobError`, nothing sent; with reason -> one more driver print of the same frozen bytes (no re-render, attempts 2); RAW->driver profile at same language/dpi re-renders; driver->RAW re-renders (brief test).
- 20 s limit unchanged (`PRINT_SEND_LIMIT_MS`, timer asserted at 20000 < the shell's 30 s); job stays in flight past the limit; a driver send behind a held send to the same queue (RAW or driver share the address key) becomes `busy` and is never given to the shell even after the held call settles.
- Press guard 400 ms (`VIEW_GUARD_MS`, LabelPanel) is UI code untouched by this task.

## RED / GREEN

- RED: `vitest run test/floor-print-driver.test.ts` -> 6 failed (`checkWindowsJob is not a function`, driver sends answered via RAW etc.) (`/tmp/claude/impl-drv-t5/red.log`).
- GREEN: brief's 5 files -> 250 passed; after additions floor-print-driver 20 tests.
- Gates: typecheck 0, lint 0, build 0; focused verbose (driver, runtime, jobs, resolution, app) 5 files / 264 tests, stderr 0 bytes; delayed-setImmediate stand (3 ms; scratch config+setup created and deleted) on floor-print-driver + app.test: 172 passed; full Vitest `--testTimeout=60000 --hookTimeout=60000`: 151 files / 4692 tests passed, stderr 0 bytes (task 4: 150 / 4671; +1 file, +21 tests); prettier gate live (scratch file -> exit 1, deleted; 6 changed files pass); `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`; tree clean after commit.

## Mutants (scratch one-line, `/tmp/claude/impl-drv-t5/mutate.py`, log `mut.log`; originals in `orig/`; each restore sha256- and `cmp`-verified, files touched): 26 mutants, 25 killed, 1 equivalent

| #     | Guard                                          | Mutant                                             | Killed by                                                                        |
| ----- | ---------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| 0     | default mode RAW                               | default `windows_driver`                           | "sends a driver page ... never through RAW"                                      |
| 1     | RAW route                                      | `if (false)`                                       | same                                                                             |
| 2     | driver only to Windows queue                   | check -> `false`                                   | "refuses a driver send to anything but a Windows queue"                          |
| 3     | no shell driver = unsupported                  | check -> `false`                                   | same                                                                             |
| 4     | document name `Markiro:`                       | `Markiro-`                                         | "sends a driver page ..."                                                        |
| 5     | fresh doc id per send                          | constant default id                                | "different document name ... for every send"                                     |
| 6     | receipt only of newest send                    | check -> `true`                                    | "keeps the receipt of the job's newest send only"                                |
| 7     | new send forgets receipt                       | `receipts.delete` removed                          | "forgets the old receipt as soon as the job is sent again"                       |
| 8/9   | rejected call mapping                          | always `outcome_unknown` / always `driver_unknown` | "answers a driver call that rejects as in doubt ..."                             |
| 10    | late send not started                          | `expired` check -> `false`                         | "starts a driver send only after the earlier send ... busy, never sent"          |
| 11    | expired flag set                               | removed                                            | same                                                                             |
| 12    | timeout when started                           | always `busy`                                      | "asks the spooler ..."                                                           |
| 13    | 20 s limit                                     | 30_000                                             | "waits 20 s ..."                                                                 |
| 14    | check needs a receipt                          | receipt check dropped                              | "asks the spooler ..."                                                           |
| 15    | check without shell driver                     | `windows === undefined` dropped                    | SURVIVED: equivalent (no receipt can exist without `windows`)                    |
| 16    | failed observation = unavailable               | -> `absent`                                        | "never lets an answer without a receipt or a failed observation read as printed" |
| 17-19 | supports: no driver / asks the shell / failure | `true` variants                                    | "refuses ... without the shell's driver", "says the shell cannot print ..."      |
| 20    | in-flight released                             | `release()` removed                                | "asks the spooler ..." (isInFlight false)                                        |
| 21    | job passes its mode                            | `"raw"`                                            | "goes to the Windows queue once and, in doubt, waits"                            |
| 22/23 | reprint re-render on mode change               | clause dropped / inverted                          | "is rendered again when printed again on a printer of the other way"             |
| 24    | App wires `windows`                            | option dropped                                     | App test "gives the floor a print runtime over the shell's driver printing"      |
| 25    | App uses given `windowsPrinting`               | prop ignored                                       | same                                                                             |

## Anchor adaptations

- All anchors matched exactly once. Test typing fix: `printWindowsRaster` mock annotated `Promise<PrintResult>` (brief's literal `{ sent: true, ... }` widened to `boolean` and failed typecheck). Test additions beyond the brief listed above; one brief test left as written.

## Concerns

- Windows queue check (`checkWindowsJob`) has no screen yet (Task 6); `supportsWindowsDriver` unused outside App test until then.
- Equivalent mutant #15 left (guard is redundant by construction).
- Real driver printing / spooler behaviour not exercised (no Windows); all fakes. `graphify update .` not run.
