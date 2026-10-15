# 1d4 gate flake — the countdown tolerance in devices-page tests (report)

Status: **DONE** (with the concerns listed at the end).
Commit: `34babfeedef5bbf14311f74afeda6ac2f3949e43` (parent `89f99cba7`), branch
`claude/autonomous-desktop-station-9e6f13`. One file, `apps/standalone/test/devices-page.test.tsx`
(+45 / −10). No production code, no other file. `git status --short` is empty after the commit.

## What changed

- Added `COUNTDOWN = /^Код действует ещё (\d{2}):(\d{2})$/` and
  `expectCountdownFrom(scope, since, lifetimeMs = LIFETIME_MS)` after `optionLabels` (lines 122–144).
  It waits with `findByText(COUNTDOWN)`, reads the shown minutes and seconds, and asserts
  `left <= lifetime/1000` and `left >= lifetime/1000 - ceil((Date.now() - since)/1000)`.
  Doc comment is the brief's (English, same meaning; only «in `scope`» added).
- The five positive sites now call it (six test cases, the `it.each` runs twice):

  | line | test                                                            | scope             | since                                                | lifetime        |
  | ---- | --------------------------------------------------------------- | ----------------- | ---------------------------------------------------- | --------------- |
  | 392  | shows a new code with its DataMatrix…                           | `within(pairing)` | before the click on «Подключить устройство»          | default         |
  | 417  | `it.each` «shows a fresh 10:00 countdown…» (ahead / behind)     | `within(pairing)` | same                                                 | default         |
  | 436  | counts the lifetime the host gives the code… (fake timers)      | `screen`          | same                                                 | `5 * 60 * 1000` |
  | 458  | offers a new code once the code expired… (fake timers)          | `screen`          | same (first click)                                   | default         |
  | 744  | replaces the old code and restarts the countdown… (fake timers) | `within(pairing)` | before the click on «Новый код» (the SECOND request) | default         |

- The negative assertion (`queryByText(/…(10:00|09:59)$/)).toBeNull()`, now line 727, was 695) and every
  other assertion, title and comment are untouched; the `it.each` title stays (the countdown still
  starts from a full lifetime).
- Two small adaptations to the brief, both deliberate:
  1. `scope` is typed `Pick<typeof screen, "findByText">`, not `ReturnType<typeof within>`. The latter
     COMPILES but resolves to `any` in this repo (probe with `type IsAny<T> = 0 extends 1 & T ? true : false`:
     `IsAny<ReturnType<typeof within>>` and `IsAny<…["findByText"]>` both accepted `true`; the same probe on
     the `Pick` type is rejected, i.e. it is really typed). The repo rule is «no `any`», and an `any` scope
     would also type `.textContent` as `any`. `Pick<typeof screen, "findByText">` accepts both `screen` and
     `within(...)` (typecheck passes at all five sites).
  2. The role query of the button runs BEFORE the clock read: `const add = screen.getByRole(...);
const askedAt = Date.now(); fireEvent.click(add);` so the slow `getByRole` over the office DOM is not
     counted in the tolerance and `since` is really «right before the click» (`requestedAt` is taken
     synchronously inside the click handler).
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test` → only the allowed
  `src/host/pairing-code.ts:66`. `git diff --check` clean.

## Proof 1 — probe (stall of 2500 ms before the countdown check)

Original file (`git show HEAD:…` → `apps/standalone/test/zz-scratch-stall.test.tsx`, line
`await new Promise((r) => setTimeout(r, 2500));` inserted before the countdown assertion of
«shows a new code with its DataMatrix…»; diff against the original is exactly that one line):

```
DEBUG_PRINT_LIMIT=400000 pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec \
  vitest run test/zz-scratch-stall.test.tsx -t "shows a new code with its DataMatrix" --reporter=verbose
exit=1
 × … > shows a new code with its DataMatrix, the code, the fingerprint and the host's addresses 2777ms
   → Unable to find an element with the text: /^Код действует ещё (10:00|09:59)$/. This could be because the text is broken up by multiple elements. …
      <p class="office-note">
        Код действует ещё 09:58
      </p>
 Test Files  1 failed (1) / Tests  1 failed | 28 skipped (29)
```

Fixed file + the same stall (before the helper call), two variants, each a scratch copy deleted afterwards:

```
variant A (stall before line 392, the DataMatrix test): exit=0
 ✓ … > shows a new code with its DataMatrix, the code, the fingerprint and the host's addresses 2784ms
 Tests  1 passed | 28 skipped (29)
variant B (stall before line 417, the it.each): exit=0
 ✓ … > shows a fresh 10:00 countdown even when the host clock is an hour ahead of this PC's 2790ms
 ✓ … > shows a fresh 10:00 countdown even when the host clock is an hour behind this PC's 2692ms
 Tests  2 passed | 27 skipped (29)
```

(In both variants stderr carries React's «An update to PairingCodeDialog inside a test was not wrapped in
act(...)»: an artefact of the probe's raw 2.5 s sleep outside `act` while the dialog's real 1 s interval
ticks — not of the committed file, whose stderr is empty.) Scratch file deleted.

## Proof 2 — mutants on production code (fixed tests, `vitest run test/devices-page.test.tsx --reporter=verbose`)

Every mutant was applied with an exact-one-match replacement, the original was kept as a byte copy,
restored with `cp`, then `shasum -a 256` and `cmp` against the copy (and `git status` clean of src).

| mutant | file:line → change                                                                 | result                     | failing tests (messages)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | `DevicesPage.tsx:121` `requestedAt + codeLifetimeMs(code)` → `… - 30_000`          | **6 failed**, 23 passed    | all five positive sites: DataMatrix test, both `it.each` cases, 5-minute test, «offers a new code once the code expired», «replaces the old code and restarts the countdown». Messages: five × `expected 570 to be greater than or equal to 599`, the 5-minute one `expected 270 to be greater than or equal to 299`                                                                                                                                                                                                                                                              |
| M2     | same line → `deadline: Date.parse(code.expiresAt)`                                 | **3 failed**, 26 passed    | (1) DataMatrix test (`pairingCode(30)`): `expected 570 to be greater than or equal to 599`; (2) `it.each` «behind»: code reads as expired, `Unable to find an element with the text: 7K3MQ 9XV2D`; (3) 5-minute test (fixed 2026-09-28 timestamps are in the past): no countdown, `Unable to find an element with the text: /^Код действует ещё (\d{2}):(\d{2})$/`. Not failing: `it.each` «ahead» (the clamp `Math.min(deadline - now, lifetime)` caps 4200 s at 600 s), «offers a new code…» and «replaces the old code…» (`pairingCode(0)`: host clock equals this PC's there) |
| M3     | `PairingCodeDialog.tsx:59` `Math.min(deadline - now, lifetime)` → `deadline - now` | **none fails** (29 passed) | finding, stated plainly: nothing in `devices-page.test.tsx` pins the clamp — neither before nor after this change. Also none under the delayed-`setImmediate` stand (extra run)                                                                                                                                                                                                                                                                                                                                                                                                   |

sha256 (before = after for every mutant; each `cmp` printed «identical»):

- `apps/standalone/src/office/devices/DevicesPage.tsx`
  `461138098daeaf8377d9584ec71821ff59b8ebb9f65e58514efed20c82529a76` (M1 and M2)
- `apps/standalone/src/office/devices/PairingCodeDialog.tsx`
  `57476e12f166aab77965e8f8e76c7f288d015f50b62f0a1cb3789fd7413f6efa` (M3, plain and under the stand)

## Proof 3 — runs and static checks

Normal (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run
test/devices-page.test.tsx --reporter=verbose`): exit 0, **29 passed (29)**, stderr empty (0 bytes),
8.58 s (final re-run after the commit: 29/29, stderr empty, 6.44 s).

Delayed-`setImmediate` 3 ms stand (recipe of the 1d4 plan, lines 151–170: `test/delayed-immediate.setup.ts` +
`vitest.delay.config.ts`, both created inside the package and deleted right after; `--config
vitest.delay.config.ts`): exit 0, **29 passed (29)**, stderr empty, 13.74 s. The stand is active: the
fake-timer tests are several times slower (2336 / 4457 / 1045 ms against 356 / 504 / 368 ms).

Extra (not required):

- HEAD's ORIGINAL file under the same stand: 29/29, stderr empty, the same durations
  (2239 / 4336 / 1041 ms) — the change adds no time.
- Fixed file under real CPU saturation (24 busy loops on 12 cores, three runs in a row): all three exit 0,
  29 passed, stderr empty, 17.98 / 18.21 / 19.63 s (about 2.5× the idle duration).

Static checks (all exit 0): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`,
`… lint` (whole package), `pnpm --config.verifyDepsBeforeRun=false exec prettier --check
apps/standalone/test/devices-page.test.tsx` («All matched files use Prettier code style!»), `git diff --check`.
Not run, as instructed: the full suite, cargo.

Commit message check (`git log -1 --format=%B`): Russian subject as in the brief, a 4-line body, and exactly one
trailer line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (count = 1; the branch history uses the
same trailer on 30 of 30 recent commits).

## Concerns / notes

1. **M3 survives** (see above): the `Math.min(…, lifetime)` clamp in `useRemainingMs` is not covered by any test in
   this file, and was not before. Not part of this fix; a test would need a frame with a stale `now` after a new
   `deadline` (the regenerate flow) to observe «10:01».
2. Under the artificial stand the test «offers a new code once the code expired…» takes about 4.4 s of the 5 s
   default test timeout — the same on HEAD (4.3 s). Pre-existing and stand-only; noted, not changed.
3. My load experiment: I started 24 shell busy loops in one command; the command hit the 10-minute limit
   because its final `wait` blocked and was moved to the background, so I stopped it with TaskStop. The sandbox
   forbids `ps`/`pgrep`, so I could not list processes; the 1-minute load average then fell 133 → 91 → 50 → 31 →
   21 → 15 → 8, which is impossible if any of the 24 loops still ran. If the machine still feels busy, look for
   stray `zsh` busy-loop processes (none expected).
4. The `it.each` runs the helper twice; each `since` is per test case (no shared state).
