# US-11 Transformation native transaction foundation

Status: owner-approved written specification on 2026-10-07. The implementation
plan requires its own review before execution.

## 1. Intent and scope

Extend the existing US product with a realistic six-month synthetic demo for
one reserved tenant. The next business stage is Transformation after the
accepted dataset Receiving stage. Preserve the established recipe, inbound lot
identities, historic civil dates, real service timestamps and native audit facts.

The agreed sequence is native transaction composition, dataset Transformation
orchestration, then recovery and contention verification. This specification
covers the first prerequisite only: native commands/readers that can participate
in a caller-owned transaction. The dataset codec, orchestrator and canonical
current-state verifier require a subsequent specification and plan. They must
not be implemented implicitly under this foundation plan.

Success means existing product commands can create and finalize Transformation
inside the same transaction as documents and a caller's other writes, with no
partial business commit and no change to public behavior. It does not mean that
the demo has been populated or that all 260 chains have been generated.

## 2. Current evidence and selected approach

`UsTransformationStore.createDraft` delegates to `createTransformationDraft`;
`finalize` delegates to `finalizeTransformation`. Both currently start their own
`transformationTransaction`. That wrapper uses repeatable read and up to three
whole-command attempts. Readiness and record reads also use this wrapper.
The finalizer maps three established lot-uniqueness violations to
`transformation_lot_conflict` after the transaction boundary.

The dataset journal instead owns a guarded read-committed transaction and commits
business writes, verification and its stage receipt together. Calling current
public wrappers within that callback would not establish this atomicity.
Receiving and reference-document services already provide native supplied-
transaction entry points; use the same pattern for Transformation.

Extract one native implementation per required command and let public wrappers
delegate to it. Do not duplicate business validation or generate business rows
with seed SQL. Separate public calls would allow partial chain commits; direct
SQL would bypass product rules, snapshots and audit provenance. Neither is used.

## 3. Internal boundaries

Expose narrowly scoped supplied-transaction operations for draft creation,
readiness, finalization and record reads. Exact signatures and file boundaries
belong in the implementation plan. Use the existing typed transaction and
contracts; do not emulate a database object or replace its transaction method.

Each native entry point reloads its current capability/profile before parsing
business input, resolving IDs or replaying a receipt. Creation retains
TRANSFORMATION_WRITE, readiness/record reads retain READ, and finalization
retains QA_MANAGE. Tenant and actor are explicit trusted caller context, not an
authorization grant. Existing denial order and cross-tenant behavior remain.

The native command owns the same body as today's public command: validation,
operation locks/digests, replay, counters, children, snapshot, lot creation,
source locks, dependency-version updates, genealogy and exact audits. No
alternative demo implementation or weaker readiness path is introduced.

Native operations start no transaction, commit nothing independently, perform
no pool read outside the supplied transaction and retry nothing internally.
The caller owns commit, rollback and any fresh whole-transaction retry. A database
failure leaves the transaction aborted; no subsequent statement may pretend to
recover it inside the same attempt.

## 4. Public compatibility and error behavior

Keep public store methods, HTTP contracts, capability requirements, response
schemas, commandVersion 1 digests, operation keys and historical replay bytes
unchanged. Save, amend, void, revisions and genealogy entry points are not
extended unless an actual extraction dependency requires a minimal adjustment.

Public wrappers retain repeatable-read isolation, the existing three-attempt
retry policy, retry classification and sanitized exhaustion behavior. Native
commands propagate serialization/deadlock failures to the caller without
retrying or converting them to success. Preserve the existing public mapping of
the three named lot unique constraints. Do not map other database failures to
lot conflicts; do not parse credentials or expose SQL in errors.

Historical command replay is not a certification of current origin. Native
record reads return current product state with today's existing lifecycle and
snapshot checks. A later dataset verifier must independently reject unexpected
amendment, void, missing support or foreign evidence; this foundation adds no
dataset repair/adoption behavior.

## 5. Isolation and lock contract

Retain the existing root-before-header record locking and the finalizer's
sorted affected-lot locks before reference revalidation. Preserve locked
readiness evidence used by snapshot construction, source/TLC collision ordering
and dependency-version writes. Do not acquire an upstream root after holding
its lot locks or claim that the dataset advisory lock protects cabinet writers.

Supplied-transaction multi-query readers require caller-owned repeatable read
or a sufficient explicit lock protocol. Reading this transaction's fresh draft
and output rows proves visibility of those writes, not general read-committed
consistency. In particular, caller-owned read-committed composition against
existing input origins is not accepted solely because a representative case
passes. The plan must map relevant public origin/lifecycle writers and lock
order, and test actual contention. If it reveals a lock gap, stop and scope that
gap explicitly rather than silently changing isolation or extending this spec.

The later dataset orchestrator must separately coordinate Receiving prerequisite
verification, reference locks and Transformation locks without inversion. This
foundation alone does not establish that later cross-stage protocol.

## 6. Required acceptance evidence

Use invocation-owned disposable US PostgreSQL databases and actual services.
No test may migrate, reset or populate the shared base or primary database.

- Demonstrate a focused failure before adding each new native boundary.
- Compose real documents, draft, readiness and finalization in one transaction;
  confirm two genuine inbound FTL lots produce a source-locked output lot,
  frozen input/output quantities and actual genealogy edges.
- Throw after finalization and verify full rollback of new documents,
  root/revision/children, counter changes, output lot, genealogy, input source
  locks/dependency changes, operation receipts and exact audits. Preserve the
  existing inbound data byte-for-byte where rollback is expected.
- Exercise actual write/audit/operation failures, not only a throw after success.
- Assert exact tenant, actor, action, target, outcome, request ID and audit
  before/after data, as well as unchanged historical receipt replay.
- Prove capability denial before malformed input, current access reload on
  replay and cross-tenant rejection through native and retained public paths.
- Check real driver serialization/deadlock error propagation and absence of
  inner retry. Distinguish injected SQLSTATE evidence from naturally induced
  concurrency; neither is silently claimed to prove the other.
- Exercise public writer contention and preserve affected public draft,
  readiness, finalization, amendment/void, genealogy and HTTP regressions.
- Validate unconditional serial check-only US CI ownership after dependency/API
  builds with the explicit fixture URL and no DATABASE_URL fallback.
- Run API build/typecheck/lint, focused configured suites with zero skips,
  scoped formatting and diff checks. Report the full API gate separately.

Fixtures must drain asynchronous work and dispose only resources acquired by
that invocation, including failure before setup/readiness barriers. Do not
rebuild mutable compiled dependencies while fixtures are alive. No timeout
increase or assertion weakening is accepted as a fix for wider-run failures.

## 7. Boundaries and subsequent work

Work only in the existing `codex/us-mvp` US worktree, preserving dirty baseline.
No stage, commit, push, PR, release, deployment, runtime/CLI registration,
environment/dependency change, migration, Station, scanning, printing, archive
or design-file edit is included. Commit instructions in generic skills do not
override this task's explicit source-preservation and publication boundaries.

Keep `us-processor-six-month-v1`, April through September 2026,
America/Los_Angeles, Scenario A, migrations 0141/0142 and 256 KiB journal bounds.
Cases, Shipping, correction/orphan orchestration, Plan/Requests artifacts,
full-volume generation, viewer/browser and hosting remain subsequent work.
Future hosted persistence/infrastructure remain outside RF; nothing is deployed
here. Local tests do not establish hosted, operational or regulatory acceptance.

The preceding full API result remains nongreen; this spec does not clear its
setup failures/skips or the retained native-loader warning. No remote CI result
is asserted. The local Graphify graph is absent; source was inspected directly
without installing tooling or generating a graph.
