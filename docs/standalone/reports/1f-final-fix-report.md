# Plan 1f (part 1f1) — final fix wave report

Status: DONE. Start HEAD `440187498`; end HEAD `787a4a4c5`. Six commits, each with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (verified by counting the trailer in all six messages). Tree clean after each commit.

## Commits

| #   | SHA       | Subject                                                                                                    |
| --- | --------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 78710b742 | docs(standalone): sign-in comments and docs after the final review (copies ready, lockout ceiling, forget) |
| 2   | ce5ab051e | test(standalone): sign-in guards for the PIN verifier's count and the input patterns                       |
| 3   | 020076c60 | fix(standalone): the reducer stores the operator's four fields, not the action's object                    |
| 4   | 3f0d07720 | fix(standalone): the sign-in screen keeps the office open during a check and its notice dismissed          |
| 5   | 39269d835 | fix(standalone): the wedge source reads Ctrl+] as the group separator and drops shortcuts                  |
| 6   | 787a4a4c5 | test(standalone): widen the idle-touch test's real-time margins to 1 500 ms                                |

## Final gates

- typecheck 0, lint 0.
- Whole package suite: 63 files / 1662 tests passed (baseline 1649 + 13 new: 4 in commit 2, 1 in commit 3, 4 in commit 4, 4 in commit 5; commit 6 adds none). No `act(` or stderr output in any `--reporter=verbose` run of the touched files.
- Delayed-`setImmediate` stand (3 ms) over every touched test file after each commit: green (`floor-sign-in`; `operator-sign-in`+`app`+`floor-operator`; `shell`+`app`+`floor-operator`). Both stand files deleted each time.
- `build` once: ok. Main chunk `dist/assets/index-BnQdPxGH.js` 893.91 kB (gzip 264.68 kB); `bwip-js-gen` 925.37 kB.
- `git diff --stat 440187498 -- apps/station packages apps/standalone/host apps/standalone/proto apps/standalone/src-tauri pnpm-lock.yaml apps/standalone/package.json`: empty.
- `git diff --check` clean; `\u04` grep: only `src/host/pairing-code.ts:66`; prettier --check clean on every changed file (AGENTS.md added lines checked at <= 80 characters).
- Not run: cargo (no Rust touched), `graphify update .` (failed in the sandbox with "Operation not permitted"; `graphify-out/` is ignored anyway).

## Per item

### Commit 1 — docs and comments (#1, #6, M1, M3, #22, #15 residual)

- `copiesReady` docstring (`reference-sync.ts`): now says a run has begun to fill the copies (a page applied, `last_rev` written on every page), that an interrupted first sync reads ready with partial copies, and that sign-in fails closed on missing records. Same wording fixed in `sign-in.ts` (the `not_ready` refusal doc, `FloorReadiness`, `operatorStillAllowed`) and `OperatorSignIn.tsx` doc.
- `DUMMY_PIN_PHC` comment names the cloud's `DUMMY_PHC` (`apps/station/src/lib/auth.ts`).
- M1: sustained ceiling sentence in the `STATION_LOCKOUT` comment (`lockout.ts`), AGENTS «Operators and badges» lockout bullet and spec §5.6 (Russian), with the per-operator 5 per 5 minutes bound and escalation named as an open owner question.
- M3: «a forget resets every lockout counter» in AGENTS «Local database» and spec §5.3 (names the reachable «Переподключить»/«Сбросить» screens and 1f2's way out).
- #22: «the stub shows the name and role as of sign-in» in AGENTS (signed-in operator bullet) and spec §5.6; plan 2a refreshes it with an explicit session counter.
- #15 residual: «what `key` a real wedge scanner produces for GS (Ctrl+] in WebView2) is unverified» in the not-verified clause (AGENTS and spec).
- Deliberately: the old wedge sentence (appends Ctrl-/Alt-modified keys) was left true in commit 1 and rewritten in commit 5 together with the behaviour change, so no commit documents behaviour it does not have.

### Commit 2 — sign-in guard tests (#3, #5; `test/floor-sign-in.test.ts`)

- #3: one test, two hashes written straight into `ref_operators.pin_phc`: 2 000 000 iterations (real digest, so the right PIN would verify) and the real PIN hash with its count written `0100000` (`parsePhc` reads 100 000). Each expects `{refused, wrong}`, `verifyPhc` called once with the dummy, and the failure rows `operator:<id> = 1`, `station = 1`.
- #5: new describe with three tests comparing the sign-in's `LOGIN`/`PIN` (observed through whether `verifyPhc` ran) and `readBadgeScan` against `operatorLoginRule`/`pinRule`/`badgeCodeRule` on shared tables: 2/3/12/13 digits, 257 chars, fullwidth digits, Cyrillic, `\u001d`, `" 0421 "`, `"\t0421"`, badge 1/256/257 chars, empty, spaces, `café`, newline. The only intended differences are the office trimming a number or PIN (the keypad never needs it), named in the table; for badges the trimmed codes must be equal.
- No RED run is possible for guard tests of existing behaviour; the mutant runs below are the RED.

| Mutant (one line, file)                                                                  | Test that failed                                                               | Restore proof                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| `isPinPhc` drops the `<= MAX_PHC_ITERATIONS` cap (`lib/credentials.ts`)                  | does not take a hash the host would not write (`signed_in` instead of `wrong`) | sha 178fe45ad234 before/after, `cmp` 0 |
| `asHostWrites` returns `parsed` (drops canonical-digits rule)                            | same test                                                                      | same                                   |
| cap replaced by `true`                                                                   | same test                                                                      | same                                   |
| `isPinPhc` keeps only the 10 000 floor (cap and canonical both gone, the brief's mutant) | same test                                                                      | same                                   |
| `LOGIN` `{3,12}` -> `{3,13}`                                                             | «verifies exactly…» and the new login parity                                   | sha 3d2c300bb79b, `cmp` 0              |
| `PIN` `{4,6}` -> `{3,6}`                                                                 | «verifies exactly…» and the new PIN parity                                     | same                                   |
| `BADGE_CODE` `{1,256}` -> `{1,255}`                                                      | 3 tests incl. the badge parity                                                 | same                                   |
| `readBadgeScan` without `trim()`                                                         | 5 tests incl. the badge parity                                                 | same                                   |
| `LOGIN` allows surrounding `\s*`                                                         | «verifies exactly…» and the login parity                                       | same                                   |

### Commit 3 — reducer copies four fields (#11; `shell.ts`, `test/shell.test.ts`)

- `operator_signed_in` stores `{ id, login, name, role }` built from `action.operator`, one fresh object per sign-in (the App's session token by object identity is untouched; the App and floor-operator tests stayed green).
- Test: an action whose operator carries `pinPhc` is stored with exactly four keys, `toEqual` the operator, not the same object, and two sign-ins give two different objects. RED before the fix: `expected { …(5) } to deeply equal { …(4) }`.
- Mutants: store `action.operator` itself; store `{ ...action.operator, id, login, name, role }` — both fail that test; sha 462ac067061a before/after, `cmp` 0.

### Commit 4 — sign-in screen (#14, #17, #12, #19)

- #14: «Офис» is no longer `disabled={busy}` (keypad and «Назад» stay held). Test: PIN path, gate held, «Проверяем…» shown, «Назад» and the keypad disabled, «Офис» enabled and pressed (the `onOffice` mock unmounts the screen as the shell does), gate released: `onSignedIn` and `onSync` not called. The two existing tests that asserted «Офис» disabled during a check were updated. RED before the fix (3 failures).
- #17: `noticeDismissed` set by the first attempt (not by step changes). Test: the notice survives going to the number step and back, is gone while the first check runs and after its refusal, and does not return on a step change or the next screen. RED before the fix.
- #12: it.each over «pairing's device» and «station's line»: gate the DB, type 4821, press «Войти», change the prop (for the device case the other pairing is synced first so the PIN step stays up and the readout is observable), release; the readout is `""` and `onSignedIn` is not called. This differs from the brief's «another deviceId» only in adding the line variant and the sync that keeps the step visible (without it the screen shows the not-ready text and no readout, so the clear is unobservable).
- #19: title renamed «documents today's behaviour, owner decision pending: …».
- Also one AGENTS sentence (the office stays enabled during a check; the notice stays until the first attempt).

| Mutant                                                                            | Test that failed                                               | Restore proof                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| «Офис» `disabled={busy}` back                                                     | 3 tests (the two updated + the new leave test)                 | sha ffdcd761fb3f before/after, `cmp` 0 |
| notice condition without `!noticeDismissed`                                       | does not bring the leave notice back…                          | same                                   |
| `setNoticeDismissed(true)` removed                                                | same                                                           | same                                   |
| `setPin("")` moved after the changed-props return (the review's surviving mutant) | both new «empties the typed PIN even when the … changed» tests | same                                   |

### Commit 5 — wedge source (#15; `scan-source.ts`, tests in `test/operator-sign-in.test.tsx`)

- `ctrlKey && !altKey && key === "]"` appends `\u001d`; keys with `ctrlKey` or `metaKey` and no `altKey` are dropped; other single-char keys are appended as before. No separate scan-source test file existed, so the four tests sit in the «keyboard-wedge scan source» describe: Ctrl+] to GS; Ctrl+c, Ctrl+Shift+v, Meta+a and Meta+] dropped; AltGr (Ctrl+Alt) `@` and `]` kept (`]` as a character, not the separator); plain, shifted and Alt-held characters kept. RED before the fix (2 failures).
- AGENTS and spec «not verified» sentences rewritten to the new behaviour.

| Mutant                           | Test that failed                 | Restore proof                          |
| -------------------------------- | -------------------------------- | -------------------------------------- |
| GS mapping disabled (`false &&`) | Ctrl+] reads as GS               | sha 209c04839be0 before/after, `cmp` 0 |
| GS mapping ignores `altKey`      | AltGr test                       | same                                   |
| Ctrl dropped from the drop guard | Ctrl/Meta drop test              | same                                   |
| Meta dropped from the drop guard | Ctrl/Meta drop test              | same                                   |
| drop guard loses `!altKey`       | AltGr test                       | same                                   |
| drop guard also drops Alt-only   | AltGr test and the Alt-held test | same                                   |

### Commit 6 — idle-touch margins (M2; `test/app.test.tsx`)

- Idle timeout 4 000, elapses 2 500 / 2 500 / 1 700: the touch lands 1 500 ms before the first wait would end, the check 1 500 ms before the restarted one would (the final 1 700 only moves toward firing, so real-time drift helps it). Kept plain `shouldAdvanceTime` fake timers (no change to the harness).
- 5 consecutive delayed-`setImmediate` stand runs of the test: 5/5 passed; the whole `app.test.tsx` file passes (82) and the test takes 47 ms.
- Mutant: drop `"touchstart"` from `ACTIVITY_EVENTS` (`idle-lock.ts`): the test fails; sha 322cde30b110 before/after, `cmp` 0.

## Equivalent-mutant claims

None made. Every mutant listed above was killed.

## Decided differently / notes

- #12 test gained the line variant and the other-pairing sync (see above).
- #14: the test models the shell's leave by unmounting from `onOffice`; «the queue is not released» is a property of `sign-in.ts` that this commit does not touch (`oneAtATime` unchanged).
- Commit 5 also edits AGENTS and the spec (named in the brief for docs) because the old text would otherwise describe behaviour that no longer exists.

## For the controller (plan 1f «Перенесено» outline of 1f2; the plan file was not edited)

- M3: the 1f2 way out of the kiosk must know that a forget resets every lockout counter (`clear_copies` empties `floor_sign_in_failures`; a station on the host's PC re-pairs itself); decide whether a per-device maintenance code gets its own row and whether forget clears it.
- #22 with #20: refresh name/role and an explicit session counter together in plan 2a.
- Owner questions that stay open: lockout escalation and the report's other recommendations (section e); stray product scans counted as badge guesses (#7, partly eased now that product codes with GS arrive as GS, but a bare EAN-13 still counts); minimum PIN length 6; the real `key` for GS from a wedge scanner under WebView2.
- Documents to extend in the plan's «Отклонения при исполнении»: the six commits above; the AGENTS sentence about «Офис» during a check and the notice.

## Not verified

Windows/WebView2, a real wedge scanner (what `key` GS produces), PBKDF2 time on a factory PC, cargo suites (no Rust touched), `graphify update` (sandbox refused).
