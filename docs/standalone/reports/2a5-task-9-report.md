# Plan 2a5, Task 9 report (documents)

Status: DONE_WITH_CONCERNS (concerns below). Commit: `afe157e28` on `claude/2a5-floor` (base 41bb37f54):
`docs(standalone): the station's shifts, its production tables, the operator's session and what waits for the shift's work`.
Trailer: exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Only the two named files changed.

## What was done

Documents only; no source change, no Vitest/cargo run (the brief does not require them).

`apps/standalone/AGENTS.md` (+277/-43 lines):

- Local database: forget screens with the unsent count and «Сбросить всё равно» (`countUnsentRecords`, `keepUnsent: true`); a held refusal never replaces a work screen; classes now 19 tables (11 `Disposable`, 8 `DeviceData`, `Workstation` empty until 2a7); the stale "No outbox exists yet" sentence replaced; the "Two windows stay by design" paragraph rewritten to what 2a5 delivered (confirm control done, sender is 2a6's, other host not yet behind the gate); new paragraph "This device's own records" (0006 tables, pairing keys, rules, four read indexes, query plans pinned twice on SQLite 3.46 and node:sqlite 3.53).
- Operators and badges: `sessionId` / `lastSessionId`, `operator_signed_out` compares the number, `operator_refreshed`; the stale "stage 1 shows a stub" text replaced.
- Reference sync: `notQuarantinedNewer` on `org_profile` and `lines`.
- Connection / hardware: "nothing calls it before 2a5-2a7" corrected; device/line paragraph: "plan 2a's decision" replaced by the wait (В9).
- App shell: `floor_operator` is `FloorApp`; shift reading in `useHostLink` (`shifts_read`, `shiftReads`, `deviceNotSaved`); status bar (device name, shift number, two warnings in a polite region, `refusalHeld`).
- Shifts: new "The station's side (plan 2a5)" in five paragraphs: list/entry/copies; the `entered` gate; new shift and the requestId rule; leave/gate/pending refusal and line; `WorkScreenProps` obligations and the 2a6 carries.
- Verification: the manual list of the floor (brief's text, plus an explicit "only jsdom" sentence) and the sentence about the "station's side is plan 2a5" brought up to date.

`docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (+108): new section `## 18. Уточнения плана 2a5` at the end of the file.

## Deviations from the brief's text, and why (Step 2: reconciled with the code, text changed, not code)

The brief's anchors were written against an older AGENTS.md; integration (2a3, 2a4) had already rewritten the same paragraphs, so every fragment was adapted by hand to the current text (script with exact-once anchors; each matched once):

- Fragment 2 (no foreign keys) was already true in the file (2a4 added `no_table_has_a_foreign_key`); skipped.
- Fragment 9 ("The device's own name is not in it") was already stale after 2a4; rewritten.
- Fragment 10's anchor ("revoking blocks ... plan 2b.") now sits mid-paragraph; the station's side was added at the end of the Shifts section instead.
- The brief says `FloorOperatorScreen` is replaced; it is gone from `src`, `test`, `AGENTS.md` (grep of `apps/standalone` source files clean).
- Where the brief said plan 2a5 "sender", "forget screen with no open shift and writer stopped": corrected to the real state (sender is plan 2a6's; condition one holds for a refusal since 2a5; other host not yet).
- "A block's cursor ... moves only by a compare-and-set" softened: the schema keeps it within the block; the CAS is plan 2a6's writer.

## Mandatory addendum (minors) as documented, each checked against the code at HEAD

- Item 20 deviations: the `entered` gate (`FloorApp.tsx` `entered`: copy not `active` or `localState !== null` gives the list, no `work_entered`; notice only for an office close); a sign-out outranks a waiting leave (`leave`: `reason.kind === "sign_out"` replaces `standing`); a leave for another line ends on the list when the move was undone (`finish` + reducer `device_refreshed` same line clears `pendingDevice`).
- `refusalHeld` (App passes `state.pendingRejection !== null`; `FloorStatusBar` polite region, `role="presentation"`); the fact that `HostStatusLine` still says online beside it is stated as open (minor 22).
- requestId rule: one id per chosen product (`choose` mints), form frozen once `created` is set, `isShiftOfRequest` compares productId/boxTemplateId/productionDate/boxCapacity/plannedQty, mismatch gives the `existing` notice and the button opens that shift; not persisted across a restart.
- Forget with unsent records: confirmation, nothing deleted, records stay on disk, cannot be sent (matches `shell.unsent.*` texts).
- `WorkScreenProps` obligations as in the type's JSDoc (track before start; no scan while leaving; bounded tracked work 35 s / 5 s / 300 ms; `aria-disabled` focus rule).
- Carried to 2a6: minors 26 (`other_host` without the gate; the gate has `drain`, not `idle()`), 27 (`countUnsentRecords` text vs the Node plan list). Also written in the spec as "to add to plan 2a6's contract": minors 1, 2, 3 (three outbox counts, `+host_id` unary plus on the receipt UPDATE, SSCC pre-check). Minor 4 (spec §5.3 versus `0006`), 5 (two plan lists) and 6 (`readStoredWork` answers `ready` for closed copies) are in the spec section; 5 also in AGENTS.

## Spec section number: collision

The brief names §17 for 2a5, but on this branch §16 (2a3) and §17 (2a4) are already taken (`## 17. Уточнения плана 2a4` is the last section). Two `## 17.` headings would be a defect, so I used the next free number here, **§18**. Brief Step 2 itself says "next free". Known cross-branch collision: the 2a6 plan uses §18, 2a2 uses §19, 2a8 uses §20 on other branches. §18 therefore collides with the 2a6 plan's §18 on merge; the integrator must renumber (suggest 2a2 = §?, in merge order). No text in the repo refers to "§18" of this spec, so renumbering is only the heading.

## Checks

- `node_modules/.bin/prettier --check` on both files: clean (all anchors in the brief that prettier would reformat were not needed; the new text was written as plain markdown).
- `git diff --check`: clean. `\u04` grep: 0 in both documents, and in `src`/`test` only `src/host/pairing-code.ts:66`.
- `git status --short` after the commit: empty. No scratch files in the tree (script lives in `/tmp/claude/t9`).
- Not run: Vitest, cargo, typecheck (documents only). Not verified by any run: WebView2, scanners, Windows, a real host.

## Concerns

1. Statements that the plan's FINAL WAVE may invalidate (written as true of HEAD = Task 8, update after the wave): minor 15 (an office close is dropped while a leave waits, AGENTS says so), minor 22 (the status bar's link line still says online beside the held-refusal warning, marked "open"), minor 21 (not mentioned), minor 16 (not mentioned). The "Two windows" paragraph says `other_host` is not behind the gate; true until 2a6.
2. Section number: see above; renumber at integration.
3. The sentence "the line finishes its box" (from the brief) is a design statement for 2a6, not behaviour of the stub; the same for "the refusal waits for the operator" which is real code.
