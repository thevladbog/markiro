# plan СКЛ, Task 8 report: entry from the shift list, `FloorApp` wiring, docs, final checks

Status: DONE_WITH_CONCERNS. Commit: `74362fe17 feat(standalone): open the warehouse reprint from the floor; docs and spec §30 (plan СКЛ task 8)` on `claude/wh` (base df81aec36). Tree clean after commit.

## What was done

- Brief steps 1-7: `ShiftList` prop `onWarehouse` + button (`floor.warehouse.open`, `size="floor"`, `disabled={busy}`); `FloorApp`: `warehouseLookup` prop, `FloorView` `warehouse`, `Leave` `warehouse_setup`, `setup.back: WorkShift | "warehouse" | null`, `leave()` gates the warehouse like a shift but dispatches no `work_left`, `backFromSetup("warehouse")`, the `WarehouseScreen` render, the list's entry (resets `ending`); `App.tsx` passes `hostApi.warehouseLookup`; AGENTS.md section + Verification list; pilot spec §30.
- Decision on the rejected-records count: NOT done, recorded in AGENTS.md («Not done») and in §30. A count of `wh_outbox` records with `outcome = 'rejected'` needs an index (`wh_outbox_unsent` is partial on `acked_at IS NULL`, `wh_outbox_session` leads with `session_id`), i.e. an edit of the committed `0012` or a new shell migration; `0013` is plan ОЧ's, which also owns «Отправить снова». Beyond a small change, so left to ОЧ.
- Beyond the brief (tests): `test/floor-app-warehouse.test.tsx` (13 tests, `WarehouseScreen` stubbed: the wiring, the gate, leave/sign-out/idle/removed operator, setup round trip, the props), `test/floor-app-warehouse-real.test.tsx` (1 test, the real screen inside `FloorApp`: an unknown label, leave through the floor, back in: still «исход неизвестен», sent once, record kept, no `work_entered`), 2 tests in `floor-shift-list.test.tsx`, 1 in `app.test.tsx` (App wiring: list button, session, a scan reaches `host.warehouseLookup({ sscc })`).

## Anchor adaptations

- The brief's test clicks «К сменам» right after the screen opens: Task 7's 400 ms press guard (`useViewGuard`) swallows that click. Added a 450 ms real-time wait (`pastTheViewGuard`) in the brief's test (and in the App test, and `pastTheSetupGuard` before «Назад» of the setup). `FloorApp` leaves the screen's `clock` at the default, as asked.
- AGENTS.md: the line `- Pallets of several stations on one shift …` is in «Floor exceptions and close», not «Verification» as the brief says. The by-hand list was inserted in «Verification» before `- The floor's pallets (plan ПЛ-Ц) by hand …`. Section «Warehouse reprint» inserted before `## Shift exports` as the brief says.
- The pilot spec ends at §24 on this branch (§25–29 absent); §30 is written anyway as allocated, with a sentence saying so.
- The brief does not pass `render` to `WarehouseScreen`, and I did not either: `FloorApp.render` is a 3-argument `RenderLabel` (shift labels) and would drop the `{ kmDataMatrix }` options of a unit's label.
- The `leaving` field of `{ kind: "warehouse" }` is set but never read (the screen asks `isLeaving()`); kept as the brief's interface.

## RED / GREEN

- RED: `vitest run test/floor-app.test.tsx -t "warehouse reprint on the floor"` -> test timed out (no button) (`/tmp/claude/impl-skl-t8/red.log`).
- GREEN: that test passes after the edits (with the guard wait). `floor-app` + `floor-shift-list` + `floor-app-warehouse(-real)`: 4 files, 155 passed, stderr 0. Delayed-`setImmediate` stand (3 ms, both temp files deleted): same 4 files 155 passed, `app.test.tsx` 156 passed.
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: 159 files, 4869 passed (Task 7: 157 / 4851; +2 files, +18 tests: 13 + 1 + 2 + 1 + 1), 0 `stderr |`, exit 0.
- typecheck 0, lint 0, webview build 0, `cargo fmt --check` 0, `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`. Prettier gate live-proven (mis-formatted scratch exit 1, deleted); all 10 changed files pass from the worktree root with `--ignore-path`. `grep console.` in `floor/warehouse` and `warehouse-sender.ts`: empty; `tracing::` in `routes/warehouse.rs`: one line (`a warehouse batch failed`).
- Cargo: ONE full `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed (run concurrently with the full Vitest, load 100-150): 1170 passed, 1 failed = `host/tests/restore.rs::a_restore_cut_off_after_the_new_database_took_its_place_is_finished_by_the_next` ("the database closed: Elapsed", a timing timeout under load; this task touches no Rust). The target rerun alone: 33 passed. `--test local_db` 35 passed (shell 3.46 SQLite). `test/floor-schema.test.ts` + `test/warehouse-protocol.test.ts` (the TS side of both parity pins: SQL text agreement with `local_db.rs`, and the fixtures read by `proto/tests/warehouse.rs`): 76 passed. Plan: no number for Task 8.

## Mutants (harness `/tmp/claude/impl-skl-t8/mut.py`; sources copied to `orig/`; every restore asserted by sha256 in the harness; final shas equal: FloorApp `44dcbc05…`, ShiftList `e1e734f9…`, App `b45f291e…`; files touched)

Tests: `-t "warehouse reprint"` over `floor-app-warehouse`, `floor-app-warehouse-real`, `floor-shift-list`, `floor-app`, `app`.

| Mutant (one line)                                               | Killed by                                                                                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 `leave` does not gate the warehouse (`from !== "work"` only) | "waits for the work the screen tracks…", "ends in a sign-out when one comes while the leave waits"                                                                                        |
| F2 `work_left` dispatched for the warehouse too                 | same two                                                                                                                                                                                  |
| F3 `leaving` flag only for `work`                               | SURVIVED, equivalent: the warehouse view's `leaving` is never read (`isLeaving()` is the signal)                                                                                          |
| F4 `warehouse_setup` leave goes to the list                     | "waits for the work, opens the setup, and comes back to the reprint, not the list"                                                                                                        |
| F5 setup opened with `back: null`                               | same                                                                                                                                                                                      |
| F6 `backFromSetup("warehouse")` does not reset `ending`         | same (`isLeaving()` false on return)                                                                                                                                                      |
| F7 `backFromSetup("warehouse")` goes to the list                | same                                                                                                                                                                                      |
| F8 list entry does not reset `ending`                           | "enters the reprint again after a leave, taking scans again"                                                                                                                              |
| F11 `online` always true                                        | "says offline when the link is down, and when the host refused the device"                                                                                                                |
| F12 `touch` a no-op                                             | "starts the operator's idle wait again on a touch" (first survived: the sign-out waits for the work, so `onSignOut` was not the signal; asserted `isLeaving()` and the test now kills it) |
| F13 `onRecorded` a no-op                                        | "gives it this pairing, the lookup of the host…"                                                                                                                                          |
| F14 `onHostError` a no-op                                       | "hands a refused key of the host to the shell"                                                                                                                                            |
| F15 `isLeaving` always false                                    | "waits for the work the screen tracks…"                                                                                                                                                   |
| F16 pairing with the device id as the host id                   | real-screen test (the operator is vetted against the wrong pairing)                                                                                                                       |
| F17 «Рабочее место» leaves to the list                          | setup round trip test                                                                                                                                                                     |
| F18 button not `disabled={busy}`                                | shift list "opens the reprint… waits while a shift is being entered"                                                                                                                      |
| F19 button shown without `onWarehouse`                          | "shows no button…", "opens from the list… only when the host can be asked"                                                                                                                |
| F20 button `size="md"`                                          | shift list test (`mk-btn--floor`)                                                                                                                                                         |
| F21 button's text key changed                                   | App test and the real-screen test (button by name)                                                                                                                                        |
| F22 `App` does not pass `warehouseLookup`                       | App test                                                                                                                                                                                  |
| F23 warehouse view rendered only when no lookup                 | App test, real-screen test, brief test                                                                                                                                                    |

## Concerns

- The warehouse reprint is no shift, so the shell is told of no work (the brief's rule, asserted): a refused device key, another host answering at the address, or a line change takes the floor at once and does not wait for a print in hand as it waits for a shift's work. The screen's writes survive (a job left in `sending` reads `unknown` at the next opening, never resent), but a print can be cut mid-flight. If the owner wants the reducer to wait for it too, `floorWork` (which names a shift) would need a second kind. Recorded in AGENTS.md.
- Rejected warehouse records are still not surfaced anywhere (see above): left to plan ОЧ.
- Leaving while a send is in flight waits for the gate, up to the print runtime's 20 s send limit (the same as a shift's label); not exercised here with a real held send.
- The only red in the final full cargo run was the load-dependent timing test of `host/tests/restore.rs` (green alone, 33/33): not caused by this webview-only task.
- Not verified: Windows, WebView2, a real host over a LAN, real printers and scanners, a real canvas (the unit's Data Matrix raster), the on-screen keyboard, and the printing through the Windows driver (plan ДРВ: absent on this branch). `graphify update .` not run (worktree outside the sandbox write scope).

## Files

Modified: `apps/standalone/src/floor/shifts/ShiftList.tsx`, `src/floor/FloorApp.tsx`, `src/app/App.tsx`, `test/floor-app.test.tsx`, `test/floor-shift-list.test.tsx`, `test/app.test.tsx`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`. Created: `apps/standalone/test/floor-app-warehouse.test.tsx`, `apps/standalone/test/floor-app-warehouse-real.test.tsx`.
