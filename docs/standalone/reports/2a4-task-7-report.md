# Plan 2a4, Task 7 report — `print_bytes`, the spooler and `list_usb_printers` (written by the controller from the implementer's returned text; claims are the implementer's and UNVERIFIED)

Commit `4e62ee18f` on `claude/2a4-shell` (BASE `c0db63cd6`), one Opus 5.5 trailer, tree clean, no Cargo.toml/Cargo.lock/CI change.

## Tests (implementer's numbers)

lib 85 (56 before; +22 `printer::tests`, +7 `printer::spooler::tests`) in the sandbox; outside the sandbox `--test printer` 15, `--test ipc` 24; all `markiro-standalone` suites green; 5 repeats green and 4 runs under 24 busy-loop processes green; fmt, clippy 0 warnings, host/proto check 0 warnings; Windows probe crates for `x86_64-pc-windows-msvc` clean (probe 1: only serialport + windows-sys, `deny(warnings)`, the real `spooler.rs` via `#[path]`, brief's mutation dropping `Win32_Graphics_Gdi` fails with E0432; probe 2: tauri + real `printer.rs`, `cargo check` and `--tests`). Probes are NOT committed (`/tmp/claude/p2a4-probe7*`).

## Departures from the brief

1. `spooler.rs` split: the order of the seven spooler calls and the stage a failure leaves the job in are a generic `print_raw_via<S: Spooler>` that compiles and is tested on every OS with a recording fake; only the seven calls (`WindowsSpooler`) and `installed_printers` sit in `#[cfg(windows)] mod native`. Reason: a mutant per spooler boundary must be runnable off Windows.
2. `pub mod spooler`; `From<SpoolerError> for PrintFailure` replaces the plan's cfg(windows) match in `print_usb`.
3. Anchors all matched; RED error is `E0583`+`E0433` (lib.rs applied together with the tests).

## Additions beyond the plan

`MAX_PAYLOAD_BYTES` = 32 MiB checked after decoding (`invalid_payload`); `connect` tries every resolved address within one total connect timeout (`connect_with`; IPv6-first `localhost` fix); `run_blocking`/`list_with` generic async bodies (dead-thread and spooler-failure mappings unit-tested, "send does not run on the awaiting thread"); `Timeouts` doc (write timeout is per write); `drop(payload_base64)` before the send; tests for write-timeout setter failure, multi-address connect, bound edges of every target field, Cyrillic queue names (chars not bytes), control-char vs whitespace rules, strict base64, command error mappings, `list_usb_printers` refusal, `NOTUSB9` port in prioritize.

## Mutants

65 run, 63 caught, restored byte-identically (harness `/tmp/claude/t7/mut.py`, log `/tmp/claude/t7/mut.log`). Survivors (argued equivalent): A7 (`TcpStream::flush` is a no-op that cannot fail; COM flush same line, untestable off a real port), A15 (length guard before decoding is observable only as memory; removed). Classes covered: not_sent/outcome_unknown at every failure point (resolve, connect, write-timeout setter, COM open, spooler open/start/start_page/write/short write/end_page/end_document, send thread death), base64 strictness, target bounds, USB queue prioritisation, timeouts, command mappings.

## Data-integrity split

`not_sent`: name does not resolve; connect refused/unreachable/timeout/zero time/all addresses fail; write-timeout setter fails; COM open fails; spooler OpenPrinter/StartDocPrinter refused; label > 4 GiB; (`invalid_*` before anything opens; USB off Windows = `unsupported`). `outcome_unknown`: TCP `write_all` fails (cut, hung up, stalled), send thread dies, spooler StartPage/Write failure/short write/EndPage/EndDoc; when several fail the first is reported; page and document are still ended and the queue closed after a write failure.

## No leaks / no hang

Error detail = call name + system words only; tests assert no address, port or label byte appears (also after a 64 MiB label; COM open error does not name the port). Both commands async with `spawn_blocking`. Every send in tests runs on a thread under `recv_timeout(10 s)`.

## Only on a real printer / Windows

Spooler runtime (RAW datatype, `EnumPrintersW LOCAL|CONNECTIONS`, stopped spooler → `spooler_unavailable`); COM printers (open, write, flush, 5 s write timeout; no stub possible on macOS); a TCP success means the OS took every byte (no printer receipt; a label lost in the socket buffer after `write_all` is reported printed; no graceful shutdown/read-until-EOF added); wall-clock connect bound against a blackholed address; dual-stack localhost only on this Mac; two labels in flight to a one-connection printer.

## Concerns

1. COM `flush` can in theory block past the 5 s write timeout (hardware flow control): IPC stays free but the webview call stays pending → plan 2a7 needs its own limit on the awaiting side. 2. Command's `Timeouts::default()` checked by inspection + unit test, not via IPC. 3. TCP success is not a receipt. 4. Windows: a printer added between the two `EnumPrintersW` calls makes the second fail with 122 → `spooler_unavailable` (plan's two-call shape kept). 5. `connect` and `MAX_PAYLOAD_BYTES` are `pub` for the integration tests. 6. `print_bytes` takes `target: Value`/`payload_base64: String`: a call omitting `target` or sending a non-string payload gets Tauri's own text, not a bare code (the webview wrapper always sends both; its fallback for an unknown answer is `outcome_unknown`). 7. `/tmp/claude/t7/` already held another task's scratch files; overwritten (scratch only).
