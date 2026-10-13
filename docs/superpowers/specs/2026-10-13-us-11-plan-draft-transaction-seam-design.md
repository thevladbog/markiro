# US-11 Plan draft transaction boundary

Status: prepared under the owner's standing authorization to finish the agreed
US demo without repeated approval questions. The current Trace/Readiness source
increment and independent review are accepted. This independent Plan service
boundary may proceed while its full native CI gate runs; integration into the
dataset and complete-demo acceptance must wait for that gate to pass.
No hosted operation, release or complete-dataset acceptance is implied.

## Why this boundary is needed

The approved six-month recipe requires one service-owned approved synthetic Plan.
Creating its draft and recording its owned dataset receipt must commit together:
a connection failure between two independent commits must not cause adoption of
an unrelated draft or duplicate creation on resume. The current `UsPlanStore`
owns draft authorization, tenant locking, validation, version allocation and
success audit, but its public `createDraft` starts its own transaction.

Add only an internal transaction seam for draft creation. The dataset Plan stage,
approval, PDF publication and artifact verification are subsequent increments.
Do not make the Plan stage complete merely because a draft exists.

## Shared service implementation

Expose `UsPlanStore.createDraftCommandInTransaction(tx, tenantId, actorUserId,
input, requestId): Promise<UsPlanDraftView>`. The caller owns the supplied native
transaction, commit, rollback and any retry of the complete transaction.

The seam must independently reload membership/capabilities, require the same
processor profile and QA_MANAGE capability, and lock the organization before
querying draft/version state. Only then parse the existing strict create schema,
reject an existing tenant draft, allocate the next tenant version, insert through
the existing service logic and write the exact existing metadata-only success
audit in that same transaction. No caller-supplied IDs, version numbers,
approval state or saved evidence are accepted.

Share the existing authorization/organization-lock helper and the native draft
creation body rather than reproducing them in a dataset module. Keep public
`createDraft` inside its existing command/error-audit wrapper; call the shared
body after that wrapper's authorization/lock. The internal seam calls the same
body after its own authorization/lock, without opening a nested transaction.
Avoid duplicate authorization/locking on the public path.

Public conflict/rejection audit behavior, existing error mappings, schema,
result, lock ordering and metadata remain unchanged. The native seam must not
attempt an out-of-transaction rejection audit while the caller's transaction
is still active. A caller rollback removes both the created draft and success
audit. Infrastructure failures propagate; no error is rewritten as success.

This is an internal method, not a new route or public client contract. No schema,
recipe, configuration, artifact-store, approval, HTTP, UI or dependency changes.

## Acceptance

Use actual owned disposable PostgreSQL with DATABASE_URL unset. First prove a
meaningful failing test for the absent seam. Then verify committed native draft
and exact audit actor/tenant/action/target/outcome/metadata; forced caller rollback
leaves neither draft nor success audit; no native nested transaction is required.
Check wrong tenant, non-member, read-only role, unsupported profile and malformed
input without leaking draft facts. Concurrent native callers retain one draft
winner under the existing tenant lock. Test a public/native competing create and
the existing public rejection audit, without weakening existing assertions.

Run all existing Plan draft native tests unchanged, relevant Plan consumer
regressions, API typecheck/lint/build, formatting and diff checks. Retain existing
fixture/test budgets and owned-work drainage before normal database disposal.
No proof of approval, external PDF storage, Request inclusion, browser access or
hosted configuration is claimed by this service boundary alone.
