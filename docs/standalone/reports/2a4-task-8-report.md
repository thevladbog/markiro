# Plan 2a4, Task 8 report — COM scanners in the shell

Status: DONE_WITH_CONCERNS. Commit `2953d6d79` on `claude/2a4-shell` (BASE `4e62ee18f`), one Opus 5.5 trailer, tree clean, no Cargo.toml / Cargo.lock / CI change. Files: `src-tauri/src/scanner.rs`, `scanner/runtime.rs`, `scanner/runtime_tests.rs` (new), `src-tauri/src/lib.rs`, `src-tauri/tests/ipc.rs`.

## Tests (measured)

- `--lib`: 120 (85 before; +35 scanner: 28 in `scanner::runtime::tests`, 7 in `scanner::tests`). The plan counted 76 / 16 on its copy; the tree already had 85 (Tasks 2-7), the plan's own 16 runtime tests are all still in, plus mine. Scanner tests also pass inside the sandbox (no sockets).
- `--test ipc` (outside the sandbox): 25 (24 + `scanners_answer_through_the_ipc_shapes`), 5 repeats of the scanner test green. Whole package outside the sandbox: all suites green (claim 5, connection 6, device 15, host_probe 2, host_probe_proxy 1, host_request_timeout 5, ipc 25, line 16, local_db 26, lockdown 4, printer 15).
- `--lib scanner` 5 repeats green; 3 runs under 24 busy-loop processes green.
- `cargo fmt --check` clean, `cargo clippy --all-targets -p markiro-standalone` 0 warnings, host/proto `cargo check --all-targets` 0 warnings, `git diff --check` clean. No TS changed, so no vitest/prettier run.
- RED: after the ipc test was added, `cargo test --test ipc --no-run` failed with `E0432: unresolved imports markiro_standalone_lib::scanner`. GREEN of the plan's baseline (cloud copy + the plan's edits only): lib 101, ipc 25.

## Anchor adaptations

1. `tests/ipc.rs` fragment 1: the `local_db` import already differed (`MIGRATOR`), so the `use ...scanner::{self, PortOpener, ScannerManager};` line was inserted after the `power` import. Fragment 2 (the `connection.ts` doc comment + `#[test]`) matched once.
2. `lib.rs` fragments matched in spirit; the registration list ends with the `printer::list_usb_printers` of Task 7. Cloud hashes matched the plan (`b620b1fd...`, `fdd8bbd1...`).

## Departures from the brief (all deliberate, all tested)

The cloud runtime was audited as production input. Findings and changes:

1. **Cloud defect, fixed: an oversize frame was emitted as a fragment.** `absorb_chunk` cleared the buffer when it passed 4096 bytes without a terminator, but the rest of that frame, up to its CR/LF, then went out as a scan; and a frame of 4097..4352 bytes was emitted or not depending on how reads fell. Reproduced against the cloud code with 256-byte reads: a 5004-byte frame yielded a 652-byte "scan"; a 4200-byte frame in one read was emitted whole. Replaced `split_lines`/`absorb_chunk` by `Framer` (byte state machine, `MAX_FRAME_BYTES` = 4096): a frame of up to 4096 bytes is a scan, a longer one is dropped whole through its terminator, memory stays bounded, and the result never depends on read chunking (test cuts a mixed stream at every one and every two positions and byte-by-byte). An oversize drop writes a stderr line with the port name only (no frame bytes). The five cloud framing tests were rewritten on `Framer` with the same intent.
2. `configure` also refuses more than `MAX_SCANNERS` = 32 scanners, a port name over `MAX_PORT_NAME_CHARS` = 256 characters, and any control character (the brief had empty / NUL only; the printer uses the same name rule). Same code `invalid_scanners`. Rationale: one OS thread per element of a webview-supplied array. No baud whitelist: the brief and cloud accept any non-zero `u32`, and an unsupported rate only keeps the port `disconnected` (retried every 2 s).
3. `configure_scanners` takes `Option<Value>` through `pub parse_scanners`, so a missing argument is also bare `invalid_scanners` (Task 7's `print_bytes` still gives Tauri's text for a missing `target`).
4. `list_serial_ports` is `#[tauri::command(async)]` (port enumeration can take seconds on Windows and sync commands run on the main thread).
5. `tauri_sink` is `emit_sink(emit, report)` generic over the emit function so failure handling is testable on macOS; a failed emit is reported as `standalone: <event name> not delivered: <system text>` and never the payload.
6. `pub` seams: `emit_sink`, `parse_scanners`, `MAX_*`, `RETRY`; `Framer` is private to `runtime` (tested by its child module).

## Mutants (harness `/tmp/claude/t8/mut.py`, `run_mut.py`; every mutant restored byte-identically — sha256 and `cmp` both checked by the harness)

Plan mutants: P1 drop `deny_unknown_fields` -> `scanners_answer_through_the_ipc_shapes` (ipc) and `the_scanners_argument_is_read_strictly...` (lib) fail; P2 `canonical_port` no upper-casing -> 5 tests fail incl. `configuration_validation_is_atomic_and_com_only_is_case_insensitive` (plan said 4; measured 5 because of the extra tests).

Mine, all CAUGHT unless listed below:

- Validation: cap `>`->`>=`, cap off, name length `>`->`>=` and off, control->NUL only, baud guard off and `==1`, duplicates allowed, empty name allowed, no trim, `len>3`->`>=3`, `all`->`any` digit, canonical dropped.
- Framing: LF-only, CR-only, empty frames emitted, limit `==`->`>`, limit-1, no discard flag, discard never ends, pending not cleared after a frame, pending kept on oversize, oversize uncounted / sticky, strict UTF-8, whole 256-byte buffer absorbed instead of `[..n]`, GS-exempt limit, framer hoisted out of the connection loop.
- Runtime: `Ok(0)` continue, `Interrupted` / `WouldBlock` / `TimedOut` each dropped from the keep-reading set, any other error keeps the port, retry without a pause (busy loop), stale-id `set_status` (new test `a_removed_workers_late_open_does_not_mark_its_replacement_connected`), stale-id scans, revision +2, no-op configure not acknowledged, no cancel on removal, gate ignored, poisoned lock in `configure` (aborts the test process: panic inside `Drop` while unwinding) and in `snapshot`, `Drop` not closing, handle dropped after the loss is published (new deterministic test with a sink that inspects the handle at publish time).
- Sink / commands: events swapped, scan trimmed, failure unreported, failure carries payload, `RETRY` 1 s, `MAX_FRAME_BYTES` 4000, missing argument = empty set (would close every scanner), lenient parse, `configure_scanners` ignoring the parse error, `close_scanners` doing nothing, `get_scanner_connections` stale, `close_scanners` not registered.

Initial survivors that I fixed by adding tests: R8 stale `set_status`, S2 scan trimmed (test strings had no edge whitespace), S5 (anchor), R21 (race-prone, replaced by the sink-inspection test), S13 (GS at the limit byte).
Remaining survivors, argued equivalent: (a) `set_status`'s `if worker.status != status` guard: every call is a real change (Connected after open, Disconnected after loss); (b) in `run_port`, stale `set_status(Connected)` returning vs continuing: a removed worker is already cancelled, so the loop exits anyway; (c) removing the oversize `eprintln!` (log only; message holds only the port name); (d) the `to_value` failure branch in `emit_sink` (cannot happen for the snapshot); (e) `serialport::new(...).timeout(200 ms)` value: hardware. Removed one guard that was provably redundant (`!self.discarding &&` before emitting: `pending` is empty while discarding), commented.

## Behaviours, as tested

- Terminators: CR, LF, CRLF, LFCR, runs; empty frames skipped; a frame of spaces is a scan (spaces never trimmed); GS 0x1D, `]d2` / `]C1` prefixes, NUL, BOM kept raw. UTF-8 with replacement applied once per whole frame (a Cyrillic letter cut between reads survives; a Latin-1 byte becomes U+FFFD; all 256 byte values in one frame: nothing dropped or reordered).
- A scanner that vanishes mid-frame: the partial frame is dropped (never emitted), the next connection starts with a new `Framer`; a frame cut by `Ok(0)` or any non-timeout error likewise.
- Status: `revision` grows by exactly 1 per published change (concurrent 4-thread reconfiguration with flapping ports: events are 1..n consecutive, the last equals `get_scanner_connections`); the IPC test checks the same on the events a `Listener` hears. An invalid request publishes nothing and changes nothing (old ports and the half-read scan kept). `close_scanners` twice is fine; every `configure` publishes a status even if unchanged (the cloud's acknowledgement).
- `close_scanners` / `Drop` close every port even after a poisoned lock (test poisons it). Replacing the set closes removed ports' handles (`dropped` signal) and a re-added port waits for the old handle.
- Retry pace: an absent port is retried every `retry` (bounded: <=5 attempts in 350 ms at 100 ms), publishes nothing while absent; `RETRY` = 2 s asserted. Every wait in tests is `wait_until` (3 s) or `recv_timeout`, none can hang.
- Logs/errors: refusal codes are bare; the only new stderr lines are the oversize drop (port name), `list_serial_ports` failure (system text, as the plan allows), and emit failure (event name + system text); a test asserts the scan text is absent.

## Needs a real COM scanner / Windows (not verified here)

Real `serialport` open/read/timeout behaviour (200 ms read timeout, `TimedOut` vs `Ok(0)` on unplug on Windows/USB-serial, DTR/RTS, flow control), `available_ports()` content and latency on Windows, com0com loopback end to end, a scanner configured without a CR/LF suffix (its frames merge up to 4096 bytes and are then dropped: the scanner must send CR or LF), `scanner::manager(...)` being managed in `run()`'s `setup` (the mock builder skips `setup`; covered by compilation only, same gap as Task 6 minor 11), the `serial_unavailable` branch (only the "array or this code" tolerance in the test), and the real webview receiving the events. No Windows probe crate was built: nothing in this task is `cfg(windows)`.

## Concerns

1. A scan emitted while the webview is reloading or absent is lost (no queue); status is recoverable by `get_scanner_connections`, a scan is not. Plan 2a7 must not reload the window mid-scan; the module doc says so.
2. A baud mismatch (wrong rate) yields garbage frames that are delivered as scans (short lines with CR/LF bytes); validation belongs to the consumer.
3. If a read returned `TimedOut`/`WouldBlock` instantly forever (a misbehaving driver), the read loop would spin; real `serialport` waits its 200 ms timeout. Not guarded.
4. A panic inside the sink would kill that port's thread with the status left `connected`. The real sink does not panic.
5. `ScannerConfig` canonicalises only `COMn`; `\\.\COM3` and `COM3` would be two entries for one device (the second stays `disconnected`). `list_serial_ports` returns the plain names.
6. Limits `MAX_SCANNERS` 32 / 256-char names are my addition, one code `invalid_scanners`; if the owner prefers the plan's literal checks, drop `scanners.len() > MAX_SCANNERS` and the two name checks in `configure` (tests `port_names_and_the_number_of_scanners_...` and `a_refused_configuration_...` then change).
7. The harness leaves scratch files in `/tmp/claude/t8/` only.
