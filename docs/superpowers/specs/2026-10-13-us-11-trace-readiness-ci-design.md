# US-11 Trace/Readiness native CI ownership

Status: prepared under the owner's standing completion/US-branch authorization.
Read-only proof and durable progress code have independent source approval and
native focused acceptance9/9 and13/13. Full acceptance remains outstanding after
an unexpected local SIGTERM, not an established900000ms timeout.

## Outcome

Give the three new opt-in native suites an explicit GitHub Actions owner. A
missing US_TEST_DATABASE_URL skip must not look like covered Trace/Readiness.
Run the actual unchanged full260+2 composition on a dedicated fresh Linux runner
with a local synthetic PostgreSQL service; this is another isolated test
environment, not a deployment or a replacement for assertions.

Add exactly one job `dataset_trace_readiness` to `us-development.yml`, after the
existing isolation matrix via `needs: isolation`. Keep all six matrix segments,
82 existing steps, guards, commands, action pins, max-parallel3, fail-fastfalse,
30-minute job limit and release protections unchanged. Waiting for the existing
matrix avoids adding a fourth concurrent workload. The new job has the same
30-minute limit, not an enlarged existing budget. Its full test keeps900000ms.

The job uses the same pinned checkout/pnpm/Node24 actions, frozen install and
reserved loopback PostgreSQL17 service as the existing workflow. It builds shared
contracts before all Node tooling checks, checks US isolation, builds API
dependencies/entrypoints, then runs exactly these suites with maxWorkers1:

- `us-dataset-trace-readiness.e2e.test.ts`;
- `us-dataset-trace-readiness-stage.e2e.test.ts`;
- `us-dataset-trace-readiness-seed.e2e.test.ts`.

Only the tracked synthetic US_TEST_DATABASE_URL is supplied for native execution.
DATABASE_URL remains absent. Owned fixtures retain actual administrative identity,
tenant/owner guards,144 migrations, work drainage and normal disposal/absence.
No user credentials, private environment, production DB, storage or release
permissions are introduced. No retries, continue-on-error, test filters, smaller
range, assertion changes or timeout overrides are allowed.

## Preservation contracts

Add strict ownership tests for the complete job, prerequisite order, exact file
selection/serial execution, target/service, actions, read-only permissions,
30-minute limit and dependency on the unchanged six-segment isolation matrix.
Require one owner per suite and reject duplicate/foreign ownership, absent or
changed database configuration, skipped/bypassed commands and extra capabilities.

Historical workflow/step byte and AST pins must remain authoritative. Extend the
existing normalizer only to remove this exact complete reviewed job from a copy,
then apply the unchanged six-segment normalization. A missing or mutated job must
remain observable to new ownership checks; an altered job must never be removed
by a generic key/name allowlist. All old steps, hashes and other workflows remain
unchanged. Add mutation coverage for job/command/env/order/needs/timeouts/action
pins/guards and prior-step tampering. Adjust only expected normalization surfaces,
never refresh historical hashes to excuse unrelated changes.

## Acceptance and limits

Test-first ownership RED, full Node tooling GREEN, formatting/diff checks and
independent review precede scoped commit/push to the existing US branch. Do not
create a PR, merge, publish artifacts or dispatch any release/deployment workflow.
Observe the exact pushed SHA and all existing six checks plus the new native job.
Queued/running/skipped/old-SHA results are not green acceptance. Native failure
requires exact logs and diagnosis; no budget, scope or expectation relaxation.

GitHub native test success can establish this automated synthetic slice, not
Plan/Request integration, complete visitor acceptance or non-RF hosted access.
Local SIGTERM cause remains unknown unless independent evidence explains it.
