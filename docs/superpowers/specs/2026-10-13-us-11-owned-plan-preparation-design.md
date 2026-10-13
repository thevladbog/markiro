# US-11 owned Plan preparation and approval

Status: prepared under the owner's standing authorization to finish the agreed
synthetic US demo. Separate implementation and review remain required. This
document does not claim full Trace/Readiness CI acceptance or authorize release.

## Boundaries

The immutable six-month definition already declares one `plan` unit and one
`plan` stage. Keep that definition, stage sequence and digest unchanged. A pending
intent is not an approved Plan receipt. Creation of an owned draft and capture of
the intent containing its generated identity must commit together; approval and
private PDF publication continue through the existing approval service.

This stage is independently testable with the real owned references. The final
dataset coordinator must finish all regular/special Trace/Readiness proofs before
declaring the entire dataset complete. Do not repeat the entire dataset for every
Plan-only regression or infer canonical chain validity from journal receipts.

## Guarded preparation transaction

Add a small internal journal operation for preparing a missing stage intent.
The journal, not the callback, owns the transaction, actual database/original
owner guards, mutation advisory lock, dataset-header validation/lock and stage
eligibility. Check the addressed unit/stage and operation-key collision before
invoking any creation callback. For an existing addressed stage return its parsed
original identity without invoking the creation callback; the caller must still
validate its exact canonical input and live service-owned facts.

Only for a missing stage invoke trusted internal preparation inside that guarded
transaction. Its returned intent must match the addressed unit/stage and proposed
operation key, pass existing strict/bounded parsing and have the correct input
digest. Reuse the existing capture predicates/insertion rather than duplicating
the journal's collision, predecessor and row-parsing rules. Any callback, SQL,
parse or commit failure rolls back its draft, success audit and pending intent.
No receipt is written here. No nested transaction or rejection audit outside the
active transaction is allowed. Preserve all existing journal methods and tests.

The Plan caller uses the independently reviewed
`UsPlanStore.createDraftCommandInTransaction` seam. It does not insert Plan rows,
allocate versions or write success audit independently. Hold the organization
lock before checking absence of unowned Plan versions/drafts and before draft
creation, so concurrent public creation cannot pass an unlocked absence check.
Reject versions/drafts that have no matching owned intent; never adopt them by
content, actor or an `effective` status alone. Lock ordering remains advisory/owned
provenance/header before Plan organization/version locks, as in native stages.

## Plan-specific captured identity

Use a separately versioned, bounded synthetic Plan-content descriptor without
changing the installed dataset manifest. Its English text describes this demo's
actual manual FTL review, processing-time TLC assignment and non-farm scope.
Fictional contact data uses `example.test` and synthetic labels. Storage/recovery
descriptions explicitly describe demonstration procedures, not verified operating
infrastructure or regulatory approval. Use existing section/claims validation.

Capture the dataset identity, exact completed owned-reference digest, descriptor
version/content, generated draft ID/version/revision/creator and stable approval
operation identity in the intent. Use generated service values, never caller
chosen IDs/version numbers. The operation identity survives all resumes. Technical
timestamps are actual service times, not dates from the six-month event history.

On a pending intent, branch by the exact owned version's current lifecycle. For a
draft, validate its identity, revision, sections, summary and creator through the
service before approval. For an already-effective version, validate its frozen
publication and original approval binding instead of parsing it as a draft;
this is the publication-committed/receipt-missing recovery path. Missing,
superseded or changed owned state is a precise conflict, not repair permission.

## Approval and final receipt

Invoke `UsPlanApprovalStore.approve` with the captured version/revision and stable
key. Use the existing synthetic provenance and confirmation semantics; do not
claim real operational procedures or backdate approval. Provider I/O remains
outside journal transactions and organization locks.

If publication commits but final journal recording fails, resume only the exact
owned version and original approval key/request digest. The approval service's
existing idempotent retry must return the same immutable result; a similar Plan
approved with another key or actor must conflict. The existing retry response
alone is not proof of current lifecycle: it preserves the original approval
result even after supersession. Do not create another draft or replacement PDF
to hide an uncertain result.

Use a narrow tenant-scoped internal read of the exact owned Plan row inside the
guarded dataset transaction to prove its creator, current status and persisted
`idempotencyKeyHash`/`approvalRequestDigest`. Compare the hashes with the existing
domain functions over the captured key and exact approval request, including
confirmations. The request digest does not bind actor, so compare creator and
approver independently. Reuse the existing published-row parser for frozen
evidence/descriptor validation. Do not expose extra public fields or change the
general approval protocol. Nonempty replacement hashes must fail completed
verification even if public published projections and PDF bytes are unchanged.

Before final receipt, prove the live service-owned published Plan has the expected
ID/version/creator/approver, effective status, exact frozen sections, synthetic
provenance and confirmation evidence. Verify actual immutable PDF bytes through
`UsPlanArtifactStore.readVerified`: scope, MIME, length, SHA-256 and renderer are
the existing adapter's authority. Do not call the public audited download command
from read-only verification, since that writes an audit row. Do not re-render
historical PDF bytes or recalculate approval time/current configuration as facts.

The existing journal's secret-key walker forbids `objectKey`; preserve that
policy. Persist the public artifact fields (SHA-256, length, MIME and renderer)
plus the canonical digest of the complete native artifact descriptor, including
its private object identity. Obtain the raw object key only from the guarded
live Plan read and pass it to `readVerified` outside the transaction; never store
or rename the private key into journal evidence. Compare the full descriptor
digest as well as the public fields so same-content object replacement also
conflicts. Store one bounded frozen result and final receipt for this exact Plan
identity/evidence/artifact binding; `datasetComplete` remains false.
Completed initialize and verify recheck actual published state and stored bytes,
compare the exact receipt and make no business, journal, audit or provider writes.
Verify refuses a missing or pending stage and never finishes approval implicitly.

## Acceptance

Use actual owned disposable US PostgreSQL and a fixture-owned private provider
boundary, with real draft/approval/PDF rendering services. Provider transport
fixtures test that external boundary only; no fake Plan state or prebuilt PDF.

First accept guarded preparation separately: meaningful native RED, exact commit
and forced rollback of draft/audit/intent, collision/invalid callback and target
denials before callbacks, concurrent one-winner ownership and existing journal
regressions. Existing time budgets and assertions remain unchanged.

Then test the Plan stage: fresh references, exact synthetic immutable PDF and
audit, stable replay/no-write verify, real SQL failure after draft preparation,
real SQL failure after published approval but before receipt, original-key resume,
foreign/unowned Plan refusal, content/revision/approver/key/evidence/bytes drift,
nonempty persisted key/request-hash replacement, same-key approval by another
actor and supersession,
cross-tenant/read-only/original-owner denials and propagated provider failures.
Assert exact stage diagnostics, counts and full-table hashes, not just existence.
Drain owned work, dispose normally and prove each owned child is absent.

API typecheck/lint/build, relevant existing Plan/journal consumers, formatting and
diff checks plus independent reviews are required. No new HTTP/UI, public runtime,
schema, dependencies, recipe changes, credentials, release or hosted acceptance.
