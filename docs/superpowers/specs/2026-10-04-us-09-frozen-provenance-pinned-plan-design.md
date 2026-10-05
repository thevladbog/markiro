# US-09 — Frozen Tenant Origin and Pinned Plan PDF

Status: owner-approved written specification, 2026-10-04. The implementation plan requires a separate owner review; no implementation is authorized by this document alone.

This supplements the [current US-09 design](2026-10-04-us-09-trace-request-current-design.md) and [selection/freeze design](2026-10-04-us-09-selection-freeze-design.md). It follows the accepted local [frozen-payload foundation](../plans/2026-10-04-us-09-frozen-payload-foundation.md), without claiming completion of stage 3 or US-09. Current code and tests determine implementation status.

## Intent and scope

Make the next internal package inputs trustworthy: freeze server-derived tenant-origin evidence and retrieve the exact historical US-08 Plan PDF selected during preparation. Later changes to the tenant, request, sources or effective Plan must not reclassify or replace an accepted run.

The owner approved leaving earlier v1 runs unchanged and requiring a freshly validated v2 run revision for a future full package. Existing v1 validation JSON and XLSX composition remain supported. The owner also approved a synthetic demo mark, failure on damaged reserved-demo evidence, exact historical PDF reads, and fail-closed handling of corrupt or unavailable pinned bytes.

Work stays in the isolated `codex/us-mvp` worktree. Use only synthetic fixtures and owned disposable US PostgreSQL databases. Preserve operational-workflow locks. No changes to RU runtime, primary environment, shared databases, production storage or release configuration; no commit, push, PR, deployment or cleanup.

This increment adds no report renderer, manifest, sums, ZIP, artifact publication, worker, HTTP route, OpenAPI change or cabinet UI. It does not provision storage or establish production residency, recovery or regulatory readiness.

## Verified implementation baseline

- `us-request-snapshot.ts` captures a strict schema-v1 scope snapshot inside the caller's transaction. Its canonical digest includes the selected Plan ID/hash, but contains no tenant-origin evidence.
- `us-request-run-evidence.ts` verifies the saved v1 envelope, row identities and digests without reading live configuration. Shape parsing alone is not evidence verification or authorization.
- `us-request-payloads.ts` composes validation JSON and optional XLSX only from verified saved evidence. It makes no database, artifact or audit writes.
- `UsDevelopmentOwnerStore.verifyTrustedSeed` verifies the reserved local demo tenant's persisted provisioning identity, membership, credential presence and exact provisioning audit. It accepts the caller's transaction. A positive result proves that tenant's fixture origin, not the truth or synthetic origin of every event.
- `parseUsPlanPublishedRow` validates effective or superseded historical Plan evidence and private artifact metadata without current configuration or rendering.
- `UsPlanArtifactStore.readVerified` reads the exact private object and checks tenant/version key scope, content type, actual size and SHA256. Its existing maximum is **8,000,000 bytes**, with a bounded **15-second** storage operation. The current storage configuration is local synthetic, not a production provider.
- The request run's JSON column has no SQL schema-version discriminator requiring a new migration for this version change. Do not edit migration 0139 or add a migration unless a separately identified persistence change requires one.

## Tenant-origin evidence

New validation snapshots have `schemaVersion: 2` and a strict `tenantOrigin` object. Its independent evidence schema has version 1 and contains:

- `schemaVersion`: 1;
- `verificationPolicy`: the fixed versioned policy identifier `us-request-tenant-origin-v1`;
- `result`: `trusted_synthetic` or `not_attested`;
- `trustedSeed`: exact stable `{ seedId, verifiedBy }` evidence for the positive result, otherwise null.

The positive seed ID must equal the snapshot tenant ID, and `verifiedBy` must be the supported reserved seed verifier version. Reject unsupported policies, extra fields, mismatched IDs and inconsistent result/evidence pairs. Neither the client nor requester/contact text supplies this object.

`trusted_synthetic` means the tenant's reserved demo provisioning origin was verified. Future report/package presentation must display `Synthetic demo / not an operational record` and retain machine-readable provenance. Do not assert that every event has individually been proven synthetic.

`not_attested` means the server performed this origin check and found no trusted reserved-demo identity. It is not proof of real operation, factual accuracy, compliance or independently verified operational records. Future presentation must preserve this distinction; it must not relabel this result as verified real data.

Reserved-demo evidence that is present but inconsistent fails technically with `us_request_tenant_origin_invalid`; it cannot become `not_attested`. Inspect the tenant's reserved slug, versioned seed metadata and provisioning-audit evidence alongside the existing verifier. The presence of the reserved owner elsewhere does not classify every tenant as demo. Arbitrary human-readable names alone are neither a positive attestation nor the reserved identity boundary.

The verifier uses only bounded persisted evidence in the same repeatable-read transaction as selection and Plan capture. It must not provision, repair, elevate a role, change credentials or emit synthetic provisioning audits. Infrastructure errors propagate; they are not a negative attestation. If every historical marker has been erased, this policy cannot prove a lost origin; the evidence is not a tamper-proof external attestation.

## Stable validation and immutable preparation

Both Validate and a new-key Prepare capture the same v2 tenant-origin facts under their existing transaction, authorization and request-lock boundaries. Include the complete stable `tenantOrigin` object in the mode-neutral scoped-content digest. Origin changes invalidate validation just like source or Plan changes.

Do not include a new wall-clock check time in that digest: Validate and Prepare occur at different instants. The existing seed verifier's returned `verifiedAt` is a check-time observation, not a stable origin fact; retain only `seedId` and `verifiedBy` in the new digest-bearing object. The accepted run's existing `generatedAt` identifies the freeze instant. Actor, mode, command key and generation time remain outside the scoped-content digest.

New frozen run envelopes and their validation snapshots both use schema version 2. The embedded US-07 `ExportInputV1`, its canonical input digest and registry contract remain version 1. The command identity digest also stays version 1, with the existing request ID/mode semantics; changing snapshot format must not redefine an accepted idempotency command.

Preserve the existing 500-revision and 16 MiB canonical full-snapshot limits, current-chain semantics, mode eligibility, warning acknowledgement, exact actor/tenant audit assertions and atomic run insertion. No origin check is a waiver of readiness errors. A negative attestation is not itself a claim of incomplete record selection or a fabricated business finding.

## Compatibility and verification

Use explicit strict v1 and v2 parsers and verification branches. Do not add defaults, normalize old v1 data into v2 or synthesize origin evidence while reading historical runs. Preserve the existing raw-versus-parsed canonical-byte check and all saved identity/digest consistency checks for both formats.

The compatibility rules are:

- Existing v1 runs retain their exact saved snapshot, scoped-content digest, command digest, Plan pin, input digest and original revision. Do not update rows or backfill them.
- A same-key accepted command returns the original v1 or v2 run after fresh authorization, even after source drift, request closure, Plan supersession or demo-marker changes. Replay must happen before new live capture, as it does today.
- Validation JSON and XLSX composition accept both verified versions. For v1, preserve its original canonical JSON and saved US-07 input; do not add provenance fields to the output. This is same-code replay compatibility, not a promise about future XLSX library releases.
- An old stored validation digest does not authorize a new v2 run silently. A new key requires a fresh matching v2 validation and the existing warning acknowledgement rules.
- Future full-package input assembly rejects v1 with the finite compatibility code `us_request_package_refreeze_required`, before Plan I/O. The remedy is Validate, then Prepare with a new key, creating a new run revision; a same-key replay cannot upgrade it.
- v2's explicit `not_attested` result is usable as a frozen origin-check result without being presented as proven operational data. Ordinary ready/incomplete eligibility still applies. Old v1 differs because no origin check result was recorded at all.

The shared saved-evidence verifier remains pure: no current tenant, request, Plan, registry or build recapture. Validate v2's structural policy/seed consistency against its saved tenant, not today's provisioning rows. Later corruption of demo markers can block new preparation but cannot rewrite a previously verified frozen result.

## Exact pinned Plan reader

Add a focused internal reader in the US request module. Its inputs are a saved run row and an expected tenant supplied by a trusted internal caller, plus the existing private US Plan artifact reader dependency. Verify the run first and enforce v2 package compatibility before querying Plan rows or storage.

This service grants no tenant authorization and is not an HTTP API. Current user-facing boundaries continue to reload membership/capabilities. A future worker must supply its authorized, tenant-scoped claimed run; a payload-provided tenant or calling the evidence verifier is not worker authority. Do not invent a worker credential or register this service in the runtime in this increment.

If a verified run has no Plan pin, return an explicit absent-Plan result only for `available_records_incomplete`; perform no Plan lookup or object read. Ready-mode absence is invalid evidence, not a successful omission.

When a pin exists:

1. Query `traceabilityPlanVersions` by **both tenant ID and exact pinned version ID**. Do not select the current effective version or enumerate alternatives.
2. Validate the row through `parseUsPlanPublishedRow`. Effective and superseded versions are both eligible; a draft, missing row, corrupt approved evidence or malformed artifact identity is not.
3. Require the published artifact SHA256 to equal the frozen request pin and the run's checked Plan hash. Resolve the private object key and size from that validated historical row, not a caller or a new Plan rendering.
4. Call the existing `UsPlanArtifactStore.readVerified` with that exact tenant/version scope and artifact evidence. Keep its content-type, key-scope, byte-size, SHA256, timeout and body-cleanup guards intact.
5. Return caller-owned PDF bytes, exact Plan ID, SHA256 and actual byte size. No public URL, storage key or credentials appear in the result or error payload.

Missing configuration, missing objects, unreadable streams, wrong type/length/hash and corrupted published evidence fail in both modes. Map failures after saved-run verification to the finite sanitized request-layer error `us_request_plan_read_failed`; preserve the existing saved-evidence verifier's error for an invalid run. Expose neither low-level causes nor private requester/object information. Never convert a failed pinned read into the absent-Plan result, return partial bytes, retry with another Plan, or render a replacement PDF.

Reuse the internal artifact reader, not `UsPlanApprovalStore.readPdf`: that user-facing path reauthorizes and audits a user download. Internal package input retrieval is not a fictitious user download. This read-only slice writes no run, artifact, status or audit rows and performs no upload, reference marking, cleanup or deletion.

The frozen Plan pin binds historical ID/hash. Private key and byte size may be resolved from its strictly validated published row; no live tenant-origin classification is taken from that lookup. The Plan keeps its own approved evidence and byte-level markings unchanged. Attaching it does not reclassify the frozen request tenant origin.

## Components and implementation handoff

Keep three responsibilities distinct: a transaction-bound tenant-origin capture helper; strict versioned saved-run evidence verification; and the pinned Plan PDF reader. Extend the existing snapshot, Prepare and payload modules only where these boundaries require it. Avoid a generic provenance framework, general-purpose artifact provider or unrelated refactor of US-08.

The forthcoming implementation plan should assign separately reviewed tasks for origin capture/digest, dual-read/new-write compatibility, and exact historical PDF retrieval with CI ownership and final integration review. The owner already chose a separate implementer and independent review per task; do not ask for the execution method again.

## Required verification

Use focused failing tests first. Transactional coverage must execute on owned disposable synthetic US PostgreSQL with general `DATABASE_URL` unset; database skips do not satisfy acceptance.

- Positive reserved-demo evidence, unmarked tenant, wrong tenant, inconsistent reserved slug/metadata/audit/member/credential evidence, infrastructure failure and no repair writes. No secret values are logged.
- Repeated Validate/Prepare at different instants produce matching scoped-content digests when stable content is unchanged; changes to origin facts invalidate validation. Prove repeatable-read behavior under concurrent origin edits.
- Real accepted v1 fixture replay preserves original row fields, canonical validation bytes, XLSX input/bytes and hashes. Verify same-key replay after drift/closure and new-key stale validation before revalidation.
- Strict v2 parsing rejects unsupported policies/versions, normalization drift, extra fields, mismatched seed/tenant and rehashed structural corruption. Later live origin edits leave accepted v2 evidence and JSON/XLSX unchanged.
- v1 full-package compatibility denial precedes all Plan/database/storage reads. This denial does not block the existing v1 JSON/XLSX renderer or mutate its row.
- Actual published Plan evidence and private PDF bytes, not only synthetic metadata with a fake hash: exact effective version, superseded pinned version after a newer approval, absent Plan in incomplete mode and cross-tenant denial.
- Missing row/configuration/object, draft Plan, malformed historical evidence/key, mismatched frozen hash, wrong content type/size, bounded stream failure and tampered PDF bytes. Both modes fail technically for failed pinned reads.
- Caller mutation of returned PDF bytes cannot affect a later read. Assert exact Plan identity/hash and unchanged run, artifact and audit rows; no user-download audit, upload, delete, re-render or current-Plan fallback.
- Preserve US-only check CI ownership for each new suite after required dependency builds, serial database tests and unconditional test environment. Confirm isolation contracts and release locks remain intact.

Run the affected US-09 and US-08 suites plus API typecheck/lint/build, formatting and diff checks. Build affected shared packages before consumers if their source changes. Report counts and skips accurately; existing broad API setup failures remain a separate non-green gate unless a current run proves otherwise.

Transport-level and disposable database tests prove bounded internal behavior, not hosted storage operation. Live local storage checks, if included in the approved implementation plan, must use only fixture-owned synthetic keys and report their scope separately. No browser, Excel interoperability, backup/restore, cloud residency, hardware or legal acceptance is claimed by this spec.

## Self-review and approval boundary

The spec distinguishes three states without historical inference: v1 origin not recorded, v2 origin checked but not attested, and v2 trusted reserved-demo origin. Wall-clock values do not make Validate/Prepare digests perpetually stale. Full-package compatibility gating does not disable existing v1 payloads; historical PDF reads do not substitute current configuration or impersonate a download.

Only this specification is written now. After owner approval of the written file, create the implementation plan through `writing-plans`; implementation starts only after that written plan is approved. No product code or database state is changed at this gate.
