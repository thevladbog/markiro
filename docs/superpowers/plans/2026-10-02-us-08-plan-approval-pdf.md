# US-08 Immutable Plan PDF and Approval Implementation Plan

> **For agentic workers:** Execute each task with a separate implementer and independent reviewer. The primary agent accepts each review before the next task starts.

**Status:** owner-approved on 2026-10-02; implementation in progress.

**Goal:** Turn a US processor's validated draft into one immutable, auditable effective plan and English PDF, without adding HTTP routes, cabinet UI, release or deployment.

**Architecture:** A US-only approval service captures a consistent draft/configuration/actor snapshot, renders bounded deterministic PDF bytes, writes them to a separately configured private US artifact store under a unique attempt key, then reacquires short tenant-scoped locks and rechecks draft revision and configuration digest before committing one winner. A losing or failed attempt leaves the draft intact and can delete only its own unreferenced object. Published rows retain their frozen evidence and bytes; later changes are represented by a new draft/version, never by re-rendering a prior PDF.

**Tech stack:** Existing `@markiro/domain` plan rules, Drizzle/PostgreSQL, NestJS internal services, bundled-font PDF renderer, a narrow S3-compatible US adapter, Vitest with disposable `US_TEST_DATABASE_URL` and a fake object store.

**Spec:** `docs/superpowers/specs/2026-10-02-us-08-traceability-plan-current-design.md`. Follows the accepted rules, schema and draft-service plans dated 2026-10-02.

## Non-negotiable boundaries

- Stay on `codex/us-mvp`. Read root and `apps/api/AGENTS.md`; preserve RU routes, shared production storage, Station, existing releases and user data. No PR, merge, release or deployment. A reviewed checkpoint may be pushed only to the already-authorized US branch.
- No request-supplied tenant/actor/demo identity, configuration snapshot, digest, artifact key, approver or timestamp is trusted. Reload current membership and `traceability.qa.manage` plus `US_FSMA204_PROCESSOR` at the service boundary. Cross-tenant IDs are indistinguishable from absent IDs.
- A real tenant's procedure/contact/non-farm confirmations are explicit approval assertions attributed to the authenticated actor and server time. They are not evidence that backup, restore or legal compliance has been independently verified. The trusted local synthetic seed must be verified against its exact server-created identity; copied metadata, slug or client flags alone do not qualify.
- Use one frozen English model for preview and published PDF. Preview is marked `DRAFT — not effective`; a published synthetic PDF carries `Synthetic demo — not an operational record` on every page. No locale-dependent re-render or live lookup for an approved document.
- Store only through explicitly configured private US artifact credentials/bucket. No fallback to the RU/default S3 service or development values in a production US runtime. A cloud endpoint/region string alone does not prove physical non-RF residency or operational backup; those remain deployment gates.
- Approval must fail closed on incomplete master data, missing TLC-source location, unsupported farm scope, prohibited claims, missing real confirmations, stale draft/configuration, unready storage, duplicate/mismatched idempotency key and artifact verification failure. Preserve the draft on every failure.
- Use exact loopback `US_TEST_DATABASE_URL` and disposable databases for DB tests; never use a shared database. Keep sensitive narrative/contact text out of audit metadata and logs.

## Task 1: Frozen approval evidence and idempotency schema

**Files:** extend `packages/domain/src/traceability/plan/*` and focused tests; add strict internal approval input contract in `packages/platform-contracts/src/traceability/plans.ts` and tests; extend `packages/db/src/schema/traceability-plans.ts` with an additive migration and schema/migration tests; add a US-only trusted-seed verifier near the existing owner provisioning boundary and isolated tests.

- [ ] **Red:** Test an approved evidence envelope with configured facts, per-path provenance, exact actor/time confirmations and versioned application-policy source. Reject client-supplied demo markers and forged confirmation evidence. Test exact trusted seed identity and near-miss tenant/metadata/owner cases. Test idempotency-key reuse for another request digest and tenant isolation. Verify the schema migration fails before the new fields exist.
- [ ] **Green:** Define a versioned approved-evidence envelope around the existing snapshot rather than stamping draft `operator_pending` entries as approved. Derive `operator_confirmed` actor/time only on the server; use `synthetic_fixture` only after exact seed verification. Store a hash of the one-time idempotency key and a canonical request digest on the published version, with a tenant-scoped uniqueness constraint; drafts retain null fields. Do not store a raw key in audit or PDF. Keep migration additive and inspect constraints/indexes.
- [ ] **Verify/review:** Domain/contracts/db tests, typecheck/lint/build, migration tests and isolated authorization cases. Reviewer checks provenance completeness, seed proof, request-digest stability, compatibility with current draft rows and absence of a client demo override.

## Task 2: Deterministic English PDF and draft preview

**Files:** US-owned renderer and bundled licensed font assets under `apps/api/src/modules/traceability/plans/`; focused renderer tests and rendered-page inspection evidence. Do not import RU billing PDF services or runtime fonts from a network source.

- [ ] **Red:** Same frozen model and renderer version produce byte-identical output across repeated calls and EN/ES UI selection. Verify required sections, location/product facts as represented in the approved model, provenance, version/timezone/approver, non-farm statement, change summary, retention note and wording limitations. Multi-page synthetic output has the marker on every page; preview has the draft watermark and is not an approved artifact. Oversized text/array input fails a bounded validation rather than exhausting memory or silently truncating.
- [ ] **Green:** Render from a plain-text frozen model only, with fixed PDF metadata and bundled fonts. Pin a renderer version; store SHA-256 and byte count from the exact generated bytes. Avoid wall-clock generation timestamps, remote assets and unsafe markup. Keep preview ephemeral and separate from published storage.
- [ ] **Verify/review:** Focused tests, API static gates, visual inspection of sample PDF pages and text extraction for marker/required content. Reviewer checks deterministic bytes, clear synthetic/draft marking, readable pagination and no unearned compliance claim. Visual inspection is not a physical print or regulatory acceptance test.

## Task 3: Private US artifact adapter and failure semantics

**Files:** US-specific artifact interface/adapter and tests; US runtime configuration validation and variable inventory, without enabling an HTTP route or release. Reuse low-level S3 SDK patterns, not the default RU bucket/service instance.

- [ ] **Red:** Missing/ambiguous production US storage configuration refuses approval readiness; no fallback to `S3_BUCKET`. A fake private store proves verified put (hash/size/content type), bounded read, unique attempt keys, and delete restricted to an object created by the losing attempt. Simulate upload, verification, read and cleanup failures. Never delete a referenced winner or any other tenant's object.
- [ ] **Green:** Add the narrow adapter with explicit US bucket/credentials/endpoint inputs and bounded operations. Derive the object key from server tenant/version/attempt IDs, never client text. Return opaque storage evidence to the approval service; no public bucket ACL or long-lived unrestricted URL. Keep production readiness unavailable until separately configured/verified non-RF storage and backup procedures are evidenced operationally.
- [ ] **Verify/review:** Adapter/unit tests, env validation and US isolation gate; static API gates. Reviewer checks key isolation, no shared-store fallback, cleanup ownership and secret-free diagnostics. Do not claim cloud residency from tests.

## Task 4: Atomic internal approval, supersession and immutable read

**Files:** extend `apps/api/src/modules/traceability/plans/us-plan-store.ts` or add a focused approval service; isolated e2e/concurrency tests; add the guarded US-only test step. No controller/UI yet.

- [ ] **Red:** Test real confirmation missing, unknown/yes farm status, absent/incomplete TLC-source location, forbidden words, stale revision/config after render, wrong tenant/role/profile, duplicate/concurrent approval and same-key retry vs changed-key conflict. Inject storage failure and losing-attempt cleanup failure. Test v1 effective, v2 supersession, inclusive `retainThrough` with saved floor/hold, immutable v1 snapshot/PDF after source edits, winner object never deleted, and exact success/rejection audit actor/tenant/action/target/outcome/version/hash/request ID. The retained published detail must parse frozen evidence and verify stored object metadata, not live data.
- [ ] **Green:** Phase A, in a consistent short read transaction, authorize, capture draft revision/configuration digest, trusted seed classification, server approver/time and confirmations; validate and freeze. Render/upload/verify outside a long DB transaction. Phase B, lock tenant organization then relevant version rows, re-authorize and re-read config/draft, compare revision/digest, enforce the idempotency key, set new effective and old superseded atomically with retention calculation and exact audit. On losing/failed attempts, leave draft and winning object unchanged; clean only the unreferenced object owned by this attempt, reporting cleanup failure for an auditable retry. Published reads expose immutable evidence and hash, not a re-rendered PDF. Retried identical approval returns the original result even if its version is now superseded.
- [ ] **Verify/review:** Focused isolated DB and fault-injection tests, required domain/db/contracts/API package gates, `git diff --check`, scoped formatting and `node tools/us-development/check-isolation.mjs`. Add CI coverage to `.github/workflows/us-development.yml`; no release capability. Reviewer inspects lock order, TOCTOU recheck, idempotency, cross-tenant denial, retention, exact audit and no object deletion of a winner. Acceptance requires a separate review after any fix round.

## Handoff after acceptance

The next plan is the explicit US HTTP boundary (list/detail, draft/preview/approve/download) with OpenAPI and route-denial tests, followed by the EN/ES cabinet and an integrated synthetic browser flow. This stage alone does not make the service publicly reachable or prove non-RF storage, backups, recovery, deployment or regulatory acceptance.
