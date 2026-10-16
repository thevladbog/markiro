# US-11: separate performance and correctness acceptance budgets

Status: approved by the user on 2026-10-16; implementation authorized, including
the increased aggregate budget and push to `codex/us-mvp`. No release or deployment.

## Evidence and scope

At `94465ba483bc39f0a6497c0db323569af9737127`, GitHub run `38835793250`
completed six jobs successfully. M05, M06 and C17 exceeded their combined
five-second test bodies although the selected public calls took approximately
2.1, 2.5 and 4.0 seconds. The full 262-unit resume returned after approximately
765 seconds; independent verification and replay exceeded the combined
900-second body. This decision changes test acceptance, not product performance.

Keep one original sequential scenario per case. Do not duplicate seeding, share
mutable fixtures between cases, remove assertions, change query freshness,
cache public-call results, or alter production sources, SQL, schemas or fixtures.

## Boundaries

| Scenario | Performance window                                                  | Performance cap | Correctness cap | Outer body timeout |
| -------- | ------------------------------------------------------------------- | --------------- | --------------- | ------------------ |
| M05/M06  | Exactly one selected composition-owner public call                  | 5,000 ms        | 5,000 ms        | 10,000 ms          |
| C17      | Exactly one coordinator command inside existing invocation counting | 5,000 ms        | 5,000 ms        | 10,000 ms          |
| Full 262 | Exactly one resumed coordinator initialize command                  | 900,000 ms      | 900,000 ms      | 1,800,000 ms       |

Correctness duration is the entire successful original body minus the selected
performance window. It includes all original pre/post reads, independent public
verifications, assertions, complete table snapshots/digests, and (for C17)
`withOwnedWork` cleanup. Setup/fixture hooks retain their existing boundaries.
All other cases, including both M11 cases, retain their existing timeouts.

Measure the exact call rather than surrounding logs/assertions. Require exactly
one measured window, finite nonnegative durations, positive finite caps, and
performance duration no greater than total duration. Never round or clamp the
values used for acceptance. Each phase independently fails above its cap even
when the aggregate is below the outer timeout; equality at the cap is allowed.

Check budgets only after original work succeeds, never in a `finally` block that
could hide the original assertion, driver or cleanup failure. Report both phase
durations and caps. Keep all original diagnostics.

## CI and verification

Only `dataset_trace_readiness` receives a 45-minute aggregate job timeout, to
cover the full 30-minute body plus its other three complete files and setup.
Every other job remains at its existing limit. Pin the new job both structurally
and byte-for-byte; changed limits, added filters, removed assertions and release
capabilities must remain rejected. Keep historical policy snapshots meaningful.

Exercise pure phase-boundary tests outside the opt-in PostgreSQL describe in the
already CI-owned measurement file. Test overrun in either phase independently,
exact boundaries, fractional durations, invalid/nonfinite inputs, missing and
multiple windows. Run the two complete small integration files against disposable
US PostgreSQL, API static/package gates, US tooling contracts and formatting.
The exact pushed SHA must pass all US Development jobs and US Cases Bridge CI.
The full four-file Trace/Readiness gate may be exercised by that CI run rather
than duplicated locally. A skipped PostgreSQL suite is not acceptance evidence.
