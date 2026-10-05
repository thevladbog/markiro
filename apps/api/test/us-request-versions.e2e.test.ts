import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseUsRequestFrozenRun,
  requireUsRequestPackageEvidence,
  verifyUsRequestRunEvidence,
  type UsRequestFrozenRunV2,
  type UsTraceExportRunRow,
} from "../src/modules/traceability/requests/us-request-run-evidence";
import { renderUsRequestPayloads } from "../src/modules/traceability/requests/us-request-payloads";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import {
  captureUsRequestScope,
  stableStringify,
} from "../src/modules/traceability/requests/us-request-snapshot";
import { captureUsRequestTenantOrigin } from "../src/modules/traceability/requests/us-request-tenant-origin";
import * as origins from "../src/modules/traceability/requests/us-request-tenant-origin";
import * as snapshots from "../src/modules/traceability/requests/us-request-snapshot";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { transformationTransaction } from "../src/modules/traceability/transformation/us-transformation-operations";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  legacyRequestBuild as build,
  seedLegacyUsRequestRun,
} from "./support/us-request-v1-fixture";
import {
  finalizeUsRequestPayloadReceiving,
  seedUsRequestPayloadPlan,
} from "./support/us-request-payload-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const modes = ["available_records_incomplete", "export_ready"] as const;
const negative = {
  schemaVersion: 1,
  verificationPolicy: "us-request-tenant-origin-v1",
  result: "not_attested",
  trustedSeed: null,
} as const;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe.skipIf(!url)("US request frozen evidence versions", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant))
      .orderBy(schema.tenantAuditEvents.id);
  const rows = () =>
    f.db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.tenantId, c.tenant))
      .orderBy(schema.traceExportRuns.revision);
  const create = async (empty = true) =>
    new UsRequestStore(f.db).create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic version fixture",
      requesterOrganization: null,
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope: empty ? { tlcs: ["NO-MATCH-VERSION-FIXTURE"] } : { lotId: c.lot },
    });
  const prepare = (run: UsTraceExportRunRow) =>
    new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      run.requestId,
      { mode: verifyUsRequestRunEvidence(run, c.tenant).mode, idempotencyKey: run.idempotencyKey },
      build,
    );
  const replayAudit = async (
    before: Awaited<ReturnType<typeof audits>>,
    run: UsTraceExportRunRow,
  ) => {
    const after = await audits(),
      ids = new Set(before.map((audit) => audit.id));
    expect(after.filter((audit) => ids.has(audit.id))).toEqual(before);
    expect(after.filter((audit) => !ids.has(audit.id))).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        requestId: null,
        organizationId: c.tenant,
        actorUserId: c.actor,
        action: "traceability.request.prepare_replayed",
        outcome: "success",
        targetType: "trace_request",
        targetId: run.requestId,
        before: null,
        after: {
          runId: run.id,
          revision: run.revision,
          mode: run.mode,
          digest: run.scopedContentDigest,
          inputDigest: run.inputDigest,
        },
      },
    ]);
  };

  async function reservedFixture() {
    if (!url) throw new Error("Missing isolated US database URL");
    const child = await createUsProfileTestDatabase(url);
    try {
      const owner = await new UsDevelopmentOwnerStore(child.db).provision(
        "Synthetic-local-owner-password-42!",
        randomUUID(),
      );
      await child.db.insert(schema.traceabilityProfiles).values({
        tenantId: owner.tenantId,
        code: "US_FSMA204_PROCESSOR",
        baselineVersion: "US-REG-2026-09-03",
        retentionYears: 5,
        effectiveAt: new Date(),
        updatedByUserId: owner.userId,
      });
      await child.db
        .insert(schema.orgProfiles)
        .values({ tenantId: owner.tenantId, timeZone: "America/Chicago" });
      const request = await new UsRequestStore(child.db).create(owner.tenantId, owner.userId, {
        requestNumber: randomUUID(),
        requesterName: "Synthetic reserved requester",
        requesterOrganization: null,
        requesterContact: null,
        receivedAt: "2026-10-04T00:00:00Z",
        scope: { tlcs: ["NO-MATCH-RESERVED-FIXTURE"] },
      });
      return { child, owner, request };
    } catch (error) {
      await child.close();
      throw error;
    }
  }

  it.each(modes)("pins original v1 bytes and actual same-key replay in %s", async (mode) => {
    const legacy = await seedLegacyUsRequestRun(f.db, c, mode);
    expect(verifyUsRequestRunEvidence(legacy, c.tenant)).toMatchObject({
      schemaVersion: 1,
      validationSnapshot: { schemaVersion: 1 },
    });
    const before = await renderUsRequestPayloads(legacy, c.tenant);
    const beforeAudits = await audits();
    const replay = await new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      legacy.requestId,
      {
        mode,
        idempotencyKey: legacy.idempotencyKey,
      },
      build,
    );
    expect(replay).toEqual(legacy);
    await replayAudit(beforeAudits, legacy);
    expect(await renderUsRequestPayloads(replay, c.tenant)).toEqual(before);
    expect(before.validation.byteSize).toBeGreaterThan(0);
    expect(before.validation.sha256).toMatch(/^[a-f0-9]{64}$/);
    if (mode === "export_ready") {
      expect(before.workbook?.byteSize).toBeGreaterThan(0);
      expect(before.workbook?.sha256).toMatch(/^[a-f0-9]{64}$/);
    } else expect(before.workbook).toBeNull();
    expect(before.validation.sha256).toBe(hash(before.validation.bytes));
    if (before.workbook) expect(before.workbook.sha256).toBe(hash(before.workbook.bytes));
    expect(stableStringify(legacy.inputSnapshot)).not.toContain("tenantOrigin");
    expect(() => requireUsRequestPackageEvidence(legacy, c.tenant)).toThrow(
      expect.objectContaining({
        status: 409,
        response: { code: "us_request_package_refreeze_required" },
      }),
    );
    const all = await rows(),
      original = all.find((run) => run.revision === legacy.revision - 1);
    if (!original) throw new Error("Missing untouched accepted v2 writer row");
    expect(verifyUsRequestRunEvidence(original, c.tenant).schemaVersion).toBe(2);
    expect(legacy.id).not.toBe(original.id);
    expect(legacy.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(legacy.inputDigest).toBe(original.inputDigest);
    expect(legacy.commandDigest).toBe(original.commandDigest);
    expect(legacy.startedAt).toEqual(original.startedAt);
    expect(verifyUsRequestRunEvidence(legacy, c.tenant).exportInput).toEqual(
      verifyUsRequestRunEvidence(original, c.tenant).exportInput,
    );
  });

  it("accepts complete v2 shape while retaining the embedded US-07 input format", async () => {
    const run = await seedLegacyUsRequestRun(f.db, c, "export_ready");
    const saved = verifyUsRequestRunEvidence(run, c.tenant);
    const v2 = {
      ...saved,
      schemaVersion: 2,
      validationSnapshot: {
        ...saved.validationSnapshot,
        schemaVersion: 2,
        tenantOrigin: {
          schemaVersion: 1,
          verificationPolicy: "us-request-tenant-origin-v1",
          result: "not_attested",
          trustedSeed: null,
        },
      },
    };
    expect(parseUsRequestFrozenRun(v2)).toEqual(v2);
    expect(saved.exportInput?.schemaVersion).toBe(1);
  });

  it("writes a v2 envelope and explicit negative origin for a newly prepared tenant", async () => {
    const run = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    const next = await new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      run.requestId,
      {
        mode: "available_records_incomplete",
        idempotencyKey: randomUUID(),
      },
      build,
    );
    expect(verifyUsRequestRunEvidence(next, c.tenant)).toMatchObject({
      schemaVersion: 2,
      validationSnapshot: { schemaVersion: 2, tenantOrigin: negative },
    });
    expect(requireUsRequestPackageEvidence(next, c.tenant).schemaVersion).toBe(2);
  });

  it.each(modes)(
    "replays v1 after real source amendment/void, request close and damaged origin in %s",
    async (mode) => {
      const run = await seedLegacyUsRequestRun(f.db, c, mode);
      const before = await renderUsRequestPayloads(run, c.tenant);
      const source = verifyUsRequestRunEvidence(run, c.tenant).exportInput?.events[0];
      if (source) {
        const receiving = new UsReceivingStore(f.db);
        const origin = await receiving.getLiveRecord(c.tenant, c.actor, source.eventId);
        const amendment = await receiving.amend(
          c.tenant,
          c.actor,
          source.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: origin.lifecycle.lifecycleVersion,
            reason: "Correct synthetic receipt",
          },
          "versions-amend",
        );
        const checked = await receiving.checkRevisionReadiness(
          c.tenant,
          c.actor,
          amendment.eventId,
          { expectedDraftVersion: 1 },
        );
        const finalized = await receiving.finalizeRevision(
          c.tenant,
          c.actor,
          amendment.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedLifecycleVersion: checked.expectedLifecycleVersion,
            previousRevisionId: checked.previousRevisionId,
            expectedInputDigest: checked.inputDigest,
            reviewedExemptLines: checked.exemptReviewRequiredLines,
          },
          "versions-finalize",
        );
        expect(finalized.record).toMatchObject({ revision: 2, status: "finalized" });
        const amendmentAudits = await audits();
        expect(await prepare(run)).toEqual(run);
        await replayAudit(amendmentAudits, run);
        expect(await renderUsRequestPayloads(run, c.tenant)).toEqual(before);
        const voided = await receiving.void(
          c.tenant,
          c.actor,
          amendment.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: finalized.record.lifecycle.lifecycleVersion,
            expectedDraftVersion: null,
            reason: "Synthetic receipt entered in error",
          },
          "versions-void",
        );
        expect(voided.record.status).toBe("void");
      }
      await new UsRequestStore(f.db).close(c.tenant, c.actor, run.requestId, {
        expectedRevision: 1,
      });
      await f.db
        .update(schema.organization)
        .set({
          metadata: JSON.stringify({ synthetic: false, seedVersion: "us-development-owner-v1" }),
        })
        .where(eq(schema.organization.id, c.tenant));
      await expect(
        transformationTransaction(f.db, (tx) => captureUsRequestTenantOrigin(f.db, tx, c.tenant)),
      ).rejects.toMatchObject({ response: { code: "us_request_tenant_origin_invalid" } });
      const accepted = await rows(),
        beforeAudits = await audits();
      expect(await prepare(run)).toEqual(run);
      await replayAudit(beforeAudits, run);
      expect(await renderUsRequestPayloads(run, c.tenant)).toEqual(before);
      expect(await rows()).toEqual(accepted);
    },
  );

  it("reauthorizes actual v1 replay and denies wrong tenant or revoked role", async () => {
    const run = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    const other = await seedCompleteReceiving(f.db);
    await expect(
      new UsRequestPrepareStore(f.db).prepare(
        other.tenant,
        other.actor,
        run.requestId,
        {
          mode: "available_records_incomplete",
          idempotencyKey: run.idempotencyKey,
        },
        build,
      ),
    ).rejects.toMatchObject({ status: 404, response: { code: "us_request_not_found" } });
    await f.db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, c.member));
    await expect(prepare(run)).rejects.toMatchObject({
      status: 403,
      response: { code: "insufficient_permission" },
    });
    expect((await rows()).find((row) => row.id === run.id)).toEqual(run);
  });

  it("keeps v1 actor-bound command identity conflicts for another request and another mode", async () => {
    const run = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    const other = await create();
    for (const command of [
      { requestId: other.id, mode: "available_records_incomplete" },
      { requestId: run.requestId, mode: "export_ready" },
    ] as const) {
      await expect(
        new UsRequestPrepareStore(f.db).prepare(
          c.tenant,
          c.actor,
          command.requestId,
          {
            mode: command.mode,
            idempotencyKey: run.idempotencyKey,
          },
          build,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "us_request_idempotency_conflict" },
      });
    }
    expect((await rows()).find((row) => row.id === run.id)).toEqual(run);
  });

  it("requires fresh v2 validation for a new key after a saved v1 validation digest", async () => {
    const legacy = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    await f.db
      .update(schema.traceRequests)
      .set({ lastValidationDigest: legacy.scopedContentDigest })
      .where(eq(schema.traceRequests.id, legacy.requestId));
    const before = await rows();
    const body = { mode: "available_records_incomplete", idempotencyKey: randomUUID() } as const;
    await expect(
      new UsRequestPrepareStore(f.db).prepare(c.tenant, c.actor, legacy.requestId, body, build),
    ).rejects.toMatchObject({ response: { code: "us_request_validation_stale" } });
    expect(await rows()).toEqual(before);
    const validated = await new UsRequestValidationStore(f.db).validate(
      c.tenant,
      c.actor,
      legacy.requestId,
      build,
    );
    const next = await new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      legacy.requestId,
      body,
      build,
    );
    expect(next.scopedContentDigest).toBe(validated.digest);
    expect(next.scopedContentDigest).not.toBe(legacy.scopedContentDigest);
    expect(next.revision).toBe(legacy.revision + 1);
    expect(requireUsRequestPackageEvidence(next, c.tenant).schemaVersion).toBe(2);
    expect((await rows()).find((row) => row.id === legacy.id)).toEqual(legacy);
  });

  it("captures complete positive reserved-owner Validate/Prepare at independent instants", async () => {
    const { child, owner, request } = await reservedFixture();
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
      const validated = await new UsRequestValidationStore(child.db).validate(
        owner.tenantId,
        owner.userId,
        request.id,
        build,
      );
      vi.setSystemTime(new Date("2026-10-05T11:00:00Z"));
      const run = await new UsRequestPrepareStore(child.db).prepare(
        owner.tenantId,
        owner.userId,
        request.id,
        {
          mode: "available_records_incomplete",
          idempotencyKey: randomUUID(),
        },
        build,
      );
      expect(run.scopedContentDigest).toBe(validated.digest);
      expect(run.startedAt.toISOString()).not.toBe(validated.validatedAt);
      const frozen = requireUsRequestPackageEvidence(run, owner.tenantId);
      expect(frozen).toMatchObject({
        schemaVersion: 2,
        selectionKind: "empty",
        exportInput: null,
        validationSnapshot: {
          schemaVersion: 2,
          tenantOrigin: {
            schemaVersion: 1,
            verificationPolicy: "us-request-tenant-origin-v1",
            result: "trusted_synthetic",
            trustedSeed: { seedId: owner.tenantId, verifiedBy: "us-development-owner-v1" },
          },
        },
      });
      expect(stableStringify(frozen)).not.toContain("verifiedAt");
      expect(parseUsRequestFrozenRun(frozen)).toEqual(frozen);
      const origin = frozen.validationSnapshot.tenantOrigin;
      if (origin.result !== "trusted_synthetic") throw new Error("Missing actual reserved seed");
      for (const broken of [
        {
          ...origin,
          trustedSeed: { ...origin.trustedSeed, verifiedBy: "unsupported-seed-verifier" },
        },
        { ...origin, trustedSeed: { ...origin.trustedSeed, seedId: randomUUID() } },
        { ...origin, trustedSeed: { ...origin.trustedSeed, extra: true } },
      ]) {
        const validationSnapshot = { ...frozen.validationSnapshot, tenantOrigin: broken };
        const corrupted = {
          ...run,
          inputSnapshot: { ...frozen, validationSnapshot },
          scopedContentDigest: canonicalExportDigest(validationSnapshot),
        };
        expect(() => requireUsRequestPackageEvidence(corrupted, owner.tenantId)).toThrow(
          expect.objectContaining({
            status: 503,
            response: { code: "us_request_run_stored_invalid" },
          }),
        );
      }
      const bytes = await renderUsRequestPayloads(run, owner.tenantId);
      await child.db
        .update(schema.organization)
        .set({ metadata: null })
        .where(eq(schema.organization.id, owner.tenantId));
      expect(requireUsRequestPackageEvidence(run, owner.tenantId)).toEqual(frozen);
      expect(await renderUsRequestPayloads(run, owner.tenantId)).toEqual(bytes);
      await expect(
        new UsRequestPrepareStore(child.db).prepare(
          owner.tenantId,
          owner.userId,
          request.id,
          {
            mode: "available_records_incomplete",
            idempotencyKey: randomUUID(),
          },
          build,
        ),
      ).rejects.toMatchObject({ response: { code: "us_request_tenant_origin_invalid" } });
    } finally {
      vi.useRealTimers();
      await child.close();
    }
  }, 60_000);

  it("rejects stale origin after all reserved markers are erased and creates a new revision only after revalidation", async () => {
    const { child, owner, request } = await reservedFixture();
    try {
      const validation = new UsRequestValidationStore(child.db),
        prepareStore = new UsRequestPrepareStore(child.db);
      await validation.validate(owner.tenantId, owner.userId, request.id, build);
      const original = await prepareStore.prepare(
        owner.tenantId,
        owner.userId,
        request.id,
        { mode: "available_records_incomplete", idempotencyKey: randomUUID() },
        build,
      );
      await child.db
        .update(schema.organization)
        .set({ slug: "erased-owned-demo", metadata: null })
        .where(eq(schema.organization.id, owner.tenantId));
      await child.db
        .delete(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, owner.tenantId),
            eq(schema.tenantAuditEvents.action, "us.development.owner.provisioned"),
          ),
        );
      const body = { mode: "available_records_incomplete", idempotencyKey: randomUUID() } as const;
      await expect(
        prepareStore.prepare(owner.tenantId, owner.userId, request.id, body, build),
      ).rejects.toMatchObject({ response: { code: "us_request_validation_stale" } });
      const validated = await validation.validate(owner.tenantId, owner.userId, request.id, build);
      const next = await prepareStore.prepare(
        owner.tenantId,
        owner.userId,
        request.id,
        body,
        build,
      );
      expect(next.revision).toBe(original.revision + 1);
      expect(next.scopedContentDigest).toBe(validated.digest);
      expect(next.scopedContentDigest).not.toBe(original.scopedContentDigest);
      expect(
        requireUsRequestPackageEvidence(next, owner.tenantId).validationSnapshot.tenantOrigin,
      ).toEqual(negative);
      expect(
        requireUsRequestPackageEvidence(original, owner.tenantId).validationSnapshot.tenantOrigin
          .result,
      ).toBe("trusted_synthetic");
    } finally {
      await child.close();
    }
  }, 60_000);

  it.each(modes)(
    "keeps accepted v2 origin and actual event JSON/XLSX after marker drift in %s",
    async (mode) => {
      await finalizeUsRequestPayloadReceiving(f.db, c);
      await seedUsRequestPayloadPlan(f.db, c);
      const request = await create(false);
      await new UsRequestValidationStore(f.db).validate(c.tenant, c.actor, request.id, build);
      const run = await new UsRequestPrepareStore(f.db).prepare(
        c.tenant,
        c.actor,
        request.id,
        { mode, idempotencyKey: randomUUID() },
        build,
      );
      const frozen = requireUsRequestPackageEvidence(run, c.tenant),
        bytes = await renderUsRequestPayloads(run, c.tenant);
      await f.db
        .update(schema.organization)
        .set({
          metadata: JSON.stringify({ seedVersion: "us-development-owner-v1", synthetic: false }),
        })
        .where(eq(schema.organization.id, c.tenant));
      const before = await rows(),
        beforeAudits = await audits();
      expect(await prepare(run)).toEqual(run);
      await replayAudit(beforeAudits, run);
      expect(requireUsRequestPackageEvidence(run, c.tenant)).toEqual(frozen);
      expect(await renderUsRequestPayloads(run, c.tenant)).toEqual(bytes);
      expect(await rows()).toEqual(before);
    },
  );

  it("rejects rehashed v2 structural corruption and normalization-only drift without leaking source details", async () => {
    const legacy = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    const run = await new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      legacy.requestId,
      { mode: "available_records_incomplete", idempotencyKey: randomUUID() },
      build,
    );
    const saved = requireUsRequestPackageEvidence(run, c.tenant);
    const snapshot = saved.validationSnapshot,
      origin = snapshot.tenantOrigin;
    const edits: Array<(frozen: UsRequestFrozenRunV2) => { validationSnapshot: unknown }> = [
      (v) => ({
        ...v,
        validationSnapshot: {
          ...snapshot,
          tenantOrigin: { ...origin, verificationPolicy: "unsupported-private@example.test" },
        },
      }),
      (v) => ({
        ...v,
        validationSnapshot: { ...snapshot, tenantOrigin: { ...origin, schemaVersion: 2 } },
      }),
      (v) => ({
        ...v,
        validationSnapshot: {
          ...snapshot,
          tenantOrigin: {
            ...origin,
            result: "trusted_synthetic",
            trustedSeed: { seedId: randomUUID(), verifiedBy: "us-development-owner-v1" },
          },
        },
      }),
      (v) => ({ ...v, schemaVersion: 1 }),
      (v) => ({ ...v, validationSnapshot: { ...snapshot, schemaVersion: 1 } }),
      (v) => ({
        ...v,
        validationSnapshot: {
          ...snapshot,
          tenantOrigin: {
            ...origin,
            trustedSeed: { seedId: c.tenant, verifiedBy: "us-development-owner-v1" },
          },
        },
      }),
      (v) => ({
        ...v,
        validationSnapshot: {
          ...snapshot,
          tenantOrigin: { ...origin, extra: "private@example.test" },
        },
      }),
      (v) => ({ ...v, validationSnapshot: { ...snapshot, extra: true } }),
      (v) => ({ ...v, extra: true }),
      (v) => ({
        ...v,
        validationSnapshot: {
          ...snapshot,
          request: { ...snapshot.request, requesterName: snapshot.request.requesterName + " " },
        },
      }),
    ];
    const before = await rows(),
      beforeAudits = await audits();
    for (const edit of edits) {
      const corrupted = edit(structuredClone(saved));
      const invalid = {
        ...run,
        inputSnapshot: corrupted,
        scopedContentDigest: canonicalExportDigest(corrupted.validationSnapshot),
      };
      let failure: unknown;
      try {
        verifyUsRequestRunEvidence(invalid, c.tenant);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        status: 503,
        response: { code: "us_request_run_stored_invalid" },
      });
      expect(failure).not.toHaveProperty("cause");
      expect(String(failure)).not.toContain("private@example.test");
      await expect(renderUsRequestPayloads(invalid, c.tenant)).rejects.toMatchObject({
        response: { code: "us_request_run_stored_invalid" },
      });
    }
    expect(parseUsRequestFrozenRun({ schemaVersion: 2 })).toBeNull();
    expect(await rows()).toEqual(before);
    expect(await audits()).toEqual(beforeAudits);
  });

  it("rejects untrusted scope-capture origin shape and positive tenant mismatch", async () => {
    const request = await create();
    for (const origin of [
      { ...negative, extra: true },
      {
        ...negative,
        result: "trusted_synthetic" as const,
        trustedSeed: { seedId: randomUUID(), verifiedBy: "us-development-owner-v1" as const },
      },
    ]) {
      await expect(
        transformationTransaction(f.db, (tx) =>
          captureUsRequestScope(tx, c.tenant, c.actor, request, build, origin),
        ),
      ).rejects.toMatchObject({ response: { code: "us_request_snapshot_invalid" } });
    }
  });

  it("captures positive origin and scope in the established repeatable-read transaction during a concurrent marker edit", async () => {
    const { child, owner, request } = await reservedFixture();
    try {
      const originalCapture = origins.captureUsRequestTenantOrigin;
      const observedCapture = vi
        .spyOn(origins, "captureUsRequestTenantOrigin")
        .mockImplementation(async (...args) => {
          const origin = await originalCapture(...args);
          await child.pool.query("UPDATE organization SET metadata = NULL WHERE id = $1", [
            owner.tenantId,
          ]);
          return origin;
        });
      const scopeCapture = vi.spyOn(snapshots, "captureUsRequestScope");
      const validated = await new UsRequestValidationStore(child.db).validate(
        owner.tenantId,
        owner.userId,
        request.id,
        build,
      );
      const originTransaction = observedCapture.mock.calls[0]?.[1];
      observedCapture.mockRestore();
      expect(scopeCapture).toHaveBeenCalledTimes(1);
      const scope = await scopeCapture.mock.results[0]?.value;
      expect(scope?.digest).toBe(validated.digest);
      expect(scope?.snapshot.tenantOrigin).toMatchObject({
        result: "trusted_synthetic",
        trustedSeed: { seedId: owner.tenantId },
      });
      await expect(
        transformationTransaction(child.db, (tx) =>
          captureUsRequestTenantOrigin(child.db, tx, owner.tenantId),
        ),
      ).rejects.toMatchObject({ response: { code: "us_request_tenant_origin_invalid" } });
      // The verifier's check and the scope snapshot share the same transaction object.
      expect(Boolean(originTransaction)).toBe(true);
      expect(originTransaction === scopeCapture.mock.calls[0]?.[0]).toBe(true);
    } finally {
      await child.close();
    }
  }, 60_000);
});
