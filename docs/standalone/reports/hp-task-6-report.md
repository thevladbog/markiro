# Plan ХП, Task 6 report (docs) + flaky host test

Status: DONE. Branch claude/m1 (/tmp/claude/wt/m1), base a8558af61. Evidence dir /tmp/claude/impl-hp-t6/.

Commits:

- `60d7aac07` docs(standalone): plan ХП — empty block list, shift indexes, pallet serials, EAN128 import
- `fdb8ee569` test(standalone): the host test of a shift totals builds the late device id instead of drawing it

## Docs commit

- All 10 AGENTS.md fragments and 4 runbook fragments matched exactly once (applied by script from the brief); spec section 25 appended. Files: `apps/standalone/AGENTS.md`, `docs/runbooks/standalone-backup-restore.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`.
- Passages made untrue by the plan rewritten: "a station without blocks stays «Не вернула»" (AGENTS Left open, runbook x3, spec via section 25), "no index by shift / retention scans whole" (AGENTS migration paragraph + known limit + fragment 7), the in-queue host wait for a full pallet, the early close without retry loop, "1–64 blocks". Re-grepped the three files for 1–64, hasBlocks, "пока не принимает", "2 × 10", confirmNoBlocks: the only remaining hits are historical sections 19/24 of the spec (explicitly lifted by section 25) and the early-close wait that stays true.
- One deviation: in spec section 25 the index bullet was reworded (brief text had a code span broken over lines; prettier strips the indent of such a continuation and the file would not pass the gate). Same facts, no code span across lines.
- Gates: live prettier gate proved on a scratch file (`[warn]`, exit 1, deleted), then the 3 files clean; `git diff --check` clean; `git status --short` empty.
- Plan deviations not written (controller's).

## Flake commit

Test `the_office_reads_a_shifts_totals_from_its_facts` (`host/tests/facts.rs`) drew up to 64 random device UUIDs hoping one sorts after the station's. Now the second device is inserted into `devices` directly with the built id `ffffffff-ffff-4fff-bfff-ffffffffffff` (largest a v4 UUID can be; kept `assert!(other > floor.station)`); the `shift_participants` entry and the assertion `deviceIds == [other, floor.station]` are unchanged.

- RED: 50 runs of the old test, `cargo test ... --test facts the_office_reads_a_shifts_totals_from_its_facts`: 1 failed (run 28, `facts.rs:7055 assertion failed: other > floor.station`, `old-28.txt`), 49 passed.
- GREEN: 50 runs of the new test: 0 failed, 50 `1 passed`.
- Mutant (ordering assumption still bites): `ORDER BY p.first_entered_at, p.device_id` -> `ORDER BY p.device_id, p.first_entered_at` in `host/src/routes/office_shifts.rs`: test FAILS deterministically (left `[be51…, ffff…]`, right `[ffff…, be51…]`, `facts.rs:7070`). Restored from copy: shasum before/after identical (cmp), file touched, `git status` clean.
- Gates: `cargo fmt --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings; `git diff --check` clean; no literal `\u0` added.
- ONE final `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed after both commits: exit 0, 1128 passed, 0 failed, 0 warnings (same count as task 5).

## Not run

Vitest/webview gates (no TS touched); Windows/hardware.

## Concerns

- The mutant swaps the host's secondary ordering only; a mutant that ordered by row id would also differ only if rows are inserted in an order different from entry time, which the test does (other inserted after the station's participant row, entered earlier by timestamp? — the station row carries its real entry time; other has 14:00 on 2026-09-21), and which the original test shared. Not separately mutated.
- The known ПАЛЕТА/ПАЛЛЕТА failures (3 domain print-forms-snapshot, 3 standalone forms-parity) from tasks 4/5 remain outside this task.
