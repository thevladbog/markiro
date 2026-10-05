import { schema } from "@markiro/db";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ServiceUnavailableException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsRequestPlanReader } from "../src/modules/traceability/requests/us-request-plan-reader";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import { UsRequestWorkerCheckpoints } from "../src/modules/traceability/requests/us-request-worker-checkpoint";
import { UsRequestWorkerPublication } from "../src/modules/traceability/requests/us-request-worker-publication";
import { UsRequestWorkerCleanup } from "../src/modules/traceability/requests/us-request-worker-cleanup";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";
import { createUsRequestWorkerStorageFixture } from "./support/us-request-worker-storage-fixture";
import { seedLegacyUsRequestRun, legacyRequestBuild } from "./support/us-request-v1-fixture";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import type { UsWorkerLease } from "../src/modules/traceability/requests/us-request-worker-types";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import {
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
} from "../src/modules/traceability/requests/us-request-package-types";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import { verifyUsRequestRunEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("one-run US request worker in owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof createUsRequestPackageFixture>>;
  let storage: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  let lifecycle: UsRequestWorkerLifecycle;
  let checkpoints: UsRequestWorkerCheckpoints;
  let publication: UsRequestWorkerPublication;
  let planReader: UsRequestPlanReader;
  beforeEach(async () => {
    if (!url) throw new Error("Explicit US fixture URL required");
    f = await createUsProfileTestDatabase(url);
    c = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
    storage = createUsRequestWorkerStorageFixture();
    lifecycle = new UsRequestWorkerLifecycle(f.db);
    checkpoints = new UsRequestWorkerCheckpoints(f.db, lifecycle);
    publication = new UsRequestWorkerPublication(f.db, lifecycle);
    planReader = new UsRequestPlanReader(f.db, c.planFixture.artifacts);
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    storage?.destroy();
    c?.destroy();
    await f?.close();
  });
  const worker = async (configured = true) => {
    const { UsRequestWorker } =
      await import("../src/modules/traceability/requests/us-request-worker");
    const { createSyntheticUsRequestExecutionIdentity } =
      await import("../src/modules/traceability/requests/us-request-worker-execution");
    return new UsRequestWorker(f.db, {
      lifecycle,
      checkpoints,
      publication,
      cleanup: new UsRequestWorkerCleanup(f.db, storage.store),
      planReader,
      storage: configured ? storage.store : null,
      execution: createSyntheticUsRequestExecutionIdentity(
        { apiVersion: "test-us09-package", gitSha: "a".repeat(40), dirty: false },
        { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
      ),
    });
  };
  const scope = () => ({ tenantId: c.tenantId, runId: c.run.id });
  const replace = async (options: Parameters<typeof createUsRequestPackageFixture>[1]) => {
    const old = await lifecycle.claimNext();
    if (!old) throw new Error("Missing old fixture lease");
    await lifecycle.finishFailure(old, {
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
    c.destroy();
    c = await createUsRequestPackageFixture(f.db, options);
    planReader = new UsRequestPlanReader(f.db, c.planFixture.artifacts);
  };
  const dbNow = async () => {
    const result = await f.pool.query<{ instant: Date }>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS instant",
    );
    const instant = result.rows[0]?.instant;
    if (!instant) throw new Error("Missing DB clock");
    return instant;
  };
  const priorLease = async (): Promise<UsWorkerLease> => {
    const old = await lifecycle.claimNext();
    if (!old) throw new Error("Missing prior fixture lease");
    await lifecycle.finishFailure(old, {
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
    c.destroy();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date((await dbNow()).getTime() - 180_000));
    try {
      c = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
    } finally {
      vi.useRealTimers();
    }
    planReader = new UsRequestPlanReader(f.db, c.planFixture.artifacts);
    // Explicit synthetic prior state, valid INSERT; immutable clocks/SQL guards stay active.
    const start = new Date((await dbNow()).getTime() - 119_400);
    const expiry = new Date(start.getTime() + 120_000);
    const deadline = new Date(start.getTime() + 300_000);
    const lease = {
      ...scope(),
      attemptId: randomUUID(),
      token: randomUUID(),
      attemptNumber: 1,
      cycle: 1,
      startedAt: start.toISOString(),
      expiresAt: expiry.toISOString(),
      deadlineAt: deadline.toISOString(),
    };
    await f.db.insert(schema.traceExportAttempts).values({
      id: lease.attemptId,
      tenantId: c.tenantId,
      runId: c.run.id,
      token: lease.token,
      attemptNumber: 1,
      cycle: 1,
      status: "active",
      startedAt: start,
      leaseExpiresAt: expiry,
      deadlineAt: deadline,
    });
    await f.db
      .update(schema.traceExportRuns)
      .set({
        status: "processing",
        attemptCount: 1,
        cycleAttemptCount: 1,
        lifecycleVersion: 1,
        leaseAttemptId: lease.attemptId,
        leaseToken: lease.token,
        leaseExpiresAt: expiry,
        attemptDeadlineAt: deadline,
        generationStartedAt: start,
      })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    vi.spyOn(lifecycle, "claimNext").mockResolvedValueOnce(lease);
    return lease;
  };
  const passExpiry = async (lease: UsWorkerLease) => {
    await f.pool.query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)",
      [lease.expiresAt],
    );
  };
  const snapshot = async () => ({
    runs: await f.db.select().from(schema.traceExportRuns),
    attempts: await f.db.select().from(schema.traceExportAttempts),
    checkpoints: await f.db.select().from(schema.traceExportRenderCheckpoints),
    objects: await f.db.select().from(schema.traceExportObjectIntents),
    artifacts: await f.db.select().from(schema.traceExportArtifacts),
    audits: await f.db.select().from(schema.tenantAuditEvents),
  });
  it("leaves every durable row exactly unchanged when storage is absent", async () => {
    const before = await snapshot();
    const read = vi.spyOn(planReader, "read");
    const render = await import("../src/modules/traceability/requests/us-request-report-pdf");
    const pdf = vi.spyOn(render, "renderUsRequestReportPdf");
    expect(await (await worker(false)).runOne()).toEqual({ kind: "storage_unavailable" });
    expect(await snapshot()).toEqual(before);
    expect(read).not.toHaveBeenCalled();
    expect(pdf).not.toHaveBeenCalled();
  });
  it("uses real bytes, checkpoints before PDF and allocation before verified conditional upload", async () => {
    const originalPlanObjects = new Map(c.planFixture.objects);
    const planCallCount = c.planFixture.transport.calls.length;
    const renderer = await import("../src/modules/traceability/requests/us-request-report-pdf");
    const original = renderer.renderUsRequestReportPdf;
    const render = vi
      .spyOn(renderer, "renderUsRequestReportPdf")
      .mockImplementation(async (model) => {
        const state = await lifecycle.read({ tenantId: c.tenantId, runId: c.run.id });
        expect(state.checkpoint?.model).toEqual(model);
        expect(state.expectation).toBeNull();
        expect(storage.calls).toEqual([]);
        return original(model);
      });
    const put = storage.store.putVerified.bind(storage.store);
    vi.spyOn(storage.store, "putVerified").mockImplementation(async (scope, evidence, bytes) => {
      const state = await lifecycle.read(scope);
      expect(state.expectation).not.toBeNull();
      const intents = await f.db.select().from(schema.traceExportObjectIntents);
      expect(intents.find((o) => o.id === evidence.id)?.state).toBe("allocated");
      await put(scope, evidence, bytes);
    });
    expect(await (await worker()).runOne()).toEqual({
      kind: "ready",
      scope: { tenantId: c.tenantId, runId: c.run.id },
    });
    const state = await lifecycle.read({ tenantId: c.tenantId, runId: c.run.id });
    expect(state.run.exportReady).toBe(true);
    expect(state.checkpoint?.model.tenantOrigin.result).toBe("not_attested");
    expect(state.checkpoint?.model.timing.workerStartedAt).toBe(
      state.attempts[0]?.startedAt.toISOString(),
    );
    expect(state.run.reportRenderedAt?.getTime()).toBeGreaterThanOrEqual(
      Date.parse(state.checkpoint?.model.timing.reportDataPreparedAt ?? ""),
    );
    expect(state.run.completedAt?.getTime()).toBeGreaterThanOrEqual(
      state.run.reportRenderedAt?.getTime() ?? 0,
    );
    expect(state.artifacts.map((a) => a.kind).sort()).toEqual(
      ["xlsx", "plan_pdf", "validation_report", "request_report", "manifest", "package_zip"].sort(),
    );
    for (const artifact of state.artifacts) {
      const object = storage.objects.get(artifact.objectKey);
      expect(object?.bytes.length).toBe(Number(artifact.byteSize));
      expect(
        createHash("sha256")
          .update(object?.bytes ?? Buffer.alloc(0))
          .digest("hex"),
      ).toBe(artifact.sha256);
      expect(artifact.publishedAt).toEqual(state.run.completedAt);
    }
    expect(storage.calls.map((call) => call.kind)).toEqual(
      Array.from({ length: 6 }, () => ["put", "get"]).flat(),
    );
    expect(storage.calls.every((call) => call.command.input.Key?.startsWith("us/requests/"))).toBe(
      true,
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(c.planFixture.objects).toEqual(originalPlanObjects);
    expect(c.planFixture.transport.calls.slice(planCallCount).map((call) => call.command)).toEqual([
      "GetObjectCommand",
    ]);
    expect(await (await worker()).runOne()).toEqual({ kind: "idle" });
    expect(render).toHaveBeenCalledTimes(1);
    const audits = await f.db.select().from(schema.tenantAuditEvents);
    const published = audits.filter((a) => a.action === "traceability.request.worker.published");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      organizationId: c.tenantId,
      actorUserId: null,
      targetId: c.run.id,
      targetType: "trace_export_run",
      outcome: "success",
      after: {
        actorKind: "system",
        initiatorId: c.actorId,
        runId: c.run.id,
        requestId: c.request.id,
        attemptNumber: 1,
        mode: "export_ready",
      },
    });
  });
  it("fails build drift before Plan or package I/O with a finite result", async () => {
    const module = await import("../src/modules/traceability/requests/us-request-worker-execution");
    const create = module.createSyntheticUsRequestExecutionIdentity;
    vi.spyOn(module, "createSyntheticUsRequestExecutionIdentity").mockImplementationOnce(
      (build, source) => {
        return create({ ...build, gitSha: "b".repeat(40) }, source);
      },
    );
    const read = vi.spyOn(planReader, "read");
    const result = await (await worker()).runOne();
    expect(result).toEqual({
      kind: "failed",
      scope: { tenantId: c.tenantId, runId: c.run.id },
      code: "us_request_worker_execution_invalid",
    });
    expect(read).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([]);
    expect((await snapshot()).checkpoints).toEqual([]);
  });
  it("does not upload when the frozen pinned Plan cannot be read", async () => {
    c.planFixture.transport.fault = "unavailable";
    expect(await (await worker()).runOne()).toMatchObject({
      kind: "failed",
      code: "us_request_plan_read_failed",
    });
    expect(storage.calls).toEqual([]);
    expect((await snapshot()).checkpoints).toEqual([]);
  });
  it("routes classified storage failures to delayed retry while retaining checkpoint", async () => {
    vi.spyOn(storage.store, "putVerified").mockRejectedValueOnce({
      code: "us_request_package_storage_timeout",
    });
    expect(await (await worker()).runOne()).toMatchObject({ kind: "retry_scheduled" });
    const state = await lifecycle.read({ tenantId: c.tenantId, runId: c.run.id });
    expect(state.run.status).toBe("queued");
    expect(state.run.nextAttemptAt).not.toBeNull();
    expect(state.checkpoint).not.toBeNull();
    expect(state.expectation).not.toBeNull();
    expect(state.artifacts).toEqual([]);
  });
  it("reconciles an actual committed publication before considering failure or cleanup", async () => {
    const publish = publication.publish.bind(publication);
    vi.spyOn(publication, "publish").mockImplementationOnce(async (lease) => {
      await publish(lease);
      throw { code: "08007", private: "must not escape" };
    });
    const failure = vi.spyOn(lifecycle, "finishFailure");
    expect(await (await worker()).runOne()).toMatchObject({ kind: "ready" });
    expect(failure).not.toHaveBeenCalled();
    expect(storage.calls.some((call) => call.kind === "delete")).toBe(false);
  });
  it("prevents publication when the original initiator loses authority after render", async () => {
    const accept = checkpoints.acceptPackage.bind(checkpoints);
    vi.spyOn(checkpoints, "acceptPackage").mockImplementationOnce(async (...args) => {
      const saved = await accept(...args);
      await f.db
        .update(schema.member)
        .set({ role: "viewer" })
        .where(eq(schema.member.userId, c.actorId));
      return saved;
    });
    expect(await (await worker()).runOne()).toMatchObject({
      kind: "failed",
      code: "insufficient_permission",
    });
    expect((await snapshot()).artifacts).toEqual([]);
  });
  it.each([false, true])(
    "publishes frozen incomplete mode with original Plan presence %s",
    async (withPlan) => {
      await replace({ mode: "available_records_incomplete", withPlan });
      expect(await (await worker()).runOne()).toEqual({ kind: "ready", scope: scope() });
      const state = await lifecycle.read(scope());
      expect(state.run.exportReady).toBe(false);
      expect(state.checkpoint?.model.identity.mode).toBe("available_records_incomplete");
      expect(state.artifacts.some((a) => a.kind === "plan_pdf")).toBe(withPlan);
      expect(state.checkpoint?.model.missingFiles.some((m) => m.code === "plan_absent")).toBe(
        !withPlan,
      );
    },
  );
  it("publishes valid empty incomplete selection without a fabricated workbook", async () => {
    await replace({ mode: "available_records_incomplete", withPlan: false, empty: true });
    expect(await (await worker()).runOne()).toMatchObject({ kind: "ready" });
    const state = await lifecycle.read(scope());
    expect(state.artifacts).toHaveLength(4);
    expect(state.checkpoint?.model.missingFiles).toEqual([
      { name: "records.xlsx", code: "empty_selection" },
      { name: "plan.pdf", code: "plan_absent" },
    ]);
  });
  it("rejects full v1 execution before payload/Plan/private I/O and preserves snapshot", async () => {
    const first = await lifecycle.claimNext();
    if (!first) throw new Error("Missing original lease");
    await lifecycle.finishFailure(first, {
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
    const seeded = await seedCompleteReceiving(f.db);
    const legacy = await seedLegacyUsRequestRun(f.db, seeded, "available_records_incomplete");
    const siblings = await f.db
      .select()
      .from(schema.traceExportRuns)
      .where(
        and(
          eq(schema.traceExportRuns.tenantId, legacy.tenantId),
          eq(schema.traceExportRuns.requestId, legacy.requestId),
        ),
      );
    expect(siblings).toHaveLength(2);
    const prepared = siblings.find((run) => run.id !== legacy.id);
    if (!prepared) throw new Error("Missing exact companion v2 run");
    expect(verifyUsRequestRunEvidence(legacy, seeded.tenant).schemaVersion).toBe(1);
    expect(verifyUsRequestRunEvidence(prepared, seeded.tenant).schemaVersion).toBe(2);
    expect(prepared).toMatchObject({
      tenantId: legacy.tenantId,
      requestId: legacy.requestId,
      revision: legacy.revision - 1,
      startedAt: legacy.startedAt,
      status: "queued",
      attemptCount: 0,
    });
    // These fixture rows share startedAt, so UUID order cannot select v2 by name.
    // Defer only the validated v2 companion; the worker's real claim must own v1.
    const [deferred] = await f.db
      .update(schema.traceExportRuns)
      .set({
        nextAttemptAt: sql`date_trunc('milliseconds',clock_timestamp()) + interval '10 minutes'`,
      })
      .where(
        and(
          eq(schema.traceExportRuns.tenantId, prepared.tenantId),
          eq(schema.traceExportRuns.id, prepared.id),
        ),
      )
      .returning();
    expect(deferred?.id).toBe(prepared.id);
    expect(deferred?.nextAttemptAt?.getTime()).toBeGreaterThan((await dbNow()).getTime());
    const module = await import("../src/modules/traceability/requests/us-request-worker-execution");
    const create = module.createSyntheticUsRequestExecutionIdentity;
    vi.spyOn(module, "createSyntheticUsRequestExecutionIdentity").mockImplementationOnce(
      (_build, source) => create(legacyRequestBuild, source),
    );
    const payloadModule = await import("../src/modules/traceability/requests/us-request-payloads");
    const payload = vi.spyOn(payloadModule, "renderUsRequestPayloads");
    const read = vi.spyOn(planReader, "read");
    expect(await (await worker()).runOne()).toEqual({
      kind: "failed",
      scope: { tenantId: legacy.tenantId, runId: legacy.id },
      code: "us_request_package_refreeze_required",
    });
    expect(payload).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([]);
    const [after] = await f.db
      .select()
      .from(schema.traceExportRuns)
      .where(
        and(
          eq(schema.traceExportRuns.tenantId, legacy.tenantId),
          eq(schema.traceExportRuns.id, legacy.id),
        ),
      );
    expect(after?.inputSnapshot).toEqual(legacy.inputSnapshot);
    expect(after).toMatchObject({
      id: legacy.id,
      tenantId: legacy.tenantId,
      status: "failed",
      failureCode: "us_request_package_refreeze_required",
      attemptCount: 1,
    });
    const claimed = await lifecycle.read({ tenantId: legacy.tenantId, runId: legacy.id });
    expect(claimed.attempts).toHaveLength(1);
    expect(claimed.attempts[0]).toMatchObject({
      tenantId: legacy.tenantId,
      runId: legacy.id,
      status: "failed",
      failureCode: "us_request_package_refreeze_required",
    });
    expect(claimed.checkpoint).toBeNull();
    expect(claimed.artifacts).toEqual([]);
    const companion = await lifecycle.read({ tenantId: prepared.tenantId, runId: prepared.id });
    expect(companion.run).toEqual(deferred);
    expect(companion.attempts).toEqual([]);
  });
  it.each(["Plan read", "PDF render", "upload readback"])(
    "rejects a late %s result after actual persisted expiry",
    async (boundary) => {
      const lease = await priorLease();
      if (boundary === "Plan read") {
        const read = planReader.read.bind(planReader);
        vi.spyOn(planReader, "read").mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          await passExpiry(lease);
          return result;
        });
      } else if (boundary === "PDF render") {
        const renderer = await import("../src/modules/traceability/requests/us-request-report-pdf");
        const render = renderer.renderUsRequestReportPdf;
        vi.spyOn(renderer, "renderUsRequestReportPdf").mockImplementationOnce(async (model) => {
          const result = await render(model);
          await passExpiry(lease);
          return result;
        });
      } else {
        const put = storage.store.putVerified.bind(storage.store);
        vi.spyOn(storage.store, "putVerified").mockImplementationOnce(async (...args) => {
          await put(...args);
          await passExpiry(lease);
        });
      }
      expect(await (await worker()).runOne()).toEqual({ kind: "lease_lost", scope: scope() });
      const state = await lifecycle.read(scope());
      expect(state.artifacts).toEqual([]);
      const intents = await f.db.select().from(schema.traceExportObjectIntents);
      expect(intents.some((o) => o.state === "verified" || o.state === "referenced")).toBe(false);
      if (boundary !== "upload readback") expect(storage.calls).toEqual([]);
      else expect(storage.calls.map((call) => call.kind)).toEqual(["put", "get"]);
    },
  );
  it("continues with an original captured lease after its expiry was durably renewed", async () => {
    const original = await priorLease();
    const renewed = await lifecycle.renew(original);
    expect(renewed.expiresAt > original.expiresAt).toBe(true);
    await passExpiry(original);
    expect(await (await worker()).runOne()).toEqual({ kind: "ready", scope: scope() });
    expect((await lifecycle.read(scope())).attempts[0]?.leaseExpiresAt.toISOString()).toBe(
      renewed.expiresAt,
    );
  });
  it("retains objects when post-publication reconciliation cannot reach the database", async () => {
    const publish = publication.publish.bind(publication);
    vi.spyOn(publication, "publish").mockImplementationOnce(async (lease) => {
      await publish(lease);
      vi.spyOn(publication, "reconcile").mockRejectedValue({ code: "08006" });
      throw { code: "08007" };
    });
    const finish = vi.spyOn(lifecycle, "finishFailure");
    expect(await (await worker()).runOne()).toEqual({ kind: "outcome_unresolved", scope: scope() });
    expect(finish).not.toHaveBeenCalled();
    expect(storage.objects.size).toBe(6);
    expect(storage.calls.some((call) => call.kind === "delete")).toBe(false);
    expect((await lifecycle.read(scope())).run.status).toBe("ready");
  });
  it("fails arbitrary errors without a retry and without returning private causes", async () => {
    vi.spyOn(planReader, "read").mockRejectedValueOnce(new Error("private source text"));
    expect(await (await worker()).runOne()).toEqual({
      kind: "failed",
      scope: scope(),
      code: "us_request_worker_unknown_failure",
    });
    expect((await lifecycle.read(scope())).run.nextAttemptAt).toBeNull();
  });
  it("reproduces exact accepted checkpoint and ZIP on storage retry", async () => {
    vi.spyOn(storage.store, "putVerified").mockRejectedValueOnce({
      code: "us_request_package_storage_timeout",
    });
    expect(await (await worker()).runOne()).toMatchObject({ kind: "retry_scheduled" });
    const first = await lifecycle.read(scope());
    // Synthetic due-time advance affects only retry eligibility, not immutable attempt clocks.
    await f.db
      .update(schema.traceExportRuns)
      .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    expect(await (await worker()).runOne()).toMatchObject({ kind: "ready" });
    const second = await lifecycle.read(scope());
    expect(second.checkpoint).toEqual(first.checkpoint);
    expect(second.expectation).toEqual(first.expectation);
    expect(second.attempts).toHaveLength(2);
    expect(second.run.reportRenderedAt).toEqual(second.attempts[1]?.reportRenderedAt);
    expect(second.checkpoint?.model.timing.workerStartedAt).toBe(
      second.attempts[0]?.startedAt.toISOString(),
    );
  });
  it.each(["ready", "initial authorization", "transient", "unknown publication"])(
    "stops and joins invocation renewal on %s exit",
    async (exit) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const renew = lifecycle.renew.bind(lifecycle);
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(lifecycle, "renew").mockImplementationOnce(async (lease) => {
        await pending;
        return renew(lease);
      });
      if (exit === "initial authorization") {
        vi.spyOn(lifecycle, "authorize").mockImplementationOnce(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          release?.();
          throw new ServiceUnavailableException({ code: "insufficient_permission" });
        });
      } else {
        const renderer = await import("../src/modules/traceability/requests/us-request-report-pdf");
        const render = renderer.renderUsRequestReportPdf;
        vi.spyOn(renderer, "renderUsRequestReportPdf").mockImplementationOnce(async (model) => {
          await vi.advanceTimersByTimeAsync(30_000);
          release?.();
          return render(model);
        });
        if (exit === "transient")
          vi.spyOn(storage.store, "putVerified").mockRejectedValueOnce({
            code: "us_request_package_storage_timeout",
          });
        if (exit === "unknown publication") {
          vi.spyOn(publication, "publish").mockRejectedValueOnce({ code: "08007" });
          vi.spyOn(publication, "reconcile").mockRejectedValueOnce({ code: "08006" });
        }
      }
      const result = await (await worker()).runOne();
      expect(result.kind).toBe(
        exit === "ready"
          ? "ready"
          : exit === "transient"
            ? "retry_scheduled"
            : exit === "initial authorization"
              ? "failed"
              : "outcome_unresolved",
      );
      expect(vi.getTimerCount()).toBe(0);
      const count = vi.mocked(lifecycle.renew).mock.calls.length;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(vi.mocked(lifecycle.renew).mock.calls.length).toBe(count);
      expect(count).toBe(1);
    },
  );
  it("fails closed even when renewal rejects with an undefined cause", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(lifecycle, "renew").mockRejectedValueOnce(undefined);
    const renderer = await import("../src/modules/traceability/requests/us-request-report-pdf");
    const render = renderer.renderUsRequestReportPdf;
    vi.spyOn(renderer, "renderUsRequestReportPdf").mockImplementationOnce(async (model) => {
      await vi.advanceTimersByTimeAsync(30_000);
      return render(model);
    });
    expect(await (await worker()).runOne()).toEqual({
      kind: "failed",
      scope: scope(),
      code: "us_request_worker_unknown_failure",
    });
    expect(storage.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns only after an in-flight renewal has settled on failure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let release: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorization = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const renew = lifecycle.renew.bind(lifecycle);
    vi.spyOn(lifecycle, "renew").mockImplementationOnce(async (lease) => {
      await pending;
      return renew(lease);
    });
    vi.spyOn(lifecycle, "authorize").mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      reached?.();
      throw new ServiceUnavailableException({ code: "insufficient_permission" });
    });
    const service = await worker();
    let settled = false;
    const invocation = service.runOne().then((result) => {
      settled = true;
      return result;
    });
    await authorization;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    release?.();
    expect(await invocation).toMatchObject({ kind: "failed" });
    expect(settled).toBe(true);
  });
  it("preserves explicitly null timing from a valid prior checkpoint", async () => {
    const lease = await lifecycle.claimNext();
    if (!lease) throw new Error("Missing checkpoint lease");
    const execution =
      await import("../src/modules/traceability/requests/us-request-worker-execution");
    const stamp = execution.createSyntheticUsRequestExecutionIdentity(
      { apiVersion: "test-us09-package", gitSha: "a".repeat(40), dirty: false },
      { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
    );
    const model = bindUsRequestPackageInputs(c.run, c.tenantId, c.payloads, c.plan, {
      schemaVersion: 1,
      workerStartedAt: null,
      reportDataPreparedAt: (await dbNow()).toISOString(),
    }).model;
    // Valid synthetic prior checkpoint inserted once; no accepted facts are rewritten.
    await f.db.insert(schema.traceExportRenderCheckpoints).values({
      tenantId: c.tenantId,
      runId: c.run.id,
      attemptId: lease.attemptId,
      model,
      modelDigest: createHash("sha256").update(stableStringify(model)).digest("hex"),
      executionDigest: stamp.digest,
      packageVersion: US_REQUEST_PACKAGE_VERSION,
      reportVersion: US_REQUEST_REPORT_PDF_VERSION,
    });
    await lifecycle.finishFailure(lease, {
      code: "us_request_package_storage_timeout",
      retryable: true,
    });
    await f.db
      .update(schema.traceExportRuns)
      .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    expect(await (await worker()).runOne()).toMatchObject({ kind: "ready" });
    expect((await lifecycle.read(scope())).checkpoint?.model).toEqual(model);
    expect((await lifecycle.read(scope())).expectation?.manifest.timing.workerStartedAt).toBeNull();
  });
  it.each(["workbook_unrepresentable", "workbook_writer_failed"] as const)(
    "retains typed %s omission and rejects recovered workbook substitution",
    async (code) => {
      await replace({ mode: "available_records_incomplete", withPlan: false });
      const module = await import("../src/modules/traceability/requests/us-request-payloads");
      const render = module.renderUsRequestPayloads;
      vi.spyOn(module, "renderUsRequestPayloads").mockImplementationOnce(async (...args) => ({
        ...(await render(...args)),
        workbook: null,
        missingWorkbook: { code },
      }));
      vi.spyOn(storage.store, "putVerified").mockRejectedValueOnce({
        code: "us_request_package_storage_timeout",
      });
      expect(await (await worker()).runOne()).toMatchObject({ kind: "retry_scheduled" });
      const prior = await lifecycle.read(scope());
      expect(prior.checkpoint?.model.missingFiles).toEqual([
        { name: "records.xlsx", code },
        { name: "plan.pdf", code: "plan_absent" },
      ]);
      await f.db
        .update(schema.traceExportRuns)
        .set({ nextAttemptAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(schema.traceExportRuns.id, c.run.id));
      const renderer = await import("../src/modules/traceability/requests/us-request-report-pdf");
      const pdf = vi.spyOn(renderer, "renderUsRequestReportPdf");
      expect(await (await worker()).runOne()).toMatchObject({
        kind: "failed",
        code: "us_request_worker_checkpoint_mismatch",
      });
      expect(pdf).not.toHaveBeenCalled();
      expect((await lifecycle.read(scope())).checkpoint).toEqual(prior.checkpoint);
    },
  );
  it("claims and completes at most one of two queued runs per invocation", async () => {
    const another = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
    try {
      expect(await (await worker()).runOne()).toEqual({ kind: "ready", scope: scope() });
      const second = await lifecycle.read({ tenantId: another.tenantId, runId: another.run.id });
      expect(second.run.status).toBe("queued");
      expect(second.run.attemptCount).toBe(0);
      expect(second.attempts).toEqual([]);
      expect(second.checkpoint).toBeNull();
      expect(second.artifacts).toEqual([]);
    } finally {
      another.destroy();
    }
  });
  it("rejects forged execution authority before selecting a queued run", async () => {
    const module = await import("../src/modules/traceability/requests/us-request-worker-execution");
    const create = module.createSyntheticUsRequestExecutionIdentity;
    vi.spyOn(module, "createSyntheticUsRequestExecutionIdentity").mockImplementationOnce(
      (build, source) => ({ ...create(build, source) }),
    );
    const before = await snapshot();
    await expect((await worker()).runOne()).rejects.toMatchObject({
      response: { code: "us_request_worker_execution_invalid" },
    });
    expect(await snapshot()).toEqual(before);
    expect(storage.calls).toEqual([]);
  });
  it("sanitizes a preclaim database error without exposing raw cause or changing rows", async () => {
    const before = await snapshot();
    vi.spyOn(lifecycle, "claimNext").mockRejectedValueOnce({
      code: "08006",
      private: "private database text",
    });
    await expect((await worker()).runOne()).rejects.toMatchObject({
      response: { code: "us_request_worker_database_unavailable" },
    });
    expect(await snapshot()).toEqual(before);
    expect(storage.calls).toEqual([]);
  });
  it("records a finite initialization failure if the invocation timer cannot start", async () => {
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw new Error("private initialization text");
    });
    expect(await (await worker()).runOne()).toEqual({
      kind: "failed",
      scope: scope(),
      code: "us_request_worker_unknown_failure",
    });
    const state = await lifecycle.read(scope());
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]?.status).toBe("failed");
    expect(storage.calls).toEqual([]);
  });
});
