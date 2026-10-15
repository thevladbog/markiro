# Plan 1f2 — final fix wave report

BASE 63507cfac20c231e7a3bbb48ab4525e6bb4ea520. Status: DONE_WITH_CONCERNS (see concerns).

## Commits

- 3d7b58955 test(standalone): the floor's status bar names the assigned line, forgets names on a failed read and ignores a stale read
- c97d4ab8c fix(standalone): focus goes to the office page after leaving kiosk mode
- f11014113 docs(standalone): kiosk mode on every PC, its lifetime and trust boundary, the open owner step, more Windows checks

## Mutants (all restored; sha256 before == after, cmp silent)

| Commit         | Mutant                                                                                                                                                              | Failing test                                                                             | Key line                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1 (item 11)    | floor-status.ts `LINE_NAME ... WHERE id = ? OR 1 = 1` (equivalent of `OR true`)                                                                                     | names the line the station is assigned to (+ the stale-read test)                        | expected 'Линия фасовки 1' to be 'Линия розлива 2'       |
| 1 (item 10)    | FloorStatusBar.tsx rejection handler `if (!cancelled) return;`                                                                                                      | forgets the names when the next read of the copies fails                                 | expected <dd></dd> to be null                            |
| 1 (item 12)    | FloorStatusBar.tsx `setPlace(next);` without the cancelled check                                                                                                    | keeps the names of the line it has now when a read for the line before it lands late     | Unable to find an element with the text: Линия розлива 2 |
| 2 (items 6, 8) | WindowModeButton.tsx `onLeft();` replaced by `void onLeft;` (this is also the RED run: the test was written against the finished change, then the call neutralised) | moves focus to the office page when the window is an ordinary one and the button is gone | expected <body> to be <main tabindex="-1">;              |

## Notes

- Commit 1: tests only. Item 11 uses two lines in the copies, the other one sorting and inserted first. Item 12 holds the read for line A with a gate, switches to B, B lands, then A is released inside `act` with a setTimeout(0) settle.
- Commit 2: `WindowModeButton` takes a required `onLeft`; `OfficeShell` passes `() => mainRef.current?.focus()`; called after `leave()` returns true. The test uses a stateful wrapper (button disappears as in App) because with a static mock the Modal's focus restore would return focus to the still-present button. Comment at app.test.tsx reworded. Two AGENTS sentences updated.
- Commit 3: AGENTS «App shell» / Verification / manual list and spec §5.1, §5.3, §8 (I1, M1-M7). Plan file untouched. AGENTS additions kept at 80 columns; prettier clean.
- `\u04` grep: only pairing-code.ts:66. Verbose runs of floor-status-bar, office, app: no `stderr`. Delayed-setImmediate stand: floor-status-bar 10 passed; office + app 121 passed; stand files deleted. git diff --check clean; git status empty.

## Tests

Package `test`: 66 files, 1716 passed (1712 + 3 in commit 1 + 1 in commit 2). `typecheck` and `lint` green after commit 1, 2 and 3. No cargo run (no Rust change).

## Concerns

- Task 1 owner step still open (documented). Not verified: Windows, real focus behaviour in WebView2.
- Mutant A used `OR 1 = 1` (SQLite-equivalent to `OR true`).
- The App.tsx comment "only until that session ends" is left as is (code unchanged in the docs commit); docs now say what "ends" means.
