# Merge claude/plh-pallets -> claude/integration

- Merge commit 7290e1516 (no conflicts, auto-merge of AGENTS.md, protocol.ts, protocol.test.ts).
- Follow-up 91bfdbbba: 2a spec snapshot bound (256 KB / 320 KB sentences, ~lines 57 and 154) now says 320 KB (CHECK of 0009, shifts::MAX_SNAPSHOT_BYTES) and 409 snapshot_too_large at entry; Prettier realigned the table (39-line diff, whitespace only).
- Spec numbering: PLH's §18 lives in the pilot spec (headings 1..18 on integration, 18 = «Уточнения плана ПЛ-Х»); 2a spec has 1..17, 19, 20 (18 is reserved for 2a6). No collision, no renumber.
- No semantic conflicts found; no extra fix commit needed.
- Checks: cargo fmt --check clean; cargo check --workspace --tests ok; full cargo test --workspace 813 passed / 0 failed (device_shifts 25, facts 57, office_shifts 34, pallet_facts 29, sscc_blocks 19, templates 27, markiro-proto 5); pnpm typecheck, lint, build ok; focused Vitest 13 files / 673 tests; full Vitest 89 files / 2649 tests (--testTimeout=60000); prettier gate on 18 touched files clean and proven live with a scratch file (deleted); git diff --check clean; grep '\u04' only pairing-code.ts:66.
- Webview announces protocol 3 without knowing pallets: expected until ПЛ-Ц.
- Not run: graphify update, turbo build of deps, any Windows/hardware check.
