import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import {
  assembleUsRequestPackage,
  type UsRequestPackageResult,
} from "../src/modules/traceability/requests/us-request-package";
import {
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
  type UsRequestPackageInputs,
} from "../src/modules/traceability/requests/us-request-package-types";
import { renderUsRequestPayloads } from "../src/modules/traceability/requests/us-request-payloads";
import { UsRequestPlanReader } from "../src/modules/traceability/requests/us-request-plan-reader";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import { requireUsRequestPackageEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import type {
  UsWorkerCheckpoint,
  UsWorkerLease,
} from "../src/modules/traceability/requests/us-request-worker-types";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const mismatch = { response: { code: "us_request_worker_checkpoint_mismatch" } };
const body = (inputs: UsRequestPackageInputs) => ({
  model: inputs.model,
  modelDigest: hash(Buffer.from(stableStringify(inputs.model))),
  executionDigest: "b".repeat(64),
  packageVersion: US_REQUEST_PACKAGE_VERSION,
  reportVersion: US_REQUEST_REPORT_PDF_VERSION,
});
const expectation = (result: UsRequestPackageResult) => ({
  manifest: result.manifest,
  entries: result.files.map(({ bytes, ...descriptor }) => {
    void bytes;
    return descriptor;
  }),
  zip: {
    name: result.zip.name,
    mediaType: result.zip.mediaType,
    byteSize: result.zip.byteSize,
    sha256: result.zip.sha256,
  },
});

describe.skipIf(!url)("US worker checkpoint in fixture-owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof createUsRequestPackageFixture>>;
  let lifecycle: UsRequestWorkerLifecycle;
  let lease: UsWorkerLease;
  let inputs: UsRequestPackageInputs;
  const dbNow = async () => {
    const result = await f.pool.query<{ instant: Date }>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS instant",
    );
    const instant = result.rows[0]?.instant;
    if (!instant) throw new Error("Missing database time");
    return instant.toISOString();
  };
  beforeEach(async () => {
    if (!url) throw new Error("Explicit isolated US database URL required");
    f = await createUsProfileTestDatabase(url);
    c = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
    lifecycle = new UsRequestWorkerLifecycle(f.db);
    const claimed = await lifecycle.claimNext();
    if (!claimed) throw new Error("Missing synthetic lease");
    lease = claimed;
    // Unlike the generic fixture's synthetic offsets, worker context starts at
    // the real claim, and capture occurs after actual payload/Plan acquisition.
    const payloads = await renderUsRequestPayloads(c.run, c.tenantId);
    const plan = await new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(
      c.run,
      c.tenantId,
    );
    const reportDataPreparedAt = await dbNow();
    expect({
      generated: requireUsRequestPackageEvidence(c.run, c.tenantId).generatedAt,
      start: lease.startedAt,
      capture: reportDataPreparedAt,
    }).toSatisfy(
      (t: { generated: string; start: string; capture: string }) =>
        t.generated <= t.start && t.start <= t.capture,
    );
    inputs = bindUsRequestPackageInputs(c.run, c.tenantId, payloads, plan, {
      schemaVersion: 1,
      workerStartedAt: lease.startedAt,
      reportDataPreparedAt,
    });
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    c?.destroy();
    await f?.close();
  });
  const service = async () => {
    const { UsRequestWorkerCheckpoints } =
      await import("../src/modules/traceability/requests/us-request-worker-checkpoint");
    return new UsRequestWorkerCheckpoints(f.db, lifecycle);
  };
  const read = () => lifecycle.read({ tenantId: c.tenantId, runId: c.run.id });

  // Break caught: two accepted first contexts, mutation of the winner, or lost restart evidence.
  it("accepts exactly one candidate context and returns the durable first model after restart", async () => {
    const s = await service(),
      a = body(inputs),
      b = body(inputs);
    b.model = structuredClone(b.model);
    b.model.timing.reportDataPreparedAt = new Date(
      Date.parse(a.model.timing.reportDataPreparedAt) + 1,
    ).toISOString();
    b.model.timing.elapsedToReportDataPreparationMs += 1;
    b.modelDigest = hash(Buffer.from(stableStringify(b.model)));
    const results = await Promise.allSettled([s.acceptReport(lease, a), s.acceptReport(lease, b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: mismatch });
    const saved = (await read()).checkpoint;
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("Missing accepted report");
    expect(await (await service()).acceptReport(lease, saved)).toEqual(saved);
    expect(saved.model.timing.workerStartedAt).toBe(lease.startedAt);
    a.model.request.requesterName = "Mutated caller model";
    expect((await read()).checkpoint?.model.request.requesterName).toBe(
      "Synthetic package requester",
    );
    expect((await read()).expectation).toBeNull();
    expect((await read()).attempts[0]?.reportRenderedAt).toBeNull();
  });

  it("rejects stale token and wrong tenant for report and package writes", async () => {
    const s = await service(),
      result = await assembleUsRequestPackage(inputs);
    for (const stale of [
      { ...lease, token: randomUUID() },
      { ...lease, tenantId: randomUUID() },
    ]) {
      await expect(s.acceptReport(stale, body(inputs))).rejects.toMatchObject({
        response: { code: "us_request_worker_lease_lost" },
      });
      await expect(
        s.acceptPackage(stale, expectation(result), await dbNow()),
      ).rejects.toMatchObject({ response: { code: "us_request_worker_lease_lost" } });
    }
    expect((await read()).checkpoint).toBeNull();
  });

  it("cannot save a report after a checkpoint-table lock wait crosses lease expiry", async () => {
    await lifecycle.finishFailure(lease, {
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
    // Synthetic prior state: real preparation under a scoped backdated Date,
    // then a valid INSERTed attempt. No immutable clocks or SQL guards change.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 600_000);
    let older: Awaited<ReturnType<typeof createUsRequestPackageFixture>>;
    try {
      older = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
    } finally {
      vi.useRealTimers();
    }
    const client = await f.pool.connect();
    try {
      const start = new Date(Date.parse(await dbNow()) - 119_000),
        attemptId = randomUUID(),
        token = randomUUID();
      const expiry = new Date(start.getTime() + 120_000),
        deadline = new Date(start.getTime() + 300_000);
      const prior: UsWorkerLease = {
        tenantId: older.tenantId,
        runId: older.run.id,
        attemptId,
        token,
        attemptNumber: 1,
        cycle: 1,
        startedAt: start.toISOString(),
        expiresAt: expiry.toISOString(),
        deadlineAt: deadline.toISOString(),
      };
      await f.db.insert(schema.traceExportAttempts).values({
        id: attemptId,
        tenantId: older.tenantId,
        runId: older.run.id,
        token,
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
          leaseAttemptId: attemptId,
          leaseToken: token,
          leaseExpiresAt: expiry,
          attemptDeadlineAt: deadline,
          generationStartedAt: start,
        })
        .where(eq(schema.traceExportRuns.id, older.run.id));
      const bound = bindUsRequestPackageInputs(
        older.run,
        older.tenantId,
        older.payloads,
        older.plan,
        { schemaVersion: 1, workerStartedAt: prior.startedAt, reportDataPreparedAt: await dbNow() },
      );
      await client.query("BEGIN");
      await client.query("LOCK TABLE trace_export_render_checkpoints IN ACCESS EXCLUSIVE MODE");
      const realActive = lifecycle.assertActive.bind(lifecycle);
      let notifyActive: (() => void) | undefined;
      const activeReached = new Promise<void>((resolve) => {
        notifyActive = resolve;
      });
      vi.spyOn(lifecycle, "assertActive").mockImplementation(async (tx, current) => {
        await realActive(tx, current);
        notifyActive?.();
      });
      const save = (await service()).acceptReport(prior, body(bound));
      const assertion = expect(save).rejects.toMatchObject({
        response: { code: "us_request_worker_lease_lost" },
      });
      await activeReached;
      await client.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)",
        [prior.expiresAt],
      );
      await client.query("COMMIT");
      await assertion;
      expect(await f.db.select().from(schema.traceExportRenderCheckpoints)).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      older.destroy();
    }
  });

  it("rejects self-consistent models with changed frozen actor, timezone, request, Plan and origin", async () => {
    const s = await service();
    const mutations: ((m: UsWorkerCheckpoint["model"]) => void)[] = [
      (m) => {
        m.identity.preparedBy = "other-actor";
      },
      (m) => {
        m.stamps.timeZone = "Europe/London";
      },
      (m) => {
        m.request.requesterName = "Altered frozen name";
      },
      (m) => {
        if (m.plan) m.plan.id = randomUUID();
      },
      (m) => {
        m.tenantOrigin = {
          schemaVersion: 1,
          verificationPolicy: "us-request-tenant-origin-v1",
          result: "trusted_synthetic",
          trustedSeed: { seedId: m.identity.tenantId, verifiedBy: "us-development-owner-v1" },
        };
      },
      (m) => {
        m.identity.runRevision += 1;
      },
      (m) => {
        const validation = m.preReportFiles.find((d) => d.name === "validation.json");
        if (validation) validation.sha256 = "a".repeat(64);
      },
    ];
    for (const change of mutations) {
      const candidate = body(inputs);
      candidate.model = structuredClone(candidate.model);
      change(candidate.model);
      candidate.modelDigest = hash(Buffer.from(stableStringify(candidate.model)));
      await expect(s.acceptReport(lease, candidate)).rejects.toMatchObject(mismatch);
    }
    expect((await read()).checkpoint).toBeNull();
  });

  it("rejects report chronology or execution versions that cannot describe the first attempt", async () => {
    const s = await service();
    for (const candidate of [
      { ...body(inputs), executionDigest: "invalid" },
      { ...body(inputs), packageVersion: "unsupported-package" },
      { ...body(inputs), reportVersion: "unsupported-renderer" },
    ])
      await expect(s.acceptReport(lease, candidate)).rejects.toThrow();
    const early = body(inputs);
    early.model = structuredClone(early.model);
    early.model.timing.workerStartedAt = new Date(Date.parse(lease.startedAt) - 1).toISOString();
    early.modelDigest = hash(Buffer.from(stableStringify(early.model)));
    await expect(s.acceptReport(lease, early)).rejects.toMatchObject(mismatch);
    const future = body(inputs);
    future.model = structuredClone(future.model);
    future.model.timing.reportDataPreparedAt = new Date(Date.now() + 60_000).toISOString();
    future.model.timing.elapsedToReportDataPreparationMs =
      Date.parse(future.model.timing.reportDataPreparedAt) - c.run.startedAt.getTime();
    future.modelDigest = hash(Buffer.from(stableStringify(future.model)));
    await expect(s.acceptReport(lease, future)).rejects.toMatchObject(mismatch);
  });

  it("refuses corrupt persisted report evidence without replacing or repairing it", async () => {
    const candidate = body(inputs);
    // Valid SQL shape but corrupt digest, inserted only in this child's synthetic fixture.
    await f.db.insert(schema.traceExportRenderCheckpoints).values({
      tenantId: c.tenantId,
      runId: c.run.id,
      attemptId: lease.attemptId,
      ...candidate,
      modelDigest: "a".repeat(64),
    });
    await expect((await service()).acceptReport(lease, candidate)).rejects.toThrow();
    const [row] = await f.db.select().from(schema.traceExportRenderCheckpoints);
    expect(row?.modelDigest).toBe("a".repeat(64));
    expect(row?.packageExpectation).toBeNull();
  });

  it("reconciles a successful but unknown report COMMIT from a fresh database read", async () => {
    const s = await service(),
      candidate = body(inputs),
      transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) => {
      await transaction(work);
      throw Object.assign(new Error("synthetic connection loss"), { code: "08007" });
    });
    expect(await s.acceptReport(lease, candidate)).toEqual(candidate);
    expect((await read()).checkpoint).toEqual(candidate);
    await expect(
      s.acceptReport(lease, { ...candidate, executionDigest: "c".repeat(64) }),
    ).rejects.toMatchObject(mismatch);
  });

  it("does not invent report persistence when an uncertain transaction actually rolled back", async () => {
    const s = await service(),
      transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) =>
      transaction(async (tx) => {
        await work(tx);
        throw Object.assign(new Error("synthetic rollback"), { code: "08007" });
      }),
    );
    await expect(s.acceptReport(lease, body(inputs))).rejects.toMatchObject({
      response: { code: "us_request_worker_database_unavailable" },
    });
    expect((await read()).checkpoint).toBeNull();
  });

  it("retains a committed checkpoint if fresh reconciliation is unavailable and returns only a finite failure", async () => {
    const s = await service(),
      candidate = body(inputs),
      transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) => {
      await transaction(work);
      throw Object.assign(new Error("synthetic commit response lost"), { code: "08007" });
    });
    vi.spyOn(lifecycle, "read").mockRejectedValueOnce(
      Object.assign(new Error("private provider text"), { code: "08006" }),
    );
    await expect(s.acceptReport(lease, candidate)).rejects.toMatchObject({
      response: { code: "us_request_worker_database_unavailable" },
    });
    expect((await read()).checkpoint).toEqual(candidate);
  });

  it.each(["workbook_unrepresentable", "workbook_writer_failed"] as const)(
    "preserves typed incomplete %s omission and rejects recovered workbook substitution",
    async (code) => {
      await lifecycle.finishFailure(lease, {
        code: "us_request_worker_unknown_failure",
        retryable: false,
      });
      const incomplete = await createUsRequestPackageFixture(f.db, {
        mode: "available_records_incomplete",
        withPlan: false,
      });
      try {
        const active = await lifecycle.claimNext();
        if (!active) throw new Error("Missing incomplete lease");
        const context = {
          schemaVersion: 1 as const,
          workerStartedAt: active.startedAt,
          reportDataPreparedAt: await dbNow(),
        };
        // A trusted typed upstream omission is a controlled fixture boundary.
        // Actual frozen validation bytes and all report/package work remain real.
        const omitted = bindUsRequestPackageInputs(
          incomplete.run,
          incomplete.tenantId,
          { ...incomplete.payloads, workbook: null, missingWorkbook: { code } },
          incomplete.plan,
          context,
        );
        const s = await service(),
          saved = await s.acceptReport(active, body(omitted));
        expect(saved.model.missingFiles).toEqual([
          { name: "records.xlsx", code },
          { name: "plan.pdf", code: "plan_absent" },
        ]);
        const complete = bindUsRequestPackageInputs(
          incomplete.run,
          incomplete.tenantId,
          await renderUsRequestPayloads(incomplete.run, incomplete.tenantId),
          incomplete.plan,
          context,
        );
        expect(() => s.assertReproduction(saved, complete, saved.executionDigest)).toThrow(
          expect.objectContaining(mismatch),
        );
        const result = await assembleUsRequestPackage(omitted),
          expected = expectation(result);
        expect(expected.entries.map((d) => d.name)).toEqual([
          "validation.json",
          "request-report.pdf",
          "manifest.json",
          "SHA256SUMS",
        ]);
        expect(await s.acceptPackage(active, expected, await dbNow())).toEqual(expected);
        expect(() => s.assertPackageReproduction(expected, result)).not.toThrow();
      } finally {
        incomplete.destroy();
      }
    },
  );

  it("checks actual upstream bytes, complete saved context and execution identity on reproduction", async () => {
    const s = await service(),
      saved = await s.acceptReport(lease, body(inputs));
    expect(() => s.assertReproduction(saved, inputs, saved.executionDigest)).not.toThrow();
    expect(() => s.assertReproduction(saved, inputs, "c".repeat(64))).toThrow(
      expect.objectContaining(mismatch),
    );
    const changed = {
      model: structuredClone(inputs.model),
      preReportFiles: inputs.preReportFiles.map((file) => ({
        ...file,
        bytes: Buffer.from(file.bytes),
      })),
    };
    const workbook = changed.preReportFiles[0];
    if (!workbook) throw new Error("Missing workbook");
    workbook.bytes[0] = (workbook.bytes[0] ?? 0) ^ 1;
    expect(() => s.assertReproduction(saved, changed, saved.executionDigest)).toThrow(
      expect.objectContaining(mismatch),
    );
    const later = { ...inputs, model: structuredClone(inputs.model) };
    later.model.timing.reportDataPreparedAt = new Date(
      Date.parse(inputs.model.timing.reportDataPreparedAt) + 1,
    ).toISOString();
    later.model.timing.elapsedToReportDataPreparationMs += 1;
    expect(() => s.assertReproduction(saved, later, saved.executionDigest)).toThrow(
      expect.objectContaining(mismatch),
    );
    // Explicit null is a valid saved package-core context; reproduction must
    // retain it rather than manufacture timing from a recovery attempt.
    const nullable = body(inputs);
    nullable.model = structuredClone(nullable.model);
    nullable.model.timing.workerStartedAt = null;
    nullable.modelDigest = hash(Buffer.from(stableStringify(nullable.model)));
    expect(() =>
      s.assertReproduction(
        nullable,
        { ...inputs, model: nullable.model },
        nullable.executionDigest,
      ),
    ).not.toThrow();
    expect(() => s.assertReproduction(nullable, inputs, nullable.executionDigest)).toThrow(
      expect.objectContaining(mismatch),
    );
  });

  it("saves ordered real composer expectations after the report checkpoint and records actual render completion", async () => {
    const s = await service();
    const result = await assembleUsRequestPackage(inputs),
      expected = expectation(result);
    await expect(s.acceptPackage(lease, expected, await dbNow())).rejects.toMatchObject(mismatch);
    await s.acceptReport(lease, body(inputs));
    const renderedAt = await dbNow();
    expect(await s.acceptPackage(lease, expected, renderedAt)).toEqual(expected);
    expect(expected.entries.map((d) => d.name)).toEqual([
      "records.xlsx",
      "plan.pdf",
      "validation.json",
      "request-report.pdf",
      "manifest.json",
      "SHA256SUMS",
    ]);
    expect((await read()).attempts[0]?.reportRenderedAt?.toISOString()).toBe(renderedAt);
    expect((await read()).run.reportRenderedAt).toBeNull();
    expect(() => s.assertPackageReproduction(expected, result)).not.toThrow();
    const rebuilt = await assembleUsRequestPackage(inputs);
    expect(rebuilt.zip.bytes.equals(result.zip.bytes)).toBe(true);
    expect(await s.acceptPackage(lease, expectation(rebuilt), renderedAt)).toEqual(expected);
    const drift = { ...expected, zip: { ...expected.zip, sha256: "a".repeat(64) } };
    await expect(s.acceptPackage(lease, drift, renderedAt)).rejects.toMatchObject(mismatch);
    const changed = { ...result, zip: { ...result.zip, bytes: Buffer.from(result.zip.bytes) } };
    changed.zip.bytes[0] = 0;
    expect(() => s.assertPackageReproduction(expected, changed)).toThrow(
      expect.objectContaining(mismatch),
    );
    expect((await read()).artifacts).toEqual([]);
  });

  it("reconciles an unknown successful package COMMIT including attempt completion evidence", async () => {
    const s = await service();
    await s.acceptReport(lease, body(inputs));
    const result = await assembleUsRequestPackage(inputs),
      expected = expectation(result),
      renderedAt = await dbNow();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) => {
      await transaction(work);
      throw Object.assign(new Error("synthetic lost commit response"), { code: "08007" });
    });
    expect(await s.acceptPackage(lease, expected, renderedAt)).toEqual(expected);
    const state = await read();
    expect(state.expectation).toEqual(expected);
    expect(state.attempts[0]?.reportRenderedAt?.toISOString()).toBe(renderedAt);
  });

  it("keeps first timing and frozen bytes through a real failure, retry, request edit and Plan supersession", async () => {
    const s = await service(),
      saved = await s.acceptReport(lease, body(inputs));
    const original = await assembleUsRequestPackage(inputs),
      expected = expectation(original);
    await s.acceptPackage(lease, expected, await dbNow());
    const originalPlan = c.plan.kind === "pdf" ? Buffer.from(c.plan.bytes) : null;
    await lifecycle.finishFailure(lease, {
      code: "us_request_package_storage_timeout",
      retryable: true,
    });
    await f.db
      .update(schema.traceExportRuns)
      .set({
        nextAttemptAt: sql`date_trunc('milliseconds',clock_timestamp()) - interval '1 second'`,
      })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    const retry = await lifecycle.claimNext();
    if (!retry) throw new Error("Missing retry lease");
    const source = requireUsRequestPackageEvidence(c.run, c.tenantId).exportInput?.events[0];
    if (!source) throw new Error("Missing frozen Receiving");
    const receiving = new UsReceivingStore(f.db),
      live = await receiving.getLiveRecord(c.tenantId, c.actorId, source.eventId);
    const amendment = await receiving.amend(
      c.tenantId,
      c.actorId,
      source.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: live.lifecycle.lifecycleVersion,
        reason: "Synthetic checkpoint source correction",
      },
      "checkpoint-source-amend",
    );
    const checked = await receiving.checkRevisionReadiness(
      c.tenantId,
      c.actorId,
      amendment.eventId,
      { expectedDraftVersion: 1 },
    );
    const finalized = await receiving.finalizeRevision(
      c.tenantId,
      c.actorId,
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
      "checkpoint-source-finalize",
    );
    expect(finalized.record.revision).toBe(2);
    await new UsRequestStore(f.db).update(c.tenantId, c.actorId, c.request.id, {
      expectedRevision: c.request.revision,
      requesterName: "New live requester",
    });
    await c.planFixture.approve("Synthetic superseding Plan");
    const recoveredPlan = await new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(
      c.run,
      c.tenantId,
    );
    const reconstructed = bindUsRequestPackageInputs(
      c.run,
      c.tenantId,
      await renderUsRequestPayloads(c.run, c.tenantId),
      recoveredPlan,
      {
        schemaVersion: saved.model.timing.schemaVersion,
        workerStartedAt: saved.model.timing.workerStartedAt,
        reportDataPreparedAt: saved.model.timing.reportDataPreparedAt,
      },
    );
    const restarted = await service();
    expect(() =>
      restarted.assertReproduction(saved, reconstructed, saved.executionDigest),
    ).not.toThrow();
    expect(await restarted.acceptReport(retry, saved)).toEqual(saved);
    const result = await assembleUsRequestPackage(reconstructed);
    expect(() => restarted.assertPackageReproduction(expected, result)).not.toThrow();
    expect(result.zip.bytes).toEqual(original.zip.bytes);
    expect(await restarted.acceptPackage(retry, expectation(result), await dbNow())).toEqual(
      expected,
    );
    const plans = await f.db.select().from(schema.traceabilityPlanVersions);
    expect(plans.find((p) => p.id === saved.model.plan?.id)?.status).toBe("superseded");
    expect(recoveredPlan.kind === "pdf" ? recoveredPlan.bytes : null).toEqual(originalPlan);
    expect((await read()).checkpoint).toEqual(saved);
    await expect(restarted.acceptReport(lease, saved)).rejects.toMatchObject({
      response: { code: "us_request_worker_lease_lost" },
    });
  });
});
