# US-11 — one affected-regression revalidation after host remediation

Status: proposed execution-only supplement; independent preflight and root GO
required. No implementation or execution permission is implied by this document.

## Narrow decision

The preceding `2026-10-15-us-11-host-remediation-revalidation.md` allowance has
been consumed: its unchanged original composition file passed 2/2 with normal
owned DB disposal. That result does not establish a causal fix or full budget.
The same explicitly approved host remediation also warrants one revalidation of
the still-open eight-file affected inventory, before changing more application
code or claiming the shared-reader regressions are resolved.

This is an explicit exception to the unchanged-failure rerun restriction in the
closed-terminal plan Task 3 steps 6–7, restricted to the exact inventory below.
It is not another composition run, profiler, source/reference pair, repeated
attempt-until-green, Shipping221 replacement, API aggregate or full262 gate.
Historical 014/066/044 RED evidence stays immutable. Even a passing result proves
only this invocation's cases and budgets; it does not establish why old runs failed.

## Exact invocation

Use the unchanged closed-reader `task-1-runner.mjs`, fresh tag
`post-remediation-affected-001`, native mode, then exactly:

```text
test/us-dataset-receiving-verify.e2e.test.ts
test/us-dataset-transformation-verify.e2e.test.ts
test/us-dataset-cases-prepare.e2e.test.ts
test/us-dataset-cases-verify.e2e.test.ts
test/us-dataset-shipping-origin-status.e2e.test.ts
test/us-dataset-shipping-prerequisites.e2e.test.ts
test/us-dataset-shipping-verify.e2e.test.ts
test/us-dataset-shipping-seed.e2e.test.ts
--maxWorkers=1 --reporter=verbose
```

This matches actual 044 argv, which executed 262 API cases, not the 260+2 dataset
acceptance workload. Match all exact case identities/outcomes against 044, not
only the aggregate. Preserve every source/test/fixture/counter/config byte,
assertion, original 5000-ms bodies and each original cleanup/hook budget
(including existing 10000/60000-ms hooks); no filter, preseed, relocation,
instrumentation, tuning, stronger locks, user env or shared DB change.

One executor only; use the existing cleaned canonical guarded loopback fixture
and necessary scoped sandbox escalation. Capture fresh dirty raw Buffer baseline
and account for declared plan additions. Record full sanitized logs and actual
argv/cwd/exit/signal; reconcile every old and new failed/passed/skipped case.
Let all phases drain, then normal-DROP each invocation-owned DB and verify
absence. No FORCE, cancellation, extra SQL/host probe, source/build overlap or
automatic retry. A setup failure also consumes the one allowance.

Stop after that invocation, freeze before/after raw integrity and report for
independent review. Any unresolved assertion, timeout, driver, setup or cleanup
failure stays open; inspect it before proposing a source fix. If it passes, only
this exact affected inventory is closed on the dispatched source. Comparative
range proof, coordinator implementation/assembly, complete G+2V+3R+H margin,
original full260+2, full API, push/same-SHA CI and release boundaries are unchanged.
