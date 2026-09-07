# Receiving draft persistence

Status: implemented server-only on 2026-09-07; unreleased. Scope: isolated US API only.

## Behavior

Create, read and fully replace an incomplete receiving draft. The server owns its
UUID, readable number, timezone, status, event revision, draft version and actors.
`revision` stays 1; `draftVersion` starts at 1 and advances only on a changed save.
This does not implement confirmed revisions, finalization, amendment or voiding.
The event timezone is captured from the locked organization profile on creation;
editing a calendar date never changes that timezone or converts the date to UTC.

Creation and replacement require an explicit UUID `operationKey`. Replacement
also requires `expectedDraftVersion`. Keys belong to a tenant and command
(`receiving.create` or `receiving.save`), not to an actor. A transaction-scoped
operation lock serializes retries. Identical normalized input returns the original
response, even after later edits. Reusing a key with different input returns 409.
Every retry still checks current membership, capability and profile. A new-key
stale save returns 409 even if its values happen to match; a current unchanged
save records its operation result without incrementing the version or audit.

The existing complete replacement input remains the editable document. Its rows
are ordered positions, not independently editable records; internal rows and
document links are replaced atomically. No row identity is exposed yet. Selected
non-null products, lots, locations and documents must belong to the tenant and be
active when a changed draft is saved. Incomplete combinations remain allowed;
product/lot/TLC/source consistency and required KDEs are finalization concerns.
Reads and successful retries preserve the saved document without revalidating
current master-data activity. Saved quantities remain exact strings, including
trailing zeros. Stored response validation must never normalize persisted values.

## Storage and isolation

An additive migration introduces a draft-only common event header, receiving rows,
ordered document links, tenant/year receiving counters and operation receipts.
The database rejects non-receiving/non-draft lifecycle values in this increment.
Composite tenant foreign keys protect every business reference. The number is
allocated on creation using the server creation year in the captured timezone,
not the editable receipt date. Account identifiers are historical attribution.
Header, children, operation result and exact before/after audit share one commit.
No lot, lot source lock, inventory or other event is written by this module.

Only the isolated US composition exposes POST `/traceability/receiving`, GET
`/traceability/receiving/:id`, and PUT `/traceability/receiving/:id`. Reads require
US read access; writes require receiving write access. Tenant/actor come from the
MFA-verified session. Receiving POST/PUT JSON is bounded at 256 KiB as well as the
100-row/100-document contract limits; all other business/auth JSON stays 16 KiB.
No browser proxy, UI, list/search, CSV, attachments or deployment is opened.

## Proof

Contract tests distinguish entry normalization from lossless stored reads.
Owned synthetic PostgreSQL tests cover migration preservation, tenant FKs,
incomplete saves, exact strings, lifecycle/version constraints, stable identity,
stale/concurrent saves, retries, revoked access and atomic audit rollback.
Real HTTP tests cover MFA, capabilities, input/transport bounds and unavailable
lifecycle routes. This is server evidence, not browser or hosted acceptance.
