# US-09 — Trace request and mock recall drill — Design Spec

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

**Date:** 2026-09-03
**Status:** Draft for review (not implemented)
**Slice:** US-09 from docs/us/implementation-plan.md; depends on US-06 (trace query, completeness findings, search), US-07 (field registry, workbook), US-08 (effective plan PDF); consumed by US-11 (seed, evidence)
**Requirements:** RQ-001, RQ-002, RQ-003, RQ-004, RQ-005, RQ-006, RQ-007, RQ-008 (P1); contributes evidence to REG-008, EXP-008, EXP-010, NFR-005, NFR-013, EVD-006, C-013, C-014
**Related:**

- `docs/superpowers/specs/2026-09-03-us-traceability-design.md` — founding ADR
- `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` — `RequireTraceabilityProfile`, U.S. capabilities, `traceability_profiles.retention_years`
- `docs/superpowers/specs/2026-09-03-us-06-trace-search-completeness-design.md` — `TraceResult`, `runReadinessSweep`, `CompletenessFinding`, search result used to build a request
- `docs/superpowers/specs/2026-09-03-us-07-xlsx-export-adapter-design.md` — `TraceExportAdapterService.render`, registry version/hash, `buildTraceExportManifest`, `verifyTraceExportManifest`
- `docs/superpowers/specs/2026-09-03-us-08-traceability-plan-design.md` — `traceability_plan_versions`, `pdf_object_key`, `pdf_sha256`
- `docs/superpowers/specs/2026-08-27-inventory-operational-documents-design.md` — the deterministic ZIP + manifest precedent this slice copies
- `docs/us/requirements.md` (RQ, REG-008, EXP-008/010, NFR-005/013), `docs/us/data-dictionary.md` (§2, §3 `TraceRequest 1 ── * ExportRun ── * Artifact`, §4 "a trace request pins specific revisions", §8 endpoints, §9 tables), `docs/us/demo-scenario.md` (§5.3 REQ-2026-APPLE-001, §5.4 steps 7–8, §5.5), `docs/us/acceptance.md` (§1, §2.2, §2.3, §2.5, C-013, C-014), `docs/us/limitations.md` (no direct FDA submission)

## Problem

FDA-01 expects records for a traceability request within 24 hours. The FDA tabletop report (FDA-06) shows the hard part is not the format but the drill: knowing the deadline, finding the gaps before the package is built, and producing a package that can be reproduced later. Markiro needs a request record with a due time, a dry-run validation that surfaces missing or ambiguous data, a package (workbook, plan PDF, validation report, request report, manifest) whose inputs are frozen at generation so later corrections never rewrite a response already given, and a timed report proving the drill fits the acceptance targets. Nothing is sent to FDA (RQ-007).

## Key facts of the codebase

- Job infrastructure: `apps/api/src/jobs/jobs.module.ts` owns pg-boss. `BUILD_SHIFT_EXPORT_QUEUE` is created with `retryLimit: 5, retryDelay: 30, retryBackoff: true, retryDelayMax: 900, expireInSeconds: 900`; the worker is `boss.work(queue, { includeMetadata: true }, jobs => runner.run(job.data.exportId, { retryCount, retryLimit }))`; `reconcileQueuedShiftExports(boss)` re-enqueues rows left `queued` at boot; `PgBossService.enqueueShiftExport(id)` is the send helper. The same shape is used for `BUILD_INVENTORY_DOCUMENT_QUEUE`.
- Runner pattern: `apps/api/src/modules/shift-exports/shift-export-runner.service.ts` — `claim()` moves `queued` → `processing` fenced by `attempt_count` with a 20 s lease (`PROCESSING_LEASE_MS`), `refreshLease()`, object key `tenants/{tenantId}/shift-exports/{id}/attempt-{n}/part-{k}.{ext}`, `storage.putVerified`, `publishReady` inserts artifacts + audit in one transaction, `publishFailed` with a safe error-code list (`SHIFT_EXPORT_SAFE_ERROR_CODES`), requeue while `retryCount < retryLimit`, delete attempted objects on failure, `hasCommittedPublication` for ambiguous commits.
- Request-side idempotency: `apps/api/src/modules/shift-exports/shift-exports.service.ts` relies on unique `shift_exports_tenant_idempotency_uq (tenant_id, created_by_user_id, idempotency_key)`, detects 23505 by constraint name (`isIdempotencyConflict`), returns the existing row when the payload matches and 409 when it differs, restores `QUEUE_FAILED` rows, and throws 503 when the queue is unavailable.
- Download authorization: `ShiftExportsService.download()` joins artifact + export on `(tenant_id, export_id)`, requires `status = 'ready'`, returns `storage.presignRead(objectKey, 300, { downloadFilename })` and writes audit `shift_export.downloaded`; the controller (`shift-exports.controller.ts`) is guarded by `TenantGuard, AuthorizationGuard, SubscriptionAccessGuard`, `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)` and `@AllowSubscriptionReadOnly("export")` for generation routes.
- Schema precedents: `packages/db/src/schema/shift-exports.ts` (`shift_export_status` enum queued/processing/ready/failed, `shift_exports_status_consistency` check, artifacts with `sha256 ~ '^[0-9a-f]{64}$'`), `packages/db/src/schema/inventory.ts` `inventory_document_runs` (`result_revision`, `request_digest char(64)`, snapshot columns, `source_snapshot_started_at/completed_at`) and `inventory_document_artifacts` (`downloaded_at`, `downloaded_by_user_id`, `invalidated_at`).
- Deterministic ZIP: `apps/api/src/modules/inventories/inventory-document-runner.service.ts` builds the archive with `fflate.zipSync`, `ZIP_MTIME = 2000-01-01`, level 9, `manifest.json` first (`schemaVersion`, `runId`, `resultRevision`, `artifacts[{ name, mimeType, bytes, sha256, ... }]`), rejects case-folding filename collisions and hash mismatches; `apps/api/test/inventory-document-runner.test.ts` "is byte-deterministic and contains an exact checksummed manifest".
- Evidence tooling: `tools/evidence-package/evidence-package.mjs` exports `buildManifest`, `sealEvidencePackage` (writes `manifest.json` + `SHA256SUMS` atomically and re-hashes to confirm nothing changed) and `verifyEvidencePackage`; CLI wrappers `seal.mjs`/`verify.mjs`. Its manifest requires `operationId` matching `/^INV-\d{8}-[a-z0-9-]{2,40}-\d{2}$/`, i.e. it is inventory-specific today.
- Object storage: `apps/api/src/modules/storage/object-storage.service.ts` — `putVerified`, `presignRead` (max 300 s), `get` capped at 5 MiB (`MAX_PRIVATE_OBJECT_BYTES`), `assertSafeKey` accepts `tenants/` keys.
- Audit: `tenant_audit_events` (`packages/db/src/schema/team.ts`); write idiom `writeAudit` in the shift-exports service and runner.
- "Task with due date": the only existing due concept is `invoices.due_date` (`packages/db/src/schema/billing.ts:277`); there is no generic task/deadline entity to reuse.
- Runtime PDF renderer and determinism precedent: see US-08 Key facts (`@react-pdf/renderer`, `inventory-act-pdf.test.ts`).
- Admin precedents: shift export dialog polling (`apps/admin/test/shift-exports-dialog.test.tsx`), page structure `apps/admin/src/pages/<area>/{api.ts,schemas.ts,index.tsx}`, `apiFetch` in `apps/admin/src/api/client.ts`, UI primitives `Alert`, `StatusChip`, `DataTabs`, `Drawer`, `ConfirmDialog`, `DefinitionGrid`, `Table` in `packages/ui/src/components`.
- OpenAPI gate `apps/api/test/openapi-coverage.test.ts` and helpers in `apps/api/src/lib/openapi.ts`.
- Sibling-spec contracts this slice consumes: US-00 capabilities `traceability.read`, `traceability.qa.manage`, `traceability.export.read`, guard `RequireTraceabilityProfile(...)` + `TraceabilityProfileGuard` (403 on mismatch), `traceability_profiles.retention_years`, and `apps/api/test/authorization-metadata.test.ts` listing every traceability controller; US-06 `TraceResult` (events with `revision`, `excluded` void/draft, `provenance` on every node and edge) and `runReadinessSweep(input): CompletenessFinding[]` with `{ code, severity: error|warning|info, cte, field, message, provenance, lotId?, productId?, partyId?, eventId?, eventRevision? }`, explicitly not persisted ("US-09 stores its own dry-run snapshot"); US-07 `TraceExportAdapterService.render(input) → { artifacts: { kind, filename, mediaType, bytes, sha256, byteSize }[], findings, manifestEntries, timings }`, artifact kinds `xlsx|csv_zip|canonical_json|validation_report|manifest|plan_pdf`, `registry_version` per artifact, object keys `tenants/<tenantId>/traceability/exports/<runId>/attempt-<n>/<filename>`, domain `buildTraceExportManifest`/`verifyTraceExportManifest`, and audit actions `trace_export_run.completed|failed` carrying `registryVersion`, `registryHash`, `errorsCount`, `warningsCount`.

## Design

### Data model

Three tables in `packages/db/src/schema/traceability.ts` (names from data-dictionary §9). Every table carries `tenant_id` and `UNIQUE (tenant_id, id)`; cross-entity references are composite tenant FKs.

```sql
CREATE TYPE trace_request_status AS ENUM
  ('open', 'validated', 'package_ready', 'export_ready', 'closed');
CREATE TYPE trace_export_run_status AS ENUM ('queued', 'processing', 'ready', 'failed');
CREATE TYPE trace_export_artifact_kind AS ENUM
  ('xlsx', 'csv_zip', 'canonical_json', 'validation_report', 'plan_pdf',
   'request_report', 'manifest', 'package_zip');   -- US-07 kinds + request_report, package_zip
   -- csv_zip and canonical_json are P1 (EXP-009): declared here so the enum is
   -- stable, never produced by the P0 runner (see "Package generation").
CREATE TYPE trace_qa_decision AS ENUM ('approved', 'rejected');

CREATE TABLE trace_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES organization(id),
  request_number text NOT NULL,                     -- e.g. REQ-2026-APPLE-001
  requester_name text NOT NULL,
  requester_organization text,
  requester_contact text,                           -- phone/email as given, not normalized
  received_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,                      -- default received_at + 24h (domain)
  alternate_deadline_reason text,                   -- required when due_at <> received_at + 24h
  scope jsonb NOT NULL,                             -- TraceRequestScope (below)
  status trace_request_status NOT NULL DEFAULT 'open',
  last_validation jsonb,                            -- findings + counts + inputDigest
  last_validated_at timestamptz,
  validation_acknowledged_at timestamptz,
  validation_acknowledged_by_user_id text REFERENCES "user"(id),
  validation_acknowledgement_reason text,
  validation_acknowledged_digest char(64),
  created_by_user_id text NOT NULL REFERENCES "user"(id),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trace_requests_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT trace_requests_tenant_number_uq UNIQUE (tenant_id, request_number),
  CONSTRAINT trace_requests_due_after_received CHECK (due_at > received_at),
  CONSTRAINT trace_requests_alternate_deadline_reason CHECK
    (due_at = received_at + interval '24 hours' OR alternate_deadline_reason IS NOT NULL),
  CONSTRAINT trace_requests_ack_consistency CHECK
    ((validation_acknowledged_at IS NULL AND validation_acknowledged_by_user_id IS NULL
      AND validation_acknowledgement_reason IS NULL AND validation_acknowledged_digest IS NULL)
     OR (validation_acknowledged_at IS NOT NULL AND validation_acknowledged_by_user_id IS NOT NULL
      AND validation_acknowledgement_reason IS NOT NULL AND validation_acknowledged_digest IS NOT NULL))
);
CREATE INDEX trace_requests_tenant_due_idx ON trace_requests (tenant_id, due_at);

CREATE TABLE trace_export_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES organization(id),
  request_id uuid NOT NULL,
  revision integer NOT NULL,                        -- 1..n per request
  status trace_export_run_status NOT NULL DEFAULT 'queued',
  error_code text,
  created_by_user_id text NOT NULL REFERENCES "user"(id),   -- operator (RQ-004)
  idempotency_key uuid NOT NULL,
  input_snapshot jsonb NOT NULL,                    -- frozen at run creation (RQ-005)
  input_digest char(64) NOT NULL,
  plan_version_id uuid NOT NULL,                    -- effective plan at run creation
  field_registry_version text NOT NULL,             -- US-07
  export_ready boolean NOT NULL DEFAULT false,        -- RQ-003 outcome for this revision
  validation_summary jsonb NOT NULL,                -- { errors, warnings, blocking, acknowledged }
  started_at timestamptz NOT NULL DEFAULT now(),    -- operator pressed "Prepare package"
  generation_started_at timestamptz,                -- first worker claim
  completed_at timestamptz,
  elapsed_ms bigint GENERATED ALWAYS AS
    (CASE WHEN completed_at IS NULL THEN NULL
          ELSE (EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::bigint END) STORED,
  attempt_count integer NOT NULL DEFAULT 0,
  qa_decision trace_qa_decision,                    -- RQ-008 (P1)
  qa_decided_by_user_id text REFERENCES "user"(id),
  qa_decided_at timestamptz,
  qa_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trace_export_runs_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT trace_export_runs_tenant_request_revision_uq UNIQUE (tenant_id, request_id, revision),
  CONSTRAINT trace_export_runs_tenant_actor_idempotency_uq
    UNIQUE (tenant_id, created_by_user_id, idempotency_key),
  CONSTRAINT trace_export_runs_tenant_request_fk FOREIGN KEY (tenant_id, request_id)
    REFERENCES trace_requests (tenant_id, id),
  CONSTRAINT trace_export_runs_tenant_plan_fk FOREIGN KEY (tenant_id, plan_version_id)
    REFERENCES traceability_plan_versions (tenant_id, id),
  CONSTRAINT trace_export_runs_input_digest_check CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trace_export_runs_status_consistency CHECK (
    (status = 'ready' AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
    OR (status IN ('queued', 'processing') AND completed_at IS NULL AND error_code IS NULL)),
  CONSTRAINT trace_export_runs_qa_consistency CHECK (
    (qa_decision IS NULL AND qa_decided_by_user_id IS NULL AND qa_decided_at IS NULL AND qa_reason IS NULL)
    OR (qa_decision IS NOT NULL AND qa_decided_by_user_id IS NOT NULL AND qa_decided_at IS NOT NULL AND qa_reason IS NOT NULL))
);
CREATE INDEX trace_export_runs_queued_created_idx ON trace_export_runs (created_at) WHERE status = 'queued';

CREATE TABLE trace_export_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES organization(id),
  run_id uuid NOT NULL,
  kind trace_export_artifact_kind NOT NULL,
  registry_version text,                            -- US-07 registry that produced xlsx/csv/json
  filename text NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 char(64) NOT NULL,
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trace_export_artifacts_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT trace_export_artifacts_tenant_run_kind_uq UNIQUE (tenant_id, run_id, kind),
  CONSTRAINT trace_export_artifacts_tenant_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES trace_export_runs (tenant_id, id),
  CONSTRAINT trace_export_artifacts_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT trace_export_artifacts_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
```

`TraceRequestScope` (RQ-002): `{ productDescription?: string, productIds?: uuid[], dateRange?: { from: date, to: date }, tlcs?: string[], locationIds?: uuid[], lotIds?: uuid[], searchQuery?: object }` with at least one selector; `lotIds` and `searchQuery` are filled when the request is built from a US-06 search result (TRC-008).

`input_snapshot` (RQ-005): `{ frozenAt, regulatoryBaselineId, timeZone, softwareVersion, planVersionId, planPdfSha256, fieldRegistryVersion, events: [{ eventId, eventType, revision }], lots: [TraceLotPin], locations: [TraceLocationPin], products: [TraceProductPin], masterDataDigest }`, arrays sorted by id; `input_digest` is the SHA-256 of the canonical JSON.

What is pinned by reference and what is pinned by content:

- KDE rows (Receiving, Transformation, Shipping tabs) are built only from finalized event revisions, which carry immutable `location_snapshot`, `product_snapshot` and document snapshots (US-03 §Data model). Pinning `{ eventId, revision }` is therefore sufficient for every workbook row; the runner loads exactly those revisions and never the current one.
- Lots are not revisioned in US-02, and the Metadata/Definitions tabs, the request report and the lot-level Validation rows read lot identity and current master data directly. Those values are pinned as content at run creation: `TraceLotPin = { lotId, tlc, productId, assignmentBasis, sourceLocationId, sourceReference, status, productionDate, expiryDate, originEventId }` (US-02 `traceability_lots` columns), `TraceLocationPin = { locationId, businessName, phoneNumber, addressKind, streetAddress, latitude, longitude, city, stateOrRegion, zipOrPostalCode, countryCode, roles }` (US-01 Location Description; the TLC source description printed for each lot), `TraceProductPin = { productId, description: ProductDescriptionSnapshot (US-02 `buildProductSnapshot`), coverageStatus, ftlCategory }`. `masterDataDigest` is the SHA-256 of the canonical JSON of the three arrays and is printed in the Metadata tab.
- The runner renders from `input_snapshot` only (`trace-export-source.service.ts` takes the snapshot, not the scope); it may read `traceability_lots`/`traceability_locations`/`product_traceability_profiles` solely to detect a pinned id that no longer exists (`SNAPSHOT_EVENT_MISSING` applies to events; a missing lot/location/product row is not an error because the pinned content is complete).

Later amendments create new event revisions (data-dictionary §6) and therefore a different digest; a prior run keeps rendering from its own pinned revisions and pinned master-data content.

Runs and artifacts are never deleted or rewritten in P0; regeneration is always a new `revision`.

### Domain rules

`packages/domain/src/traceability/requests/` (pure):

- `defaultDueAt(receivedAt)` = `receivedAt + 24h` in absolute time (no calendar arithmetic, so a DST day still yields exactly 24 h); `requiresAlternateReason(receivedAt, dueAt)`.
- `validateTraceRequestScope(scope)` — at least one selector, date range ordered, TLCs trimmed and non-empty, no duplicates.
- `buildTraceRequestInputSnapshot(traceResult, context)` and `inputSnapshotDigest(snapshot)` — the trace result comes from US-06 (events with `revision`, lots, locations, products); the builder copies the pinned master-data fields listed above into `lots`/`locations`/`products` (content, not just ids) and computes `masterDataDigest`; the digest is independent of input order.
- `evaluateValidation(findings, acknowledgement)` → `{ errors, warnings, blocking, acknowledged }`; `blocking = errors > 0` (acknowledgement never waives an error). Findings are US-06 `CompletenessFinding`s (`code`, `severity`, `cte`, `field`, `message`, `provenance`, `eventId?`, `eventRevision?`, `lotId?`), so every row points back to its source record (TRC-009).
- `traceRequestTransition(status, event)` — `open --validate--> validated`, `validated|open --run_ready(export_ready=false)--> package_ready`, `--run_ready(export_ready=true)--> export_ready`, any `--close--> closed`; `closed` accepts nothing.
- `buildRequestReportModel(request, run, artifacts, operator, reviewer?)` — requester, scope, received/due (tenant tz + UTC), timing (`started_at`, `generation_started_at`, `completed_at`, `elapsed_ms`), operator time (`completed_at − request.created_at`), validation summary, artifact table (name, media type, bytes, SHA-256), baseline ID (REG-001), allowed-wording disclaimer, and the sentence "Package prepared in the U.S. instance; delivery to the requester is performed by the covered entity" (RQ-007).
- Manifest: US-07 owns `buildTraceExportManifest(entries)` (`schemaVersion`, `packageId`, `requestId`, `requestRevision`, `exportRunId`, `generatedAt`, `registry`, `regulatoryBaseline`, `artifacts[{ name, byteSize, mediaType, sha256 }]`); US-09 feeds it every artifact including `request-report.pdf` and sets `generatedAt = frozenAt` and `packageId = requestNumber-r<revision>` so the manifest is reproducible (EXP-008). `inputDigest` and `softwareVersion` are added as top-level keys (OQ-US09-20).
- `buildTracePackageZip(manifest, artifacts)` — copies the inventory ZIP idiom (fixed mtime, level 9, `manifest.json` first, `SHA256SUMS` second, collision and hash checks). P0 package contents are exactly: workbook (`xlsx`), plan PDF (`plan_pdf`), `validation.json` (`validation_report`), `request-report.pdf` (`request_report`), `manifest.json` (`manifest`); the ZIP itself is stored as `package_zip`.
- `verifyTracePackage(entries)` — unzips, delegates to US-07 `verifyTraceExportManifest(manifest, files)` and additionally checks `SHA256SUMS`; used by the API test and by the CLI (OQ-US09-4).

### Contracts and API

Zod contracts in `packages/platform-contracts/src/traceability/requests.ts` (`.strict()`): `traceRequestScopeSchema`, `createTraceRequestBodySchema`, `updateTraceRequestBodySchema`, `traceRequestSchema`, `validationFindingSchema`, `validationResultSchema`, `acknowledgeValidationBodySchema { reason, inputDigest }`, `createExportRunBodySchema { idempotencyKey }`, `traceExportRunSchema`, `traceExportArtifactSchema`, `exportDownloadResponseSchema { url, filename, expiresInSeconds: 300 }`, `qaSignoffBodySchema { decision, reason }`.

Module `apps/api/src/modules/traceability/requests/` (`trace-requests.controller.ts`, `trace-requests.service.ts`, `trace-export-runner.service.ts`, `trace-export-source.service.ts`, `request-report-pdf.tsx`). Guards as in shift exports plus `TraceabilityProfileGuard` with `@RequireTraceabilityProfile("US_FSMA204_PROCESSOR")` (generic profile per OQ-US09-16); the controller is listed in `authorization-metadata.test.ts`. Capabilities from US-00 (OQ-US09-14): `traceability.read` (auditor: GET routes), `traceability.export.read` (downloads), `traceability.qa.manage` (create, validate, acknowledge, prepare, retry, close, P1 sign-off). Generation routes use `@AllowSubscriptionReadOnly("export")`.

| Method | Route                                                | Behavior                                                                                                                                                             |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/traceability/requests`                             | List with `status`, `dueBefore` filters; newest first.                                                                                                               |
| POST   | `/traceability/requests`                             | Create; `dueAt` defaults to +24 h; alternate deadline needs a reason (400 otherwise).                                                                                |
| GET    | `/traceability/requests/:id`                         | Detail with `lastValidation`, runs and artifacts.                                                                                                                    |
| PUT    | `/traceability/requests/:id`                         | Requester/scope edits while not `closed`; scope change clears acknowledgement (OQ-US09-10).                                                                          |
| POST   | `/traceability/requests/:id/validate`                | Synchronous dry run through US-06 completeness over the scope; persists `last_validation`, returns findings and `inputDigest`.                                       |
| POST   | `/traceability/requests/:id/acknowledge-validation`  | Records reason + digest; 409 `validation_stale` if the digest differs from `last_validation.inputDigest`.                                                            |
| POST   | `/traceability/requests/:id/exports`                 | Freezes the snapshot in the same transaction as the run insert (revision = max + 1 under a request-row lock), computes `export_ready`, enqueues; idempotent per key. |
| GET    | `/traceability/requests/:id/exports`                 | Run history for the request.                                                                                                                                         |
| GET    | `/traceability/exports/:id`                          | Run detail with artifacts, timing and QA decision.                                                                                                                   |
| POST   | `/traceability/exports/:id/retry`                    | Failed runs with retryable codes only, like `ShiftExportsService.retry`.                                                                                             |
| GET    | `/traceability/exports/:id/download?artifact=<kind>` | Presigned URL (300 s) for one artifact of a `ready` run; default `package_zip`; audited.                                                                             |
| POST   | `/traceability/exports/:id/signoff`                  | P1: QA approve/reject with reason; one decision per run.                                                                                                             |
| POST   | `/traceability/requests/:id/close`                   | Closes the request; runs stay downloadable.                                                                                                                          |

Package generation (`BUILD_TRACE_EXPORT_QUEUE = "build-trace-export"`, registered in `jobs.module.ts` with the shift-export queue options and a boot reconciliation): the runner claims the run with attempt fencing and lease, sets `generation_started_at` on first claim, loads the pinned event revisions and lots from `input_snapshot` (never re-queries by scope), uses the pinned findings to produce `validation-report.json`, calls US-07 `TraceExportAdapterService.render` with the pinned registry version (P0: `xlsx` and `validation_report`; the `csv_zip` and `canonical_json` kinds are P1 per EXP-009 and are not requested by the P0 runner, so no P0 package, manifest or acceptance evidence contains them), fetches the plan PDF bytes by `plan_version_id` (`storage.get`, well below the 5 MiB cap) and asserts the SHA-256 equals `traceability_plan_versions.pdf_sha256`, renders `request-report.pdf` (react-pdf, `creationDate = frozenAt`, en-US formatting in tenant timezone), builds `manifest.json` and the ZIP, uploads each artifact with `putVerified` under `tenants/{tenantId}/traceability/exports/{runId}/attempt-{n}/{filename}` (US-07 convention), and publishes artifacts + status + audit in one transaction. Safe error codes: `PLAN_NOT_EFFECTIVE`, `PLAN_PDF_MISMATCH`, `SCOPE_EMPTY`, `SNAPSHOT_EVENT_MISSING`, `REGISTRY_VERSION_UNKNOWN`, `GENERATION_FAILED`, `STORAGE_FAILED`, `QUEUE_FAILED`. No FDA or arbitrary external HTTP call exists in this path; approved object storage and internal services remain required; there is no FDA endpoint or credential variable in `apps/api/src/env.ts` (RQ-007).

Audit events (`tenant_audit_events`; `actor_user_id = req.userId` or the run's `created_by_user_id` inside the worker; `outcome` success/failure; `after` always includes `tenantId`, `requestId`, `requestNumber`):

| Target type        | Action                                          | Extra `after` fields                                                                                                      |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `trace_request`    | `trace_request.created`                         | `receivedAt`, `dueAt`, `alternateDeadline` (bool), scope summary                                                          |
| `trace_request`    | `trace_request.updated`                         | `changedKeys`                                                                                                             |
| `trace_request`    | `trace_request.validated`                       | `errors`, `warnings`, `blocking`, `inputDigest`                                                                           |
| `trace_request`    | `trace_request.validation_acknowledged`         | `reason`, `inputDigest`                                                                                                   |
| `trace_request`    | `trace_request.closed`                          | none                                                                                                                      |
| `trace_export_run` | `trace_export_run.created`                      | `revision`, `inputDigest`, `planVersionId`, `exportReady`                                                                 |
| `trace_export_run` | `trace_export_run.completed`                    | `revision`, `elapsedMs`, `registryVersion`, `registryHash`, `errorsCount`, `warningsCount`, `artifacts[{ kind, sha256 }]` |
| `trace_export_run` | `trace_export_run.failed` / `.retried`          | `errorCode`, `attemptCount`                                                                                               |
| `trace_export_run` | `trace_export_run.downloaded`                   | `artifactKind`, `filename`, `sha256`                                                                                      |
| `trace_export_run` | `trace_export_run.qa_approved` / `.qa_rejected` | `reason`                                                                                                                  |

### Admin UI

`apps/admin/src/pages/traceability/requests/`:

- `TraceRequestsPage` — table: request number, requester, received, due with a countdown `StatusChip` ("Due in 5 h 12 m", "Overdue by 40 m", text plus icon, never color only), status, latest revision, actions. Primary action "New trace request". `EmptyState` explains the drill with allowed wording.
- `TraceRequestWizard` (four `DataTabs` steps, each a form; state is persisted server-side after step 1 so a reload does not lose the drill):
  1. Requester and timing — requester fields, `received_at` (default now in tenant tz), `due_at` pre-filled +24 h and shown as a live countdown; editing it reveals the mandatory "Agreed alternate deadline reason" field.
  2. Scope — product, date range, TLC list, locations; pre-filled from router state when opened from the US-06 search page ("Create trace request from this result", button owned by US-06). Shows the matched lot/event counts from a lightweight preview call.
  3. Validation — "Run validation" button; findings grouped by severity and CTE with links to the event/lot; "Acknowledge and continue" requires a reason and is shown only when errors exist; a stale banner appears when data changed since the last validation.
  4. Prepare package — single button labelled "Prepare package" (never "submit"/"send"); progress polled like the shift export dialog; on `ready`: timing panel (`DefinitionGrid`: started, completed, elapsed, operator), artifact table (name, size, SHA-256 with copy button), "Download package (ZIP)" and per-artifact downloads; `export_ready` chip; P1 QA sign-off panel with approve/reject and reason.
- `TraceRequestDetailPage` — header with due countdown, revision history (each run: revision, status, export-ready, elapsed, operator, QA decision, downloads), "Prepare new revision" (explains that a new revision freezes current data and never replaces prior packages), "Close request".
- Navigation: "Trace requests" under the Traceability group (US-00 gating), requires `traceability.read`; write actions need `traceability.qa.manage`, downloads `traceability.export.read`.
- i18n keys `pages.traceability.requests.*` (US-01 convention) in `en.json` and `es.json`; the prohibited-wording content test covers them; the words "FDA", "submit", "upload" must not appear in button labels.
- Accessibility: wizard steps are reachable by keyboard, live countdown uses `aria-live="polite"` at most once per minute, all findings rows have text severity, download links announce file type and size.

### Station

Not touched.

### Profile gating and RU_CHZ safety

- All routes are behind the US-00 profile guard; `RU_CHZ` tenants get 403 `traceability_profile_required` and no navigation. The queue and reconciliation worker are registered only in the U.S. edition; the RU composition root excludes them; the reconciliation query touches only `trace_export_runs`.
- Additive migration only (three tables, four enums); no existing table changes.
- No CommerceML/CHZ imports in the module or domain folder (INT-004).

## Testing

- Unit (`packages/domain`): `defaultDueAt` across a DST transition day equals exactly 24 h; `requiresAlternateReason`; scope validation; snapshot digest is order-independent and changes when any event revision changes; `evaluateValidation` blocking/acknowledged matrix incl. stale digest; transitions; manifest key order and artifact sorting; ZIP byte-determinism across two builds with shuffled artifacts; `verifyTracePackage` detects a tampered byte and a missing entry.
- DB (`packages/db`): fresh + upgrade migration; composite FKs reject a run whose `plan_version_id` belongs to another tenant; unique revision per request; status, ack and QA consistency checks; generated `elapsed_ms`.
- API e2e (`apps/api/test/trace-requests.e2e.test.ts`, `trace-export-runner.test.ts`): create with default due; alternate deadline without reason → 400; validate persists findings; acknowledge with stale digest → 409; export creates revision 1 with frozen snapshot and `generation_started_at`/`completed_at`/`elapsed_ms` set (RQ-004); amend a receiving event afterwards, download revision 1 again → same object keys and SHA-256, snapshot unchanged (RQ-005, acceptance §2.2 "request snapshot remains stable after later amendments"); edit a lot's TLC source location description, a location's business name and a product's description after revision 1, then re-run the runner on revision 1's `input_snapshot` from a fresh worker → byte-identical workbook and request report (pinned master-data content, not current rows), while revision 2 reflects the edits and has a different `masterDataDigest`; same idempotency key → same run, new key → revision 2 with a different digest (NFR-005); retry only from retryable codes; plan PDF SHA mismatch → `PLAN_PDF_MISMATCH`; download only for `ready`; cross-tenant: tenant B's request/run/artifact ids → 404 on every route and no audit row; RU tenant → 403; `manager` without `traceability.qa.manage` → 403 on write routes; audit rows asserted field by field; the generation path is executed with an egress spy proving no FDA or arbitrary external call while permitting approved storage/internal services (RQ-007); package ZIP unzipped and verified with `verifyTracePackage`; workbook, plan PDF, validation report, request report, manifest all present (RQ-006).
- Performance (`apps/api/test/trace-export-performance.test.ts`, database-backed, skipped without `DATABASE_URL`): seed dataset package completes in < 60 s and the measured `elapsed_ms` is written to the evidence log (EXP-010, NFR-013, C-014).
- Admin: countdown rendering (future/overdue), alternate-reason field appears on due edit, step 3 acknowledgement requires a reason, "Prepare package" label, revision list ordering.
- Browser (acceptance §2.3 "trace request wizard and validation", "artifact package and manifest download"): full drill from search result to ZIP download with screenshots.
- Negative cases from acceptance §2.4 that apply: master data edited after finalization → historical export unchanged; duplicate retry → no duplicate run; cross-tenant ID → denied; covered product with unknown FTL status → validation error blocks `export_ready`.

## Evidence

- Timed mock request report `request-report.pdf` (+ `.json`) for REQ-2026-APPLE-001 showing operator time < 15 min and package time < 60 s (C-013, C-014); the drill is run from a clean seed by the US-11 evidence mode.
- `trace-request-REQ-2026-APPLE-001-r1.zip`, its `manifest.json`, `SHA256SUMS` and the `verifyTracePackage` output (EXP-008, EVD-006); the workbook and plan PDF hashes cross-referenced to the US-07 golden fixture and the US-08 version row.
- Screenshots: request list with countdown, validation step with findings, package step with timing and artifacts.
- The package directory is sealed with `tools/evidence-package` by US-11 once OQ-US09-4 is resolved.

## Out of scope

Direct FDA submission or Safety Reporting Portal integration, email delivery of packages, EPCIS output, CSV/JSON derived files (EXP-009 P1, US-07; the `csv_zip`/`canonical_json` enum values exist but no P0 run produces them), partner expectation profiles, multi-request bulk drills, purge of old runs, SLA notifications beyond the in-app countdown.

## Open questions

| ID         | Question                                                                                                                                                                                                                         | Options                                                                                                                                                                              | Recommendation                                                                                                                                                                                    | Blocking? |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US09-1  | Where is the input snapshot frozen?                                                                                                                                                                                              | (a) in the POST `/exports` transaction before enqueue; (b) in the worker on first claim                                                                                              | (a): the trace query is < 2 s (NFR-013) and the frozen revision list is then visible immediately                                                                                                  | yes       |
| OQ-US09-2  | May a package be generated while blocking findings are unacknowledged?                                                                                                                                                           | (a) historical draft proposal, superseded; (b) hard 409 until errors are resolved                                                                                                    | Resolved by CLAR-03: errors block export-ready; diagnostic and authorized incomplete available-records downloads remain available. No error waiver. See [MVP contract](../../us/mvp-contract.md). | no        |
| OQ-US09-3  | Where do dry-run results live?                                                                                                                                                                                                   | (a) `trace_requests.last_validation` jsonb; (b) a `trace_validation_runs` table                                                                                                      | (a) for P0; (b) if auditors need every dry run kept                                                                                                                                               | no        |
| OQ-US09-4  | Verify command: `tools/evidence-package` requires `operationId` matching `^INV-\d{8}-...`, so it cannot seal a trace package                                                                                                     | (a) generalize the regex in the tool (touches an existing file); (b) new `tools/us-demo/verify-trace-package.mjs` over `verifyTracePackage`; (c) both                                | (b) for the package itself plus `SHA256SUMS` compatible with `sha256sum -c`; (a) decided by US-11 for sealing the evidence directory                                                              | yes       |
| OQ-US09-5  | Request report format                                                                                                                                                                                                            | (a) PDF + JSON; (b) JSON only; (c) PDF only                                                                                                                                          | (a): PDF for reviewers, JSON for automated evidence                                                                                                                                               | no        |
| OQ-US09-6  | Is the ZIP stored as an artifact or assembled on download?                                                                                                                                                                       | (a) stored, one SHA-256; (b) assembled per download                                                                                                                                  | (a): reproducible hash and no 5 MiB `storage.get` concern on download                                                                                                                             | no        |
| OQ-US09-7  | QA sign-off (P1) placement                                                                                                                                                                                                       | (a) columns on `trace_export_runs`; (b) separate `trace_signoffs` table                                                                                                              | (a): one decision per package revision                                                                                                                                                            | no        |
| OQ-US09-8  | Request status enum                                                                                                                                                                                                              | (a) `open/validated/package_ready/export_ready/closed`; (b) also `qa_approved/qa_rejected`; (c) minimal `open/closed` + derived flags                                                | (a) with QA decision on the run; revisit when RQ-008 is scheduled                                                                                                                                 | no        |
| OQ-US09-9  | `started_at` semantics for RQ-004                                                                                                                                                                                                | (a) operator click (run creation); (b) first worker claim                                                                                                                            | (a) as `started_at`, (b) kept as `generation_started_at`; report prints both                                                                                                                      | no        |
| OQ-US09-10 | Scope edits after a run exists                                                                                                                                                                                                   | (a) allowed, clears acknowledgement, next run pins new data; (b) forbidden, create a new request                                                                                     | (a); prior runs stay immutable regardless                                                                                                                                                         | no        |
| OQ-US09-11 | `request_number`                                                                                                                                                                                                                 | (a) user-entered, unique per tenant; (b) generated `REQ-YYYY-NNN`                                                                                                                    | (a) to match the requester's reference (demo uses REQ-2026-APPLE-001)                                                                                                                             | no        |
| OQ-US09-12 | Alternate deadline reason                                                                                                                                                                                                        | (a) free text; (b) enum (`agreed_with_fda`, `extension_requested`, `other`) + text                                                                                                   | (a) in P0                                                                                                                                                                                         | no        |
| OQ-US09-13 | Operator-time metric for C-013                                                                                                                                                                                                   | (a) `run.completed_at − request.created_at` printed in the report; (b) manual stopwatch note only                                                                                    | (a) plus a manual note in the evidence log                                                                                                                                                        | no        |
| OQ-US09-14 | Capabilities: US-00 defines `traceability.qa.manage` for QA work. Does the request workflow need a finer split?                                                                                                                  | (a) reuse `traceability.qa.manage` for everything incl. P1 sign-off; (b) add `traceability.request.manage` and `traceability.qa.signoff` so the preparer and the reviewer can differ | (a) in P0; (b) when RQ-008 is scheduled                                                                                                                                                           | no        |
| OQ-US09-15 | Idempotency key scope                                                                                                                                                                                                            | (a) per actor like shift exports; (b) per tenant                                                                                                                                     | (a), reusing the proven constraint/conflict idiom                                                                                                                                                 | no        |
| OQ-US09-16 | Trace requests under `US_GENERIC_LOT_TRACEABILITY`                                                                                                                                                                               | (a) processor only; (b) generic too, package without plan PDF and worded "recall drill"                                                                                              | (a) in P0; (b) is a later scope decision                                                                                                                                                          | no        |
| OQ-US09-17 | `softwareVersion` source for the manifest/report                                                                                                                                                                                 | (a) `apps/api/package.json` version + git SHA env var; (b) release tag only                                                                                                          | Resolved: US-00 owns immutable build metadata; consumers share it. See [MVP contract](../../us/mvp-contract.md).                                                                                  | no        |
| OQ-US09-18 | Retention of runs and artifacts                                                                                                                                                                                                  | (a) never purged in P0, subject to the US-00 retention floor; (b) `retention_until` per run                                                                                          | (a)                                                                                                                                                                                               | no        |
| OQ-US09-19 | Data-dictionary §8 lists only four request/export endpoints; this spec adds validate-acknowledge, run detail, retry, sign-off, close                                                                                             | (a) accept the extension and update `docs/us/data-dictionary.md`; (b) fold into fewer routes                                                                                         | (a)                                                                                                                                                                                               | no        |
| OQ-US09-20 | Manifest ownership and naming: US-07 defines `buildTraceExportManifest` and audit actions `trace_export_run.*`; this spec adopts both and adds `inputDigest`/`softwareVersion` keys and the `request_report`/`package_zip` kinds | (a) accept and keep US-07 as owner of the manifest builder; (b) move the manifest to US-09                                                                                           | (a); both authors must update their specs to the merged artifact-kind enum                                                                                                                        | no        |

## Revised P0 preparation rule

The shared contract resolves OQ-US09-2: any blocking finding prevents export-ready package generation, even if acknowledged. A diagnostic report and authorized Available records — incomplete response remain downloadable while the due clock continues. Missing plan, empty scope and truncated trace remain explicit findings; unsupported profiles and permission denial block both modes. CLAR-03 supersedes the earlier diagnostic-only fallback.

Freeze request metadata, findings, lifecycle state, genealogy and full baseline/registry stamps in addition to the content already listed above. Read a consistent snapshot and never rebuild an old run from live request fields or current event status. A changed idempotency payload conflicts. Report/manifest/ZIP hashes follow the acyclic shared-contract order. Use a bigint for elapsed milliseconds. Request age is session elapsed time, not independently measured active human effort.

## Approved available-records mode — 2026-09-05

Implement [CLAR-03](../../us/development-clarifications.md) within the existing run pipeline: mode participates in the request input digest, immutable run snapshot and idempotency conflict check. Freeze actual records, source/lifecycle metadata, gaps and actor; include available artifacts and explicitly list missing ones. Reuse fresh tenant membership/export capability checks; authorized auditors download without preparing or mutating runs. Record a distinct incomplete result in audit and artifact history. Neither download nor sign-off automatically fulfils the request or clears readiness errors. Both UI languages distinguish this from export-ready. No new direct-FDA submission feature.
