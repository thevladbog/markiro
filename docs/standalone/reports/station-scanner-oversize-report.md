# Station COM scanner: oversize-frame fix

- Worktree: `/tmp/claude/wt/scanfix`, branch `fix/station-scanner-oversize-frame` from `origin/main` (cb94c03d4), local only.
- Commit: `d087d4e85` fix(station): drop an oversize scanner frame whole, through its terminator.
- Files: `apps/station/src-tauri/src/scanner/runtime.rs`, `apps/station/src-tauri/src/scanner/runtime_tests.rs`.

## Root cause

`absorb_chunk` checked the 4096-byte cap only on the unterminated tail left after `split_lines`. When the tail passed the cap it was cleared. The rest of that frame then counted as a new frame and reached the app as a scan at the next terminator (a). A complete line longer than the cap inside one read was emitted whole (b).

## Fix

Ported the standalone station's design. A private `Framer` holds `pending`, `discarding` and an `oversize` count. Its methods are `absorb_chunk(&mut self, chunk)` (the station's name, kept) and `take_oversize()`. A frame of more than `MAX_BUFFER_BYTES` (4096, terminator excluded; name kept) is dropped up to and including its terminator. A frame of exactly 4096 bytes is still a scan. `pending` never holds more than 4096 bytes. `split_lines` was removed: only tests called it, and it ignored the cap. The port loop logs `station: scanner {port} dropped a frame over 4096 bytes` with `eprintln!`, which the station already uses for its `station:` lines. The log never includes frame bytes.

(c) CR|LF split across reads produces no empty or doubled frame. Multibyte UTF-8 split across reads still decodes correctly, because frames are still decoded only once whole.

## TDD

- RED (`/tmp/claude/wt/scanfix-red.log`, against the old `absorb_chunk(&mut Vec<u8>, ..)` through a `frames` helper): 6 failed, 19 passed. Failing tests: `the_tail_of_an_oversize_frame_is_never_emitted_as_a_scan` (emitted `"xxx…TAIL"`), `an_oversize_frame_complete_in_one_read_is_dropped_whole`, `a_frame_of_exactly_the_limit_is_a_scan_and_one_byte_more_is_dropped_whole`, `a_crlf_split_between_reads_ends_the_frame_once`, `the_chunking_of_a_stream_with_an_oversize_frame_never_changes_the_scans`, and `an_oversize_frame_from_the_port_is_dropped_whole_and_the_next_scan_arrives`. The last one runs through the real port loop.
- Also added, and green before and after the fix: `bytes_are_decoded_only_when_the_frame_is_whole`, `the_chunking_of_the_stream_never_changes_the_scans` (2-cut at every position, 3-cut at every pair, bytewise) and `a_scan_split_at_the_group_separator_and_at_every_byte_arrives_once_and_whole` (port loop). Added with the fix: `an_oversize_frame_leaves_no_fragment_and_bounded_memory`, covering memory bound, the oversize count and the reset.
- Existing tests: the `split_lines`/`absorb_chunk_*` tests now run through `Framer`/`frames` with the same assertions. `buffer` became `framer.pending`. The cap-discard test also asserts `discarding`.
- GREEN: scanner 26/26.

## Mutants (`/tmp/claude/wt/scanfix-mut.log`). All killed; each restore verified by sha256 a392f9c8…e3ca, file touched.

| Mutant                                                           | Tests failed |
| ---------------------------------------------------------------- | ------------ |
| M1 `>=` → `>` (limit boundary)                                   | 3            |
| M1b `>= MAX` → `>= MAX-1`                                        | 3            |
| M2 `discarding = true` removed (flag not set)                    | 5            |
| M3 `discarding = false` removed (flag not cleared at terminator) | 7            |
| M4 discarded bytes pushed (tail emitted)                         | 5            |
| M5 no clear on overflow (oversize prefix emitted)                | 8            |
| M6 `take_oversize` does not reset                                | 1            |

## Gates

- `cargo fmt --check`: exit 0.
- `cargo test --offline --locked` (full `apps/station/src-tauri`): 170 passed, 0 failed (baseline 160 + 10 new). No network was needed.
  - Inside the sandbox one test failed: `grant_clock::…real_host_sample…` (sysctl boot identity `Unavailable`).
  - Outside the sandbox through the `/tmp` path, 5 `updater` loopback tests failed. Tauri rejects a `current_exe()` that passes through the `/tmp` symlink.
  - The green run was outside the sandbox with `--manifest-path /private/tmp/...`. Both failures are environmental and unrelated to this change.
- Clippy: not run. The CI `station-rust` job runs only `cargo build` and `cargo test`, with no clippy and no fmt.
- `git diff --check`: clean. Tree clean after commit.
- Prettier: N/A, no non-Rust files changed.
- Compiler warnings: the same pre-existing 11/8 dead-code warnings in printing code as on baseline. None in `scanner`.

## Not done / notes

- The `apps/station/dist` stub (gitignored) is used only for `generate_context!`. A real webview build needs `packages/ui/node_modules`, which was outside the allowed clone list.
- Not verified on Windows or with a real COM scanner. Host tests use an in-memory port.
- Sibling defect, not touched: `apps/kiosk/src/scanner/web-serial.ts:239-253` has the same framing (cap checked only on the tail; tail cleared and then emitted as a scan; long complete line emitted). Its comment says it mirrors the station's `MAX_BUFFER_BYTES`/`absorb_chunk` "exactly" and names a stale path, `scanner.rs`. It needs its own fix with kiosk tests.
