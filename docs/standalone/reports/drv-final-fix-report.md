# ДРВ — final fix wave report (base 7c1458672, branch claude/drv-fix, worktree /tmp/claude/wt/drvfix)

Status: DONE_WITH_CONCERNS (concerns at the end).

## Commits (4, each with exactly one Co-Authored-By trailer)

| #   | hash      | subject                                                                                 |
| --- | --------- | --------------------------------------------------------------------------------------- |
| 1   | 904af5a5a | docs(standalone): correct and complete the manual driver-printing check                 |
| 2   | 7dfb82605 | feat(standalone): one stderr line per failed driver call and per refusal                |
| 3   | e51e8483c | fix(standalone): geometry check requires the printable origin inside the page           |
| 4   | 10013b59d | test(standalone): pin the driver path end to end and the two missing observation shapes |

## What changed

1. **Docs (I1, M3, M6, M7).** `docs/runbooks/standalone-install.md`, section «Печать через драйвер Windows»:
   steps 6-7 rewritten (a paused or switched-off queue that still spools gives `sent`, the queue check reads
   `present`, the panel with the queue check exists only while the scan check is on; «Принтер не ответил вовремя» /
   «Windows не подтвердил задание…» only with a queue that really blocks; «Печать прервалась» only with a restart
   during an unanswered call), the 58×40 test-label note, the no-rollback-with-open-driver-jobs note, how to capture
   stderr (`2> drv-log.txt` from cmd) and the report's 10-line owner checklist. `apps/standalone/AGENTS.md`: one
   sentence that the queue is freed at 30 s while the Win32 call may still run (out-of-order labels, a reprint of the
   `timeout` label can double one), the diagnostics paragraph, the printable-origin rule.
2. **Diagnostics (I2).** `src-tauri/src/printer/driver.rs`: `WindowsPrintApi` methods now return `Step { name,
error, detail }` instead of `()`; `submit` takes a log sink and writes ONE line for the first failed call
   (`standalone: driver print step=<call> error=<Win32 code> [job=<id>] <numbers>`); `print_logged` (the old `print`
   is a wrapper that writes to stderr with `eprintln!`) writes one refusal line
   (`… refused code=… phase=… [job=…]`); `geometry_line` sets the page's dots, dpi and bounds against `GetDeviceCaps`
   and the merged DEVMODE (orientation, copies, scale, paper, paper size, quality, y resolution). Native steps named:
   `OpenPrinterW`, `DocumentPropertiesW.size/.out/.merge`, `DEVMODE.size`, `CreateDCW`, `StartDocW`, `StartPage`,
   `StretchDIBits` (returned vs expected, blit size), `EndPage`, `EndDoc`, `geometry`. Numbers and call names only: no
   label content, code, queue name, document name or page byte reaches a line (test asserts this).
3. **M5.** `raster.rs` `check_geometry` now also refuses `offset_x >= page.width` or `offset_y >= page.height`
   before `StartDocW`.
4. **Tests (M1, M2).** `test/floor-print-driver.test.ts`: end-to-end test (203 and 300 dpi): a box is closed on a
   driver profile with the real `renderLabel` (fake text rasterizer, jsdom has no canvas), the frozen bytes decode via
   `decodeMonoRaster` at the profile's dpi and the template's mm and dot size, and exactly those bytes reach
   `printWindowsRaster` once as `Markiro:<uuid>` with nothing sent RAW. `hardware-shapes.json` gains
   `windowsJobIdentityMismatch` and `windowsJobUnavailable` (key count 7 -> 9); Rust test serialises them, TS test
   parses them with the Zod schema and asserts 9 keys.

## Not verified here (be explicit)

- `mod native` (OpenPrinterW / DocumentPropertiesW / CreateDCW / GDI / GetJobW and the new per-call lines) never ran;
  it is type-checked only by the probe crate (`/tmp/claude/drvfix-probe`, `cargo clippy --tests --target
x86_64-pc-windows-msvc -- -D warnings`: clean on the final tree, includes the new `Step`/`log` plumbing). The line
  _content_ is host-tested through `step_line`/`geometry_line`/`refusal_line`/`submit`/`print_logged`; which native
  call produces which line, and that `last_error()` still holds the right code at the moment it is read, is Windows-only.
- No Windows, no printer, no real driver, no WebView2 run.

## Mutants (name, killing test, restore proof; every restore: sha256 equal + `cmp` + file touched; tree clean after)

Scripts: /tmp/claude/impl-drv-fix/{mut.py,tsmut.py,c2.json,c3.json,c4.json,c4f.json}.

| Mutant (one line)                                                  | Killed by                                                                                                            | Restore     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| C2-a no log line for a failure after begin                         | `a_failure_after_start_doc_leaves_one_line_with_the_job`                                                             | OK 9f4b1e15 |
| C2-b job id left out of that line                                  | same                                                                                                                 | OK          |
| C2-c no log line for a failed StartDoc                             | `a_failed_start_doc_leaves_one_line_without_a_job`                                                                   | OK          |
| C2-d `print_logged` drops the refusal line                         | `a_refused_print_logs_its_refusal_once_and_nothing_of_the_label`, `off_windows_a_checked_page_logs_only_its_refusal` | OK          |
| C2-e geometry line reports dpi_x twice                             | `the_geometry_line_sets_the_page_against_what_the_driver_reported`                                                   | OK          |
| C2-f refusal line without the job                                  | `a_refusal_is_one_line_with_its_code_phase_and_job`                                                                  | OK          |
| C2-g a whole page logs a line                                      | `a_whole_page_logs_nothing`                                                                                          | OK          |
| C2-h step line's error code off by one                             | 3 tests (step line, begin line, post-begin line)                                                                     | OK          |
| C2-i refusal line names the queue                                  | the refusal-line test and the privacy test                                                                           | OK          |
| C3-a `offset_x >= width` becomes `>`                               | `the_printable_origin_lies_inside_the_page_so_the_blit_has_a_size`                                                   | OK 16a024cc |
| C3-b same for y                                                    | same                                                                                                                 | OK          |
| C3-c x guard dropped                                               | same                                                                                                                 | OK          |
| C3-d y guard dropped                                               | same                                                                                                                 | OK          |
| T-a (reviewer's C) `prepareLabelJob` renders for `{language, dpi}` | both e2e cases (203, 300)                                                                                            | OK 6a1d5afa |
| T-b `prepareLabelJob` renders at 203 whatever the profile          | the 300 dpi case                                                                                                     | OK          |
| T-c runtime sends a driver page RAW                                | e2e + 2 existing tests                                                                                               | OK 192885bb |
| T-d `sendLabelJob` passes mode `"raw"`                             | e2e + 2 existing tests                                                                                               | OK          |
| F-a Zod drops `unavailable`                                        | windows-printing fixture test + strict test                                                                          | OK b5c7c242 |
| F-b Zod drops `identity_mismatch`                                  | same + one more                                                                                                      | OK          |
| F-c fixture says `absent` for the unavailable shape                | Rust `the_hardware_shapes_are_the_ones_the_fixture_pins`                                                             | OK 1c8ae2e6 |
| F-d Rust serialises `IdentityMismatch` as `mismatch`               | Rust test                                                                                                            | OK 9f4b1e15 |
| F-e fixture gains a 10th key                                       | TS key-count test                                                                                                    | OK          |
| F-f fixture gains a 10th key                                       | Rust key-count test                                                                                                  | OK          |

Not mutable on the host (Windows-only, probe crate only): the native `Step` constructors, `last_error()`, the
geometry-line calls inside `Device::open`.

## Gates

- `cargo fmt --check`: clean. `cargo check` 0 warnings; `cargo clippy` shows no finding in changed files (pre-existing
  `tests/ipc.rs:382` and others untouched). Probe crate clippy `-D warnings` for the Windows target: clean.
- TDD RED seen for commit 3 (new test failed before the guard) and for commit 2 (compile-level: trait change); the
  rest is mutant-proven.
- `typecheck` 0, `lint` 0, webview `build` 0.
- Focused verbose Vitest (`floor-print-driver`, `windows-printing`, `hardware`): 183 passed, stderr empty (0 bytes).
  No React effects in the changed Vitest files, so the delayed-`setImmediate` stand was not needed.
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: 4721 passed, 3 failed (see concern 1).
- ONE final full `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: exit 0, 1166 passed, 0 failed,
  0 ignored, 0 warnings (plan expectation >= 1157; base had ~1157 + 9 new = 1166).
- Parity: Rust `hardware_shapes` + TS `windows-printing`/`hardware` (fixture, 9 keys) pass; mono-raster vector: Rust
  `the_domain_writes_the_vector_this_module_reads` + domain `labels-mono-raster.test.ts` (19) pass.
- Prettier gate live: a mis-formatted scratch file failed it once (deleted); changed md/ts/json pass. `git diff --check`
  clean; `grep -rnF '\u04'` only `pairing-code.ts:66`; `git status --short` empty.

## Concerns

1. **3 Vitest failures, pre-existing and unrelated:** `test/forms-parity.test.ts` (`placard-a4`,
   `placard-a5-disassembled`, `shift-placards-a5`): the cloud's golden has «ПАЛЛЕТА» while the domain source at this
   base (`packages/domain/src/print-forms/pallet-placard.ts:278`) still writes «ПАЛЕТА». They fail identically in the
   clean review worktree at 7c1458672 (/tmp/claude/wt/rv-drv). Not touched. `@markiro/domain` dist was rebuilt here; it
   did not change the result.
2. Per-step diagnostics in `native` depend on `GetLastError` surviving until `last_error()` reads it (it is read
   immediately after the failing call, before any allocation except `format!` in the already-failed branch). Only a
   Windows run can confirm the codes.
3. Runbook names the exe as `<имя exe приложения>`: the installed binary name was not verifiable here.
4. `graphify update .` not run (no graph in this scratch worktree).
5. CARRY/DROP rows (M4 statusFlags, M11 live region, per-queue busy guard for M3) intentionally not implemented.
