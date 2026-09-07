# US-03 ordinary Receiving finalization

Status: detailed design approved by the owner on 2026-09-07; implementation in
progress. Isolated US development only;
this document does not authorize a commit, publication, migration or deployment.

## Scope and sources

Implement one transition: a saved ordinary Receiving draft becomes a finalized,
read-only event. QA confirms its saved version; the server rechecks current
references and atomically creates or explicitly links lots, freezes snapshots,
locks lot sources and records the outcome. A retry cannot duplicate effects.

Exempt-supplier receiving remains the next P0 increment. Any exempt-supplier line
blocks this transition; no automatic exemption decision or TLC assignment is
introduced here. Amendment, voiding, Transformation, Shipping, balance accounting,
export generation, Station, scanners and printing are outside this increment.
They retain their existing priorities; this is not completion of US-03 or the MVP.

Sources: [MVP contract](../../us/mvp-contract.md),
[requirements](../../us/requirements.md),
[Receiving draft persistence](2026-09-06-us-03-receiving-draft-persistence.md),
[event design brief](../../design-briefs/us/03-cte-events.md), and current receiving,
readiness, lot, document and master-data implementations. This design supersedes
conflicting ordinary-finalization details in the older
[US-03 design](2026-09-03-us-03-receiving-and-documents-design.md), not its remaining
scope. In particular, duplicate create identities block; they are not warnings.

## Confirmation contract

Add POST `/traceability/receiving/:id/finalize` to the isolated US API. Strict input:
`operationKey` (UUID), `expectedDraftVersion` (positive database-sized integer),
and `expectedInputDigest` (the SHA-256 digest from saved-draft readiness).
No client-supplied actor, tenant, snapshots, generated lot IDs or readiness verdict.
Keep the existing MFA/session boundary and the ordinary small JSON body limit.

Require current `traceability.qa.manage`, including on successful-result replay.
Existing owner/admin/QA capabilities qualify; receiving-write access alone does
not. Reading a finalized record requires current traceability read access.

The user explicitly saves dirty input before checking that saved version. The
browser shows confirmation only for a complete check. It restates the event number,
civil date and captured timezone, line count, exact totals grouped by unit,
reference documents, warnings,
and counts of new versus explicitly linked lots. Never add unlike units or use
floating-point arithmetic for quantities. Nothing is submitted to a third party.

The server recomputes readiness inside the finalization transaction. A changed
draft version returns 409 `receiving_draft_conflict`. Blocking findings return
409 `event_incomplete` with the existing typed issue list. Otherwise, a changed
input digest returns 409 `receiving_readiness_changed`, requiring another check
and confirmation, even if the new data are complete. The digest is a consistency
precondition, not an authorization token or proof of a previous check.

Warnings remain non-blocking and need no acknowledgement. FSMA and generic
profile rules remain distinct: generic coverage is not assessed and absent
documents are a warning; finalization never establishes export eligibility or a
regulatory conclusion. TLCs, quantities, dates and document numbers are not
translated, regenerated or silently repaired.

## Atomic transaction and concurrency

Use one repeatable-read database transaction for authorization, operation receipt,
event and reference reads, all writes and audit. Reuse the existing tenant/command/
operation-key advisory lock, adding command `receiving.finalize`. Hash the event
ID and all validated command fields other than the operation key for receipt
comparison. A matching receipt returns its original finalized result before
revalidating mutable references; different input with that key returns 409
`receiving_operation_conflict`. Recheck current authorization before either result.

For a new operation:

1. Lock the event header for update. Require Receiving, draft status, revision 1
   and the expected draft version. A finalized event with a new operation key
   returns 409 `receiving_already_finalized`, not a second success transaction.
2. Lock unique selected existing lots for update in ascending ID order. Acquire
   shared reference locks in a consistent order: products, existing product
   profiles, parent parties, locations, then documents; sort IDs within each
   group. Discover immutable location parent IDs before locking and reread their
   values under locks. Include document issuers and every selected TLC source.
   Locking products also coordinates with profile creation, which currently
   locks the parent product for update. Preserve the established authorization
   lock order before these business locks.
3. Build one reference context under those locks. Use it both for the readiness
   digest and snapshot creation; do not independently reload data after checking.
   Revalidate active records, location descriptions/roles, reviewed coverage,
   quantities, documents and exact existing-lot relationships. No source URL is
   fetched. Snapshot-builder errors must also be expressible as readiness issues;
   in particular, an absent GTIN is allowed and an invalid supplied GTIN blocks.
   If the readiness vocabulary changes, version it and update all consumers.
4. Plan every line before writing. Insert new lots in a deterministic identity
   order; the existing unique indexes remain the authority against concurrent
   creation or source correction. A uniqueness race rolls back the whole command
   and becomes 409 `receiving_lot_conflict`; never auto-link the winning lot.
5. Persist every line-to-lot link, source latch, immutable snapshot and finalization
   metadata. Validate the final record before recording the successful receipt
   and audit. Commit together; return success only after commit.

Existing source correction locks a lot before its references; finalization follows
that dependency. Test interactions with all relevant writers, not only two
finalizers. Serialization failures or deadlocks restart the entire transaction
with fresh authorization and the same operation key, at most three attempts.
After exhaustion return a retryable unavailable response, without claiming that
the event failed to commit. Do not retry a business conflict automatically. No
network call, queued side effect or external publication belongs in this transaction.

Implementation refinement verified on 2026-09-07: a product-profile first insert
can commit while a repeatable-read finalizer waits for the unchanged parent
product row. That wait alone does not refresh the established snapshot. The new
finalization migration therefore makes profile insertion/deletion perform a
tenant-scoped no-op parent update, advancing its database tuple version without
changing any product field or adding a product business audit. A concurrent
finalizer then retries its whole transaction and checks the new reference state.
Tests must prove both the race and byte-for-byte preservation of product values.
Existing profile-row updates are checked under their own shared lock.

## Lots and historical identity

`create_on_finalize` creates one active lot per valid line, with the entered TLC,
product and source and assignment basis `imported`. This imports the supplier's
TLC; it does not assign a replacement. The lot starts at revision 1, already
source-locked, with historical actor attribution from the confirmed command.

`link_existing` retains the explicitly selected active lot's ID, TLC, product,
assignment basis and source. Product, TLC and complete source representation must
match the saved line, including the resolved location for a source reference.
Do not reactivate quarantined, recalled, archived, shipped or consumed lots.

Create-identity uniqueness remains tenant + TLC + source location, or tenant +
TLC + reference kind/value. Reference identity does not include its resolved
location. A collision against any existing lot or another create line blocks;
the user must explicitly resolve the draft. Do not merge by names or identifiers.

Latch `sourceLockedAt` once for each linked lot not already locked, using the
event's finalization timestamp. Advance that existing lot's revision once and
update its actor/time. Invalidate `lastStatusReason`/`lastSourceReason` retry hints
when advancing the revision so a previous command cannot masquerade as a retry
of this change; its historical reason remains in audit. Already locked lots are
unchanged. Never clear or replace a source latch, including in later lifecycle work.

Store `lotId` on every finalized receiving row and retain `lotLinkMode` as the
original create/link decision. Together with the immutable event, this records
which event created each new lot without adding an unrelated genealogy engine or
inventing a current `originEventId` column. Do not rewrite existing lot origins.

Audit includes one `traceability.receiving.finalized` event with exact draft-before,
finalized-after, tenant, actor, target and request ID. Each new lot has a
`traceability.lot.created` audit entry; each existing lot newly latched has a
`traceability.lot.source_locked` entry with before/after and originating event ID.
These entries share the transaction. Failed commands and replays create no business
audit entries; existing access/security logging remains separate.

## Persistence and frozen reads

Add a new migration; do not rewrite migration 0121 or prior source-lock migrations.
Preserve all drafts, counters and create/save receipts byte-for-byte. Extend the
event header with nullable `finalizedAt`, `finalizedBy` and a versioned JSON snapshot;
extend the operation-command constraint. Revision stays 1 and `draftVersion` records
the confirmed saved version, not a new editable version. Finalization preserves
event UUID, number, captured timezone and creation attribution.

The snapshot contains the saved header and notes; profile code and baseline;
full receiving and previous-source location descriptions; ordered lines with lot
ID, original create/link decision, product-description snapshot, coverage review
and its provenance, exact TLC/quantity/unit, complete source kind/value and resolved
location description, supplier reference and notes; ordered document snapshots;
and confirmation rule version, input digest and warnings. Reuse the existing
product, location and reference-document snapshot contracts. Capture document
issuer display identity alongside its ID when present, without copying unrelated
contact/account data. Render historical labels from these snapshots, not live joins.

Database checks distinguish draft headers (no finalization metadata) from complete
finalized headers. Guard direct insertion of finalized events and guard the single
draft-to-finalized transition: require a nonempty ordered line set, non-null lot
links, latched sources on every linked lot and matching frozen payload before
accepting it. Tenant FKs remain intact.
Prevent subsequent header/payload changes, child insert/update/delete and event
deletion once finalized. Child guards lock their parent and inspect both old and
new parent identities on moves, preventing concurrent or cross-event bypasses.
Child mutations also advance the parent's physical tuple version without changing
its business fields, saved version, timestamps or audit. A lock alone does not
invalidate an older repeatable-read snapshot: a finalizer waiting for a committed
child insertion could otherwise freeze the previous child set. Apply this same
coordination to inserts, updates, deletes and both parents of a move, so the whole
transaction retries and reassesses. This closes the child-write race reproduced
during the 2026-09-07 implementation review.

Raw transition validation enforces the frozen v1 structural and relational
invariants, including strict object shapes, complete addresses, typed warning
entries and profile-specific document/coverage completeness.

**URL validation boundary — owner approved 2026-09-07.** Full URL semantics,
including international-domain/IDNA processing, are authoritative in the existing
server validators and locked snapshot construction. SQL checks the URL field's
text shape, presence/length and exact relationship to the stored reference; it
does not duplicate the WHATWG/IDNA parser. Remove the approximate SQL URL parser
instead of presenting partial parsing as equivalent validation. No additional
database extension, runtime or restriction on valid international URLs is added.
The strict frozen reader remains unchanged and fails closed on corrupt data.
Privileged direct-SQL writes bypassing server validation can therefore persist
structurally consistent snapshots with invalid URL semantics that the reader
rejects. This explicit MVP boundary supersedes the earlier requirement for
complete SQL-to-frozen-contract semantic parity; it does not weaken server
validation or permit silent reconstruction/repair of history. Tests distinguish
server rejection with no side effects from this direct-SQL corruption limit.
Retain the existing irreversible source-lock trigger. Future amendment/void support
must deliberately extend lifecycle metadata rules, never mutate frozen KDEs.

Introduce strict draft/finalized discriminated read contracts. GET by ID returns
the correct variant; list summaries include status and support an optional strict
draft/finalized status filter, defaulting to both. Preserve current search,
pagination and ordering. Finalized cards remain discoverable and read-only even
after their master records change or are archived. Missing/corrupt frozen data
fails closed; do not silently reconstruct history from current records.

Create/save receipts retain their original draft response shape. A late draft
receipt is historical, not permission to reopen editing: the browser refreshes
the current record after recovery and respects finalized status. New saves or
readiness checks against a finalized event return an explicit lifecycle conflict,
not a stored-draft parse failure or unavailable error.

## Browser behavior and isolation

Extend the existing Receiving workspace, saved-readiness panel and shared Markiro
components; preserve the logo, tokens and EN/ES copy. Add a focused confirmation
dialog and a read-only finalized detail state with actor/time, snapshots, linked
lot navigation and a clear return to the list. Do not expose nonfunctional Amend,
Void, Export or attachment controls. A non-QA reader never receives an enabled
Finalize action. Keep all fields and findings usable with keyboard and mobile.

Invalidate confirmation after edits, save/reload or readiness conflicts and reject
late asynchronous results. While a command is pending, prevent accidental second
submission. After a network interruption retain the same operation key and payload
for retry in the active session. After a full reload, read the event before offering
a new attempt; event locking protects against any older request still in flight.
Do not persist sessions or complete snapshots in new browser storage. On 401 clear
the session; on 403 refresh access and leave protected content if read access is
gone. On 409 retain user context and offer the appropriate reload/recheck path.

Allow only the exact finalize path in the US development proxy and the newly
supported list query shape. Nested/unknown routes and extra fields remain denied.
The primary API/admin, deployment entry gates and operational workflow locks remain
unchanged. Any CI extension is check-only. No infrastructure is created or released.

## Acceptance evidence

Write focused failing tests before implementation, then verify:

- Domain/contracts: complete snapshot construction, optional/invalid GTIN, strict
  commands and reads, exact identifiers/decimal strings, profile-specific blockers,
  warnings and continued exempt-supplier rejection.
- Disposable PostgreSQL: additive migration preservation; immutable header/children;
  tenant FKs; mixed create/link success; exact audit; rollback when any line, snapshot
  or audit write fails; concurrent finalizers; identity races; source correction,
  status/archive and profile changes; stale version/digest; unchanged locked lots;
  duplicate/rebound operation keys; lost-response replay and revoked permissions.
- HTTP/client: MFA and current QA checks, cross-tenant denial, transport limits,
  frozen reads without live references, list status filtering, explicit lifecycle
  conflicts, historical create/save replay and unchanged primary/release boundaries.
- UI and real local browser: confirmation/cancel, create/link counts, read-only
  result, navigation, retries, conflicts and permission changes; EN/ES, light/dark,
  desktop/mobile, keyboard focus and no clipped findings or totals.

Run affected package tests, typecheck, lint and build; rebuild DB before API tests.
Use only the established disposable synthetic US database fixture. Run isolation,
proxy and release-lock contracts, scoped formatting and `git diff --check`. Report
database/browser coverage separately from hosting, which is not exercised here.

After detailed-design approval, write the implementation plan. Update requirements
traceability and browser instructions with actual evidence as implementation lands;
leave full Receiving lifecycle and exempt-supplier acceptance marked incomplete.
