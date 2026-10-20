# US-11 Request worker: exact-run internal execution

Status: design, task and final selected-plan source reviews approved; Task 1 implemented locally on 2026-10-20 under standing implementation approval. Local gates pass; exact new-source CI remains a separate integration gate. See the implementation plan checkpoint. This is not proof of prepared demo packages.

## Purpose and current source

The synthetic six-month dataset must eventually produce three actual Request packages through the existing durable worker. It must not claim, recover, fail or publish an unrelated run while doing so. At `153a8341c`, `UsRequestWorker.runOne()` calls global `lifecycle.claimNext()`. That query locks the oldest eligible queued or expired processing run with `FOR UPDATE SKIP LOCKED`, without a tenant/run predicate. Calling it from a dataset adapter is therefore not an owned operation.

The current lifecycle already owns strict persisted evidence validation, expired recovery, bounded attempts, server clocks, durable leases and exact audit. The worker owns live execution identity, current authorization, renewal/fences, real rendering, immutable checkpoints, conditional private storage, verified bytes, publication and reconciliation. Preserve these paths rather than reproducing them in a dataset adapter.

## Approaches and selection

Select explicit `claimScoped(scope: unknown)` and `runScoped(scope: unknown)` internal methods sharing the existing private implementation. An optional parameter on global `claimNext`/`runOne` would be smaller but makes an omitted scope silently global. A dataset-specific worker implementation would duplicate recovery/security and is rejected. Explicit methods make bounded execution auditable while preserving the global runtime's unchanged no-argument methods.

Extend `UsRequestWorkerLifecycleContract` with `claimScoped(scope: unknown): Promise<UsWorkerLease | null>`. Parse once with existing `parseUsWorkerScope`; callers cannot supply a row, lease, initiator, selection callback, state, authorization proof or skip flag. `claimNext()` and `claimScoped()` delegate to one private claim body. The scoped query conjuncts exact tenant ID and run ID with the unchanged eligibility predicate **before** locking/validating/recovering any row. A missing, wrong-tenant, locked, non-due, live-processing or terminal target returns null and never falls back to another run. Expired target recovery returns null using the existing recovery behavior; a subsequent explicit invocation may claim it only when existing policy permits. No automatic loop, sleeps, retry policy or deadline change is introduced.

Extend `UsRequestWorker` with `runScoped(scope: unknown): Promise<UsRequestWorkerResult>`. Validate the scope before work, then use the same storage/execution identity checks, claim-error sanitation and shared private execution body as `runOne()`. Capture a validated independent scope; caller mutation after invocation cannot expand it. The scoped entry uses only `claimScoped`; the global entry uses only `claimNext`. All return variants, durable authorization, expiry, renderer/build identity checks, private storage verification, error classifications, cleanup and reconciliation remain unchanged. Do not add an audited download or invoke global `cleanupOne` as part of this new entry.

These methods are internal trusted-process selection boundaries, not user authorization APIs: no HTTP/controller/client surface. Once a target is claimed, current initiator authorization is reloaded through existing persisted facts before rendering/publication. The scoped selector itself grants no export capability or tenant membership.

## Verification

Native tests use disposable owned PostgreSQL and existing real preparation/worker fixtures. A test must fail on the absent scoped method before implementation. Assertions keep current per-body and setup/drain limits; fixtures arrange expensive prerequisites outside short assertion bodies as existing tests do. Never use prepared fake Ready rows, copied SQL assembly or bypass the immutable database guards.

Required cases:

- Two distinct tenants and two same-tenant runs: an older unrelated queued row cannot win; actual target claim yields exact lease/attempt/run/audit while complete foreign rows/audit/artifact state remain unchanged.
- Wrong tenant paired with a real run, missing run, malformed/extra-key/accessor scope: precise existing parse rejection or null, no claim or writes elsewhere. No caller property access for executable values before strict parsing.
- Same target simultaneously claimed by separate service instances: one actual lease, one null, one exact audit. Actual held target row lock plus eligible foreign row: scoped claim returns null via SKIP LOCKED, foreign run remains unchanged.
- Target not due, active processing, Ready/failed terminal: null, no fallback. Expired target recovery preserves original audit/failure/requeue policy and never recovers an older foreign expired row.
- Global `claimNext` still selects its original eligible oldest row and retains existing malformed queued disposal behavior. Original lifecycle regression suite remains unchanged.
- Actual `runScoped` renders/publishes the target through real checkpoints and the synthetic private storage fixture; exact resulting Ready scope, actual bytes/digests and publication evidence. Foreign queued/expired target states, attempts, audits and private objects remain unchanged.
- Target authority/profile/build identity drift produces existing classified non-Ready result for the target only. Real pre-claim storage-unavailable and execution-identity cases follow unchanged global behavior; scoped parser still rejects malformed input first.
- Real provider fault/retry schedule and publication/reconciliation continue through the common body. Recreated scoped invocation uses durable evidence; no implementation of independent retries or clock rewrites in production.
- Unit route-selection spy may prove scoped entry never invokes global claim; actual native SQL/state assertions establish ownership, not mocks alone.

Explicit CI ownership is required for every new native suite. Prefer additive selection in the dedicated prepared-services job after that job's source is reviewed; retain its 30-minute budget, independent literal selection pin and denial mutants. Source and actual same-SHA runtime acceptance remain distinct. Do not change existing worker tests to avoid failures; adapt only strict contract fixtures that genuinely require the new interface method.

## Scope and acceptance

Allowed production areas: worker lifecycle and worker private execution decomposition only. Focused new native tests/fixtures and explicit US CI selectors/ownership proof accompany them. Shared package outputs are built before consumers. Minimum gates: new native suite, unchanged lifecycle/worker/recovery/checkpoint/publication/runtime consumers, API types/lint/build, Node CI-owner tests, focused format/diff and independent task/final reviews.

No schema/migrations, worker policy/limits, public route changes, actual dataset Request preparation adapter, descriptor/identity fabrication, fake state, new organization, timer enlargement, RU/main/Station or release changes. Full Trace acceptance is a separate prerequisite for dataset package integration; generic exact-run worker source may be reviewed independently but is not an acceptance shortcut. The later adapter must first prove its target belongs to the guarded owned dataset journal and its frozen selection before calling this trusted-process boundary.
