# Plan 1d3, Task 3 — schemas, request builders and HostApi methods (`src/host/`)

**Status: DONE**

Commit: `383c1209c feat(standalone): схемы, сборщики тел и HostApi для контрагентов, линий, устройств и кодов`
(branch `claude/autonomous-desktop-station-9e6f13`, on top of `b9f6972c7`).

## What was implemented

- `apps/standalone/src/host/protocol.ts`
  - Lenient response schemas: `counterpartyRecordSchema`, `officeLineSchema` (plain `z.object`), with `CounterpartyRecord`, `OfficeLine`.
  - Strict body schemas (`.strict()`): `counterpartyCreateSchema`, `counterpartyUpdateSchema`, `lineCreateSchema`, `lineUpdateSchema`, `deviceUpdateSchema`, `pairingCodeRequestSchema`, with `CounterpartyCreate`, `CounterpartyUpdate`, `LineCreate`, `LineUpdate`, `DeviceUpdate`, `PairingCodeRequest`.
- `apps/standalone/src/host/requests.ts` (new): one builder per body, each naming every field it sends, never spreading form values.
  - `CompanyInput`, `counterpartyCreate`, `counterpartyUpdate` (both copy the prefix list), `lineCreate`, `LineChange`, `lineUpdate` (sends only `name`/`archived` that differ, always `expectedRev`), `DeviceChange`, `deviceUpdate` (sends only differing fields; a line only for a station; `null` clears it), `pairingCodeRequest`.
- `apps/standalone/src/host/api.ts`: `HostApi` and `createHostApi` gained `updateDevice`, `revokeDevice`, `listCounterparties`, `createCounterparty`, `updateCounterparty`, `listLines`, `createLine`, `updateLine`. `createPairingCode(token, request?)` now takes an optional body: with no `request` the body is `undefined` (the shell sends none).
- `apps/standalone/test/support/office.tsx`: `fakeHostApi` has the 8 new methods, each failing with "unexpected HostApi.… call" unless a test overrides it.
- `apps/standalone/test/protocol.test.ts` (+23 tests) and `apps/standalone/test/api.test.ts` (+9 tests).
- `apps/standalone/AGENTS.md`, «Protocol»: one added sentence on `src/host/requests.ts` builders and the fixture check.

How the edits were applied: a throwaway Node script (in `$TMPDIR`, not in the repo) parsed the brief's fragment/replacement pairs and applied them, asserting that each anchor occurs exactly once in its file at the moment it is applied. All 18 anchors matched (10 in step 1, 7 in step 3 plus the file creation, 1 in step 5), so there was no NEEDS_CONTEXT case and nothing was improvised.

## TDD evidence

Baseline before any change: `test/protocol.test.ts test/api.test.ts` = 2 files, 63 tests, green.

RED (after step 1, before step 3):

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts
exit code: 1
 ❯ test/protocol.test.ts (0 test)
 ❯ test/api.test.ts (0 test)
 FAIL  test/api.test.ts
TypeError: Cannot read properties of undefined (reading 'parse')
 ❯ test/api.test.ts:48:54
     48| const COUNTERPARTY_CREATE = counterpartyCreateSchema.parse(fixture("co…
 FAIL  test/protocol.test.ts
Error: Failed to resolve import "../src/host/requests.js" from "test/protocol.test.ts". Does the file exist?
 Test Files  2 failed (2)
      Tests  no tests
```

This is exactly the failure the brief predicts for both files.

GREEN (after step 3), same command:

```
exit code: 0
 Test Files  2 passed (2)
      Tests  95 passed (95)
```

95 = 71 in `protocol.test.ts` + 24 in `api.test.ts`, as the brief states (+32 over the 63 baseline: 2 response fixtures x 2, 6 request fixtures x 2, 4 exact-builder tests, 3 send-only-what-changes tests, and 9 new `HostApi` route cases).

## Verification (all run from the worktree root; exit codes captured, not piped)

| Command                                                                                                                                                                                | Result                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                            | exit 0 — 30 files, **585** tests passed (brief says 584, see Deviations)                                                 |
| `… @markiro/standalone typecheck`                                                                                                                                                      | exit 0 (`tsc -p tsconfig.json --noEmit`; `tsconfig` includes `src` and `test`, so `fakeHostApi` completeness is covered) |
| `… @markiro/standalone lint`                                                                                                                                                           | exit 0                                                                                                                   |
| `node_modules/.bin/prettier --check` on the 7 changed files                                                                                                                            | exit 0, "All matched files use Prettier code style!"                                                                     |
| `git diff --check` (before staging) and `git diff --cached --check`                                                                                                                    | exit 0 both                                                                                                              |
| `vitest run --reporter=verbose test/protocol.test.ts test/api.test.ts`                                                                                                                 | exit 0, stderr 0 bytes, no `stdout\|`/`stderr\|` console blocks, no warnings                                             |
| `vitest run --reporter=verbose` (whole suite, extra pass because `fakeHostApi` is shared)                                                                                              | exit 0, stderr 0 bytes, 0 console blocks, 0 warning/`act(` lines, 585 passed                                             |
| `grep -nF '\u04'` and `grep -nE '\\u[0-9a-fA-F]{4}'` on the 7 files                                                                                                                    | nothing found (Cyrillic is real UTF-8, not escapes)                                                                      |
| Invisible-character scan (NBSP, soft hyphen, U+2000-200F, U+2028-202F, bidi controls, word joiner, ideographic space, BOM) plus CR, trailing whitespace, final newline, on the 7 files | clean; a positive control file containing an NBSP and a trailing space made the same scanner fail, so it does fire       |
| `git log -1 --format=%B`                                                                                                                                                               | subject, blank line, exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`                               |
| `git status --short` after the commit                                                                                                                                                  | empty                                                                                                                    |

Not run, because not part of this task's checks: cargo (no Rust changes), `build`, browser/Windows/hardware checks. Nothing in this task touches those surfaces; the checks above are automated Vitest, tsc, eslint and prettier only.

## Files changed (7, +459 / -4)

- `apps/standalone/src/host/protocol.ts`
- `apps/standalone/src/host/requests.ts` (new)
- `apps/standalone/src/host/api.ts`
- `apps/standalone/test/protocol.test.ts`
- `apps/standalone/test/api.test.ts`
- `apps/standalone/test/support/office.tsx`
- `apps/standalone/AGENTS.md`

Nothing under `apps/station`, `apps/standalone/host`, `apps/standalone/proto` (fixtures included) or any Rust crate was changed.

## Deviations

None in the code: every edit is byte-for-byte the brief's text.

One difference in an expected number: the full suite reports 585 tests, the brief says 584. The cause is in the baseline, not in this task. The plan's per-task totals are 547 after task 1 and 552 after task 2. The task-1 review-fix commit `1f3caab1f` (made after those counts were taken) added one test to `test/form-dialog.test.tsx`, which now has 12 tests where the plan says 11 (`git show 79071d81e:…` has 11 `it(` calls, `1f3caab1f:…` has 12). So the baseline at HEAD is 553 = 552 + 1, and this task adds exactly 32: 553 + 32 = 585. The two changed files land on exactly the brief's 95.

Not done: `graphify update .` (root `AGENTS.md`), because there is no `graphify-out/` in this fresh worktree, and the rule applies only when a local graph exists.

## Self-review

- Completeness against the brief: all 16 schema/type exports, 9 builder/interface exports and 9 `HostApi` members exist (grep-verified one by one). All 10 fixtures the plan names are parsed by a schema in `protocol.test.ts`; the six request fixtures are also produced exactly (`toStrictEqual`) by their builders, and `device-record.json` / `pairing-code.json` feed the `deviceUpdate` / `pairingCodeRequest` builder tests.
- Cross-checked the new strict schemas against the Rust request types in `apps/standalone/proto/src/lib.rs` (`PairingCodeRequest`, `DeviceUpdate` with the double-optional nullable `lineId`, `CounterpartyCreate`/`Update`, `LineCreate`/`LineUpdate`, and the response records): names, optionality and `deny_unknown_fields` line up.
- No existing test changed beyond the brief. The test diff is additions, plus the single import line in `api.test.ts` that became a longer import; the existing `createPairingCode` case still passes and still asserts `body: undefined`.
- Tests check behaviour: exact fixture output, "only what differs", a station-only line, and no aliasing of the caller's prefix array.
- No `any`, casts or non-null assertions; `import type` used; nothing built beyond the brief.
- Two slips in my own throwaway tooling, neither touched the repo: (1) an unquoted zsh variable was not word-split, so my first prettier/grep run checked nothing (I noticed from the "No files matching" error and re-ran with an explicit array); (2) my first invisible-character scanner had raw invisible code points pasted into its regex, which is the trap the brief warns about. I rewrote it as pure-ASCII `\u` escapes, verified the script itself has no non-ASCII bytes, and added the positive control above.

## Concerns

- Later tasks in the plan quote absolute totals (594, 604, 614, 624; final 624 "was 29 files and 531"). Since the baseline is 1 higher than the plan assumed (the `form-dialog` review-fix test), expect each of those to be 1 higher (595, 605, 615, 625) unless something else drifts. That is not a failure; the controller may want to note it before reviewing those tasks.
- `pairingCodeRequestSchema.replaces` and `deviceUpdateSchema.lineId` are `z.uuid()`, stricter than the host's plain strings. That is what the brief prescribes; callers pass ids from already-parsed responses, so it holds.
- `deviceUpdate` returns `{}` when nothing differs (the host treats that as a no-op). Whether a page should skip the request in that case is a page decision for tasks 5-6, not this wire layer.
