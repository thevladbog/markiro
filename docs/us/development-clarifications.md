# Development clarifications — MUS-CLAR-001

Status: owner-approved decisions, 2026-09-05; implementation status is separate below. This record resolves existing MUS-001 requirements and supersedes conflicting draft slice/brief wording. It does not enable release or provisioning.

Read with [MUS-CR-001](p0-change-decision.md): CR-03 is an explicit P0 behavior change, CR-04 fixes an ambiguous implementation commitment, and neither is claimed to be scope-neutral. That record further defines execution failures, CSV operation identity and retention-path checks.

## CLAR-01: operation-specific connectivity

| Operation                                        | Client / dependency                                | Offline and restart contract                                         | Reconciliation / evidence status                                            |
| ------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Receiving, Transformation, Shipping              | US cabinet → US API and database                   | Server connection required; no P0 persistent browser outbox promised | Revision/idempotency tests belong to US-03–05; not implemented              |
| Trace search, readiness, plan and request export | US cabinet → US API, database and artifact storage | Server connection required; no offline result-completeness promise   | Frozen request revisions belong to US-06–09; not implemented                |
| Existing RU Station operations                   | Existing local journal/outbox and bundled assets   | Preserve current restart/reconnect invariants                        | Existing Station regression suite; not rerun by this documentation decision |
| US Station lot/case bridge                       | Future Station local store and US sync             | P1, deferred / not claimed                                           | Restart, replay and conflicts must be verified before support claims        |
| US Station receiving/shipping modes              | Future Station                                     | P2, deferred / not claimed                                           | No P0 test or feature claimed                                               |

INT-007 excludes external FDA/GS1 runtime services, not our own server. STN-001 preserves existing behavior; it does not promote the new P1 link to P0. REC-008, STN-002–010 and NFR-011 retain their scoped priorities. Site, walkthrough and release notes must use these same boundaries. Assign exact test IDs as each operation is implemented; a planned test is not evidence.

## CLAR-02: calendar retention

REG-009, PLN-007 and NFR-007 retain the existing five-calendar-year default and two-year minimum. Required record anchors are creation/obtaining; previous-plan anchors are supersession, never original creation. An effective plan remains retained. Keep the later of the configured period, regulatory floor, recorded prior retention boundary and a dated hold; an indefinite hold prevents expiry.

Domain policy uses validated ISO civil dates (years 0001–9999), independent of machine timezone. `retainThrough` includes the entire anniversary date; it is not an instruction to delete. February 29 advances to March 1 when the anniversary year has no February 29. Unrepresentable future anniversaries fail closed as indefinite retention. Timestamp-to-date conversion must use the authoritative recorded timezone in a future persistence consumer. P0 has no purge scheduler, deletion endpoint or new hold-management UI.

The profile already stores integer years with default 5 and minimum 2. The domain calculator increment and its tests do not establish database/object-store retention enforcement, backup retention, a restore drill or a completed REG-009/NFR-007.

Sources use the repository register: CFR-02 (§1.1455), CFR-03 (§1.1315), FDA-07 (FAQ/TRMA). The attachment's R03/R04 labels are not new repository source IDs. Calendar rounding, five years and no P0 purge are product policies, not additional FDA mandates.

## CLAR-03: available records are distinct from export readiness

REG-003, PRD-003 and RQ-003 block finalization and `Export-ready`, not authorized retrieval of available records. US-07/09 will provide `Available records — incomplete` alongside the validated package. This is an explicit amendment to the earlier diagnostic-report-only decision.

Both modes enforce fresh tenant membership and export capability. Existing authorized QA/export roles may prepare; authorized auditors may download without mutation. An incomplete run freezes scope, request revision, actor, source/event lifecycle, actual values, findings and artifact versions. Include the available workbook/records, validation report and manifest; include the plan only when available and explicitly list its absence otherwise. Record unavailable artifacts and omitted/unrepresentable fields with source identifiers; do not drop rows, invent KDEs or silently truncate a trace. A format limit must provide a lossless safe companion or block that particular artifact with an explicit reason, not report successful complete export.

Errors/unknown coverage remain errors. No acknowledgement, download, sign-off or mode switch converts them into success. Do not auto-finalize drafts or close the request as fulfilled merely because incomplete records were downloaded. Keep the due clock and separate audit action/result. Existing safe string-cell, no-formula, no-network-fetch, immutable-revision and acyclic-hash rules apply to both modes. Unsupported profiles and denied access remain unavailable; incompleteness is not a capability bypass. This is not direct FDA submission or a guarantee that an incomplete response satisfies a request.

Acceptance in US-07/09: a missing-KDE/unknown-coverage fixture produces an explicitly incomplete record export with all available rows and source-linked gaps, fails export-ready, remains immutable after corrections, denies another tenant/unauthorized role and records the exact actor/request/run in audit. Not implemented in the foundation increment.

## CLAR-04: bounded CSV capability

INT-002 P0 is a real fixed-template supplier CSV import and receiving-record CSV export, not only an interface, seed script or manual SQL. US-03 owns both. P0 includes preview with row-level errors, explicit confirmation, atomic application to a receiving draft and retry idempotency. Reject application while any row is invalid; never partially create hidden data. Header/date/site/reference fields may be entered manually; finalization remains a separate validated QA action.

REC-007 P1 now means the expanded import workflow beyond that fixed template. Partner column mapping (INT-003), shipping/ASN adapters and complete multi-CTE CSV ZIP/JSON packages (EXP-009) remain P1. P0 export has the same receiving row IDs and values as the supported input model and a documented spreadsheet-injection/round-trip policy; safety work for this path cannot be deferred with EXP-009.

US-03 acceptance: import the synthetic supplier fixture without manual DB writes; verify preview errors, invalid-file zero writes, correct draft rows, repeated apply without duplicates, tenant/role denial, audited actor/run and safe CSV export including formula-leading strings. US-11 uses that path for its import demonstration; synthetic setup is not a substitute for the feature. Not implemented in the foundation increment.

## Claims and follow-through

Use release-specific support claims only with actual tests and evidence. No exclusivity, lowest-price, FDA-approval, universal-offline or full-compliance claims. Preserve the existing US isolation and non-RF infrastructure rules.

Implementation sequence: reconcile requirements/briefs; add and verify the pure retention calculator in US-00; then continue US-00 integration and dependent slices. This record does not mark future imports/exports, offline flows or regulatory acceptance complete.
