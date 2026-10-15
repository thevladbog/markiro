# Task 6 of plan 1d3 — «Устройства»: report

Status: DONE_WITH_CONCERNS (one wording mismatch in the brief's final grep, see Concerns; no functional concern).

Commit: `5cd7e6a42 feat(standalone): «Устройства» — правка, отзыв, «Новый код» с replaces и срок кода от хоста`
(13 paths, exactly the brief's list plus the deleted `office-local.tsx`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` appears exactly once, verified with `git log -1 --format=%B`). Nothing pushed, no new branch, no stash.

## What I implemented

Everything in the brief, in its step order, with every code block extracted from the brief by script (`$TMPDIR/t6/apply.py`, exact-once anchor check, no retyping):

- New `src/office/devices/line-label.ts` (`lineLabel`), `DeviceDialog.tsx` (one dialog: name + a station's line; only changed fields via `deviceUpdate`; `"" -> null` mapping for `lineId` as in the brief; only active lines selectable; the station's current line stays listed, «(в архиве)» if archived; host refusal of the line goes under the field) and `RevokeDeviceDialog.tsx` (destructive confirmation naming the device).
- `DevicesPage.tsx` replaced whole: line names from `officeKeys.lines` (`GET /v1/office/lines`), edit/revoke row actions (none on a revoked device), `newCode` with the immediate `requesting` ref flag, `{ replaces }` from the code on screen (no body otherwise), deadline = request time + `codeLifetimeMs(code)`, join detection still by host `createdAt` vs `pairedAt`. Request generation, 3 s poll and DataMatrix unchanged.
- `PairingCodeDialog.tsx`: `CODE_LIFETIME_MS` replaced by exported `codeLifetimeMs`, `useRemainingMs(deadline, lifetime)`.
- Removed the local-copy reader: `office-local.tsx` deleted (`git rm`), `local` prop/provider gone from `Office.tsx`, `local={localDb}` gone from `App.tsx` (`localDb` is still used by `useHostLink` and `LineSelect`), `officeKeys.lineNames` gone from `office-query.ts`.
- `ru.json`: `office.common.archivedName`, `office.devices.table.actions`, edit/revoke/fields/noLine/revoke*/errors.lineRejected keys.
- Docs: `apps/standalone/AGENTS.md` («Office pages») and spec §5.5.
- Test file `test/devices-page.test.tsx` replaced whole (27 tests, 10 more than before).

The form sends the trimmed zod output of `handleSubmit` (`deviceNameRule` trims); no `raw: true` anywhere; the request body is built only by `deviceUpdate` / `pairingCodeRequest`, never from spread form values. The «Изменения сохранены.» test types `" Станция 1 "` and asserts the host receives `"Станция 1"`.

## TDD evidence

RED (after writing only the new test file, implementation untouched):

    pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx
    Test Files  1 failed (1)
         Tests  13 failed | 14 passed (27)

Failures, each the brief's predicted cause:

- `lists the devices, naming lines from the host's list` — `Unable to find an element with the text: Линия 1` (page still reads local copies).
- 8 edit/revoke tests (renames a station…, takes a station off its line with null, offers the active lines…, has no line to choose…, checks the name like the host…, puts a line the host would not take…, revokes a device after a confirmation…, explains a revocation the host refused…) — `Unable to find an accessible element with the role "button" and name "Изменить устройство «…»"` / `"Отозвать устройство «…»"`.
- `counts the lifetime the host gives the code…` — `Unable to find an element with the text: /^Код действует ещё (05:00|04:59)$/` (lifetime still a constant).
- `offers a new code once the code expired…` and `replaces the old code and restarts the countdown…` — `expected [ [ 'office-session-token' ], …(1) ] to strictly equal …` (no `replaces`).
- `asks for one code on a double click…` — `expected "vi.fn()" to be called 2 times, but got 3 times`.

GREEN (same command, after Step 3): `Test Files 1 passed (1)`, `Tests 27 passed (27)`, stderr 0 bytes. Also with `--reporter=verbose`: 27 x ✓, stderr 0 bytes. Plain runs repeated 3 more times: 27/27, stderr empty each time.

## Checks (all before the commit unless noted)

- `pnpm ... --filter @markiro/standalone test`: 32 files / 615 tests (baseline was 32 / 605; the brief's 614 is one low, as you said). Run 3 times in total (once pre-commit, twice more on the committed tree): green, Vitest wrote nothing to stderr (only pnpm's `$ vitest run` banner).
- `typecheck`: exit 0. `lint`: exit 0. `build` (vite): exit 0 (the >500 kB chunk warning is pre-existing: `PairingDataMatrix` and the index chunk).
- `node_modules/.bin/prettier --check` on all 12 changed/created files: each ok.
- `git diff --check` and `git diff --cached --check`: clean.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only the known intentional `src/host/pairing-code.ts:66`. All brief blocks were scanned first: only visible characters (Cyrillic, «», —, …, §, ×, U+2212 minus in `expiresAt − createdAt`); no NBSP/soft hyphen/ZWJ.
- `graphify update .` not run: no `graphify-out/` in this worktree.
- Not run, not applicable: `cargo` (no Rust touched). Not verified: a real Tauri window, a real host round trip for the new dialogs, Windows. Automated DOM tests are not browser confirmation.

## Effect-race stand (delayed `setImmediate`)

Recipe from the memory note «Vitest effect race harness» (found and used as written): a temporary setup file inside the Vite root replacing `globalThis.setImmediate` with `realSetTimeout(cb, N)` (real timeout captured at load, before `vi.useFakeTimers`) and a temporary `vitest.race.config.ts` with `setupFiles: [scratch, "test/setup.ts"]`. Both files deleted afterwards (verified: `git status` clean, no residue).

- 3 ms: 27/27 pass, stderr empty. Repeated 4 times in total, all green (the slowest test needs ~4.1 s of the 5 s default at 3 ms).
- 10 ms, default 5 s test timeout: 4 failures, all consequences of the stand, not a race:
  - `offers a new code once the code expired…` times out at 5000 ms. It advances 10 minutes of fake time (600 one-second ticks), and each tick costs a delayed scheduler `setImmediate`; measured duration scales linearly: about 1.7 s at 0 ms, 4.1 s at 3 ms, 9.3 s at 10 ms (0.36 s without the stand). The old test had the same 10-minute advance (`CODE_LIFETIME_MS`), so this is inherited.
  - The next three tests (`asks for one code on a double click…`, `warns when the host has no address…`, `reads the list every 3 s…`) fail with `Unable to find role="link" and name "Устройства"` on an empty `<body><div /></body>`: the abandoned body of the timed-out test clobbers them (the memory note's «cascade of empty `<div />`» artifact).
- 10 ms with `--testTimeout=60000` on the stand's command line (not in the test): 27/27 pass, stderr empty, 3 runs. So none of the brief's tests is racy; I added no sleeps and changed no test.

## Files changed

Created: `apps/standalone/src/office/devices/{line-label.ts,DeviceDialog.tsx,RevokeDeviceDialog.tsx}`.
Modified: `apps/standalone/src/office/devices/{DevicesPage.tsx,PairingCodeDialog.tsx}`, `apps/standalone/src/office/{office-query.ts,Office.tsx}`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/devices-page.test.tsx`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.
Deleted: `apps/standalone/src/office/office-local.tsx`.

## Self-review findings

- Completeness: every step and fragment of the brief applied (14/14 anchors matched exactly once on HEAD; the whole-file blocks compare byte-identical to the brief), the deleted file has no remaining references, the two docs updated.
- Quality/discipline: nothing beyond the brief; no files beyond its list; nothing grew past the brief's intent (line-label 19 lines, DeviceDialog 126, RevokeDeviceDialog 49, DevicesPage 283, PairingCodeDialog 166), so no splitting was needed.
- Testing: the tests check behaviour (the exact bodies the host receives, the list re-read after a revoke, one request on a double click, the countdown from the host's lifetime); output pristine (stderr empty).
- Checked against the host: a rename by whitespace only leaves the form dirty but the trimmed value unchanged, so `deviceUpdate` gives `{}` and the dialog sends an empty update. The host's `update_device` treats that as a no-op (returns the current device, no revision, no audit row), so the user simply sees «Изменения сохранены.». Benign; not changed.

## Concerns

1. The brief's final grep, `grep -rn "useOfficeLocal\|lineNames\|CODE_LIFETIME_MS" apps/standalone/src apps/standalone/test`, cannot come out empty: it hits `apps/standalone/test/app.test.tsx:678, 687, 691`, a test-local `const lineNames = () => …` that reads `ref_lines` from the local test DB in the «keeps the local copies in step with the host» test. It predates this task, is unrelated to `officeKeys.lineNames`, and `app.test.tsx` is outside the brief's file list, so I left it. The grep narrowed to the removed symbols (`useOfficeLocal|officeKeys\.lineNames|line-names|CODE_LIFETIME_MS|OfficeLocalProvider|office-local`) finds nothing in `src` and `test`. If you want the literal grep empty, renaming that helper is a one-line follow-up.
2. Informational: the 10-minute fake-time test is the slowest under a slowed scheduler (see the stand results); unchanged in shape from the old test.
