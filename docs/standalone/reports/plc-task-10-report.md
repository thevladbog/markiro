# plc Task 10 report — documents (AGENTS.md and pilot spec section 19)

Status: DONE. Commit `7009153c7` docs(standalone): the floor's pallets in AGENTS.md, pilot spec section 19 (worktree /tmp/claude/wt/flr, BASE bf5bbcc50). Tree clean after the commit. Docs only; no code, no cargo, no Vitest.

## What was done

`apps/standalone/AGENTS.md` (+188/-9):

- «Local database»: paragraph on migration `0008_floor_pallets.sql` (columns, CHECKs, `floor_boxes_pallet`, `floor_pallets_sscc`, `floor_pallets_open`, the unplanned `floor_pallets_shift`, no shift index on `floor_pallet_exceptions`, both tables DeviceData + `RETAINED_TABLES`, additive-only proofs on Node and shell SQLite, pins in `floor-pallet-schema`/`floor-schema`/`local_db.rs`).
- «Floor printing»: purposes line now «`box` prints, and `pallet` in a shift with pallets».
- New «Floor pallets» section (the brief's text plus the true shape of the code): `pallets_missing` stop for `shiftPallets === null`, `pallet_template_not_fit`, `freePalletSscc` / `invalid_serial` (lost serial, spent alone; `settlePallet` retries up to 3, then waits with its message, never a stop; early close = `pallet_failed` + «Повторить»), derived `palletWaitsNow`, pallet block supply by the half rule, rival open pallet = `close_failed`, label order by purpose, exceptions (scan of the whole SSCC or last digits with a list of up to 12, reason then confirmation, queue + track, the two in-transaction comparisons, error classes), disassembly not offered/refused while any label waits (screen-side), `finishClose` always passes `openPalletGuard`, `pendingClose` tied to the pallet label's job id, new-shift form (`palletCapacityOffered` 1..10 000, `palletsOf`, request-id parity), retention, scenario. Followed by «Known limits of the pallets» (see below).
- «Verification»: by-hand pallets bullet (as the brief), before the 2a8 bullet.
- Stale text fixed: the `closeSteps`/`onClosed` «extension points of the pallets' plan» sentence (ПЛ-Ц appends `palletStep` itself); the retention known-limit bullet that said ПЛ-Ц or РК «adds» the outbox/floor_exceptions shift indexes (ПЛ-Ц did not; `floor_pallet_exceptions` is scanned too); the scenario paragraph now says it is a shift with pallets.

`docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (+51): new `## 19. Уточнения плана ПЛ-Ц` appended after §18 (no renumbering; §20+ live on claude/integration). Brief's bullets plus: extra index, lost-serial rule, derived message, scan/digits choice and reason-then-confirm, intention tied to the label job, new-shift limits, fixture hash `70464d38…` vs plan `7057d806…` with the six-id explanation, known limits, and the not-verified list.

Known limits stated honestly (both docs): nothing run on Windows, printers, touch panel, WebView2, real host over LAN (jsdom + node:sqlite + fake HostApi; host only via the scenario router); no shift index on `floor_pallet_exceptions`; ВЦ3 closing intention not kept after a pallet stop; 2 x 10 s host wait for pallet serials inside the work queue when the host hangs; `disassemblePallet` has no own label-waits backstop (screen refuses only); pallet-choice scan flash still says «короб»; several stations/pallet block revocation = stage 2b.

## Gates

- PRETTIER GATE: `node_modules/.bin/prettier --ignore-path .prettierignore --check` from the worktree root with repo-relative paths; proven live with a mis-formatted scratch `apps/standalone/zz-probe.ts` (exit 1, deleted); then both changed files: «All matched files use Prettier code style!».
- `git diff --check` clean. One trailer line verified. `git status --short` empty.

## Anchor adaptations

The real AGENTS.md (246 KB) differs from the plan's anchors:

1. Fragment 1 (`test/floor-print-schema.test.ts` pins its rules. / ## Writes): not present. The 0008 paragraph was inserted by meaning after the 0007 paragraph, before `## Writes` (that paragraph ends «…lists `floor_print_jobs`).»), and is worded with the real details (index list, tests).
2. Fragment 2: the real line wraps as «of each purpose — `box`, `pallet`, `duplicate`; only `box` prints in stage 2a —\nthe COM scanners»; replaced to «`box` prints, and `pallet` in a shift with pallets (plan ПЛ-Ц) — the COM scanners» re-wrapped.
3. Fragment 3: anchor «changes the fixture, and both tests read it.\n\n## Marking rules» matched after I added one sentence to the scenario paragraph; section placed before `## Marking rules` as in the brief; text extended with the built behaviour.
4. Fragment 4: the 2a8 bullet exists; the preceding anchor line differs, so the bullet was inserted directly before the 2a8 bullet. The brief's wording kept.
5. Spec fragment 1 (anchor «2a читают прежние фикстуры без изменений.») does not exist in the file: §19 appended at the end (after §18), Russian, as the brief's text.
6. Additional stale statements fixed (see above); not in the brief.

## Deviations observed in the Task 1-9 reports/reviews (for the controller to write into the plan)

1. T1: `FACT_RECEIPT_CODES` already had the four pallet codes; `shiftSnapshotTemplateSchema` and `officeShiftSchema` pallet fields already existed (fragments skipped); `keepEnteredShift` also needed the `palletsEnabled` flag (beyond the plan). Plan counts (288/2666) differ from measured (375/3557).
2. T2: extra index `floor_pallets_shift`; `id TEXT NOT NULL PRIMARY KEY`; `floor_pallet_exceptions` has no shift index (scan pinned, both engines); several test files not in the brief updated (`floor-schema`, `floor-new-shift`); the Rust test file had three occurrences of the table list.
3. T3: `pallet_boxes` summary subquery rewritten (plan-driven, `floor_pallets_open` + `floor_boxes_pallet` instead of a join that walks the pairing's boxes); SQL texts exported as constants; `floor-work-close.test.tsx` adapted to `OPEN_JOB_READ_SQL`; fix commit `d7a91fb56` for `freePalletSscc` (a held pallet SSCC stopped every box close; same rule as `box-close.ts`).
4. T4: `palletExceptionStatements` lives in `facts.ts` (import cycle); `PALLET_STATE_SQL` replaces `isClosedPallet`; reprint transaction carries two comparisons and a live guard; `PalletTemplateChangedError` subclass; superseded 2a7 test replaced.
5. T5: the real `WorkScreen` has no `labelStep`/`closeSteps` memo (pallet step appended in `attemptClose`); `blockContextOf(live, extension)`; `settleLabel` fragments adapted; extra stop `pallets_missing`; `settlePallet` retries `invalid_serial` up to 3 (`PALLET_SERIAL_TRIES`); fix commit `789986485` (`palletWaitsNow` derived).
6. T6: brief tests adapted (real title «…закрыта на этой станции», `work.press`); `finishClose` single path passing `openPalletGuard` unconditionally; `confirmClose` read-back through `closeFailed`; fix commit `22d65cb09` (`pendingClose` tied to the pallet label job id).
7. T7: reprint printer resolved per purpose (box vs pallet); `nothing` considers closed pallets; confirmation key by action; Task 5 test now uses the real box-disassembly flow. Reviewer's final-wave list still open at this base (M1-M5: exact-SSCC scan test, neutral flash strings, backstop in `disassemblePallet`, R11 reason test, press guard test).
8. T8: `palletCapacityOffered` 1..10 000 and `palletsOf` beyond the brief; `isShiftOfRequest` compares pallet fields; brief test 1 answers `MADE_PALLETS`.
9. T9: fixture sha256 `70464d38…` vs plan `7057d806…` (six exception ids shifted by one, 2a8-adapted old fixture); three extra host tests and `pallet_state()` dump; mutant T4 (closeShift without `openPalletGuard`) survives in the scenario by design.
10. Plan counts everywhere were scratch-copy numbers (e.g. plan 118/2714 vs measured 122/3777 Vitest; cargo workspace 819 passed).

## Concerns

- The docs describe the code at BASE bf5bbcc50. If the final wave adds the `disassemblePallet` label-job backstop or changes the pallet-choice flash strings, the two corresponding «Known limits» bullets in AGENTS.md (and the last bullet of §19) must be removed or reworded.
- AGENTS.md is 246 KB; the stale-text search was by "pallet"/"паллет"/`RETAINED_TABLES`, not a full read.
- Not run: any Vitest/cargo (docs only), `graphify update .`, `pnpm test:production-bundle:contract`.
