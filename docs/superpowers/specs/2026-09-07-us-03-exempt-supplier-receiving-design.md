# US-03 — Exempt-supplier Receiving

Date: 2026-09-07.

Status: product behavior and technical specification approved by the owner on
2026-09-07. Not implemented. Ordinary Receiving remains available; exempt
Receiving remains blocked in current code until this increment is verified.

Execution is organized by the [implementation plan](../plans/2026-09-07-us-03-exempt-supplier-receiving.md).

Requirements: REC-004, LOT-004, LOT-005, REG-003, REG-005, REG-011; preserves
REC-001/002/003/005/006 and the existing tenant, QA, audit and source-lock rules.

Read with the [MVP contract](../../us/mvp-contract.md),
[development isolation](../../us/development-isolation.md) and
[ordinary-finalization design](2026-09-07-us-03-ordinary-receiving-finalization-design.md).
This extends ordinary finalization; it does not authorize release enablement.

## 1. Approved behavior and scope

The owner approved a receipt-specific review, not a supplier-wide exemption
registry. An operator records the exemption rationale, a supporting source URL,
and whether a TLC was already assigned. QA explicitly reviews every exempt line
when finalizing that saved receipt. The server records the reviewer, time and
reviewed content. The decision is never inherited by another receipt.

If a TLC already exists, preserve it and its source. Only when none exists may
the receiver enter a proposed own TLC, with the receiving location as its source.
Saving or checking does not assign the code or create a lot. Successful
finalization makes the assignment atomically with the receipt and audit.

The assignment boundary agrees with the FDA's
[Traceability Lot Code summary](https://www.fda.gov/food/food-safety-modernization-act-fsma/fsma-final-rule-requirements-additional-traceability-records-certain-foods):
receipt from an exempt entity requires assignment only if a TLC has not already
been assigned, with a retail/restaurant exception. This increment targets the
existing processor workflow, not those additional business types. Source checked
2026-09-07. The software records a user's assessment; it does not determine legal
exemption, verify an external declaration, or certify compliance.

Two approaches were considered: review within the individual Receiving
finalization, or a reusable supplier registry with validity and revocation rules.
The owner selected the former for this MVP. No approval endpoint, supplier
status, expiry scheduler or separate reviewer role is added.

Both existing US profiles retain their current basic Receiving access. The
generic profile continues to say that FTR applicability is not assessed; it
cannot acquire an FDA-labelled package or a coverage assessment through this
workflow. An exempt-supplier review does not change the product's coverage
review, and cannot bypass unknown or pending FSMA product coverage.

## 2. Draft model: received and proposed TLCs are different facts

Keep the existing `exemptSupplier`, `exemptReason`, `supplierLotReference`, `tlc`,
`source` and create/link fields. `tlc` remains the already-assigned TLC entered
from the receipt information, not a field silently overwritten during assignment.

Add an optional, nullable `exemptReceipt` object to each draft line. When present,
it has exactly these three required keys, whose values may be null:

- `evidenceUrl`: nullable text, using the existing credential-free HTTP(S) URL
  boundary, at most 1,024 UTF-8 bytes. It is an evidence reference, not the TLC
  source reference. Never fetch it or claim that its contents were verified.
- `tlcHandling`: `preserve_existing`, `assign_if_missing`, or null while incomplete.
- `proposedTlc`: nullable TLC with the established 1–120 Unicode code-point,
  control-character and entry-normalization rules.

The existing `exemptReason` is the rationale; do not introduce a second reason
field with competing meanings. A non-TLC supplier identifier stays in
`supplierLotReference` and is never promoted to a TLC automatically.

Drafts may remain incomplete or contain contradictory combinations. Present
values must pass their structural validators; the data check explains semantic
blockers. A legacy missing `exemptReceipt` means no additional input was recorded,
not that an exemption was reviewed or a TLC may be assigned.

When `exemptSupplier` is false, retained hidden exemption input is inactive, as
the existing hidden reason is today. It cannot assign a TLC, count as review or
change ordinary finalization. Toggling never clears or moves populated values.

| Active line path          | Required saved inputs                                                                                                                                          | Finalization effect                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Ordinary                  | Existing ordinary checks                                                                                                                                       | Preserve TLC/source; create imported lot or link the explicitly selected lot                          |
| Exempt, preserve existing | Rationale, evidence URL, existing TLC and complete original source; no proposed TLC                                                                            | Preserve TLC/source; new record has imported basis, an existing lot keeps its actual assignment basis |
| Exempt, assign if missing | Rationale, evidence URL, received `tlc = null`, valid proposed TLC, explicit location source equal to receiving location, `create_on_finalize`, `lotId = null` | Create one lot with the proposed TLC and `exempt_supplier_receipt` basis                              |

Own assignment never links or renames an existing lot. A duplicate tenant/source
identity is a conflict, not permission to link, overwrite or generate a suffix.
Duplicates across lines use the effective TLC/source, including proposed codes.
Correcting draft input is explicit; choosing an assignment mode cannot erase an
already-entered TLC or selected lot. A changed receiving site makes a mismatching
saved source incomplete until explicitly corrected.

## 3. Data check and QA confirmation

Keep the explicit Save → Check → QA confirmation flow and existing endpoints.
The read-only check validates all current references and the active path above.
It uses a new pinned readiness rule version, `receiving-readiness-v3`, and adds
`exemptReviewRequiredLines`: ascending, unique one-based line numbers for every
active exempt line in the saved record. Ordinary records return an empty array.

`state = complete` continues to mean data completeness only. The UI additionally
states that the listed lines require QA review. A complete input may open the
confirmation dialog; it is not already approved. Missing rationale, evidence,
handling mode or assignment inputs remain errors. Remove the blanket exemption
block only for structurally and semantically complete exempt inputs; do not turn
missing evidence into an acknowledgeable warning. Saving/checking writes no
review record, audit, lot, source latch or command receipt.

The finalization request retains `operationKey`, `expectedDraftVersion` and
`expectedInputDigest`. Add optional `reviewedExemptLines`, an ascending unique
array of 1–100 line numbers, with at most 100 entries. Omission means no reviews.
QA must explicitly check an initially unchecked confirmation for each exempt
line. The server requires the array to match all and only the active exempt lines
of the locked draft; a boolean on the draft is not authorization.

The existing current QA/MFA check is mandatory, including successful replay.
The reviewer is the authenticated finalizer; the review timestamp is the server's
finalization time. Client-supplied reviewer, review time or approved status is
rejected. No four-eyes requirement is introduced: an authorized QA user may also
have entered the draft.

The confirmation is bound to event ID, saved version and the readiness digest
covering all draft inputs and locked reference data. Local changes, including
edit-and-revert, save attempts, reload, session loss or QA loss invalidate it.
Closing and reopening the dialog starts unchecked. Reference changes detected by
the server require rechecking and reviewing again. An unknown delivery result
retains the exact command and review list in RAM for explicit same-key retry;
it must not become a fresh assignment request.

Malformed review lists fail request validation. A structurally valid list that
does not match the required lines returns `409 event_incomplete` with typed
exemption findings. Stale versions and changed digests retain the existing
conflict codes; inconsistent stored data fails closed with sanitized 503.
No error path converts a missing review into success or silently saves edits.

## 4. Atomic finalization and frozen history

Extend the existing transaction, not a second finalizer:

1. Reload authorization; use the established tenant/command/key lock. Check a
   successful operation receipt before mutable references, with current QA access.
2. Lock the event, compare draft version, and load the same deterministically
   locked lot/product/profile/party/location/document context as ordinary Receiving.
3. Validate the effective line identities, completeness, current digest and exact
   required review list before any business write.
4. Build the complete snapshot and lot plan. Create imported or own-assigned lots
   by line path; preserve linked lot identity and assignment basis. Latch sources
   permanently under the existing rules.
5. Persist item lot links, finalized event, immutable review content, exact audit
   and operation receipt in one commit. Do not rewrite the received draft TLC
   column with the proposed TLC; the lot and frozen item carry the effective TLC.

Retain bounded repeatable-read retries, existing parent/child concurrency guards,
current-membership locks and duplicate-identity conflict behavior. A rejected or
rolled-back command creates no lot, review, latch, successful receipt or partial
finalization. Inventory, quantities and lot operational status have no additional
side effects.

All newly finalized records use snapshot version 2. Each item keeps the existing
frozen product, coverage, source, quantity and document relationships and adds a
`receiptBasis` discriminated object:

- `ordinary`: `kind` only; no exemption approval is claimed.
- `exempt_existing_tlc`: `kind`, `reason`, `evidenceUrl`, `reviewedBy`, `reviewedAt`;
  the item's TLC/source remain the received identity.
- `exempt_assigned_tlc`: the same review fields plus explicit
  `receivedTlc: null`; the item's TLC is the saved proposal and its physical source
  equals the frozen receiving site. This path requires create-on-finalize and an
  own-assigned lot, never an imported or linked lot.

The frozen confirmation records the new readiness rule, exact digest, warnings
and confirmed line numbers. The record validator cross-checks line reviews
against the event finalizer/time and requires the exact review-line set. New-lot
audit records include the effective TLC/source, actual assignment basis and event
ID; the event's before/after audit preserves the received inputs and full reviewed
result. Existing linked-lot source-lock audit semantics remain unchanged.

Frozen history renders the stored rationale, evidence reference, handling path,
reviewer/time and effective lot identity. Never reconstruct those facts from live
party/product data or a later supplier review. Store the evidence URL and rationale,
not a purported archive of the remote page; subsequent external content changes
cannot be detected or reconstructed by this MVP.

## 5. Storage and compatibility

Add nullable `exempt_receipt` JSONB to the receiving item in the next available
migration, with strict shape/type/length checks for present values. Existing
nullable draft columns and tenant foreign keys stay intact. Do not rewrite
migrations0121/0122, prior audit payloads or successful operation receipts.

Preserve the exact version-1 frozen schema/rule and its original structural and
relational guarantees. Read versions 1 and 2 with explicit version dispatch;
unsupported or inconsistent stored content fails closed. New SQL guards must
validate version 2, including effective TLC/proposal equality, exact line/source/
lot relationships, rationale/evidence equality with saved input, review-line
membership and matching reviewer/time. No review fields are writable after
finalization. Retain finalized INSERT denial and child
INSERT/UPDATE/DELETE/move protection, including waiting concurrent transactions.

The owner-approved URL boundary is unchanged: full URL/IDNA semantics remain in
server validators and locked snapshot construction; SQL enforces shape, bounds,
exact values and relationships. Apply that same boundary to evidence URLs. No
database extension, approximate URL parser or network lookup is introduced.

Legacy drafts and create/save receipts without the new object remain readable
without silently transforming historical payloads. Fresh reads may expose null
for the new column; legacy command replay retains its original payload. Extend
strict compatibility schemas deliberately, with tests for these different shapes.
An old exempt draft remains blocked until a user explicitly supplies the new data.

Preserve ordinary finalization replay identity: an omitted or empty review list
uses the existing command digest input. A nonempty list participates in the new
command digest. Rebinding a key to different event/version/digest/review content
conflicts; identical authorized retry returns the original versioned result.
Do not backfill a new digest into old receipts or reassign their lots.

## 6. Interface and component boundaries

Extend the existing grouped Receiving line editor, readiness panel, confirmation
dialog and frozen detail. No new navigation section, wizard, branding or token
system. Support EN/ES, both themes and the current responsive widths.

The expanded line shows rationale, evidence URL, handling choice and supplier's
non-TLC reference. Existing-code mode retains the current TLC/source controls.
Own-assignment mode shows a separate proposed-TLC field and a plain-text source
summary naming the receiving location; explicitly accepting this path sets that
source only when it does not discard populated conflicting input. Invalid drafts
show an actionable source mismatch rather than silently changing it.

The QA dialog groups reviews by numbered line and displays the supplier/location,
product, rationale, evidence reference, existing/proposed TLC and source. Each
review is unchecked by default and disabled during submission or uncertain retry.
No blanket “approve this supplier” action. Use the existing modal's focus handling,
visible labels and non-color-only status. A read-only user may inspect the saved
basis but cannot submit it as reviewed.

Domain owns effective-identity and readiness rules; contracts own strict boundary
shapes and versioned readers; the US store owns current permissions, locks and
atomic writes; the UI owns transient confirmation only. Add focused exempt-rule
helpers instead of duplicating the ordinary finalizer or unrelated refactoring.
No general proxy route or new HTTP endpoint is needed.

## 7. Verification and non-goals

Use focused failing tests before implementation, then affected package gates:

- Domain/contracts: ordinary, preserved and newly assigned paths; incomplete and
  contradictory drafts; invalid evidence URLs; opaque Unicode TLCs; exact decimal
  quantities; effective-identity collisions; strict server fields; exact review
  lists; legacy/current draft and snapshot schemas without lossy transformation.
- Disposable US database/API: both exempt paths and mixed ordinary/exempt lines;
  correct assignment basis; exact actor/tenant/target/before/after audit; source
  latching; missing/extra/repeated reviews; role and cross-tenant denial; stale
  draft/reference data; conflicting codes; atomic rollback; committed replay;
  legacy receipts; concurrent finalizers and child/master-record changes.
- Direct SQL: version-1 regression, version-2 mismatch/corruption refusal,
  immutable review/header/children, and the explicit server-authoritative URL
  limitation. Build DB output before API consumers and use owned disposable US
  databases only, never the base database or primary environment.
- Client/UI: initially unchecked per-line review, edit/reload/QA invalidation,
  no hidden-field assignment, failed reads, exact response correlation, double
  submission and uncertain same-command retry, both languages and themes.
- Real local Chromium: actual QA/MFA and persisted flows, existing TLC retained,
  missing TLC assigned once, mixed lines, frozen review after reference changes,
  committed lost-response retry, receiving-operator denial, keyboard operation,
  and readable 1440/1024/390 layouts. Inspect safe screenshots; no credential
  screenshots, traces or HAR captures.

Run formatting, diff checks and the existing isolation contracts. Record actual
results separately from hosted services, real-data acceptance, fluent Spanish,
screen readers and hardware checks; unexercised surfaces remain unverified.

No exemption engine, reusable supplier approval, external evidence capture,
attachment upload, new TLC format policy/generator, amendment/void, Transformation,
Shipping, CSV, trace/export or Station work is included. Those remaining P0/P1
items retain their existing priority; this increment does not complete US-03 or
the MVP. No primary-checkout change, staging, commit, push, merge, publication,
hosted resource creation or release is authorized.
