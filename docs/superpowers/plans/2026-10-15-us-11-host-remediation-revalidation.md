# US-11 — one post-remediation unit-gate revalidation

Status: proposed execution-only amendment; independent preflight and controller
GO required before execution. This is not product design or acceptance.

## Authority and narrow reason

The user on 2026-10-15 renewed the end-to-end request: performance, all 260 chains,
API, then push only to the US branch and verify GitHub CI, without weaker checks,
longer timeouts or releases. Existing independent-executor/reviewer boundaries
remain. This supplement changes only one execution restriction in Task 3 step 6
of `2026-10-14-us-11-closed-terminal-readers.md` and the corresponding section 6
of its design: permit exactly one unchanged-source revalidation after concrete
host remediation, not an automatic repeat-until-green policy.

The original 043 two-test run remains RED. After that run, separately authorized
cleanup removed five day-old orphaned Vitest workers and then six revalidated
processes belonging to three 31–42-hour-old fb-ui test runs. The latter six
received normal SIGTERM only after the user explicitly approved their targets;
subsequent exact-PID checks found none present. No files were removed. Recorded
host load was materially different, but uncontrolled snapshots cannot establish
the cause of any historical timeout or a source speedup. The reviewed semantic
matrix subsequently passed 130/130 on frozen source, with normal owned DB disposal.

Ruling: before choosing a further application optimization or instrumentation,
revalidate the original small gate once in the remediated environment. A pass
would establish only that invocation's original deadlines/results, not prove
that cleanup caused the pass, that performance is repeatable, or that the complete
dataset/CI budget fits. A failure remains RED and requires source-backed next
work, not another unchanged rerun. If this judgment is wrong, the cost is one
bounded isolated test invocation; no assertions or customer data change.

## Exact scope and acceptance

Use the unchanged durable `task-1-runner.mjs` from the existing closed-reader SDD
workspace, with a fresh tag `post-remediation-composition-001`, native mode and
exactly `test/us-dataset-unit-composition.e2e.test.ts --reporter=verbose`.
The canonical guarded loopback fixture and clean environment are unchanged.
Use the necessary loopback sandbox escalation from the start. One native/build
executor only; no concurrent workload, host probe or manual SQL diagnostic.

Both original bodies retain 5000 ms, all original hooks/drain retain their budgets,
all source/counter/fixture/assertion bytes remain unchanged. No name filter,
benchmark replacement, setup relocation, extra timer, new profiler, instrumentation,
database tuning, shared DB or user environment change. The original two bodies
already emit the only permitted dispatch/duration observations. Do not subtract
their different workloads or extrapolate their counts to all 262 units.

Before and after, preserve raw Buffer hashes of the actual dirty source, original
composition/full-seed/counter/fixtures and prior sealed evidence. The new plan
document is a declared addition, not a product mutation or unexplained inventory
change. Capture actual argv/cwd/exit/signal/full sanitized output and both exact
case outcomes, including any assertion/timeout/setup failure. Preserve eventual
work after a timeout until normal phase drain, pool close, ordinary owned-child
DROP and verified absence; no FORCE or cancellation. A failed drain blocks any
further execution and must be reported, not hidden by deleting its resources.

After that one invocation, stop runtime and report for independent evidence review.
No native affected-inventory rerun, full API/full260+2, coordinator implementation,
push, CI dispatch or release follows from this supplement alone. Their existing
source/correctness/full-budget gates remain mandatory. If both tests pass, the
controller may plan the remaining reviewed coordinator work; Task 2 I1, 044,
missing comparative/range evidence and full acceptance are not silently waived.

## Historical evidence preserved

The 043/044 manifests/logs and their original RED statuses, the prior diagnostic
pair and Task 3 source packet, and semantic001/002 failures remain immutable.
Semantic003 is bounded 130-case proof, not a replacement for this gate.
No source-change speedup or performance attribution follows from this amendment.
