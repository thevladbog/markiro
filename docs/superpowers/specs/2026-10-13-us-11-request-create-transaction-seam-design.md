# US-11 Request creation transaction boundary

Status: prepared under the standing authorization to finish the isolated US demo.
Implement after accepted owned Plan review. No prepared run, artifact publication
or complete-demo acceptance is implied by this service boundary.

The three manifest Requests need stable service-owned identities and receipt
times. Add `UsRequestStore.createCommandInTransaction(tx, tenantId, actorUserId,
input, httpRequestId = null): Promise<UsRequestRow>` so creation/audit can share
the journal's guarded preparation transaction. Input remains unknown until the
existing strict schema parses it; independently reload QA_MANAGE and processor
profile first. Use existing deadline resolution, generated ID/default revision/
status, validated-row parser and exact metadata-only success audit in that tx.
No forged ID, revision, validation, frozen run or Ready state is accepted.

Share authorization and create body. Public create keeps its current
`transformationTransaction` repeatable-read/retry wrapper, unique-number mapping
and post-rollback conflict/rejection audit, with one authorization boundary.
Do not add a public organization lock here. The native seam opens no transaction,
savepoint or outside rejection audit and owns no retry/commit/rollback.
Infrastructure/uniqueness failures propagate; caller rollback removes request
and success audit together. The later preparation captures actual received time
once; the default deadline remains 24 elapsed hours, never reset or backdated.

Later adapters bind existing manifest selections to exact owned IDs/scopes and
refuse unowned duplicate numbers; this seam does not implement those adapters.
No schema, recipe, validation/Prepare/worker/artifact, HTTP/UI, dependency,
configuration or release change. Preserve 500-revision/16-MiB/complete-closure
gates unchanged.

Acceptance: actual owned disposable US PostgreSQL with DATABASE_URL unset,
meaningful absent-method RED, exact commit/deadline/audit, forced rollback,
tenant/non-member/read-only/profile/forged-state denial, native duplicate
propagation without outside audit, real SQLSTATE failures/one attempt/full-table
rollback, concurrent unique-number winner and exact public loser mapping/audit.
Run unchanged relevant Request consumers, API types/full lint/build, format/diff
and independent source review without relaxed assertions/budgets. Drain and
dispose only owned children normally and prove exact absence; no unrelated DBs.
