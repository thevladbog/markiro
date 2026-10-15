# ДРВ Task 7 report — documents and final gates

Status: DONE_WITH_CONCERNS (concerns are verification limits). Commit `7c1458672` docs(standalone): printing through the Windows driver — AGENTS, pilot spec §28, manual check (plan ДРВ task 7), branch claude/prt (base cbfdc10dc). Docs only.

## What was done

- `apps/standalone/AGENTS.md`: "Hardware" bullet on driver printing inserted before `configure_scanners` (brief text; added "and it has never been run" after the probe-crate sentence); "Floor printing" paragraph inserted after "…closed with." (brief text) plus an honest "Not verified" tail (spooler/GDI calls, real drivers with user-size paper, IBM Plex via `document.fonts` in WebView2, the ≥64 px production-browser contract of the new setup controls).
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: new §28 appended (no §25–27 in this branch yet; appended at the end). "Not verified" bullet extended: Windows code only type-checked by the probe crate for x86_64-pc-windows-msvc, never run; ≥64 px contract not exercised.
- `docs/runbooks/standalone-install.md`: subsection "Печать через драйвер Windows (план ДРВ)" at the end of "Ручная проверка на Windows" (it is the last section). Owner checklist: what to report (printer/driver model, driver resolution, what came out per step, on-screen texts), 7 steps from the brief; added the manual ≥64 px measurement of the new setup controls, and that a missing IBM Plex makes printing refuse with «Этикетку не удалось подготовить для этого принтера» instead of printing in a fallback face. All quoted screen texts checked against `ru.json` (render_failed, geometry_mismatch, timeout, driver_unknown, interrupted, queue.no_receipt).
- No deviations section written (controller's).

## production-browser

`tools/production-browser` covers the cloud station (`station-inventory-tests`, kiosk, admin, landing) and has no spec for `apps/standalone`; its ≥64 px gallery contract (`targetsBelow64`) runs on the cloud station gallery. Nothing under it covers the standalone setup controls, so no spec was run (none applies); the ≥64 px check for the new controls is on the manual Windows list. In jsdom only `size="floor"` and keyboard focus are pinned (Task 6).

## Final gates (all in /tmp/claude/wt/prt)

- typecheck 0, lint 0, build 0 (only the usual chunk-size warning).
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: 152 files / 4722 tests passed, exit 0, no failures (same as Task 6).
- `cargo fmt --all -- --check` 0. ONE full `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed): exit 0, 1157 passed, 0 failed, 0 ignored, 0 warnings (same as Task 2). No known base (ПАЛЕТА) failures appeared.
- Parity: `test/hardware.test.ts` 115 passed (reads `hardware-shapes.json`); Rust `--test hardware_shapes` 1 passed.
- Prettier gate live (scratch mis-formatted .md -> exit 1, deleted); the 3 changed docs + `hardware-shapes.json` pass. `git diff --check` clean; `git diff --stat -- apps/standalone/Cargo.lock pnpm-lock.yaml` empty; `grep '\u04'` only `pairing-code.ts:66`; `git status --short` empty after the commit.

## Concerns (not verified; stated in the docs)

- Spooler/GDI code (`mod native`: OpenPrinterW, DocumentPropertiesW, CreateDCW, StartDocW…EndDoc, StretchDIBits, GetJobW) was never run, only type-checked/clippy'd by a probe crate (Task 1); the order of calls is tested on every OS over a fake `WindowsPrintApi`.
- Real IBM Plex loading in WebView2 (`rasterizeDriverText` refuses if it does not load; jsdom has no `document.fonts`).
- ≥64 px for the new setup controls (select «Способ печати», «Проверить очередь Windows»): not measurable in jsdom, not covered by production-browser; manual item added.
- Real driver queues/printers: user-size paper, `GetDeviceCaps` resolution and printable area, `statusFlags` after pause, the 30 s limit with a hung driver.
