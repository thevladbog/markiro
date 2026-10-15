# Plan ПЛ-Х, Task 7 report (process log with pallets, pilot spec refinements, full check)

Status: DONE_WITH_CONCERNS (concerns: measured test counts differ from the plan's; one pre-existing load-induced Vitest timeout; the unverifiable cloud sentence was left out of the spec).

Commit: `b8cef1e25` test(standalone): the process log holds no pallet SSCC or pallet layout; the pilot spec takes plan ПЛ-Х's refinements
(base `2d320ca02` = Task 6; one `Co-Authored-By: Claude Opus 5.5` trailer, verified with `git log -1 --format=%B`; tree clean after the commit.)

Files: `apps/standalone/host/tests/no_secrets_in_logs.rs`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` (new section 18). No production code changed; manifests, lockfile, `Cargo.*`, `apps/station`, `packages/*` untouched (`git diff --stat 1095d4af4..HEAD` on those: empty; host migrations in the whole plan: only `0012_pallets.sql`). Every plan commit has exactly one trailer.

## Anchor adaptations (the test file had drifted a lot from the brief's fragments; applied by meaning)

The brief's fragments (single scan/box scenario, `let box_id = ...`, a loop `for records in [...]`) do not exist at HEAD: the pass is the 2a2 one (a large `facts` vec with an `expected` receipt table, `rid(n)` ids, helpers `record`, `box_closed_data`, `send_facts`, `assert_receipt`, `needles`). Adapted, with no semantic change to the brief's intent:

1. Pallet template (`purpose: pallet`, layout marker `layout-marker-pallet`) created before the first shift; the first shift is planned with `palletsEnabled: true` and `palletTemplateId` (as the brief).
2. A pallet block (extension 1, request id `5e4d3c2b-...` as the brief) after the box block. The brief's fixed SSCC strings are replaced by `support::app::pallet_sscc(serial)` of the block's real `fromSerial` (the wizard counter here starts at 0, so the block does not start at 40), and a second SSCC (`serial + 1`, another check digit) for the refused close.
3. `rid(14)` (the accepted box close) now names `palletId` (the box on a pallet); new helper `pallet_closed_data`.
4. Four records appended at the END of the `facts` vec (so no existing receipt index moves): `rid(60)` `pallet_closed` (accepted), `rid(61)` `pallet_label` verified (accepted), `rid(62)` `pallet_exception` reprint with reason `other` and words `reason-marker-pallet-reprint` (accepted; added beyond the brief so that the pass really sends "every kind of fact" and the pallet words are needles), `rid(63)` `pallet_closed` under the other SSCC (rejected `pallet_already_closed`). `expected` got the four rows.
5. After the pass: `kept_pallet_ssccs` (`SELECT sscc FROM pallets`) equals the one closed SSCC; `kept_pallet_words` equals the reprint words; the snapshot assertion for `layout-marker-pallet`; the layout list gets `layout-marker-pallet`; `pallet_already_closed` is in the receipt codes the log must name; `63` is in the refused records whose ids the log must name; both pallet SSCCs (whole and first 17 digits) and the pallet words are needles.
6. `unknown_kind["kind"] = "pallet_closed"` was changed to `"pallet_dispatched"`: `pallet_closed` is a real kind now, and the record's point is an UNKNOWN kind. Receipt unchanged (`invalid_record`). This edit has no mutant: with either kind the record is refused the same (its data is a scan's), so it restores the intent, it does not add coverage.
7. Brief step 8's `facts_files` count: already 17 at HEAD (Task 5); nothing to do. The second test (`the_host_prints_nothing_and_the_facts_path_logs_only_its_three_audited_lines`) passes unchanged.

## Documents (all statements checked against the code at HEAD)

`apps/standalone/AGENTS.md`:

- Facts, pallet paragraph: the ragged ~92-char line (minors item 6, was ~2410) re-wrapped to <= 78 columns.
- New paragraph after it: `openedAt`/`closedAt`/`boxCount` stored as sent (`box_count_reported` only to compare with the derived count; consumers derive contents from box memberships); item 8 as a known property (a box whose `closedAt` is after its pallet's `closedAt` joins silently; the office reports (О-Х), ЧЗ export and О-Ф forms must flag it; verified: `box_closed.rs` never compares the two instants); replay of an identical close of an already closed pallet accepted and writes nothing even after its block is revoked (verified: `pallet_closed.rs` returns before `blocks::issued`, and `a_pallet_close_comes_again_...` revokes the block), while a new close against a revoked block is `sscc_not_issued` (verified by `a_pallet_sscc_lies_in_a_live_pallet_block_...`); `pallet_exception` names its kind in `exception`, not `kind`.
- Protocol: item 4 operational rule (every station of the pilot runs protocol 3, installed together with the host; the host does not look at a station's protocol at shift entry, it records it at pairing only: verified, `ClientProtocol` is read only in `routes/pairing.rs`; the installer check is owed to plan УСТ and is not done).
- Logs: the layout walk now includes a pallet template's layout; the facts pass sentence names the pallet facts and the refused second close.
- Minors item 5 (snapshot size) deliberately NOT touched, as instructed: the three sentences "256 KB / 320 KB" are left for the final wave.

`docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: new section `## 18. Уточнения плана ПЛ-Х` (17 was the last free number; no other "Уточнения" section existed). The brief's text, plus: "what is stored as sent", the late-box known property (item 8), replay-after-revoked-block, the protocol-3 operational rule with the manual installer check owed to УСТ and an explicit "nothing was verified on a real station or Windows". Deliberate corrections of the brief's text:

- "the older fixtures were unchanged" is false at HEAD: the plan changed `hello.json`, `hello-future.json`, `error-with-details.json`, `fact-receipt-codes.json`, `office-shift.json` (two new required totals) and added `sscc-serials.json`; the section now says exactly that, and that the older fixtures of the shift-create, entry and facts-request forms stand.
- The brief's sentence "the cloud also reconciles pallets only by boxes" was left out: I could not verify it cheaply against `apps/api` and the rule is not to overclaim.

## Evidence

RED/GREEN: no RED run (the brief says the test passes at once: the pallet modules call `tracing` never; the refusal is logged by `facts::receive`). GREEN: `cargo test -p markiro-host --test no_secrets_in_logs`: 2 passed (run unsandboxed). The new receipts are asserted exactly in the `expected` table.

### Mutants (production and test lines this task relies on; each restored byte-identically, `cmp` silent and sha256 equal, copies under `/tmp/claude/impl-plh-t7/*.bak`)

| #   | Mutant (one line)                                                                                                        | Result of `secrets_never_reach_the_process_log`                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `pallet_closed.rs`: add `tracing::info!(sscc = %closed.sscc, "pallet closed")` before `blocks::consume` (the brief's M1) | FAIL: `the process log contains "146006820000000003"`                                                                          |
| M2  | `pallet_exception.rs`: add `tracing::info!(words = ?reason_text, "pallet exception")` after `check`                      | FAIL: `the process log contains "Этикетка паллеты смята, reason-marker-pallet-reprint"`                                        |
| M3  | `pallet_closed.rs`: add `tracing::warn!(refused = %closed.sscc, "x")` before the `PALLET_ALREADY_CLOSED` refusal         | FAIL: `the process log contains "146006820000000010"` (the refused, other SSCC: shows `other_pallet_sscc` is a live needle)    |
| M4  | `pallet_closed.rs`: the second close returns `Ok(Applied::accepted())` instead of `pallet_already_closed`                | FAIL at the receipt of `rid(63)`: `left: "accepted", right: "rejected"`                                                        |
| M5  | test: pallet template layout marker `layout-marker-pallet` -> `layout-marker-palet`                                      | FAIL: `the shift never froze the pallet layout` (guards the snapshot assertion; without it the log check would pass vacuously) |
| M6  | test: the reprint names an unknown pallet id                                                                             | FAIL at `rid(62)`: `pallet_unknown` instead of accepted                                                                        |

The `"pallet_dispatched"` change (adaptation 6) has no mutant, see above.

### Full check (counts as the plan states / as measured)

- `pnpm ... build`: ok (chunk-size warning only).
- `cargo fmt --all -- --check`: clean. `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked`: 0 warnings.
- `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed): exit 0, 0 failed, 0 ignored. Plan: 47 suites, 616 tests (host 34 / 451, `pallet_facts` 16, `office_shifts` 30, `device_shifts` 20, `sscc_blocks` 16, `fact_rules` 13, `facts` 36; proto 2 / 50; shell 11 / 115). Measured: 53 result lines incl. 3 empty doc-test suites, 807 tests: host 34 suites / 498, proto 2 / 52, shell + doc-tests 17 / 257. Per suite measured: `pallet_facts` 29, `office_shifts` 34, `device_shifts` 23, `sscc_blocks` 19, `fact_rules` 13, `facts` 57, `no_secrets_in_logs` 2. The plan's totals are lower everywhere except `fact_rules` (the plan's numbers were taken on a scratch copy before the fixes/tests of Tasks 2-6 and the integration base; I did not edit the plan).
- Vitest, whole package: 81 files, 2280 tests (plan: 78 files, 2123); 80 files passed, `test/template-editor.test.tsx` failed 2 tests by the 5000 ms timeout under load average ~55-60 (it failed the same way before the plan, per the brief). Re-run alone: 1 test timed out again (load), and the two named tests (`-t "marks"`) pass alone in 4.8 s. Not a result of this task (no TS touched).
- `typecheck`: ok. `lint`: ok (eslint exit 0).
- `prettier --check` on `AGENTS.md` and the spec: clean (run with absolute paths; a root-relative path from /tmp matched nothing at first). `git diff --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`; `\u0` in the Rust test file: nothing; none in the two md files.
- `graphify update .` not run (the graph lives in the main checkout, not this worktree).

## Not verified

Nothing here ran on Windows, a real station, a printer or a browser; the installer check of protocol 3 per station is a plan УСТ item and is documented as such. Host Cargo tests exercise the host's router in-process.

## Concerns for the controller

1. Measured counts differ from the plan's (807 vs 616 Rust, 2280 vs 2123 Vitest): suggest the plan's "Счёт тестов" be re-measured, not the code changed.
2. `template-editor.test.tsx` flakes on a loaded machine (5 s timeout), repeated alone passes only when the machine is quiet.
3. Minors items 3 (`PRAGMA foreign_keys = ON` in the back-compat test) and 5 (snapshot-size 409 and its three doc sentences, ragged comment `device_shifts.rs:161-163` and AGENTS ~2132-2135) remain for the final wave; item 7 was already done in Task 5.
4. I added a `pallet_exception` record to the log pass beyond the brief (small, mutant-checked); drop it if undesired.
