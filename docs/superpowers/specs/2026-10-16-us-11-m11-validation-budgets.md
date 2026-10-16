# US-11 M11 correctness and performance budgets

Status: acceptance change explicitly approved by the owner on 2026-10-16.
This supersedes only the requirement that M11 creation and its independent oracle
together complete inside one 5,000 ms test body. It does not establish a product
performance improvement or turn historical failed runs into passes.

## Problem and decision

The previous `M11 fresh-correction` test sequentially created a complete correction
chain and reran its independent native/Trace oracle under one default Vitest
5,000 ms deadline. GitHub run 38779676094 at
`dab7623c35ef3265a17319e8ddaef8daeda302ed` failed only that test; its full
260-regular-plus-two-special chain acceptance passed separately.

Separate two independently runnable cases in the existing CI-owned measurement
file. Each keeps the default 5,000 ms test-body timeout:

- **Performance:** create the correction chain from verified empty state inside
  the timed body, then verify its bounded/frozen result and complete persisted
  census/progress. Do not include the independent oracle in this timer.
- **Correctness:** its own existing setup hook creates a fresh correction chain;
  the timed body runs the full independent native/Trace oracle, exact result
  equality, detached identity, historical revision, ownership, digest, census,
  progress and other original assertions. Capture state after setup and verify
  that the independent read-only verification changes no persisted state.

Correctness setup must not consume data from the performance test or another test.
Both cases must work when selected independently. Setup work is explicitly logged
as setup, not misreported as a successful 5,000 ms creation measurement. The
separate performance case owns that creation deadline. No verification result may
be reused between public native calls or between tests.

## Scope and verification

Change only the existing measurement test and this acceptance note. Retain the
other eleven inventory scenarios, fixture acquisition/draining/disposal, actual
query counting, production code, API contracts, SQL, snapshots, transaction
isolation, authorization, release locks and global/hook timeouts. Existing workflow
ownership selects the whole file, so both cases run without workflow filtering or
new CI permissions. The file now contains thirteen cases rather than twelve.

Review the old-to-new assertion mapping before execution. First run both M11
cases, then the complete measurement file and coordinator regression. Run API
static gates and isolated API validation; push only to `codex/us-mvp` and check
GitHub CI at the exact new SHA. A green split result is not a pass of the former
combined-body budget. No release, deployment or main/RU change is authorized.
