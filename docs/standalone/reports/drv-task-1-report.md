# ДРВ Task 1 report — mono-raster-v1 parser and driver-printing core (shell)

Status: DONE_WITH_CONCERNS (concerns below are verification limits, not defects).
Commit: `2387a2dce` feat(standalone): the shell reads mono-raster-v1 pages and prints them through the Windows driver (plan ДРВ task 1), on `claude/prt` (base 2c726efba).

## What was done

- `printer.rs`: modules `driver`, `driver_commands`, `raster` declared; module comment line about driver printing added.
- `Cargo.toml`: `windows-sys` feature `Win32_Storage_Xps` + comment line. `Cargo.lock` unchanged.
- `printer/raster.rs` (decode, check_geometry, dib_pixels, Raster, Caps, MAX_BYTES) and `printer/driver.rs` (print, observe, Receipt, Failure, Outcome, Observation, WindowsPrintApi, submit, markiro_document, `mod native` under `cfg(windows)`) written from the brief verbatim, then tests extended (see mutants).
- `printer/driver_commands.rs`: one-line placeholder (task 2 replaces it).

## RED / GREEN

- RED: `raster.rs` with `decode` stubbed to `Err(())`: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib printer::raster` -> 3 FAILED (vector, dib rows, geometry), 1 passed (the malformed-page test passes vacuously on a stub; it is why the extra tests below were added).
- GREEN: brief tests -> `printer::` 54 passed (raster 4 + driver 7 as the plan says). After my additions: `printer::` 69 passed (raster 14, driver 12 + the 43 pre-existing).
- Final: `cargo test --workspace --offline --locked` (unsandboxed): exit 0, 1150 passed, 0 failed, 0 ignored, 0 warnings. `git status --short` empty.
- Gates: `cargo fmt --all -- --check` 0; `cargo check -p markiro-standalone --all-targets` 0 warnings; `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`; no `\u0` in the new Rust files. Prettier gate: not applicable (no TS/JSON/MD files changed).

## Windows verification (probe crate, not committed)

`$TMPDIR`-equivalent `/tmp/claude/impl-drv-t1/drv-probe` includes raster.rs and driver.rs by absolute path (as the brief), target `x86_64-pc-windows-msvc` (installed):

- `cargo check --tests --target x86_64-pc-windows-msvc`: OK, 0 warnings. `cargo clippy --tests --target ... -- -D warnings`: initially 1 error (below), after fix OK. Host clippy `-D warnings` of the probe: OK.
- THE WINDOWS PATH IS ONLY TYPE-CHECKED/LINTED (names and signatures of windows-sys 0.61.2 resolve); nothing was run. `mod native` (OpenPrinterW, DocumentPropertiesW, CreateDCW, StartDocW, StretchDIBits, GetJobW) has no execution evidence: it is covered only by CI `standalone-windows-build` / manual printer check. A full-crate `cargo check --target x86_64-pc-windows-msvc -p markiro-standalone` fails here in a C build script (cc-rs, no Windows C toolchain), so only the probe validates the `Win32_Storage_Xps` feature in the real manifest indirectly (the probe declares the same feature list).

## Anchor adaptations

- printer.rs doc comment inserted after the line `//! connection is not seen here.` as an `//!` block preceded by `//!` (brief says "before `use std::io::Write;`") — same place.
- `cargo fmt` reflowed four long `assert!(!markiro_document(...))` lines in driver.rs tests; semantically identical.
- Clippy (toolchain 1.93) rejected `start % 2 != 0` in `native::observe` (`manual_is_multiple_of`, -D warnings); changed to `!start.is_multiple_of(2)` (same meaning; stable toolchain in CI).
- No semantic difference from the plan's fragments found.

## Mutants (scratch, one-line each; run over `printer::` (69 tests); restore: sha256 + `cmp` against copy, `touch`; every row restore=True; final sha256 raster.rs `53ae98c2...`, driver.rs `59f36c49...`)

Script `/tmp/claude/impl-drv-t1/mutate.py`, logs `mut-run1.log`, `mut-run2.log`.

| Guard                                                  | Mutant                                                                                           | Killed by                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| header floor                                           | `< 64` -> `< 8`                                                                                  | a_truncated_header_is_refused_without_reading_past_it (all lengths 0..64; new)         |
| magic                                                  | check dropped                                                                                    | the_magic_and_the_resolution_are_checked (new)                                         |
| dpi set                                                | dropped / 204 accepted                                                                           | same                                                                                   |
| mm bounds                                              | `..=300` -> `..300`; 10 -> 10.01 / 9; 300 -> 301                                                 | the_size_in_millimetres_is_bounded_and_matches_the_dots (new), vector tests            |
| width/height dots vs mm                                | each check dropped                                                                               | same (81x80 / 80x81 pages)                                                             |
| stride                                                 | check dropped                                                                                    | same                                                                                   |
| reserved word 44, pixel length word 40                 | dropped                                                                                          | a_malformed_page_is_refused_whole                                                      |
| length equality                                        | `!=` -> `>`                                                                                      | a_malformed_page_is_refused_whole (len 863/865)                                        |
| bounds l>r, t>b, r>w, b>h (and `>=` variant)           | each dropped / loosened                                                                          | the_required_bounds_must_lie_inside_the_page (new, blank pages)                        |
| padding bits scanned                                   | `0..stride*8` -> `0..w`                                                                          | a_black_dot_in_the_row_padding_refuses_the_page (new)                                  |
| dot vs bounds left/right/top/bottom, bottom off-by-one | each dropped                                                                                     | a_black_dot_outside_the_bounds_refuses_the_page (new)                                  |
| MSB-first bit order                                    | LSB first                                                                                        | vector test + dot test                                                                 |
| caps ranges (lower)                                    | 1 -> 0 for sizes; 0 -> 1 / -1 for offsets                                                        | a_page_without_required_bounds_skips_the_area_check_but_not_the_ranges (new)           |
| dpi_x / dpi_y                                          | dropped                                                                                          | the_geometry_is_held_to_the_dot (new)                                                  |
| paper slack 1 dot                                      | slack 0 / 2 on width and height                                                                  | same                                                                                   |
| printable slack                                        | +1 -> +2 (both axes)                                                                             | same                                                                                   |
| bounds vs printable (l, t, r, b)                       | each dropped / flipped                                                                           | same                                                                                   |
| empty-bounds skip (either axis)                        | `r > l` / `b > t` forced true                                                                    | page_without_required_bounds... (bounds [0,0,0,80], [0,0,80,0]; new)                   |
| dib stride / row copy                                  | not aligned; copy short                                                                          | a_dib_row_is_padded_to_a_double_word (new), dword rows test                            |
| valid_name                                             | blank allowed; len 1024 -> 1025; NUL allowed                                                     | refusal-order test, a_name_of_exactly_the_longest_length..., payload test              |
| markiro_document                                       | prefix optional; length 36 -> >=35; hyphen/hex slot swaps; slot 23 dropped                       | the_document_name_is_exactly_a_hyphenated_uuid (new)                                   |
| print order artifact -> queue -> document              | queue first; queue/document unchecked; queue code                                                | the_refusals_come_in_the_order_artifact_queue_document (new)                           |
| artifact decode                                        | not decoded                                                                                      | the_payload_is_bounded_before_base64_is_decoded                                        |
| unsupported_platform off Windows, before_start phase   | code/phase changed                                                                               | off_windows_a_checked_page_is_unsupported_before_any_start (new), not-mono-raster test |
| submit order/abort/receipt/phase/no retry              | draw/end_page/end skipped; abort skipped; receipt dropped; phases swapped; begin retried         | a_whole_page_answers_its_receipt, a_failure_after_begin..., a_failed_start_doc...      |
| wire shapes                                            | no camelCase; untagged removed; skip_serializing_if removed; Observation snake_case; statusFlags | the_answers_have_the_shapes_the_webview_reads (new) + not-mono-raster test             |

Survivors (all behaviourally unobservable on the host, listed deliberately):

- header floor `< 64` -> `< 63`: subsumed by the length-equality check (equivalent).
- payload length bound call-site in `artifact` (`> 4*ceil(MAX/3)`): any over-bound payload is refused later anyway by the base64/`decode` size check; the guard only avoids the allocation. No behavioural test possible without refactoring.
- `observe`: `valid_name(queue/document)` and `job_id == 0`: off Windows every path returns `unavailable`, and on Windows an invalid queue also reads `unavailable` from the failed open; Windows-only, unkillable on the host.
- Upper range limits of caps (10000), `MAX_BYTES` check, `is_finite`: redundant with other checks (a valid page is at most ~1.57 MB; mm range excludes NaN/inf).

## Test totals

Plan: raster 4 + driver 7. Measured: raster 14, driver 12 (added 12 tests beyond the brief). `printer::` 69; workspace 1150 passed.

## Concerns

- `mod native` (all unsafe Windows code) never executed; only probe type-check/clippy. Needs `standalone-windows-build` CI and a real driver/queue check.
- `graphify update .` not run.
- The brief's own tests passed a stub for the malformed-page test (vacuous); strengthened as above.
