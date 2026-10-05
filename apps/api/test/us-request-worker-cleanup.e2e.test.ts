import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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
import { UsRequestWorkerPublication } from "../src/modules/traceability/requests/us-request-worker-publication";
import {
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
} from "../src/modules/traceability/requests/us-request-package-types";
import type {
  UsWorkerLease,
  UsWorkerObjectEvidence,
} from "../src/modules/traceability/requests/us-request-worker-types";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";
import { createUsRequestWorkerStorageFixture } from "./support/us-request-worker-storage-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
describe.skipIf(!url)("US request fenced cleanup in per-test owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof createUsRequestPackageFixture>>;
  let storage: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  let lifecycle: UsRequestWorkerLifecycle;
  let publication: UsRequestWorkerPublication;
  let lease: UsWorkerLease;
  let objects: readonly UsWorkerObjectEvidence[];
  let result: Awaited<ReturnType<typeof assembleUsRequestPackage>>;
  let failDelete: boolean;
  const scope = () => ({ tenantId: c.tenantId, runId: c.run.id });
  const now = async () => {
    const r = await f.pool.query<{ instant: Date }>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS instant",
    );
    if (!r.rows[0]) throw new Error("Missing DB time");
    return r.rows[0].instant.toISOString();
  };
  const service = async () => {
    const { UsRequestWorkerCleanup } =
      await import("../src/modules/traceability/requests/us-request-worker-cleanup");
    return new UsRequestWorkerCleanup(f.db, storage.store);
  };
  beforeEach(async () => {
    if (!url) throw new Error("Explicit isolated US URL required");
    f = await createUsProfileTestDatabase(url);
    c = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
    failDelete = false;
    storage = createUsRequestWorkerStorageFixture((transport) => ({
      async send(command, options) {
        if (command instanceof DeleteObjectCommand) {
          // Independent connection observes a committed fence before any DELETE.
          const r = await f.pool.query<{ state: string; fenced_at: Date }>(
            "SELECT state,fenced_at FROM trace_export_object_intents WHERE object_key=$1",
            [command.input.Key],
          );
          expect(r.rows[0]).toMatchObject({ state: "fenced", fenced_at: expect.any(Date) });
          if (failDelete)
            throw Object.assign(new Error("synthetic delete transport failure"), {
              code: "ECONNRESET",
            });
        }
        return transport.send(command, options);
      },
    }));
    lifecycle = new UsRequestWorkerLifecycle(f.db);
    publication = new UsRequestWorkerPublication(f.db, lifecycle);
    const claimed = await lifecycle.claimNext();
    if (!claimed) throw new Error("Missing lease");
    lease = claimed;
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
    const expected = {
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
    objects = await publication.allocate(lease, expected);
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    storage?.destroy();
    c?.destroy();
    await f?.close();
  });
  const upload = async () => {
    for (const object of objects) {
      const file = [...result.files, result.zip].find((file) => file.name === object.name);
      if (!file) throw new Error("Missing composer bytes");
      await storage.store.putVerified(scope(), object, file.bytes);
      await publication.markVerified(lease, object);
    }
  };
  const abandon = () =>
    lifecycle.finishFailure(lease, { code: "us_request_worker_unknown_failure", retryable: false });
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenantId),
          eq(schema.tenantAuditEvents.action, "traceability.request.worker.cleanup"),
        ),
      );
  // Break caught: uncommitted fence, deletion based on allocation, or restart using memory.
  it("protects a live candidate and the published winner including its original Plan", async () => {
    await upload();
    expect(await (await service()).cleanupOne(scope())).toBe("idle");
    const winner = await publication.publish(lease);
    expect(await (await service()).cleanupOne(scope())).toBe("referenced");
    expect(storage.objects.size).toBe(6);
    expect((await publication.reconcile(scope())).artifacts).toEqual(winner.artifacts);
    const original = await new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(
      c.run,
      c.tenantId,
    );
    expect(original.kind === "pdf" ? original.bytes : null).toEqual(
      c.plan.kind === "pdf" ? c.plan.bytes : null,
    );
    expect(await audits()).toEqual([]);
  });
  it("commits a permanent fence then deletes exactly one owned abandoned object and audits both outcomes", async () => {
    await upload();
    await abandon();
    const object = objects[0];
    if (!object) throw new Error("Missing object");
    expect(await (await service()).cleanupOne(scope())).toBe("deleted");
    expect(storage.objects.has(object.objectKey)).toBe(false);
    expect(storage.objects.size).toBe(5);
    const [intent] = await f.db
      .select()
      .from(schema.traceExportObjectIntents)
      .where(eq(schema.traceExportObjectIntents.id, object.id));
    expect(intent).toMatchObject({
      state: "deleted",
      verifiedAt: expect.any(Date),
      fencedAt: expect.any(Date),
      deletedAt: expect.any(Date),
      referencedAt: null,
    });
    const rows = await audits();
    expect(rows.map((a) => a.outcome)).toEqual(["fenced", "deleted"]);
    for (const audit of rows) {
      expect(audit).toMatchObject({
        organizationId: c.tenantId,
        actorUserId: null,
        action: "traceability.request.worker.cleanup",
        targetType: "trace_export_run",
        targetId: c.run.id,
        before: null,
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
          object: {
            name: object.name,
            kind: object.kind,
            sha256: object.sha256,
            byteSize: object.byteSize,
          },
        },
      });
      if (!audit.after || typeof audit.after !== "object")
        throw new Error("Missing audit metadata");
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
          "object",
        ].sort(),
      );
    }
    await expect(publication.publish(lease)).rejects.toThrow();
    await expect(publication.markVerified(lease, object)).rejects.toThrow();
    await expect(
      f.pool.query(
        "UPDATE trace_export_object_intents SET state='verified',fenced_at=NULL,deleted_at=NULL WHERE id=$1",
        [object.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("retains an uncertain conditional PUT collision without guessing ownership or deleting", async () => {
    const object = objects[0];
    if (!object) throw new Error("Missing object");
    const foreign = Buffer.from("Synthetic existing foreign object");
    storage.objects.set(object.objectKey, { bytes: foreign, contentType: object.mediaType });
    const file = [...result.files, result.zip].find((file) => file.name === object.name);
    if (!file) throw new Error("Missing composer bytes");
    await expect(storage.store.putVerified(scope(), object, file.bytes)).rejects.toMatchObject({
      code: "us_request_package_storage_collision",
    });
    await abandon();
    expect(await (await service()).cleanupOne(scope())).toBe("unresolved");
    expect(await (await service()).cleanupOne(scope())).toBe("unresolved");
    expect(storage.objects.get(object.objectKey)?.bytes).toEqual(foreign);
    expect(storage.calls.filter((c) => c.kind === "delete")).toEqual([]);
  });
  it("does not infer ownership from matching bytes after an uncertain successful PUT", async () => {
    const object = objects[0],
      file = [...result.files, result.zip].find((f) => f.name === object?.name);
    if (!object || !file) throw new Error("Missing object");
    const send = storage.transport.send.bind(storage.transport);
    vi.spyOn(storage.transport, "send").mockImplementationOnce(async (command, options) => {
      await send(command, options);
      if (!(command instanceof PutObjectCommand)) throw new Error("Expected conditional PUT");
      throw Object.assign(new Error("synthetic committed PUT response lost"), {
        code: "ECONNRESET",
      });
    });
    await expect(storage.store.putVerified(scope(), object, file.bytes)).rejects.toMatchObject({
      code: "us_request_package_storage_transport_failed",
    });
    expect(storage.objects.get(object.objectKey)?.bytes).toEqual(file.bytes);
    await abandon();
    expect(await (await service()).cleanupOne(scope())).toBe("unresolved");
    expect(storage.objects.get(object.objectKey)?.bytes).toEqual(file.bytes);
    expect(storage.calls.filter((c) => c.kind === "delete")).toEqual([]);
  });
  it("cannot clean another tenant or a mismatched run scope", async () => {
    await upload();
    await abandon();
    expect(await (await service()).cleanupOne({ tenantId: randomUUID(), runId: c.run.id })).toBe(
      "retry_required",
    );
    expect(storage.objects.size).toBe(6);
    expect(storage.calls.filter((c) => c.kind === "delete")).toEqual([]);
  });
  it("fences old candidates concurrently with publication of a new winning attempt", async () => {
    await upload();
    const previous = lease,
      oldObjects = objects;
    await lifecycle.finishFailure(previous, {
      code: "us_request_package_storage_timeout",
      retryable: true,
    });
    // Due-state fixture seam; immutable attempt clocks and guards remain intact.
    await f.db
      .update(schema.traceExportRuns)
      .set({
        nextAttemptAt: sql`date_trunc('milliseconds',clock_timestamp()) - interval '1 second'`,
      })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    const retry = await lifecycle.claimNext();
    if (!retry) throw new Error("Missing retry");
    lease = retry;
    const saved = await lifecycle.read(scope());
    if (!saved.checkpoint || !saved.expectation) throw new Error("Missing checkpoint");
    const timing = saved.checkpoint.model.timing;
    const inputs = bindUsRequestPackageInputs(
      c.run,
      c.tenantId,
      await renderUsRequestPayloads(c.run, c.tenantId),
      await new UsRequestPlanReader(f.db, c.planFixture.artifacts).read(c.run, c.tenantId),
      {
        schemaVersion: 1,
        workerStartedAt: timing.workerStartedAt,
        reportDataPreparedAt: timing.reportDataPreparedAt,
      },
    );
    result = await assembleUsRequestPackage(inputs);
    const checkpoints = new UsRequestWorkerCheckpoints(f.db, lifecycle);
    checkpoints.assertPackageReproduction(saved.expectation, result);
    await checkpoints.acceptPackage(lease, saved.expectation, await now());
    objects = await publication.allocate(lease, saved.expectation);
    expect(objects.every((o) => !oldObjects.some((old) => old.objectKey === o.objectKey))).toBe(
      true,
    );
    await upload();
    const [cleaned, winner] = await Promise.all([
      (await service()).cleanupOne(scope()),
      publication.publish(lease),
    ]);
    expect(cleaned).toBe("deleted");
    expect(winner.run.status).toBe("ready");
    expect(winner.artifacts.every((a) => objects.some((o) => o.objectKey === a.objectKey))).toBe(
      true,
    );
    expect(objects.every((o) => storage.objects.has(o.objectKey))).toBe(true);
    await expect(publication.publish(previous)).rejects.toThrow();
    // Cleanup may finish the remaining abandoned attempt keys, never winner keys.
    for (let n = 0; n < 5; n++) expect(await (await service()).cleanupOne(scope())).toBe("deleted");
    expect(await (await service()).cleanupOne(scope())).toBe("referenced");
    expect(storage.objects.size).toBe(6);
    expect((await publication.reconcile(scope())).artifacts).toEqual(winner.artifacts);
  });
  it("retries a failed DELETE after service recreation using the same permanent fence", async () => {
    await upload();
    await abandon();
    failDelete = true;
    expect(await (await service()).cleanupOne(scope())).toBe("retry_required");
    const [fenced] = await f.db
      .select()
      .from(schema.traceExportObjectIntents)
      .where(eq(schema.traceExportObjectIntents.id, objects[0]?.id ?? ""));
    expect(fenced?.state).toBe("fenced");
    expect(storage.objects.size).toBe(6);
    failDelete = false;
    expect(await (await service()).cleanupOne(scope())).toBe("deleted");
    const [deleted] = await f.db
      .select()
      .from(schema.traceExportObjectIntents)
      .where(eq(schema.traceExportObjectIntents.id, fenced?.id ?? ""));
    expect(deleted?.fencedAt).toEqual(fenced?.fencedAt);
    expect((await audits()).map((a) => a.outcome)).toEqual(["fenced", "retry_required", "deleted"]);
    expect((await audits())[1]?.after).toMatchObject({
      failureCode: "us_request_package_storage_transport_failed",
    });
  });
  it("does not delete when an uncertain fence transaction really rolled back", async () => {
    await upload();
    await abandon();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) =>
      transaction(async (tx) => {
        await work(tx);
        throw Object.assign(new Error("synthetic rollback"), { code: "08007" });
      }),
    );
    expect(await (await service()).cleanupOne(scope())).toBe("retry_required");
    expect(storage.objects.size).toBe(6);
    expect(storage.calls.filter((c) => c.kind === "delete")).toEqual([]);
    expect(
      (await f.db.select().from(schema.traceExportObjectIntents)).every(
        (o) => o.state === "verified",
      ),
    ).toBe(true);
    expect(await audits()).toEqual([]);
  });
  it("reconciles an actual fence COMMIT with a lost reply before deleting", async () => {
    await upload();
    await abandon();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work) => {
      await transaction(work);
      throw Object.assign(new Error("synthetic lost reply"), { code: "08007" });
    });
    expect(await (await service()).cleanupOne(scope())).toBe("deleted");
    expect(storage.objects.size).toBe(5);
    expect((await audits()).map((a) => a.outcome)).toEqual(["fenced", "deleted"]);
  });
  it("retains all objects when fresh fence confirmation is unavailable", async () => {
    await upload();
    await abandon();
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, "transaction")
      .mockImplementationOnce(async (work) => {
        await transaction(work);
        throw Object.assign(new Error("synthetic lost reply"), { code: "08007" });
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("synthetic DB unavailable"), { code: "08006" }),
      );
    expect(await (await service()).cleanupOne(scope())).toBe("retry_required");
    expect(storage.objects.size).toBe(6);
    expect(storage.calls.filter((c) => c.kind === "delete")).toEqual([]);
    expect(await (await service()).cleanupOne(scope())).toBe("deleted");
  });
});
