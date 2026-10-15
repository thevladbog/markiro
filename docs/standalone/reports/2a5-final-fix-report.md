# Plan 2a5 — report of the fix wave

## Final wave

Branch `claude/2a5-floor` (worktree `/tmp/claude/wt/2a5-floor`), from `afe157e28`. Five commits, each with the single pinned trailer; `git status --short` is empty after the last one.

| #   | Commit           | What                                                                                                                                                                                                |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `681313933` test | item 11: certificate exception, `local` and plain failures, a refusal cleared by the next attempt                                                                                                   |
| 2   | `c8341ad7e` test | items 15, 18, 21, 22 (flipped + status-bar case), 25                                                                                                                                                |
| 3   | `3a4391c2d` fix  | `FloorApp` leave upgrade (15), `useState(createWorkGate)` (16), `FloorStatusBar` offline while `refusalHeld` (22), `App` count kept to its screen (21), `OperatorSignIn` `role="presentation"` (25) |
| 4   | `a70e9731e` test | items 23, 24, N5: wait for the read/write the negative assertion is about                                                                                                                           |
| 5   | `baceddf49` docs | I-1, N1, N4, N6 (in text only), N8, the item-15 and item-22 sentences; spec §18; plan «Перенесено» and «Отклонения при исполнении»                                                                  |

Note on the commit text: commit 2's body says "Five of the tests below fail on the tree they are committed on"; six do (15 twice, 22 twice, 21, 25: RED output in `/tmp/claude/fix-2a5-final/c2-red.txt`). The history was not rewritten.

### RED evidence

- Commit 1 passes on today's code by design; its evidence is the mutants below (R7, R8, R9, R14, R22).
- Commit 2 on the tree of commit 2 (before commit 3): `Test Files 4 failed (4), Tests 6 failed | 259 passed (265)`. Failing: the two office-close-after-leave tests, the status-bar link test, the flipped `app.test.tsx` «На связи» expectation, the App count test («не отправлено на хост записей смен: 2» still on the other-host screen), the sign-in region test (`role="alert"` found in the polite region). GREEN after commit 3: 6 files, 400 tests.

### Mutants (each: restored byte-identical, `shasum` before == after and `cmp` against the pre-mutation copy in `/tmp/claude/fix-2a5-final/orig-*`; outputs in `mut-*.txt`)

| Mutant (one line)                                                               | Test that failed                                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R14 `enterShift`: transport `certificate_mismatch` no longer returns `rejected` | floor-shift-list: «hands another host's certificate… at once» and the direct `enterShift` one                                                    |
| R22 non-`HostError` falls back to `storedWork`                                  | «calls a failure that is no answer of the host a plain failure…»                                                                                 |
| R7 failed keep gives `failed` not `local`                                       | «says the computer could not keep it when the write fails»                                                                                       |
| R8 read-back not `ready` gives `failed`                                         | «…snapshot is not there to read back» and «…cannot read back»                                                                                    |
| R9 drop `setRefusal(null)` at an attempt                                        | «takes the previous refusal off the screen…»                                                                                                     |
| M15a drop the `line_changed` half of the upgrade                                | «…after the move to another line began to wait»                                                                                                  |
| M15b drop the `list`-without-notice half                                        | «…after the operator asked to leave it»                                                                                                          |
| M15c let the close replace a waiting sign-out                                   | «keeps a sign-out that waits as it is…»                                                                                                          |
| M15e drop the sign-out-outranks branch                                          | 3 existing sign-out tests                                                                                                                        |
| M15d drop `reason.notice !== null`                                              | SURVIVES: equivalent (a plain leave replacing a line change or a notice-less plain leave finishes the same way); kept as the statement of intent |
| M16 `const gate = createWorkGate()` (a new gate per render)                     | 17 tests (the semantic `useState` vs `useMemo` guarantee itself cannot be failed by a test, as the report said)                                  |
| M18 drop the `standing` guard                                                   | 7 tests incl. «finishes one leave for two presses»                                                                                               |
| M22a pass `link` unchanged to `HostStatusLine`                                  | floor-status-bar link test + the app test                                                                                                        |
| M22b `state: "connecting"` instead of `"offline"`                               | both                                                                                                                                             |
| M21a show the count on any screen                                               | App «does not carry the count of one screen…»                                                                                                    |
| M21b store the count with a constant kind                                       | 2 existing forget tests (config-error, other-host)                                                                                               |
| M25a / M25b drop `role="presentation"` (message / notice)                       | the sign-in region test (each half)                                                                                                              |
| M23 `readShiftCopy` ignores the device                                          | «names no shift of a pairing other than its own»                                                                                                 |
| M24 list focus effect depends on `[copies]`                                     | the reworked focus test (the old one also failed it on this machine)                                                                             |
| N5a / N5b drop the `alive` guard in `make` / `open`                             | the two reworked unmount tests                                                                                                                   |

### Checks

- Changed React test files verbose (`--reporter=verbose`) and under the delayed-`setImmediate` stand (temp files removed after each run): floor-shift-list alone (46), then `floor-app, floor-status-bar, app, operator-sign-in, floor-shift-list` (311), then `floor-status-bar, floor-shift-list, floor-new-shift` (153): all passed, stderr 0 bytes in both modes.
- typecheck, lint, `build`: clean (last typecheck/lint after commit 4; commit 5 is documents only). `prettier --check` (the repo binary), `git diff --check`: clean. `\u04` grep: only `pairing-code.ts:66`.
- Whole package once: `vitest run --testTimeout=60000 --hookTimeout=60000`: 87 files, 2533 tests passed (the review's baseline was 2518). No 5 s timeout was hit because the run used the large limits throughout; the earlier default-limit runs of the focused files were clean.
- Not run: Rust (no Rust or migration change), browser/Windows/hardware.

## Decisions and deviations

- N6: the shell uses `sqlx::migrate!`, which stores a checksum of each migration file in the database and refuses a changed one. Per the dispatch rule, `0006` was NOT edited; the correction («no retention at all» is out of date after 2a8's `RETAINED_TABLES`) is in AGENTS.md («Local database») and spec §18.
- N4: the plan lives in the worktree, so «Перенесено» (now names `host_probed` with `other_host`, and the 2a6 gate task) and «Отклонения при исполнении» (the review's draft plus the final wave) were edited there.
- Item 21: instead of storing the kind and clearing it with an effect, the count is stored with the screen it was asked on (`view.kind` captured in `forget`) and shown only on that screen; no effect and no render-time reset, so a stale count cannot be shown on another kind, and the same kind coming back without a forget is practically unreachable (rejections persist until `forgotten`).
- N5: a call made after the screen is gone is legitimate (the host's shift is kept, then the `alive` check drops the hand-over), so the unmount tests assert that the keep ran (`calls` grew) and that `enter`/`onEntered` did not, after a `quiet()` that waits until every call answered and nothing new was asked.
- Item 22: while `refusalHeld`, `HostStatusLine` gets the link as `offline`; with a `lastContactAt` it reads «Нет связи с хостом с HH:MM», the sync-failure line disappears (it shows only while online).
- Not done, by instruction: N7 dropped; minors 1, 2, 3, 5, 26, 27 and N3 carried to 2a6.
