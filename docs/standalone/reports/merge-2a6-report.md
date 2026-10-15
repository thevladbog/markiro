# Merge of claude/2a6-scanning (940fb4a35) into claude/integration

Status: DONE, no push.

- Merge commit: 187212320365d8703416a9cbacfbf87d9130156b (no conflicts, textually clean as the trial predicted).
- Follow-up commit: 370ec784caaabed212447507a2a66ea4383763dc (integration HEAD):
  - `FACT_RECEIPT_CODES` in `src/host/protocol.ts` gets `no_pallets`, `pallet_unknown`, `pallet_already_closed`, `pallet_state`, in the order of `proto/fixtures/fact-receipt-codes.json` (15 codes; test «know every receipt code of the host» is green).
  - `AGENTS.md` (floor extension points): the sentence "with a new field of `box_closed` that raises `PROTOCOL_VERSION`" now says the pallets plan joins the open pallet with the `palletId` of `box_closed`, which the host already takes since ПЛ-Х (protocol 3), so the plan adds no protocol version.
- Spec numbering: 2a spec has §1–17, §18 (2a6), §19 (2a2), §20 (2a5); pilot spec §1–18 (§18 = ПЛ-Х). No collision, no renumbering. 2a8's §20 and О-Ф's §21 will clash later (as the review said).
- No other semantic conflict: typecheck is clean, so no `OfficeShift` literal lacks the pallet fields; no protocol-2 expectation broke.

## Checks (on /tmp/claude/wt/integ)

- `cargo fmt --check`: clean. `cargo check --workspace --tests`: clean, 0 warnings.
- `-p markiro-proto`: 52 passed. `--test local_db`: 27 passed. `--test ipc`: 26 passed (unsandboxed).
- Full `cargo test --workspace` (unsandboxed): 53 suites, 813 passed, 0 failed, 0 ignored, 0 warnings.
- pnpm `typecheck`, `lint`, `build`: all exit 0.
- Focused Vitest (protocol, api, floor-_, host-link_, app, shift*): 34 files, 1359 tests passed.
- Full package Vitest (`--testTimeout=60000 --hookTimeout=60000`): 101 files, 3024 tests passed, no errors reported.
- Prettier gate: proved live first (a scratch mis-formatted file failed with exit 1 and was deleted), then `prettier --ignore-path <root>/.prettierignore --check` over all 44 non-`.rs` files of `git diff --name-only 91bfdbbba..HEAD`: all clean (the one `.rs` file is covered by `cargo fmt`).
- `git diff --check 91bfdbbba..HEAD`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`. Tree clean.

## Notes

- The webview still knows no pallet UI until ПЛ-Ц. The station sends `X-Markiro-Protocol: 2`; the host is protocol 3 with MIN 1, so requests are accepted. A station of protocol 2 can enter a shift planned with pallets and produce boxes without them (AGENTS.md already documents this, owed to the plan УСТ).
- Windows, hardware, real scanner and printer behavior: not exercised (host-only runs).
