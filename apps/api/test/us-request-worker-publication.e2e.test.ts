import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import { assembleUsRequestPackage } from "../src/modules/traceability/requests/us-request-package";
import { renderUsRequestPayloads } from "../src/modules/traceability/requests/us-request-payloads";
import { UsRequestPlanReader } from "../src/modules/traceability/requests/us-request-plan-reader";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import { UsRequestWorkerCheckpoints } from "../src/modules/traceability/requests/us-request-worker-checkpoint";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import {
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
} from "../src/modules/traceability/requests/us-request-package-types";
import type { UsWorkerLease } from "../src/modules/traceability/requests/us-request-worker-types";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";
import { createUsRequestWorkerStorageFixture } from "./support/us-request-worker-storage-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe.skipIf(!url)("US package publication in per-test owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof createUsRequestPackageFixture>>;
  let storage: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  let lifecycle: UsRequestWorkerLifecycle;
  let lease: UsWorkerLease;
  let result: Awaited<ReturnType<typeof assembleUsRequestPackage>>;
  let expected: Parameters<UsRequestWorkerCheckpoints["acceptPackage"]>[1];
  const scope = () => ({ tenantId: c.tenantId, runId: c.run.id });
  const now = async () => {
    const r = await f.pool.query<{ instant: Date }>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS instant",
    );
    if (!r.rows[0]) throw new Error("Missing DB time");
    return r.rows[0].instant.toISOString();
  };
  const service = async () => {
    const { UsRequestWorkerPublication } =
      await import("../src/modules/traceability/requests/us-request-worker-publication");
    return new UsRequestWorkerPublication(f.db, lifecycle);
  };
  beforeEach(async ({ task }) => {
    if (!url) throw new Error("Explicit isolated US URL required");
    f = await createUsProfileTestDatabase(url);
    const nearExpiry = task.name.includes("lease expiry");
    if (nearExpiry) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - 600_000);
    }
    try {
      c = await createUsRequestPackageFixture(f.db, {
        mode:
          task.name.includes("incomplete") || task.name.includes("extra artifact")
            ? "available_records_incomplete"
            : "export_ready",
        withPlan: !task.name.includes("extra artifact"),
      });
    } finally {
      if (nearExpiry) vi.useRealTimers();
    }
    storage = createUsRequestWorkerStorageFixture();
    lifecycle = new UsRequestWorkerLifecycle(f.db);
    if (nearExpiry) {
      // Valid seeded prior state, real prepare/checkpoint/render/upload path.
      // Immutable attempt clocks are INSERTed once and never shortened.
      const startedAt = new Date(Date.parse(await now()) - 118_000);
      const expiresAt = new Date(startedAt.getTime() + 120_000),
        deadlineAt = new Date(startedAt.getTime() + 300_000);
      lease = {
        ...scope(),
        attemptId: randomUUID(),
        token: randomUUID(),
        attemptNumber: 1,
        cycle: 1,
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
      };
      await f.db.insert(schema.traceExportAttempts).values({
        id: lease.attemptId,
        tenantId: c.tenantId,
        runId: c.run.id,
        token: lease.token,
        attemptNumber: 1,
        cycle: 1,
        status: "active",
        startedAt,
        leaseExpiresAt: expiresAt,
        deadlineAt,
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
          leaseExpiresAt: expiresAt,
          attemptDeadlineAt: deadlineAt,
          generationStartedAt: startedAt,
        })
        .where(eq(schema.traceExportRuns.id, c.run.id));
    } else {
      const claimed = await lifecycle.claimNext();
      if (!claimed) throw new Error("Missing lease");
      lease = claimed;
    }
    if (task.name.includes("JS clock")) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(await now()) - 40);
    }
    const payloads = await renderUsRequestPayloads(c.run, c.tenantId);
    const plan = await new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(
      c.run,
      c.tenantId,
    );
    const inputs = bindUsRequestPackageInputs(c.run, c.tenantId, payloads, plan, {
      schemaVersion: 1,
      workerStartedAt: lease.startedAt,
      reportDataPreparedAt: await now(),
    });
    const checkpoints = new UsRequestWorkerCheckpoints(f.db, lifecycle);
    await checkpoints.acceptReport(lease, {
      model: inputs.model,
      modelDigest: hash(Buffer.from(stableStringify(inputs.model))),
      executionDigest: "b".repeat(64),
      packageVersion: US_REQUEST_PACKAGE_VERSION,
      reportVersion: US_REQUEST_REPORT_PDF_VERSION,
    });
    result = await assembleUsRequestPackage(inputs);
    expected = {
      manifest: result.manifest,
      entries: result.files.map(({ bytes, ...d }) => {
        void bytes;
        return d;
      }),
      zip: {
        name: result.zip.name,
        mediaType: result.zip.mediaType,
        byteSize: result.zip.byteSize,
        sha256: result.zip.sha256,
      },
    };
    await checkpoints.acceptPackage(lease, expected, await now());
    if (task.name.includes("JS clock")) vi.useRealTimers();
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    storage?.destroy();
    c?.destroy();
    await f?.close();
  });
  const upload = async () => {
    const s = await service(),
      objects = await s.allocate(lease, expected);
    expect(await s.allocate(lease, expected)).toEqual(objects);
    for (const object of objects) {
      // Durable intent must exist before real adapter PUT/read-back.
      const [intent] = await f.db
        .select()
        .from(schema.traceExportObjectIntents)
        .where(eq(schema.traceExportObjectIntents.id, object.id));
      expect(intent?.state).toBe("allocated");
      const file = [...result.files, result.zip].find((file) => file.name === object.name);
      if (!file) throw new Error("Missing composer bytes");
      await storage.store.putVerified(scope(), object, file.bytes);
      await s.markVerified(lease, object);
    }
    return objects;
  };
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenantId),
          eq(schema.tenantAuditEvents.action, "traceability.request.worker.published"),
        ),
      );
  const assertUnpublished = async () => {
    const state = await lifecycle.read(scope());
    expect(state.run.status).toBe("processing");
    expect(state.run.completedAt).toBeNull();
    expect(state.artifacts).toEqual([]);
    expect(state.attempts[0]?.status).toBe("active");
    expect(await audits()).toEqual([]);
  };
  // Break caught: upload-only success, partial publication, upgraded mode or duplicate success.
  it("atomically publishes all six actual verified files and returns the same exact winner", async () => {
    const objects = await upload(),
      s = await service(),
      state = await s.publish(lease);
    expect(state.run.status).toBe("ready");
    expect(state.run.exportReady).toBe(true);
    expect(state.run.mode).toBe("export_ready");
    expect(state.artifacts.map((a) => a.kind).sort()).toEqual([
      "manifest",
      "package_zip",
      "plan_pdf",
      "request_report",
      "validation_report",
      "xlsx",
    ]);
    for (const object of objects) {
      expect(state.artifacts.find((a) => a.filename === object.name)).toMatchObject({
        tenantId: c.tenantId,
        runId: c.run.id,
        kind: object.kind,
        objectKey: object.objectKey,
        sha256: object.sha256,
        mediaType: object.mediaType,
        byteSize: BigInt(object.byteSize),
        publishedAt: state.run.completedAt,
      });
      expect(await storage.store.readVerified(scope(), object)).toEqual(
        storage.objects.get(object.objectKey)?.bytes,
      );
    }
    expect(state.run.reportRenderedAt).toEqual(state.attempts[0]?.reportRenderedAt);
    expect(state.attempts[0]).toMatchObject({
      status: "succeeded",
      finishedAt: state.run.completedAt,
    });
    expect(await s.publish(lease)).toEqual(state);
    const [audit] = await audits();
    expect(await audits()).toHaveLength(1);
    expect(audit).toMatchObject({
      organizationId: c.tenantId,
      actorUserId: null,
      action: "traceability.request.worker.published",
      outcome: "success",
      targetType: "trace_export_run",
      targetId: c.run.id,
      before: null,
      createdAt: state.run.completedAt,
      after: {
        actorKind: "system",
        initiatorId: c.actorId,
        requestId: c.request.id,
        runId: c.run.id,
        runRevision: c.run.revision,
        mode: "export_ready",
        attemptId: lease.attemptId,
        attemptNumber: 1,
        cycle: 1,
        cycleAttemptCount: 1,
        lifecycleVersion: 2,
        commandDigest: c.run.commandDigest,
        scopedContentDigest: c.run.scopedContentDigest,
        inputDigest: c.run.inputDigest,
        artifacts: objects.map(({ name, kind, sha256, byteSize }) => ({
          name,
          kind,
          sha256,
          byteSize,
        })),
      },
    });
    if (!audit?.after || typeof audit.after !== "object") throw new Error("Missing audit metadata");
    expect(Object.keys(audit.after).sort()).toEqual(
      [
        "actorKind",
        "initiatorId",
        "requestId",
        "runId",
        "runRevision",
        "mode",
        "attemptId",
        "attemptNumber",
        "cycle",
        "cycleAttemptCount",
        "lifecycleVersion",
        "commandDigest",
        "scopedContentDigest",
        "inputDigest",
        "artifacts",
      ].sort(),
    );
    const [request] = await f.db
      .select()
      .from(schema.traceRequests)
      .where(eq(schema.traceRequests.id, c.request.id));
    expect(request?.status).toBe("open");
  });
  it("keeps incomplete mode even when all six optional files are available", async () => {
    await upload();
    const state = await (await service()).publish(lease);
    expect(state.run.status).toBe("ready");
    expect(state.run.mode).toBe("available_records_incomplete");
    expect(state.run.exportReady).toBe(false);
    expect(state.artifacts).toHaveLength(6);
    expect(result.manifest.identity.mode).toBe("available_records_incomplete");
  });
  it("uses actual owning first lease and DB completion with the JS clock 40 milliseconds behind", async () => {
    const saved = await lifecycle.read(scope());
    expect(saved.checkpoint?.model.timing.workerStartedAt).toBe(lease.startedAt);
    expect(
      Date.parse(saved.checkpoint?.model.timing.reportDataPreparedAt ?? ""),
    ).toBeGreaterThanOrEqual(Date.parse(lease.startedAt));
    expect(saved.attempts[0]?.reportRenderedAt?.getTime()).toBeGreaterThanOrEqual(
      Date.parse(saved.checkpoint?.model.timing.reportDataPreparedAt ?? ""),
    );
    await upload();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(await now()) - 40);
    const state = await (await service()).publish(lease);
    expect(state.run.status).toBe("ready");
    expect(state.run.reportRenderedAt).toEqual(saved.attempts[0]?.reportRenderedAt);
    expect(state.checkpoint).toEqual(saved.checkpoint);
  });
  it("rejects direct SQL changes to intent bytes and published winning artifacts", async () => {
    const objects = await upload(),
      object = objects[0];
    if (!object) throw new Error("Missing intent");
    await expect(
      f.pool.query("UPDATE trace_export_object_intents SET sha256=$1 WHERE id=$2", [
        "a".repeat(64),
        object.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const state = await (await service()).publish(lease),
      artifact = state.artifacts[0];
    if (!artifact) throw new Error("Missing winning artifact");
    await expect(
      f.pool.query(
        "UPDATE trace_export_artifacts SET object_key='us/requests/foreign' WHERE id=$1",
        [artifact.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.pool.query("DELETE FROM trace_export_artifacts WHERE id=$1", [artifact.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.pool.query(
        "UPDATE trace_export_object_intents SET state='fenced',fenced_at=clock_timestamp(),referenced_at=NULL WHERE id=$1",
        [object.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await (await service()).reconcile(scope())).toEqual(state);
  });
  it("serializes publication behind a committed membership revocation using actual clients", async () => {
    await upload();
    const revoker = await f.pool.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(
        "SELECT id FROM member WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
        [c.tenantId, c.actorId],
      );
      const publish = (await service()).publish(lease);
      const assertion = expect(publish).rejects.toMatchObject({
        response: { code: "insufficient_permission" },
      });
      const deadline = performance.now() + 1500;
      let blocked = false;
      while (!blocked && performance.now() < deadline) {
        const activity = await f.pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%\"member\"%') AS blocked",
        );
        blocked = activity.rows[0]?.blocked === true;
      }
      expect(blocked).toBe(true);
      await revoker.query(
        "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
        [c.tenantId, c.actorId],
      );
      await revoker.query("COMMIT");
      await assertion;
      await assertUnpublished();
    } finally {
      await revoker.query("ROLLBACK");
      revoker.release();
    }
  });
  it("opens a fresh authorization transaction after a serialization failure", async () => {
    await upload();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) => {
      try {
        await transaction(async (tx) => {
          await work(tx);
          throw Object.assign(new Error("synthetic serialization abort"), { code: "40001" });
        });
      } finally {
        await f.pool.query(
          "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
          [c.tenantId, c.actorId],
        );
      }
      throw new Error("Unreachable transaction reply");
    });
    await expect((await service()).publish(lease)).rejects.toMatchObject({
      response: { code: "insufficient_permission" },
    });
    await assertUnpublished();
  });
  it("denies publication after a committed permanent object fence", async () => {
    const objects = await upload(),
      object = objects[0];
    if (!object) throw new Error("Missing intent");
    // Valid persisted fence fixture; verifies every publisher honors it even
    // when an old in-memory lease still describes the active attempt.
    await f.pool.query(
      "UPDATE trace_export_object_intents SET state='fenced',fenced_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
      [object.id],
    );
    await expect(
      f.pool.query(
        "UPDATE trace_export_object_intents SET state='verified',fenced_at=NULL WHERE id=$1",
        [object.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect((await service()).publish(lease)).rejects.toThrow();
    await assertUnpublished();
  });
  it("rechecks persisted DB time after an object-table wait crosses lease expiry", async () => {
    await upload();
    const blocker = await f.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE trace_export_object_intents IN ACCESS EXCLUSIVE MODE");
      const publish = (await service()).publish(lease);
      const assertion = expect(publish).rejects.toMatchObject({
        response: { code: "us_request_worker_lease_lost" },
      });
      let blocked = false;
      const end = performance.now() + 1000;
      while (!blocked && performance.now() < end) {
        const r = await f.pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%\"trace_export_object_intents\"%') AS blocked",
        );
        blocked = r.rows[0]?.blocked === true;
      }
      expect(blocked).toBe(true);
      // The database waits until its actual persisted deadline; no clock/guard edits.
      await blocker.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",
        [lease.expiresAt],
      );
      await blocker.query("COMMIT");
      await assertion;
      await assertUnpublished();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  it("rejects lease expiry between final active validation and publication timestamp", async () => {
    await upload();
    const active = lifecycle.assertActive.bind(lifecycle);
    let checks = 0;
    vi.spyOn(lifecycle, "assertActive").mockImplementation(async (tx, current) => {
      await active(tx, current);
      if (++checks === 2) {
        // Delay only this invocation's last active-boundary response. Actual DB
        // clocks remain immutable; publication's own timestamp is after expiry.
        await tx.execute(
          sql`SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (${current.expiresAt}::timestamptz-clock_timestamp())))+0.02)`,
        );
      }
    });
    const outcome = await (await service()).publish(lease).then(
      () => "resolved",
      (error: unknown) =>
        error &&
        typeof error === "object" &&
        "response" in error &&
        error.response &&
        typeof error.response === "object" &&
        "code" in error.response
          ? error.response.code
          : "unknown",
    );
    expect(outcome).toBe("us_request_worker_lease_lost");
    await assertUnpublished();
  });
  it("rolls back publication when an audit write wait crosses persisted lease expiry", async () => {
    await upload();
    const blocker = await f.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE tenant_audit_events IN SHARE MODE");
      const publish = (await service()).publish(lease);
      const outcome = publish.then(
        () => "resolved",
        (error: unknown) =>
          error &&
          typeof error === "object" &&
          "response" in error &&
          error.response &&
          typeof error.response === "object" &&
          "code" in error.response
            ? error.response.code
            : "unknown",
      );
      let blocked = false;
      const end = performance.now() + 1000;
      while (!blocked && performance.now() < end) {
        const r = await f.pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'insert into \"tenant_audit_events\"%') AS blocked",
        );
        blocked = r.rows[0]?.blocked === true;
      }
      expect(blocked).toBe(true);
      const live = await blocker.query<{ status: string }>(
        "SELECT status FROM trace_export_runs WHERE tenant_id=$1 AND id=$2",
        [c.tenantId, c.run.id],
      );
      expect(live.rows[0]?.status).toBe("processing");
      await blocker.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",
        [lease.expiresAt],
      );
      await blocker.query("COMMIT");
      expect(await outcome).toBe("us_request_worker_lease_lost");
      await assertUnpublished();
      expect(storage.objects.size).toBe(6);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  it("refuses a ready replay or reconciliation with an extra artifact outside its exact expected set", async () => {
    await upload();
    const s = await service(),
      state = await s.publish(lease);
    expect(state.artifacts.map((a) => a.filename)).not.toContain("plan.pdf");
    if (!state.run.completedAt) throw new Error("Missing completion time");
    const completedAt = state.run.completedAt;
    const realRead = lifecycle.read.bind(lifecycle);
    vi.spyOn(lifecycle, "read").mockImplementationOnce(async (scope) => {
      const beforeExtra = await realRead(scope);
      await f.db.insert(schema.traceExportArtifacts).values({
        tenantId: c.tenantId,
        runId: c.run.id,
        kind: "plan_pdf",
        filename: "plan.pdf",
        mediaType: "application/pdf",
        byteSize: 1n,
        sha256: "a".repeat(64),
        objectKey: `us/requests/${c.tenantId}/${c.run.id}/${lease.attemptId}/plan.pdf`,
        publishedAt: completedAt,
      });
      return beforeExtra;
    });
    const outcome = await s.reconcile(scope()).then(
      () => "resolved",
      (error: unknown) =>
        error &&
        typeof error === "object" &&
        "response" in error &&
        error.response &&
        typeof error.response === "object" &&
        "code" in error.response
          ? error.response.code
          : "unknown",
    );
    expect(outcome).toBe("us_request_worker_stored_invalid");
    await expect(s.publish(lease)).rejects.toMatchObject({
      response: { code: "us_request_worker_stored_invalid" },
    });
    expect(await audits()).toHaveLength(1);
    expect(storage.objects.size).toBe(5);
  });
  it("requires QA independently of export access and rejects a nonprocessor profile", async () => {
    await upload();
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(
        and(eq(schema.member.organizationId, c.tenantId), eq(schema.member.userId, c.actorId)),
      );
    await expect((await service()).publish(lease)).rejects.toMatchObject({
      response: { code: "insufficient_permission" },
    });
    await f.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(
        and(eq(schema.member.organizationId, c.tenantId), eq(schema.member.userId, c.actorId)),
      );
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenantId));
    await expect((await service()).publish(lease)).rejects.toMatchObject({
      response: { code: "us_request_profile_unsupported" },
    });
    await assertUnpublished();
  });
  it("rolls back artifacts, attempt and ready state when the publication audit fails", async () => {
    await upload();
    await f.pool.query(
      "CREATE FUNCTION reject_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.request.worker.published' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_publication_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_publication_audit()",
    );
    await expect((await service()).publish(lease)).rejects.toThrow();
    await assertUnpublished();
    expect(
      (await f.db.select().from(schema.traceExportObjectIntents)).every(
        (o) => o.state === "verified",
      ),
    ).toBe(true);
  });
  it("rejects partial, altered or stale receipts and cannot publish an unverified set", async () => {
    const s = await service(),
      objects = await s.allocate(lease, expected),
      object = objects[0];
    if (!object) throw new Error("Missing object");
    await expect(s.markVerified(lease, { ...object, sha256: "a".repeat(64) })).rejects.toThrow();
    await expect(s.markVerified({ ...lease, token: randomUUID() }, object)).rejects.toThrow();
    await expect(
      s.allocate(lease, { ...expected, zip: { ...expected.zip, sha256: "a".repeat(64) } }),
    ).rejects.toThrow();
    await expect(s.publish(lease)).rejects.toThrow();
    await assertUnpublished();
  });
  it("rechecks creator access after read-back and denies a stale final authorization", async () => {
    await upload();
    await f.db
      .update(schema.member)
      .set({ role: "viewer" })
      .where(
        and(eq(schema.member.organizationId, c.tenantId), eq(schema.member.userId, c.actorId)),
      );
    await expect((await service()).publish(lease)).rejects.toMatchObject({
      response: { code: "insufficient_permission" },
    });
    await assertUnpublished();
  });
  it("reconciles an actual successful COMMIT with a lost reply from fresh references", async () => {
    await upload();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) => {
      await transaction(work);
      throw Object.assign(new Error("synthetic lost reply"), { code: "08007" });
    });
    const s = await service(),
      state = await s.publish(lease);
    expect(state.run.status).toBe("ready");
    expect(await s.reconcile(scope())).toEqual(state);
    expect(await audits()).toHaveLength(1);
  });
  it("does not invent a winner for an actual ROLLBACK with a lost reply", async () => {
    await upload();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) =>
      transaction(async (tx) => {
        await work(tx);
        throw Object.assign(new Error("synthetic rollback"), { code: "08007" });
      }),
    );
    await expect((await service()).publish(lease)).rejects.toMatchObject({
      response: { code: "us_request_worker_database_unavailable" },
    });
    await assertUnpublished();
    expect(storage.objects.size).toBe(6);
  });
  it("retains objects and the committed winner when reconciliation remains unavailable", async () => {
    await upload();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) => {
      await transaction(work);
      throw Object.assign(new Error("synthetic lost reply"), { code: "08007" });
    });
    vi.spyOn(lifecycle, "read").mockRejectedValueOnce(
      Object.assign(new Error("private database response"), { code: "08006" }),
    );
    await expect((await service()).publish(lease)).rejects.toMatchObject({
      response: { code: "us_request_worker_database_unavailable" },
    });
    expect(storage.objects.size).toBe(6);
    expect((await (await service()).reconcile(scope())).run.status).toBe("ready");
  });
});
