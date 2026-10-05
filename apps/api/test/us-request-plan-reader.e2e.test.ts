import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as pdf from "../src/modules/traceability/plans/us-plan-pdf";
import { UsPlanStore } from "../src/modules/traceability/plans/us-plan-store";
import { UsRequestPlanReader } from "../src/modules/traceability/requests/us-request-plan-reader";
import {
  verifyUsRequestRunEvidence,
  type UsTraceExportRunRow,
} from "../src/modules/traceability/requests/us-request-run-evidence";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { renderUsRequestPayloads } from "../src/modules/traceability/requests/us-request-payloads";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { finalizeUsRequestPayloadReceiving } from "./support/us-request-payload-fixture";
import { createUsRequestPlanFixture } from "./support/us-request-plan-fixture";
import { seedLegacyUsRequestRun } from "./support/us-request-v1-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const build = { apiVersion: "test-us09-plan", gitSha: "a".repeat(40), dirty: false } as const;
const modes = ["export_ready", "available_records_incomplete"] as const;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!url)("US request exact pinned Plan bytes in disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let plan: ReturnType<typeof createUsRequestPlanFixture>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => f?.close());
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
    plan = createUsRequestPlanFixture(f.db, c);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    plan?.destroy();
  });
  const prepare = async (mode: (typeof modes)[number], empty = false) => {
    if (!empty) await finalizeUsRequestPayloadReceiving(f.db, c);
    const request = await new UsRequestStore(f.db).create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic Plan requester",
      requesterOrganization: null,
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope: empty ? { tlcs: ["NO-MATCH-PLAN-FIXTURE"] } : { lotId: c.lot },
    });
    await new UsRequestValidationStore(f.db).validate(c.tenant, c.actor, request.id, build);
    return new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      request.id,
      { mode, idempotencyKey: randomUUID() },
      build,
    );
  };
  const persisted = async () => ({
    runs: await f.db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.tenantId, c.tenant))
      .orderBy(asc(schema.traceExportRuns.id)),
    artifacts: await f.db
      .select()
      .from(schema.traceExportArtifacts)
      .where(eq(schema.traceExportArtifacts.tenantId, c.tenant))
      .orderBy(asc(schema.traceExportArtifacts.id)),
    plans: await f.db
      .select()
      .from(schema.traceabilityPlanVersions)
      .where(eq(schema.traceabilityPlanVersions.tenantId, c.tenant))
      .orderBy(asc(schema.traceabilityPlanVersions.id)),
    audits: await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant))
      .orderBy(asc(schema.tenantAuditEvents.id)),
  });
  const fail = async (
    operation: Promise<unknown>,
    code = "us_request_plan_read_failed",
    status = 503,
  ) => {
    const failure = await operation.catch((error: unknown) => error);
    expect(failure).toMatchObject({ status });
    expect(failure).toHaveProperty("response", { code });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain("private@example.test");
    expect(JSON.stringify(failure)).not.toContain("us/plans/");
    expect(String(failure)).not.toContain("private@example.test");
  };
  // Cloned, internally consistent evidence reaches row guards without weakening FKs.
  const repin = (run: UsTraceExportRunRow, id: string | null, sha256: string | null) => {
    const frozen = structuredClone(verifyUsRequestRunEvidence(run, c.tenant));
    frozen.validationSnapshot.plan = id && sha256 ? { id, pdfSha256: sha256 } : null;
    const scopedContentDigest = canonicalExportDigest(frozen.validationSnapshot);
    if (frozen.warningAcknowledgement) frozen.warningAcknowledgement.digest = scopedContentDigest;
    return {
      ...run,
      planVersionId: id,
      planPdfSha256: sha256,
      inputSnapshot: frozen,
      scopedContentDigest,
    };
  };

  it.each(modes)("reads exact effective PDF bytes without writes in %s", async (mode) => {
    const published = await plan.approve("Synthetic first version");
    const run = await prepare(mode);
    const original = Buffer.from(plan.objects.get(published.artifact.objectKey) ?? []);
    const before = await persisted();
    plan.transport.calls.length = 0;
    const render = vi.spyOn(pdf, "renderUsPlanPdf");
    expect(await new UsRequestPlanReader(f.db, plan.artifacts).read(run, c.tenant)).toEqual({
      kind: "pdf",
      planVersionId: published.id,
      sha256: hash(original),
      byteSize: original.length,
      bytes: original,
    });
    expect(plan.transport.calls).toEqual([
      { command: "GetObjectCommand", key: published.artifact.objectKey },
    ]);
    expect(render).not.toHaveBeenCalled();
    expect(await persisted()).toEqual(before);
  });

  it.each(modes)(
    "reads the exact superseded PDF without current fallback or writes in %s",
    async (mode) => {
      const first = await plan.approve("Synthetic first version");
      const original = Buffer.from(plan.objects.get(first.artifact.objectKey) ?? []);
      expect(original.subarray(0, 5).toString()).toBe("%PDF-");
      const run = await prepare(mode);
      const second = await plan.approve("Synthetic second version");
      const before = await persisted();
      expect(before.plans.find((row) => row.id === first.id)?.status).toBe("superseded");
      expect(before.plans.find((row) => row.id === second.id)?.status).toBe("effective");
      plan.transport.calls.length = 0;
      const render = vi.spyOn(pdf, "renderUsPlanPdf");
      const send = plan.transport.send.bind(plan.transport);
      vi.spyOn(plan.transport, "send").mockImplementation(async (...args) => {
        // The metadata transaction must be committed before the external read.
        const active = await f.pool.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'",
        );
        expect(active.rows[0]?.count).toBe("0");
        return send(...args);
      });
      const reader = new UsRequestPlanReader(f.db, plan.artifacts);
      const result = await reader.read(run, c.tenant);
      expect(result).toEqual({
        kind: "pdf",
        planVersionId: first.id,
        sha256: hash(original),
        byteSize: original.length,
        bytes: original,
      });
      if (result.kind !== "pdf") throw new Error("Missing fixture PDF");
      result.bytes.fill(0);
      const again = await reader.read(run, c.tenant);
      expect(again.kind === "pdf" ? again.bytes : null).toEqual(original);
      expect(plan.transport.calls).toEqual([
        { command: "GetObjectCommand", key: first.artifact.objectKey },
        { command: "GetObjectCommand", key: first.artifact.objectKey },
      ]);
      expect(render).not.toHaveBeenCalled();
      expect(await persisted()).toEqual(before);
    },
  );

  it("rejects legacy package assembly before I/O while v1 JSON and XLSX remain readable", async () => {
    const legacy = await seedLegacyUsRequestRun(f.db, c, "export_ready");
    const before = await persisted();
    const transaction = vi.spyOn(f.db, "transaction");
    await fail(
      new UsRequestPlanReader(f.db, plan.artifacts).read(legacy, c.tenant),
      "us_request_package_refreeze_required",
      409,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(plan.transport.calls).toEqual([]);
    const payload = await renderUsRequestPayloads(legacy, c.tenant);
    expect(JSON.parse(payload.validation.bytes.toString())).toMatchObject({ schemaVersion: 1 });
    expect(payload.workbook?.bytes.length).toBeGreaterThan(0);
    expect(await persisted()).toEqual(before);
  });

  it("denies saved cross-tenant evidence before database or object I/O", async () => {
    await plan.approve("Synthetic first version");
    const run = await prepare("export_ready");
    plan.transport.calls.length = 0;
    const transaction = vi.spyOn(f.db, "transaction");
    await fail(
      new UsRequestPlanReader(f.db, plan.artifacts).read(run, randomUUID()),
      "us_request_run_stored_invalid",
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(plan.transport.calls).toEqual([]);
  });

  it.each([true, false])(
    "returns original incomplete absence without configured storage or I/O (empty %s)",
    async (empty) => {
      const run = await prepare("available_records_incomplete", empty);
      const before = await persisted();
      const transaction = vi.spyOn(f.db, "transaction");
      expect(await new UsRequestPlanReader(f.db, null).read(run, c.tenant)).toEqual({
        kind: "absent",
        code: "plan_absent",
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(plan.transport.calls).toEqual([]);
      transaction.mockRestore();
      expect(await persisted()).toEqual(before);
    },
  );

  it("rejects ready-mode Plan absence before any I/O", async () => {
    await plan.approve("Synthetic first version");
    const ready = repin(await prepare("export_ready"), null, null);
    const before = await persisted();
    plan.transport.calls.length = 0;
    const noIo = vi.spyOn(f.db, "transaction");
    await fail(
      new UsRequestPlanReader(f.db, null).read(ready, c.tenant),
      "us_request_run_stored_invalid",
    );
    expect(noIo).not.toHaveBeenCalled();
    expect(plan.transport.calls).toEqual([]);
    noIo.mockRestore();
    expect(await persisted()).toEqual(before);
  });

  it.each(modes)(
    "sanitizes metadata infrastructure failure without object I/O in %s",
    async (mode) => {
      await plan.approve("Synthetic first version");
      const run = await prepare(mode);
      const before = await persisted();
      plan.transport.calls.length = 0;
      vi.spyOn(f.db, "transaction").mockRejectedValueOnce(
        new Error("private@example.test us/plans/private-key", { cause: new Error("private") }),
      );
      await fail(new UsRequestPlanReader(f.db, plan.artifacts).read(run, c.tenant));
      expect(plan.transport.calls).toEqual([]);
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(modes)(
    "fails configured, object, provider, body and byte corruption in %s",
    async (mode) => {
      const published = await plan.approve("Synthetic first version");
      const run = await prepare(mode);
      const before = await persisted();
      plan.transport.calls.length = 0;
      await fail(new UsRequestPlanReader(f.db, null).read(run, c.tenant));
      expect(plan.transport.calls).toEqual([]);
      const reader = new UsRequestPlanReader(f.db, plan.artifacts);
      const original = Buffer.from(plan.objects.get(published.artifact.objectKey) ?? []);
      plan.objects.delete(published.artifact.objectKey);
      await fail(reader.read(run, c.tenant));
      plan.objects.set(published.artifact.objectKey, Buffer.alloc(original.length));
      await fail(reader.read(run, c.tenant));
      plan.objects.set(published.artifact.objectKey, original);
      for (const fault of ["unavailable", "type", "length", "body", "oversize"] as const) {
        plan.transport.fault = fault;
        await fail(reader.read(run, c.tenant));
        if (fault !== "unavailable") expect(plan.transport.lastBody?.destroyed).toBe(true);
      }
      plan.transport.fault = null;
      expect(
        plan.transport.calls.every(
          (call) =>
            call.command === "GetObjectCommand" && call.key === published.artifact.objectKey,
        ),
      ).toBe(true);
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(modes)(
    "fails missing, foreign, draft and corrupt published metadata before object I/O in %s",
    async (mode) => {
      const published = await plan.approve("Synthetic first version");
      const run = await prepare(mode);
      const foreign = await seedCompleteReceiving(f.db);
      const otherPlan = createUsRequestPlanFixture(f.db, foreign);
      try {
        const other = await otherPlan.approve("Synthetic foreign version");
        const draft = await new UsPlanStore(f.db).createDraft(
          c.tenant,
          c.actor,
          { sections: published.evidence.snapshot.sections, changeSummary: "Synthetic draft" },
          "synthetic-draft",
        );
        const before = await persisted();
        plan.transport.calls.length = 0;
        const reader = new UsRequestPlanReader(f.db, plan.artifacts);
        for (const id of [randomUUID(), other.id, draft.id]) {
          await fail(reader.read(repin(run, id, published.artifact.sha256), c.tenant));
        }
        await fail(reader.read(repin(run, published.id, "f".repeat(64)), c.tenant));
        expect(plan.transport.calls).toEqual([]);
        expect(await persisted()).toEqual(before);
        const row = before.plans.find((item) => item.id === published.id);
        if (!row) throw new Error("Missing fixture row");
        for (const patch of [
          { pdfSha256: "e".repeat(64) },
          { pdfObjectKey: "us/plans/private@example.test.pdf" },
          { approvedEvidence: {} },
          { configDigest: "e".repeat(64) },
        ]) {
          // Out-of-band damage in this owned database only. All FKs remain active,
          // and the immutability guard is restored before executing the reader.
          const replace = async (values: typeof patch | typeof row) => {
            await f.pool.query(
              "ALTER TABLE traceability_plan_versions DISABLE TRIGGER traceability_plan_versions_guard_trigger",
            );
            try {
              await f.db
                .update(schema.traceabilityPlanVersions)
                .set(values)
                .where(
                  and(
                    eq(schema.traceabilityPlanVersions.tenantId, c.tenant),
                    eq(schema.traceabilityPlanVersions.id, row.id),
                  ),
                );
            } finally {
              await f.pool.query(
                "ALTER TABLE traceability_plan_versions ENABLE TRIGGER traceability_plan_versions_guard_trigger",
              );
            }
          };
          try {
            await replace(patch);
            const corrupted = await persisted();
            await fail(reader.read(run, c.tenant));
            expect(await persisted()).toEqual(corrupted);
            expect(plan.transport.calls).toEqual([]);
          } finally {
            await replace(row);
          }
        }
        expect(await persisted()).toEqual(before);
      } finally {
        otherPlan.destroy();
      }
    },
  );

  it.each(modes)(
    "defensively verifies injected adapter size/hash and copies caller bytes in %s",
    async (mode) => {
      const published = await plan.approve("Synthetic first version");
      const run = await prepare(mode);
      const original = Buffer.from(plan.objects.get(published.artifact.objectKey) ?? []);
      const before = await persisted();
      const readVerified = vi.fn(async () => original);
      const reader = new UsRequestPlanReader(f.db, { readVerified });
      const result = await reader.read(run, c.tenant);
      expect(readVerified).toHaveBeenCalledExactlyOnceWith(
        { tenantId: c.tenant, versionId: published.id },
        published.artifact,
      );
      if (result.kind !== "pdf") throw new Error("Missing fixture PDF");
      result.bytes.fill(0);
      expect(hash(original)).toBe(published.artifact.sha256);
      for (const bytes of [
        Buffer.alloc(original.length),
        original.subarray(0, original.length - 1),
      ]) {
        readVerified.mockResolvedValueOnce(bytes);
        await fail(reader.read(run, c.tenant));
      }
      expect(
        plan.transport.calls.filter((call) => call.command === "PutObjectCommand"),
      ).toHaveLength(1);
      expect(await persisted()).toEqual(before);
    },
  );
});
