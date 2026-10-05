# US-09 Frozen Tenant Origin and Pinned Plan PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Preserve the owner's chosen execution method: a separate implementer and independent reviewer per task, followed by final integration review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Owner-approved and accepted as a local internal increment on 2026-10-04. All three task reviews and final integration review are accepted. Broad API and hosted acceptance remain non-green/unverified as qualified in the checkpoint below; US-09 is not complete.

**Goal:** Freeze server-derived tenant-origin evidence in new US-09 runs while preserving v1 replay, and read the exact pinned historical Plan PDF through a bounded private internal adapter.

**Architecture:** First introduce a transaction-bound origin helper without changing live capture. Then extend saved evidence to strict v1/v2 branches and switch new validation/preparation to v2. Finally add a read-only pinned-Plan reader that verifies v2 evidence before exact tenant/version lookup and existing private byte verification.

**Tech Stack:** Existing TypeScript/NestJS, Zod, Drizzle/PostgreSQL, Node SHA256, US-07 XLSX adapter, US-08 PDF/artifact services and Vitest. No dependency changes.

**Spec:** [Owner-approved frozen-origin and pinned-Plan specification](../specs/2026-10-04-us-09-frozen-provenance-pinned-plan-design.md). Read it with the accepted [frozen-payload foundation](2026-10-04-us-09-frozen-payload-foundation.md), including its verification limits.

## Global Constraints

- Reuse `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve existing dirty work. No staging, commit, push, PR, merge, release, deployment or scratch cleanup.
- Read root and applicable scoped instructions. No local Graphify graph exists at plan creation; use scoped source checks rather than generating a repository graph. Do not touch RU runtime, primary environment, shared databases, operational locks, Station, manifests, dependencies or production configuration.
- Use only synthetic data and fixture-owned disposable US PostgreSQL databases via `createUsProfileTestDatabase`. Unset general `DATABASE_URL`. Never migrate or clean the base database or a different fixture's database. Required DB tests must run with zero skips.
- New full frozen envelopes and validation snapshots are version 2; embedded US-07 `ExportInputV1` and command digest remain version 1. Strict v1 decoding and original bytes/digests remain supported without backfill or read-time defaults.
- Origin evidence is `{ schemaVersion: 1, verificationPolicy: "us-request-tenant-origin-v1", result, trustedSeed }`. Results are exactly `trusted_synthetic` and `not_attested`; positive stable seed evidence is `{ seedId, verifiedBy }`. No wall-clock verification time enters the scoped-content digest.
- Preserve 500 event revisions and 16 MiB canonical frozen-snapshot/XLSX guards. Existing Plan reads retain **8,000,000 bytes** and **15-second** storage-operation limits. Do not substitute a ZIP aggregate limit for either guard.
- Preserve fresh authorization, repeatable-read capture, actor-bound idempotency, request locks, warning acknowledgement and exact audit fields. Saved-evidence verification and the new reader grant no authorization.
- Damaged reserved-demo identity fails with `us_request_tenant_origin_invalid`. A negative attestation is not verified real operation. The future synthetic label is `Synthetic demo / not an operational record`; no report/UI renderer is added here.
- A future full-package input reader denies v1 with `us_request_package_refreeze_required` before DB/storage reads. Existing v1 JSON/XLSX rendering stays available. The owner-approved remedy is fresh validation and a new command key/revision, never silent upgrade.
- Pinned Plan reads use exact tenant/version/hash, accept effective or superseded published rows, preserve original PDF bytes and return no storage key/URL. Missing/corrupt/unavailable pinned evidence fails both modes with sanitized errors; only original absent-Plan evidence in incomplete mode returns absence.
- Byte composition/retrieval changes no run, artifact, status or audit rows. Existing real Prepare/Validate mutations retain their own established audits. No impersonated user-download audit or storage upload/delete/cleanup in the reader.
- Report, manifest, sums, ZIP, worker, package storage/publication, immutable production build provider, HTTP/OpenAPI, cabinet UI and hosted residency/recovery acceptance remain outside this plan.
- Use focused RED/GREEN tests and independently review each task before starting its dependent successor. Preserve own-plan scratch reports while changes remain uncommitted; checkpoints, not approval, prove execution.

## Review Focus

1. A partial reserved-demo identity must fail, while an unrelated tenant is not classified synthetic just because the reserved owner exists elsewhere; complete erasure of historical markers cannot be externally attested (Task 1).
2. Validate and Prepare at different wall-clock times must agree on unchanged stable content, and a concurrent origin edit must not leak into an already-established repeatable-read view (Tasks 1–2).
3. Strict nested versions, origin/tenant consistency and rehashed corruption must fail; old v1 rows, canonical bytes, input digests and same-key replay must survive the new writer (Task 2).
4. A valid v1 run must be denied only at the full-package boundary and before any I/O, not by its JSON/XLSX renderer; fresh authorization still precedes idempotent command replay (Tasks 2–3).
5. Superseded pinned PDF identity must survive newer approval; failed or missing pinned reads must never select the current Plan, return successful absence, expose keys/private causes or write user-download audits (Task 3).

---

## File and dependency map

Task 1 creates `apps/api/src/modules/traceability/requests/us-request-tenant-origin.ts` and `apps/api/test/us-request-tenant-origin.e2e.test.ts`. It consumes the existing owner verifier, not a new provisioner. It does not switch snapshot format.

Task 2 modifies `us-request-snapshot.ts`, `us-request-validation.ts`, `us-request-prepare.ts`, `us-request-run-evidence.ts` and, only if required by union typing, `us-request-payloads.ts` in that same module. It creates `apps/api/test/us-request-versions.e2e.test.ts` and `apps/api/test/support/us-request-v1-fixture.ts`; it adapts directly affected request validation/Prepare/evidence/payload tests without weakening them. No DB or public-contract change is planned.

Task 3 creates `apps/api/src/modules/traceability/requests/us-request-plan-reader.ts`, `apps/api/test/us-request-plan-reader.e2e.test.ts` and `apps/api/test/support/us-request-plan-fixture.ts`. It consumes US-08 published-row parsing, real approval/rendering and private artifact verification. It owns the final CI additions in `.github/workflows/us-development.yml` and `tools/us-development/test/isolation.test.mjs`, plus dated checkpoints in this plan and `docs/us/implementation-plan.md` after accepted review.

Read existing request source/tests and `test/support/us-profile-database.ts`, `us-receiving-fixture.ts`, `us-request-payload-fixture.ts`; owner source/tests; and US-08 `us-plan-store.ts`, `us-plan-approval.ts`, `us-plan-published.ts`, `us-plan-artifacts.ts`, `us-plan-artifact-config.ts`, `us-plan-pdf.tsx` and their tests. The existing metadata-only `seedUsRequestPayloadPlan` does not provide actual PDF bytes; retain it for its current tests, but do not use it as PDF-read proof.

### Task 1: Transaction-bound stable tenant-origin evidence

**Interfaces:** Produce the following in `us-request-tenant-origin.ts`. Export one strict schema for reuse by the internal saved-evidence parser, not a public client contract.

```ts
export const usRequestTenantOriginSchema = z.discriminatedUnion("result", [
  z
    .object({
      schemaVersion: z.literal(1),
      verificationPolicy: z.literal("us-request-tenant-origin-v1"),
      result: z.literal("trusted_synthetic"),
      trustedSeed: z
        .object({
          seedId: z.uuid(),
          verifiedBy: z.literal("us-development-owner-v1"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      verificationPolicy: z.literal("us-request-tenant-origin-v1"),
      result: z.literal("not_attested"),
      trustedSeed: z.null(),
    })
    .strict(),
]);
export type UsRequestTenantOrigin = z.infer<typeof usRequestTenantOriginSchema>;
export async function captureUsRequestTenantOrigin(
  db: Db,
  tx: UsMasterDataTransaction,
  tenantId: string,
): Promise<UsRequestTenantOrigin>;
```

`db` is needed by the existing `UsDevelopmentOwnerStore` constructor; every actual origin read must use `tx`. Do not allow an omitted transaction, start another snapshot or accept a client-supplied origin object.

- [x] **Step 1: RED positive/negative/no-write tests.** Use owned disposable DB fixtures; provision the reserved owner only inside that fixture. Capture at two injected verifier-observation times and assert equal stable evidence with no `verifiedAt`. Seed an unrelated tenant using `seedReceivingTenant` and prove its result stays negative while the reserved owner exists. Snapshot organization/user/member/account/audit rows before and after, without printing credential values.

```ts
const owner = await new UsDevelopmentOwnerStore(f.db).provision(
  "Synthetic-local-owner-password-42!",
  randomUUID(),
);
const first = await f.db.transaction(
  (tx) => captureUsRequestTenantOrigin(f.db, tx, owner.tenantId),
  { isolationLevel: "repeatable read" },
);
expect(first).toEqual({
  schemaVersion: 1,
  verificationPolicy: "us-request-tenant-origin-v1",
  result: "trusted_synthetic",
  trustedSeed: { seedId: owner.tenantId, verifiedBy: "us-development-owner-v1" },
});
const other = await seedReceivingTenant(f.db);
expect(
  await f.db.transaction((tx) => captureUsRequestTenantOrigin(f.db, tx, other.tenant), {
    isolationLevel: "repeatable read",
  }),
).toEqual({
  schemaVersion: 1,
  verificationPolicy: "us-request-tenant-origin-v1",
  result: "not_attested",
  trustedSeed: null,
});
```

Run the new suite with `--maxWorkers=1`; expect missing helper import or assertion failure before implementation. Record RED output, not a skipped suite. For the two observation times, fake only `Date` with `vi.useFakeTimers({ toFake: ["Date"] })`, advance via `vi.setSystemTime`, and restore real timers in `finally`; leave DB/network timers real. Alternatively inspect a call-through spy on `UsDevelopmentOwnerStore.prototype.verifyTrustedSeed`. Do not replace its returned seed with fabricated success.

- [x] **Step 2: Implement the minimal helper.** Read the exact tenant row; a nonexistent tenant fails technically. Detect reserved origin using the reserved slug, parsed versioned seed metadata and tenant-scoped provisioning audit. A matching marker triggers full verification; no marker returns strict negative evidence. Invalid reserved metadata, copied markers on another tenant or inconsistent provisioning identity fails, never repairs.

Use `.limit(2)` sentinel reads for provisioning audits, credential accounts and owner memberships when checking duplicate/absent evidence. Preflight these bounded sets before calling the existing verifier, so it cannot enumerate an unbounded corrupt set. Preserve the same repeatable-read view. Tenant ID applies to audit/member reads; reserved owner lookup is by its unique identity, not an authority for another tenant. Do not change existing owner provisioning behavior or duplicate its password logic.

```ts
const seed = await new UsDevelopmentOwnerStore(db).verifyTrustedSeed(tenantId, new Date(), tx);
if (!seed || seed.seedId !== tenantId) {
  throw new ServiceUnavailableException({ code: "us_request_tenant_origin_invalid" });
}
return usRequestTenantOriginSchema.parse({
  schemaVersion: 1,
  verificationPolicy: "us-request-tenant-origin-v1",
  result: "trusted_synthetic",
  trustedSeed: { seedId: seed.seedId, verifiedBy: seed.verifiedBy },
});
```

This code is the positive branch after marker/preflight checks, not the whole helper. Catch infrastructure failures only to sanitize the finite code; never reinterpret them as `not_attested`. A malformed metadata string retaining the reserved seed identifier is inconsistent evidence, not an unmarked tenant. Human names alone do not attest origin.

- [x] **Step 3: Corruption and transaction tests.** Add table-driven mutations of reserved slug/metadata, actor email/name, revoked/duplicate membership, missing credential and missing/altered/duplicate audit. Retain another marker when testing loss of one marker. Assert exact `us_request_tenant_origin_invalid` and unchanged persisted rows. Test copied seed metadata and a foreign tenant's owner audit without granting positive attestation. Inject a verifier/database failure containing private text and assert sanitized output with no cause/message leakage.

Establish a repeatable-read transaction with an initial tenant read, then coordinate a second connection's committed metadata edit using promises, not timing sleeps. The established transaction still sees original origin; a fresh transaction fails. Restore only that fixture's edited row for subsequent cases. Exercise `schema.member` and account sets above one row to pin sentinel behavior. Test complete marker erasure as negative only after documenting that this is absence of attestation, not trusted real operation.

- [x] **Step 4: GREEN and independent task review.** Run new origin tests plus `us-development-owner.e2e.test.ts` on disposable DB, API typecheck/lint, and focused formatting/diff checks. Verify no snapshot writer, runtime registration, real storage or provisioning changes. Review exact scope/tenant/sentinel queries and stable evidence fields. Deliver helper signatures and report to Task 2 only after accepted review; no commit.

Task 1 accepted checkpoint, 2026-10-04: 31 origin + 14 owner tests passed, zero skips; API typecheck/lint and focused formatting/diff checks passed. Independent spec and quality review approved, no blocking findings. Controller rerun: 31/31 origin cases. Existing Vite configuration warning remains disclosed. Tasks 2–3 and final integration are not yet accepted.

### Task 2: Strict dual-read evidence and new-write v2

**Interfaces:** Consume Task 1's strict schema/type/helper. Preserve the original snapshot shape as `UsRequestSnapshotV1`; add `UsRequestSnapshotV2` and export the union as `UsRequestSnapshot`. No default provenance on the v1 branch.

```ts
export type UsRequestSnapshotV2 = Omit<UsRequestSnapshotV1, "schemaVersion"> & {
  schemaVersion: 2;
  tenantOrigin: UsRequestTenantOrigin;
};
export type UsRequestSnapshot = UsRequestSnapshotV1 | UsRequestSnapshotV2;

export async function captureUsRequestScope(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  requestRow: UsRequestRow,
  build: UsExportBuildIdentity,
  tenantOrigin: UsRequestTenantOrigin,
): Promise<{ snapshot: UsRequestSnapshotV2; digest: string; byteSize: number }>;
```

The new final argument is mandatory and supplied only by the server helper in the same transaction. Validate its strict shape and positive seed/tenant consistency before including it. Update all direct test capture call sites; do not add a silent negative fallback just to preserve five-argument calls.

Produce strict `UsRequestFrozenRunV1`/`UsRequestFrozenRunV2` branches and their union under existing `UsRequestFrozenRun`. Preserve entrypoint names and row/tenant arguments of `verifyUsRequestRunEvidence`, `parseUsRequestFrozenRun` and `renderUsRequestPayloads`; their evidence types become the versioned union. The graph helpers `currentChain` and `selectsEvents` accept the snapshot union without changing their behavior. Add the pure gate:

```ts
export function requireUsRequestPackageEvidence(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
): UsRequestFrozenRunV2 {
  const frozen = verifyUsRequestRunEvidence(run, expectedTenantId);
  if (frozen.schemaVersion !== 2) {
    throw new ConflictException({ code: "us_request_package_refreeze_required" });
  }
  return frozen;
}
```

- [x] **Step 1: Pin legacy fixtures and RED v2 behavior.** Create a test-only `seedLegacyUsRequestRun(db, context, mode)` in `test/support/us-request-v1-fixture.ts`, where context is the return type of `seedCompleteReceiving` and mode is the two-value prepare mode. Use real request/validation/Prepare stores and real finalized Receiving content, not hand-invented source JSON. Before changing the writer, verify and replay both empty-incomplete and nonempty accepted v1 runs through the original verifier/Prepare boundary; record validation/XLSX bytes and hashes.

After the writer changes, the helper may build a fresh test-only legacy row from the same real captured content by removing only v2 origin and restoring both v1 version literals. Recompute the scoped digest and any warning-ack digest; retain the exact US-07 input, input digest, command identity and generation instant. Insert a **new fixture-owned row** with its own ID/key/next revision. Never update or downgrade an accepted existing row. Verify this helper against the original v1 verifier before changing that verifier; document fixture insertion rather than claiming a production creation audit.

```ts
const saved = verifyUsRequestRunEvidence(prepared, c.tenant);
if (saved.schemaVersion === 1) return prepared;
const { tenantOrigin, ...priorFacts } = saved.validationSnapshot;
void tenantOrigin;
const validationSnapshot = { ...priorFacts, schemaVersion: 1 as const };
const scopedContentDigest = canonicalExportDigest(validationSnapshot);
const inputSnapshot = {
  ...saved,
  schemaVersion: 1 as const,
  validationSnapshot,
  warningAcknowledgement:
    saved.warningAcknowledgement === null
      ? null
      : {
          ...saved.warningAcknowledgement,
          digest: scopedContentDigest,
        },
};
const [legacy] = await db
  .insert(schema.traceExportRuns)
  .values({
    ...prepared,
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    revision: prepared.revision + 1,
    scopedContentDigest,
    inputSnapshot,
  })
  .returning();
if (!legacy) throw new Error("Missing owned legacy fixture row");
verifyUsRequestRunEvidence(legacy, c.tenant);
return legacy;
```

Keep this conversion entirely in test support. In the new versions suite assert new Prepare output has both version literals 2 and explicit negative origin for a normal `seedCompleteReceiving` tenant. Initially this fails because the writer is v1. Use actual positive reserved-demo fixtures from Task 1 for positive evidence parsing and transaction capture; no requester name or fake PDF text attests origin.

Also exercise the complete positive Validate/Prepare path in a separate owned fixture: provision its reserved owner, add that tenant's processor `traceabilityProfiles` and `orgProfiles` rows using the existing test baseline and `America/Chicago`, then create an empty-scope-match request as that owner. Validate and Prepare incomplete mode through the real stores; assert a v2 envelope with the exact positive seed and no workbook input. This avoids fabricating a Receiving context or reparenting existing lots to the reserved tenant. Close that child fixture after the case; do not delete/recreate a reserved owner referenced by other cases.

- [x] **Step 2: Implement dual parsers before switching writes.** Retain v1 strict schemas and create v2 with only the approved format changes. Use a strict union with version-matched nested snapshots; mixed envelope/snapshot versions are invalid. Both branches retain canonical raw-versus-parsed comparison and every existing row/digest/content binding.

```ts
const snapshotV2Schema = snapshotV1Schema
  .extend({
    schemaVersion: z.literal(2),
    tenantOrigin: usRequestTenantOriginSchema,
  })
  .refine(
    (value) =>
      value.tenantOrigin.result !== "trusted_synthetic" ||
      value.tenantOrigin.trustedSeed.seedId === value.tenantId,
  );
const frozenV2Schema = frozenV1ObjectSchema
  .extend({
    schemaVersion: z.literal(2),
    validationSnapshot: snapshotV2Schema,
  })
  .refine((value) => (value.selectionKind === "empty") === (value.exportInput === null));
const frozenSchema = z.union([frozenV1Schema, frozenV2Schema]);
```

`frozenV1ObjectSchema` is the existing strict unrefined envelope object extracted locally in this task; `frozenV1Schema` retains its existing empty/input refinement. Keep them internal and avoid two independent versions of the common evidence assertions. Export narrowed inferred types and the pure compatibility gate. Do not change the command digest version or add v2 facts to the embedded US-07 schema.

- [x] **Step 3: Switch new capture/Prepare to v2.** Both Validate and new-key Prepare capture the origin immediately before scope capture within the already established transaction. Existing-key lookup/replay stays before this new work. Update direct capture tests to call the helper with the same fixture DB and transaction.

```ts
const tenantOrigin = await captureUsRequestTenantOrigin(this.db, tx, tenantId);
const captured = await captureUsRequestScope(tx, tenantId, actorUserId, row, build, tenantOrigin);
```

Use the existing `request` variable rather than `row` at the Prepare call site. Build the snapshot with version 2 and its strict stable origin object; the canonical digest includes the object unchanged. Construct new frozen envelopes with version 2, not the embedded input. Keep original run insertion, generation time, warning acknowledgement, readiness and audit metadata semantics. Old validation digests now conflict as stale for a new key until revalidation; do not rewrite them implicitly.

- [x] **Step 4: Pin compatibility, drift and corruption outcomes.** In the versions suite exercise actual v1 same-key replay after request closure, source amendment/void and damaged reserved-demo markers; assert original row equality and exact `prepare_replayed` tenant/actor/request/run/revision/digests. Current authorization denial must still reject replay. Test different request/mode key reuse remains conflict.

```ts
const before = await renderUsRequestPayloads(legacy, c.tenant);
const replay = await new UsRequestPrepareStore(f.db).prepare(
  c.tenant,
  c.actor,
  legacy.requestId,
  { mode: "available_records_incomplete", idempotencyKey: legacy.idempotencyKey },
  build,
);
expect(replay).toEqual(legacy);
const after = await renderUsRequestPayloads(replay, c.tenant);
expect(after.validation).toEqual(before.validation);
expect(after.workbook).toEqual(before.workbook);
expect(() => requireUsRequestPackageEvidence(legacy, c.tenant)).toThrow(
  expect.objectContaining({ response: { code: "us_request_package_refreeze_required" } }),
);
```

The request must remain available for actual replay authorization; wrong-tenant and revoked role tests cannot be bypassed by the fixture. Compare frozen evidence, not audit counts, because a real replay intentionally emits one exact replay audit.

For new v2 runs assert independent Validate/Prepare wall-clock instants agree on scoped content. Prove new-key stale validation after version cutover/origin drift, then successful new v2 revision after revalidation. Current marker edits after freeze do not alter accepted JSON/XLSX or origin. Add rehashed unsupported policy/schema, positive seed/tenant mismatch, mixed nested versions, negative result with seed, extra fields and normalization-only corruption cases. Existing malformed `{ schemaVersion: 2 }` test remains invalid; do not remove it because complete v2 is now supported.

Cover both empty and event selections, both modes, 500/501 and saved byte-bound regressions through existing tests. Retain actual source/body/digest and private-error assertions. No event fabrication, v1 normalization or production backfill.

- [x] **Step 5: GREEN and independent review.** Run all existing request selection/store/validation/Prepare/evidence/payload suites plus new origin/versions suites serially with zero DB skips; run API typecheck/lint/build and formatting/diff checks. Review new-writer cutover, old digest preservation and every updated direct caller. Task 3 consumes only the accepted pure gate/types; no commit.

Task 2 accepted checkpoint, 2026-10-04: eight request suites passed 161/161 with zero skips before the suite-name correction and last added concurrency case; final correct-path versions suite passed 16/16, zero skips. API typecheck/lint/build and focused formatting/diff checks passed. Independent spec/quality review approved with no blocking findings; controller fresh versions run passed 16/16. Existing Vite warning remains. Task 3 and final integrated gates are still pending; no final combined 162-test run is implied.

### Task 3: Exact historical Plan bytes and CI ownership

**Interfaces:** Consume Task 2's `requireUsRequestPackageEvidence` and run type, plus existing `parseUsPlanPublishedRow` and `UsPlanArtifactStore.readVerified`. Produce:

```ts
export type UsRequestPinnedPlanResult =
  | { readonly kind: "absent"; readonly code: "plan_absent" }
  | {
      readonly kind: "pdf";
      readonly planVersionId: string;
      readonly sha256: string;
      readonly byteSize: number;
      readonly bytes: Buffer;
    };
export class UsRequestPlanReader {
  constructor(
    private readonly db: Db,
    private readonly artifacts: Pick<UsPlanArtifactStore, "readVerified"> | null,
  ) {}
  async read(
    run: UsTraceExportRunRow,
    expectedTenantId: string,
  ): Promise<UsRequestPinnedPlanResult>;
}
```

Keep the result private/internal; do not register HTTP/runtime providers. The narrow adapter exposes no upload/delete capability.

- [x] **Step 1: Create actual published-PDF fixture and RED historical-read tests.** In `us-request-plan-fixture.ts` expose `createUsRequestPlanFixture(db, context)` returning `{ artifacts, objects, transport, approve, destroy }`. `context` is the Receiving fixture. `objects` is a fixture-owned map of private key to copied bytes; the transport supports existing approval Put/Get/Head/Delete commands, tracks calls, enforces its synthetic bucket and returns bounded byte bodies. `approve(changeSummary)` returns the real `Published` shape from `UsPlanApprovalStore.approve`.

Update only the fixture location to include `tlc_source` along with its existing receiving role and required address. Use real sections patterned after the existing approval suite, literal synthetic contact values and all four explicit procedure confirmations. Load isolated test storage configuration as in `us-plan-artifacts.test.ts`; construct a real `UsPlanArtifactStore` and real default `renderUsPlanPdf`, not JSON masquerading as PDF or the metadata-only Plan helper.

```ts
const drafts = new UsPlanStore(db);
const approvals = new UsPlanApprovalStore(db, artifacts);
async function approve(changeSummary: string) {
  const draft = await drafts.createDraft(
    c.tenant,
    c.actor,
    { sections, changeSummary },
    "plan-fixture-create",
  );
  return approvals.approve(
    c.tenant,
    c.actor,
    {
      versionId: draft.id,
      expectedRevision: draft.draftRevision,
      idempotencyKey: randomUUID(),
      confirmations: {
        procedures: true,
        backupAndRecovery: true,
        contact: true,
        nonFarmScope: true,
      },
    },
    "plan-fixture-approve",
  );
}
```

The support helper defines `sections` with all required approved fields, matching the existing US-08 fixture shape. No special renderer, broader profile, bypassed operator confirmations or real external service is required. Close owned clients and clear owned maps in fixture teardown, not shared storage.

Approve version 1, prepare a real v2 request pinning it, then approve version 2. Capture rows/audits after these intentional setup mutations; start tracking reader storage calls after setup. Assert reading the old run yields version 1's exact bytes/hash although its status is superseded and version 2 is effective. Initial read fails due to missing reader module.

- [x] **Step 2: Implement exact read-only lookup and verified bytes.** Invoke the pure package gate before any I/O. Empty incomplete Plan absence returns without configured storage. When pinned, release the bounded tenant/version metadata read before object I/O; use a local statement timeout for the read transaction. Parse the historical row and compare its hash to the frozen pin. No actor, live origin capture, latest-Plan lookup or download method is involved.

```ts
const frozen = requireUsRequestPackageEvidence(run, expectedTenantId);
const pin = frozen.validationSnapshot.plan;
if (pin === null) {
  if (frozen.mode !== "available_records_incomplete") {
    throw new ServiceUnavailableException({ code: "us_request_run_stored_invalid" });
  }
  return { kind: "absent", code: "plan_absent" };
}
// Inside the bounded metadata read transaction:
const [row] = await tx
  .select()
  .from(schema.traceabilityPlanVersions)
  .where(
    and(
      eq(schema.traceabilityPlanVersions.tenantId, expectedTenantId),
      eq(schema.traceabilityPlanVersions.id, pin.id),
    ),
  )
  .limit(1);
if (!row) throw new Error("missing_pinned_plan");
const published = parseUsPlanPublishedRow(row);
if (published.artifact.sha256 !== pin.pdfSha256) throw new Error("pinned_hash_mismatch");
```

After metadata parsing, require configured private reader and invoke it exactly once with the parsed scope/evidence. Copy returned bytes and defensively check actual size/hash against parsed evidence; return only the approved result fields. Keep gate errors outside the sanitized Plan-read catch. Catch metadata/storage/byte failures as `us_request_plan_read_failed` without cause/private values.

```ts
const bytes = Buffer.from(
  await artifacts.readVerified(
    { tenantId: expectedTenantId, versionId: published.id },
    published.artifact,
  ),
);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (bytes.length !== published.artifact.byteSize || sha256 !== pin.pdfSha256) {
  throw new Error("pinned_bytes_mismatch");
}
return { kind: "pdf", planVersionId: pin.id, sha256, byteSize: bytes.length, bytes };
```

The existing concrete artifact reader enforces 8,000,000 bytes and 15 seconds; preserve those guards and rerun their tests. No partial return on failure, fallback to effective Plan, re-render, upload, audit insertion or status update.

- [x] **Step 3: Negative/safety tests.** Assert v1 compatibility denial and wrong-tenant saved evidence denial occur before database transactions or transport calls, while existing v1 JSON/XLSX rendering still succeeds. Incomplete original absence performs no I/O even with null reader; ready absence fails. For corrupted references that DB composite FKs prohibit, use a cloned run with recomputed saved evidence to reach the actual row-lookup guard rather than disabling constraints.

Test absent configuration, missing object, same-length tampered bytes, wrong ContentType/ContentLength, body failure/oversize and metadata hash mismatch in both modes. Corrupt fixture-owned published rows or adapter responses only for the negative case and restore them; assert exact sanitized response and no embedded object key/requester text/cause. Test a draft pin, foreign tenant Plan, malformed private key, invalid approved evidence and unavailable storage without successful absence. Preserve existing underlying timeout/stream cleanup tests; use fake timers only in isolated adapter tests and restore them.

```ts
const before = await persisted(); // exact tenant run/artifact/audit rows
const result = await reader.read(run, c.tenant);
expect(result.kind).toBe("pdf");
if (result.kind !== "pdf") throw new Error("Missing fixture PDF");
expect(result.bytes).toEqual(originalPdfBytes);
expect(result.sha256).toBe(createHash("sha256").update(originalPdfBytes).digest("hex"));
result.bytes.fill(0);
const again = await reader.read(run, c.tenant);
expect(again.kind === "pdf" ? again.bytes : null).toEqual(originalPdfBytes);
expect(await persisted()).toEqual(before);
```

`persisted` is a local test helper querying tenant-scoped run, artifact and audit rows in stable ID order. No logs or assertions print credential rows. Track transport commands and a spy on real rendering after setup: only exact pinned Get calls are allowed during read; no Put/Delete/Head from publication, no current Plan key and no rendering/user-download audit. A transport-injected fixture proves adapter behavior, not live MinIO or cloud operation.

- [x] **Step 4: RED/GREEN CI ownership.** Extend the existing US-09 isolation test tuples with the three new suites. Run `node --test tools/us-development/test/isolation.test.mjs` first and record missing-suite failures. Add the suites to the existing serial check-only request step after dependency builds, preserving `US_TEST_DATABASE_URL`, no general `DATABASE_URL`, no conditional skips/continue-on-error and `--maxWorkers=1`.

```yaml
run: pnpm --filter @markiro/api exec vitest run test/us-request-selection.e2e.test.ts test/us-request-store.e2e.test.ts test/us-request-validation.e2e.test.ts test/us-request-prepare.e2e.test.ts test/us-request-run-evidence.e2e.test.ts test/us-request-payloads.e2e.test.ts test/us-request-tenant-origin.e2e.test.ts test/us-request-versions.e2e.test.ts test/us-request-plan-reader.e2e.test.ts --maxWorkers=1
```

Existing API affected ownership already covers these files. Inspect `tools/ci/affected.mjs` and `.github/workflows/ci.yml`; change neither unless a concrete missing owner is proven and report that scope change. Re-run all US isolation tests and checker; operational release locks must remain unconditional.

- [x] **Step 5: Final GREEN gates and independent task review.** Execute the commands below and report exact results/skips. Review the whole new reader, fixture, compatibility tests and CI diff, including untracked files; do not claim correctness from existing adapter tests alone. No commit.

## Final verification and controller handoff

Run with the already established synthetic loopback `US_TEST_DATABASE_URL`, general `DATABASE_URL` unset, without sourcing primary `.env` or printing credentials. Use Node 24+ and Corepack. Build consumer dependencies first:

```sh
corepack pnpm turbo build --filter '@markiro/api^...'
corepack pnpm --filter @markiro/api exec vitest run test/us-request-tenant-origin.e2e.test.ts test/us-request-versions.e2e.test.ts test/us-request-plan-reader.e2e.test.ts test/us-request-selection.e2e.test.ts test/us-request-store.e2e.test.ts test/us-request-validation.e2e.test.ts test/us-request-prepare.e2e.test.ts test/us-request-run-evidence.e2e.test.ts test/us-request-payloads.e2e.test.ts --maxWorkers=1
corepack pnpm --filter @markiro/api exec vitest run test/us-development-owner.e2e.test.ts test/us-plan-artifacts.test.ts test/us-plan-approval.e2e.test.ts test/us-export-source-reader.e2e.test.ts test/us-export-adapter.test.ts test/us-export-xlsx-writer.test.ts --maxWorkers=1
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
node --test tools/us-development/test/*.test.mjs
node tools/us-development/check-isolation.mjs
corepack pnpm format:check
git diff --check
```

Existing `us-plan-approval.e2e.test.ts` includes `pdftotext` assertions. Check that executable before the approval regression; missing tooling is an explicitly unrun gate, not permission to replace actual PDF proof or silently skip PostgreSQL. No browser, Excel, physical, live hosted storage, backup/restore or regulatory acceptance is included. Remote CI has not run merely because local workflow contracts pass. Existing broad API setup failures remain non-green unless freshly exercised and resolved separately.

- [x] **Final integration review and checkpoint.** A fresh reviewer checks the accepted tasks together: schema boundaries, stable origin/digest, v1 replay/no-backfill, pure compatibility gate, exact historical PDF/no-write behavior, corruption/error privacy and CI/isolation ownership. Controller independently verifies decisive affected tests and reviews the complete stage changes, preserving unrelated dirty work. Add dated accepted checkpoints to this plan and the roadmap with counts, skips and unrun gates only after final acceptance.

Retain reports under this plan's own ignored scratch directory `.superpowers/sdd/2026-10-04-us-09-frozen-provenance-pinned-plan/`. Do not reuse another plan's execution ledger, open unrelated scratch or remove reports while uncommitted. The controller records accepted findings and any declined fix with reason; no additional fix scope is inferred from a review suggestion.

## Self-review and approval boundary

All approved requirements have an owner: Task 1 handles origin authority and bounded transaction reads; Task 2 handles v2 capture/digests and v1 compatibility; Task 3 handles historical PDF bytes, failure semantics, no-write behavior and CI. Every Review Focus item has explicit tests above. Shared interfaces and exact files are defined before dependent tasks; there is no new DB migration or public API contract.

Plan approval alone is not an execution checkpoint. The owner approved this plan on 2026-10-04; the dated checkpoint below records actual implementation and verification. Execution used a separate implementer plus independent reviewer per task, then final integration review. No push, release, publication or full-package completion is authorized.

## Accepted local implementation checkpoint — 2026-10-04

All three scoped tasks and the final whole-increment source review are accepted with no Critical or Important findings. This records internal frozen-input behavior, not completion of US-09 or readiness to merge/release the entire branch. Existing unrelated dirty work remains outside this increment, and HEAD is unchanged at `7aca1b70703728cc24d09455d42095aa24eafcf8`.

- New validation snapshots and frozen envelopes are strict v2 with stable transaction-derived tenant origin. Embedded US-07 input and command digest remain v1. Strict legacy v1 decoding, saved JSON/XLSX, actor-bound replay and fresh authorization are preserved without defaults, backfill or silent upgrade. A new command after v1 validation requires fresh v2 validation; full-package input denies v1 before I/O and requires a new key/revision.
- Positive origin attests reserved demo tenant provisioning only, not every record's factual/synthetic provenance. `not_attested` is absence of trusted demo attestation, not verified real operation. Damaged present reserved markers fail technically; no human name or PDF text creates origin proof.
- The internal Plan reader returns exact effective/superseded historical PDF bytes for the frozen tenant/version/hash. Its read-only metadata transaction has a local 3-second statement timeout and is released before object I/O. The existing private adapter retains 8,000,000-byte and 15-second guards. It copies verified bytes, exposes no private key/URL, never falls back to the current Plan, and creates no run/artifact/status/audit mutation or impersonated download. Only originally absent Plan in incomplete mode returns absence without I/O.
- Final selected verification passed nine request suites **179/179** and six owner/Plan/export regressions **130/130**, all **zero skips** on owned disposable US PostgreSQL. Real default-rendered approval and PDF text/byte checks execute; injected storage transport is not live object-store proof. The controller independently verified origin **31/31**, versions **16/16**, and all final 15 selected suites again within the complete API package invocation: **309/309**, zero skips/failures.
- Fresh controller API typecheck, lint and build passed. Direct Corepack builds of domain, DB, platform contracts, email and legal dependencies passed. US Node isolation tests passed **37/37**, zero skips; the isolation checker passed local workflow contracts. Full formatting and whitespace checks passed. All nine request suites are owned by unconditional serial check-only CI; operational release locks remain unchanged.
- The controller's complete API invocation was **not green**: exit 1, **394 files** (8 failed, 283 passed, 103 skipped), **3305 tests passed and 1411 skipped**, with no failed individual assertions; duration 773.58 seconds. The eight failed files are `billing-accounts.e2e.test.ts`, `exchange-credentials.e2e.test.ts`, `exchange-import.e2e.test.ts`, `exchange-orders.e2e.test.ts`, `exchange-protocol.e2e.test.ts`, `integrations-delete.e2e.test.ts`, `integrations.e2e.test.ts` and `subscription-route-inventory.test.ts`. Their primary database/auth/platform/pairing setup is unavailable in this intentionally isolated environment; some teardown errors follow failed setup. Those files and `env.ts` are unchanged, and no primary environment was sourced or shared/RU database altered. This fresh result retains the broad API limitation; selected US success is not whole-package success.
- The inherited Vite CommonJS/native-config warning remains disclosed. Local Turbo orchestration remains unverified because its child resolves global pnpm 11.18 rather than required 11.22; direct Corepack builds did not bypass policy. Dedicated v1-plus-Plan-supersession execution is not claimed: version-neutral replay source and separate legacy replay/current-writer supersession scenarios were judged sufficient by final review. Historical RED/GREEN and random legacy byte pins remain attributed to original task evidence, not regenerated.
- Manual checks covered source/workflow review, fixture ownership and tool availability. Browser, visual PDF layout, Excel, live MinIO/cloud storage, remote CI/settings, hardware/Windows, backup/restore, hosted residency and legal/regulatory acceptance were not run. No local Graphify graph exists to update. Report/manifest/sums/ZIP, worker, package publication, immutable production build identity provider, HTTP/OpenAPI and cabinet UI remain outside this increment.

The machine-generated full API results and exact before-snapshot/task/final review evidence are retained under this plan's own ignored scratch directory. Review used immutable working-tree baselines rather than commit ranges because staging, commits and cleanup are prohibited. No commit, push, PR, merge, deployment, release or scratch cleanup occurred.
