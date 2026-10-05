import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { schema } from "@markiro/db";
import { receivingAmendmentDraftSchema } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  bindUsRequestWorkerFixture,
  createUsRequestWorkerFixture,
  createUsWorkerDatabaseTransport,
  prepareUsWorkerSource,
  requestWorkerFixtureBuild,
} from "./support/us-request-worker-fixture";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { renderUsRequestPayloads } from "../src/modules/traceability/requests/us-request-payloads";
import * as payloadModule from "../src/modules/traceability/requests/us-request-payloads";
import { requireUsRequestPackageEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { US_REQUEST_PACKAGE_LIMITS } from "../src/modules/traceability/requests/us-request-package-types";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import * as executions from "../src/modules/traceability/requests/us-request-worker-execution";
import type { UsWorkerLease } from "../src/modules/traceability/requests/us-request-worker-types";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US worker new-service-instance durable recovery", () => {
  let database: Awaited<ReturnType<typeof createUsProfileTestDatabase>> | undefined;
  let fixture: Awaited<ReturnType<typeof createUsRequestWorkerFixture>> | undefined;
  let clock: ReturnType<typeof createUsWorkerDatabaseTransport>;
  afterEach(async () => {
    vi.restoreAllMocks();
    fixture?.destroy();
    await database?.close();
    fixture = undefined;
    database = undefined;
  });
  async function setup(
    options: Parameters<typeof createUsRequestWorkerFixture>[1] = { mode: "export_ready" },
  ) {
    if (!url) throw new Error("Explicit owned US database URL required");
    database = await createUsProfileTestDatabase(url);
    clock = createUsWorkerDatabaseTransport(database.db);
    fixture = await createUsRequestWorkerFixture(clock.db, options);
    return fixture;
  }
  async function customDatabase() {
    if (!url) throw new Error("Explicit owned US database URL required");
    database = await createUsProfileTestDatabase(url);
    clock = createUsWorkerDatabaseTransport(database.db);
    return database;
  }
  async function durableRows() {
    if (!database) throw new Error("Missing child database");
    const result: Record<string, unknown> = {};
    for (const table of [
      "trace_export_runs",
      "trace_export_attempts",
      "trace_export_render_checkpoints",
      "trace_export_object_intents",
      "trace_export_artifacts",
      "tenant_audit_events",
    ])
      result[table] = (await database.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    return result;
  }
  async function lateWrite<T>(
    c: Awaited<ReturnType<typeof setup>>,
    lease: UsWorkerLease,
    table: string,
    bound: "expiry" | "deadline",
    work: () => Promise<T>,
  ): Promise<T> {
    if (!database) throw new Error("Missing child database");
    // Real timely renewals reach the fixed deadline without rewriting persisted clocks.
    if (bound === "deadline") {
      await clock.advancePast(new Date(Date.parse(lease.startedAt) + 100_000));
      await c.lifecycle.renew(lease);
      await clock.advancePast(new Date(Date.parse(lease.startedAt) + 200_000));
      await c.lifecycle.renew(lease);
    }
    const before = await durableRows();
    const storageBefore = [...c.storage.calls];
    const blocker = await database.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${table} IN SHARE MODE`);
      const pending = work().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let blocked = false;
      const end = performance.now() + 1_000;
      while (!blocked && performance.now() < end) {
        const rows = await database.pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation=$1::regclass AND mode='RowExclusiveLock' AND NOT granted) AS blocked",
          [table],
        );
        blocked = rows.rows[0]?.blocked === true;
      }
      expect(blocked).toBe(true);
      await clock.advancePast(new Date(bound === "expiry" ? lease.expiresAt : lease.deadlineAt));
      await blocker.query("COMMIT");
      const outcome = await pending;
      expect(outcome).toMatchObject({
        ok: false,
        error: {
          response: {
            code:
              bound === "expiry"
                ? "us_request_worker_lease_lost"
                : "us_request_worker_deadline_exceeded",
          },
        },
      });
      expect(await durableRows()).toEqual(before);
      expect(c.storage.calls).toEqual(storageBefore);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  }

  const writeCases = [
    ["report", "trace_export_render_checkpoints"],
    ["package", "trace_export_render_checkpoints"],
    ["package", "trace_export_attempts"],
    ["allocate", "trace_export_object_intents"],
    ["verify", "trace_export_object_intents"],
    ["failure", "trace_export_attempts"],
    ["failure", "trace_export_runs"],
    ["failure", "tenant_audit_events"],
    ["renew", "trace_export_attempts"],
    ["renew", "trace_export_runs"],
  ] as const;
  it.each(
    writeCases.flatMap(([operation, table]) =>
      (["expiry", "deadline"] as const).map((bound) => ({ operation, table, bound })),
    ),
  )(
    "rolls back $operation at $table SHARE write barrier crossing $bound",
    async ({ operation, table, bound }) => {
      const c = await setup();
      let observed: Promise<unknown> | undefined;
      const intercept = <T>(lease: UsWorkerLease, work: () => Promise<T>) => {
        const pending = lateWrite(c, lease, table, bound, work);
        observed = pending;
        return pending;
      };
      if (operation === "renew" || operation === "failure") {
        const lease = await c.lifecycle.claimNext();
        if (!lease) throw new Error("Missing actual claim");
        observed = lateWrite<unknown>(c, lease, table, bound, () =>
          operation === "renew"
            ? c.lifecycle.renew(lease)
            : c.lifecycle.finishFailure(lease, {
                code: "us_request_package_storage_timeout",
                retryable: true,
              }),
        );
        await observed.catch(() => undefined);
      } else {
        if (operation === "report") {
          const original = c.checkpoints.acceptReport.bind(c.checkpoints);
          vi.spyOn(c.checkpoints, "acceptReport").mockImplementation((lease, body) =>
            intercept(lease, () => original(lease, body)),
          );
        } else if (operation === "package") {
          const original = c.checkpoints.acceptPackage.bind(c.checkpoints);
          vi.spyOn(c.checkpoints, "acceptPackage").mockImplementation((lease, body, time) =>
            intercept(lease, () => original(lease, body, time)),
          );
        } else if (operation === "allocate") {
          const original = c.publication.allocate.bind(c.publication);
          vi.spyOn(c.publication, "allocate").mockImplementation((lease, body) =>
            intercept(lease, () => original(lease, body)),
          );
        } else {
          const original = c.publication.markVerified.bind(c.publication);
          vi.spyOn(c.publication, "markVerified").mockImplementation((lease, body) =>
            intercept(lease, () => original(lease, body)),
          );
        }
        await c.worker.runOne();
      }
      expect(observed).toBeDefined();
      await expect(observed).rejects.toMatchObject({
        response: {
          code:
            bound === "expiry"
              ? "us_request_worker_lease_lost"
              : "us_request_worker_deadline_exceeded",
        },
      });
      const calls = [...c.storage.calls];
      await c.lifecycle.recoverExpired(c.scope);
      const recovered = await c.lifecycle.read(c.scope);
      expect(recovered.run.status).toBe("queued");
      expect(recovered.attempts.map((a) => a.status)).toEqual(["abandoned"]);
      expect(recovered.artifacts).toEqual([]);
      expect(c.storage.calls).toEqual(calls);
    },
    60_000,
  );

  it.each([false, true])(
    "disposes one older corrupt queued row before healthy work, revoked=%s",
    async (revoked) => {
      const c = await setup();
      if (!database) throw new Error("Missing child database");
      // INSERT corruption, never UPDATE immutable evidence or disable guards.
      const [corrupt] = await database.db
        .insert(schema.traceExportRuns)
        .values({
          ...c.source.run,
          id: randomUUID(),
          revision: c.source.run.revision + 1,
          idempotencyKey: randomUUID(),
          startedAt: new Date(c.source.run.startedAt.getTime() - 1),
          inputDigest: "f".repeat(64),
          attemptCount: 7,
        })
        .returning();
      if (!corrupt) throw new Error("Missing inserted corrupt run");
      const payloads = vi.spyOn(payloadModule, "renderUsRequestPayloads");
      const plan = vi.spyOn(c.planReader, "read");
      if (revoked)
        await database.db
          .delete(schema.member)
          .where(
            and(
              eq(schema.member.organizationId, c.source.tenantId),
              eq(schema.member.userId, c.source.actorId),
            ),
          );
      expect(await c.worker.runOne()).toEqual({ kind: "idle" });
      const [failed] = await database.db
        .select()
        .from(schema.traceExportRuns)
        .where(eq(schema.traceExportRuns.id, corrupt.id));
      expect(failed).toEqual({
        ...corrupt,
        status: "failed",
        failureCode: "us_request_run_stored_invalid",
        completedAt: expect.any(Date),
        lifecycleVersion: 1,
      });
      expect(await database.db.select().from(schema.traceExportAttempts)).toEqual([]);
      expect(await database.db.select().from(schema.traceExportRenderCheckpoints)).toEqual([]);
      expect(await database.db.select().from(schema.traceExportObjectIntents)).toEqual([]);
      expect(c.storage.calls).toEqual([]);
      expect(payloads).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      const audits = await database.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, corrupt.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        organizationId: corrupt.tenantId,
        actorUserId: null,
        action: "traceability.request.worker.failed",
        outcome: "failed",
        targetType: "trace_export_run",
        targetId: corrupt.id,
        before: null,
        createdAt: failed?.completedAt,
      });
      expect(audits[0]?.after).toEqual({
        actorKind: "system",
        initiatorId: corrupt.createdBy,
        requestId: corrupt.requestId,
        runId: corrupt.id,
        runRevision: corrupt.revision,
        mode: corrupt.mode,
        attemptId: null,
        attemptNumber: 7,
        cycle: 1,
        cycleAttemptCount: 0,
        lifecycleVersion: 1,
        commandDigest: corrupt.commandDigest,
        scopedContentDigest: corrupt.scopedContentDigest,
        inputDigest: corrupt.inputDigest,
        failureCode: "us_request_run_stored_invalid",
        retryable: false,
        terminalFailureCode: "us_request_run_stored_invalid",
        nextAttemptAt: null,
      });
      expect(await c.worker.runOne()).toEqual(
        revoked
          ? { kind: "failed", scope: c.scope, code: "insufficient_permission" }
          : { kind: "ready", scope: c.scope },
      );
      if (revoked) {
        expect(payloads).not.toHaveBeenCalled();
        expect(plan).not.toHaveBeenCalled();
        expect(c.storage.calls).toEqual([]);
      }
      expect(await c.worker.runOne()).toEqual({ kind: "idle" });
      expect(
        await database.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.targetId, corrupt.id)),
      ).toEqual(audits);
    },
    60_000,
  );
  it.each(["missing actor", "publication reference"] as const)(
    "does not dispose corrupt evidence with ambiguous %s",
    async (ambiguity) => {
      const c = await setup();
      if (!database) throw new Error("Missing child database");
      const [corrupt] = await database.db
        .insert(schema.traceExportRuns)
        .values({
          ...c.source.run,
          id: randomUUID(),
          revision: c.source.run.revision + 1,
          idempotencyKey: randomUUID(),
          startedAt: new Date(c.source.run.startedAt.getTime() - 1),
          createdBy: ambiguity === "missing actor" ? "missing-synthetic-actor" : c.source.actorId,
          inputDigest: "f".repeat(64),
        })
        .returning();
      if (!corrupt) throw new Error("Missing inserted corrupt run");
      if (ambiguity === "publication reference")
        await database.db.insert(schema.traceExportArtifacts).values({
          tenantId: corrupt.tenantId,
          runId: corrupt.id,
          kind: "package_zip",
          filename: "package.zip",
          mediaType: "application/zip",
          byteSize: 1n,
          sha256: "a".repeat(64),
          objectKey: `us/requests/${corrupt.tenantId}/${corrupt.id}/${randomUUID()}/package.zip`,
          publishedAt: new Date(),
        });
      const before = await durableRows();
      await expect(c.worker.runOne()).rejects.toMatchObject({
        response: { code: "us_request_worker_stored_invalid" },
      });
      expect(await durableRows()).toEqual(before);
      expect(c.storage.calls).toEqual([]);
    },
    60_000,
  );
  async function due(c: Awaited<ReturnType<typeof setup>>) {
    const state = await c.lifecycle.read(c.scope);
    if (!state.run.nextAttemptAt) throw new Error("Missing actual persisted retry due time");
    expect(await c.recreate().runOne()).toEqual({ kind: "idle" });
    await clock.advancePast(state.run.nextAttemptAt);
  }
  async function publishedOnce(c: Awaited<ReturnType<typeof setup>>) {
    if (!database) throw new Error("Missing database");
    const rows = await database.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.scope.tenantId),
          eq(schema.tenantAuditEvents.action, "traceability.request.worker.published"),
        ),
      );
    expect(rows).toHaveLength(1);
    const state = await c.lifecycle.read(c.scope);
    const winner = state.attempts.find((a) => a.status === "succeeded");
    expect(rows[0]).toMatchObject({
      organizationId: c.scope.tenantId,
      actorUserId: null,
      action: "traceability.request.worker.published",
      outcome: "success",
      targetId: c.scope.runId,
      targetType: "trace_export_run",
      before: null,
      after: {
        actorKind: "system",
        initiatorId: c.source.actorId,
        requestId: c.source.request.id,
        runId: c.scope.runId,
        runRevision: c.source.run.revision,
        mode: c.source.run.mode,
        attemptId: winner?.id,
        attemptNumber: winner?.attemptNumber,
        cycle: winner?.cycle,
        lifecycleVersion: state.run.lifecycleVersion,
        commandDigest: c.source.run.commandDigest,
        scopedContentDigest: c.source.run.scopedContentDigest,
        inputDigest: c.source.run.inputDigest,
      },
    });
    expect(rows[0]?.after).toEqual({
      actorKind: "system",
      initiatorId: c.source.actorId,
      requestId: c.source.request.id,
      runId: c.scope.runId,
      runRevision: c.source.run.revision,
      mode: c.source.run.mode,
      attemptId: winner?.id,
      attemptNumber: winner?.attemptNumber,
      cycle: winner?.cycle,
      cycleAttemptCount: state.run.cycleAttemptCount,
      lifecycleVersion: state.run.lifecycleVersion,
      commandDigest: c.source.run.commandDigest,
      scopedContentDigest: c.source.run.scopedContentDigest,
      inputDigest: c.source.run.inputDigest,
      artifacts: state.artifacts
        .map((row) => ({
          name: row.filename,
          kind: row.kind,
          sha256: row.sha256,
          byteSize: Number(row.byteSize),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
    expect(await c.recreate().runOne()).toEqual({ kind: "idle" });
    expect((await c.lifecycle.read(c.scope)).artifacts).toEqual(state.artifacts);
  }
  it("reconstructs the verified archive with fresh service instances", async () => {
    const c = await setup();
    expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
    await c.verifyReady();
    await publishedOnce(c);
  }, 60_000);

  // Removing durable recovery, retaining stale fences, substituting context or trusting
  // metadata instead of bytes must break these observed post-real-boundary tests.
  it.each([
    "claim",
    "report checkpoint",
    "package expectation",
    "partial PUT",
    "read-back",
  ] as const)(
    "recovers after actual %s with PostgreSQL clock projection and new instances",
    async (boundary) => {
      const c = await setup();
      const expire = async () => {
        const state = await c.lifecycle.read(c.scope);
        if (!state.run.leaseExpiresAt) throw new Error("Missing real claimed lease");
        await clock.advancePast(state.run.leaseExpiresAt);
      };
      if (boundary === "claim") {
        const claim = c.lifecycle.claimNext.bind(c.lifecycle);
        vi.spyOn(c.lifecycle, "claimNext").mockImplementationOnce(async () => {
          const lease = await claim();
          await expire();
          return lease;
        });
      } else if (boundary === "report checkpoint") {
        const save = c.checkpoints.acceptReport.bind(c.checkpoints);
        vi.spyOn(c.checkpoints, "acceptReport").mockImplementationOnce(async (...args) => {
          const result = await save(...args);
          await expire();
          return result;
        });
      } else if (boundary === "package expectation") {
        const save = c.checkpoints.acceptPackage.bind(c.checkpoints);
        vi.spyOn(c.checkpoints, "acceptPackage").mockImplementationOnce(async (...args) => {
          const result = await save(...args);
          await expire();
          return result;
        });
      } else if (boundary === "partial PUT") {
        let puts = 0;
        c.storage.faults.after = async (command, result) => {
          if (command instanceof PutObjectCommand && ++puts === 2) await expire();
          return result;
        };
      } else {
        let verified = 0;
        const save = c.publication.markVerified.bind(c.publication);
        vi.spyOn(c.publication, "markVerified").mockImplementation(async (...args) => {
          await save(...args);
          if (++verified === 6) await expire();
        });
      }
      expect(await c.worker.runOne()).toEqual({ kind: "lease_lost", scope: c.scope });
      const first = await c.lifecycle.read(c.scope);
      expect(first.attempts).toHaveLength(1);
      expect(first.attempts[0]?.status).toBe("active");
      expect(first.artifacts).toEqual([]);
      expect(first.checkpoint !== null).toBe(boundary !== "claim");
      expect(first.expectation !== null).toBe(
        ["package expectation", "partial PUT", "read-back"].includes(boundary),
      );
      if (boundary === "partial PUT") expect(c.storage.objects.size).toBe(2);
      if (boundary === "read-back") expect(c.storage.objects.size).toBe(6);
      c.storage.faults.after = null;
      expect(await c.recreate().runOne()).toEqual({ kind: "idle" });
      const recovered = await c.lifecycle.read(c.scope);
      expect(recovered.attempts[0]?.status).toBe("abandoned");
      expect(recovered.run.status).toBe("queued");
      expect(recovered.run.nextAttemptAt?.getTime()).toBe(
        (recovered.attempts[0]?.finishedAt?.getTime() ?? 0) + 10_000,
      );
      await due(c);
      expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
      const { state } = await c.verifyReady();
      expect(state.attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
      expect(state.attempts.map((a) => a.status)).toEqual(["abandoned", "succeeded"]);
      if (first.checkpoint) expect(state.checkpoint).toEqual(first.checkpoint);
      if (first.expectation) expect(state.expectation).toEqual(first.expectation);
      expect(state.run.inputSnapshot).toEqual(first.run.inputSnapshot);
      expect(
        clock.statements.some((s) => s.raw !== s.projected && s.raw.includes("clock_timestamp()")),
      ).toBe(true);
      await publishedOnce(c);
    },
    60_000,
  );

  it.each(["commit", "rollback"] as const)(
    "reconciles actual PostgreSQL %s followed by lost reply",
    async (fault) => {
      const c = await setup();
      clock.faultCommit(fault, (text) => /^insert into "trace_export_artifacts"/i.test(text));
      const outcome = await c.worker.runOne();
      expect(outcome).toEqual({
        kind: fault === "commit" ? "ready" : "retry_scheduled",
        scope: c.scope,
      });
      expect(
        clock.statements.filter((s) => s.outcome !== "forwarded").map((s) => s.outcome),
      ).toEqual([fault === "commit" ? "committed_reply_lost" : "rolled_back_reply_lost"]);
      const before = await c.lifecycle.read(c.scope);
      if (fault === "rollback") {
        expect(before.artifacts).toEqual([]);
        expect(before.run.status).toBe("queued");
        await due(c);
        expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
      } else expect(c.storage.calls.some((call) => call.kind === "delete")).toBe(false);
      const { state } = await c.verifyReady();
      expect(state.checkpoint).toEqual(before.checkpoint);
      expect(state.expectation).toEqual(before.expectation);
      expect(state.attempts).toHaveLength(fault === "commit" ? 1 : 2);
      await publishedOnce(c);
    },
    60_000,
  );

  it("restarts deletion after the actual durable cleanup fence and retains winning/Plan bytes", async () => {
    const c = await setup();
    let puts = 0;
    c.storage.faults.before = async (command) => {
      if (command instanceof PutObjectCommand && ++puts === 2) throw { code: "ECONNRESET" };
      if (command instanceof DeleteObjectCommand) {
        const intents = await clock.db
          .select()
          .from(schema.traceExportObjectIntents)
          .where(eq(schema.traceExportObjectIntents.objectKey, command.input.Key ?? ""));
        expect(intents[0]?.state).toBe("fenced");
        expect(intents[0]?.fencedAt).not.toBeNull();
        throw { code: "ECONNRESET" };
      }
    };
    expect(await c.worker.runOne()).toEqual({ kind: "retry_scheduled", scope: c.scope });
    const [fenced] = await clock.db
      .select()
      .from(schema.traceExportObjectIntents)
      .where(eq(schema.traceExportObjectIntents.state, "fenced"));
    if (!fenced) throw new Error("No actual fence survived interrupted delete");
    expect(c.storage.objects.has(fenced.objectKey)).toBe(true);
    c.storage.faults.before = null;
    expect(await c.instances().cleanup.cleanupOne(c.scope)).toBe("deleted");
    const [deleted] = await clock.db
      .select()
      .from(schema.traceExportObjectIntents)
      .where(eq(schema.traceExportObjectIntents.id, fenced.id));
    expect(deleted?.fencedAt).toEqual(fenced.fencedAt);
    expect(deleted?.state).toBe("deleted");
    expect(c.storage.objects.has(fenced.objectKey)).toBe(false);
    await due(c);
    expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
    await c.verifyReady();
    const winners = new Map(c.storage.objects);
    await c.instances().cleanup.cleanupOne(c.scope);
    expect(c.storage.objects).toEqual(winners);
    await publishedOnce(c);
  }, 60_000);

  it.each([
    { mode: "export_ready" as const, empty: false, withPlan: true },
    ...[false, true].flatMap((empty) =>
      [false, true].map((withPlan) => ({
        mode: "available_records_incomplete" as const,
        empty,
        withPlan,
      })),
    ),
  ])(
    "keeps $mode optional workbook empty=$empty and Plan=$withPlan",
    async (options) => {
      const c = await setup(options);
      expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
      const { state, actual } = await c.verifyReady();
      expect(state.artifacts.some((a) => a.kind === "xlsx")).toBe(!options.empty);
      expect(state.artifacts.some((a) => a.kind === "plan_pdf")).toBe(options.withPlan);
      expect(actual.manifest.tenantOrigin.result).toBe("not_attested");
      await publishedOnce(c);
    },
    60_000,
  );

  it.each(["export_ready", "available_records_incomplete"] as const)(
    "preserves frozen %s through business/request edits, Plan supersession and closure",
    async (mode) => {
      const c = await setup({ mode });
      const saved = c.checkpoints.acceptPackage.bind(c.checkpoints);
      vi.spyOn(c.checkpoints, "acceptPackage").mockImplementationOnce(async (...args) => {
        const result = await saved(...args);
        const event = requireUsRequestPackageEvidence(c.source.run, c.scope.tenantId).exportInput
          ?.events[0];
        if (!event) throw new Error("Missing real Receiving event");
        const receiving = new UsReceivingStore(clock.db);
        const live = await receiving.getLiveRecord(
          c.scope.tenantId,
          c.source.actorId,
          event.eventId,
        );
        const amendment = await receiving.amend(
          c.scope.tenantId,
          c.source.actorId,
          event.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: live.lifecycle.lifecycleVersion,
            reason: "Synthetic source correction",
          },
          "worker-amend",
        );
        if (amendment.record.content.kind !== "draft")
          throw new Error("Missing actual amendment draft");
        const draft = receivingAmendmentDraftSchema.parse(amendment.record.content.draft);
        const changed = await receiving.saveAmendment(
          c.scope.tenantId,
          c.source.actorId,
          amendment.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: amendment.record.lifecycle.lifecycleVersion,
            expectedDraftVersion: 1,
            draft: {
              ...draft,
              dateReceived: "2026-10-01",
              notes: "Changed later business note",
              items: draft.items.map((item) => ({ ...item, quantity: "250" })),
            },
          },
          "worker-save-business-correction",
        );
        const checked = await receiving.checkRevisionReadiness(
          c.scope.tenantId,
          c.source.actorId,
          amendment.eventId,
          { expectedDraftVersion: changed.record.draftVersion },
        );
        await receiving.finalizeRevision(
          c.scope.tenantId,
          c.source.actorId,
          amendment.eventId,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedDraftVersion: changed.record.draftVersion,
            expectedLifecycleVersion: checked.expectedLifecycleVersion,
            previousRevisionId: checked.previousRevisionId,
            expectedInputDigest: checked.inputDigest,
            reviewedExemptLines: checked.exemptReviewRequiredLines,
          },
          "worker-amend-finalize",
        );
        const requests = new UsRequestStore(clock.db);
        const edit = await requests.update(
          c.scope.tenantId,
          c.source.actorId,
          c.source.request.id,
          {
            expectedRevision: 1,
            requesterName: "Later requester",
            scope: { tlcs: ["NO-LATER-MATCH"] },
          },
        );
        await requests.close(c.scope.tenantId, c.source.actorId, c.source.request.id, {
          expectedRevision: edit.revision,
        });
        await c.source.planFixture.approve("Later synthetic Plan");
        return result;
      });
      expect(await c.worker.runOne()).toEqual({ kind: "ready", scope: c.scope });
      const { state, actual } = await c.verifyReady();
      expect(actual.manifest.identity.requestRevision).toBe(1);
      expect(state.checkpoint?.model.request.requesterName).toBe("Synthetic package requester");
      const [request] = await clock.db
        .select()
        .from(schema.traceRequests)
        .where(eq(schema.traceRequests.id, c.source.request.id));
      expect(request?.status).toBe("closed");
      await expect(
        new UsRequestPrepareStore(clock.db).prepare(
          c.scope.tenantId,
          c.source.actorId,
          c.source.request.id,
          { mode, idempotencyKey: randomUUID() },
          requestWorkerFixtureBuild,
        ),
      ).rejects.toMatchObject({ status: 409 });
      await publishedOnce(c);
    },
    60_000,
  );

  it.each([
    { empty: true, withPlan: true },
    { empty: false, withPlan: false },
    { empty: true, withPlan: false },
  ])(
    "refuses export_ready before a worker run with workbook empty=$empty Plan=$withPlan",
    async (options) => {
      await expect(setup({ mode: "export_ready", ...options })).rejects.toMatchObject({
        status: 409,
        response: { code: "us_request_not_export_ready" },
      });
      expect(await clock.db.select().from(schema.traceExportRuns)).toEqual([]);
      expect(await clock.db.select().from(schema.traceExportArtifacts)).toEqual([]);
    },
    60_000,
  );

  it("requires restored original initiator and replays a manual receipt after a later failure", async () => {
    const c = await setup();
    const save = c.checkpoints.acceptPackage.bind(c.checkpoints);
    vi.spyOn(c.checkpoints, "acceptPackage").mockImplementationOnce(async (...args) => {
      const result = await save(...args);
      await clock.db
        .update(schema.member)
        .set({ role: "viewer" })
        .where(eq(schema.member.userId, c.source.actorId));
      return result;
    });
    expect(await c.worker.runOne()).toEqual({
      kind: "failed",
      scope: c.scope,
      code: "insufficient_permission",
    });
    const first = await c.lifecycle.read(c.scope);
    const body = {
      expectedLifecycleVersion: first.run.lifecycleVersion,
      idempotencyKey: randomUUID(),
      reason: "Synthetic restored authority",
    };
    await expect(c.lifecycle.retry(c.scope, c.source.actorId, body)).rejects.toMatchObject({
      status: 403,
    });
    await clock.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.userId, c.source.actorId));
    const receipt = await c.instances().lifecycle.retry(c.scope, c.source.actorId, body);
    expect(receipt.cycle).toBe(2);
    c.storage.faults.before = async (command) => {
      if (command instanceof PutObjectCommand)
        throw new Error("Synthetic permanent unknown failure");
    };
    expect(await c.recreate().runOne()).toEqual({
      kind: "failed",
      scope: c.scope,
      code: "us_request_worker_unknown_failure",
    });
    const later = await c.lifecycle.read(c.scope);
    expect(await c.instances().lifecycle.retry(c.scope, c.source.actorId, body)).toEqual(receipt);
    expect(await c.lifecycle.read(c.scope)).toEqual(later);
    c.storage.faults.before = null;
    await c.instances().lifecycle.retry(c.scope, c.source.actorId, {
      expectedLifecycleVersion: later.run.lifecycleVersion,
      idempotencyKey: randomUUID(),
      reason: "Synthetic retry after fixed transport",
    });
    expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
    const { state } = await c.verifyReady();
    expect(state.checkpoint).toEqual(first.checkpoint);
    expect(state.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(state.attempts.map((a) => a.cycle)).toEqual([1, 2, 3]);
    await publishedOnce(c);
  }, 60_000);

  it("records exact scheduled retry and third-exhaustion worker.failed audits", async () => {
    const c = await setup();
    c.storage.faults.before = async (command) => {
      if (command instanceof PutObjectCommand) throw { code: "ECONNRESET" };
    };
    for (let number = 1; number <= 3; number++) {
      expect(await c.recreate().runOne()).toEqual(
        number < 3
          ? { kind: "retry_scheduled", scope: c.scope }
          : { kind: "failed", scope: c.scope, code: "us_request_worker_retry_limit" },
      );
      const state = await c.lifecycle.read(c.scope);
      const attempt = state.attempts[number - 1];
      if (!attempt?.finishedAt) throw new Error("Missing actual failure attempt");
      const dueAt =
        number < 3
          ? new Date(attempt.finishedAt.getTime() + (number === 1 ? 10_000 : 60_000)).toISOString()
          : null;
      const audits = await clock.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.targetId, c.scope.runId),
            eq(schema.tenantAuditEvents.action, "traceability.request.worker.failed"),
          ),
        );
      expect(audits).toHaveLength(number);
      const audit = audits.find(
        (a) =>
          a.after &&
          typeof a.after === "object" &&
          "attemptNumber" in a.after &&
          a.after.attemptNumber === number,
      );
      expect(audit).toMatchObject({
        organizationId: c.scope.tenantId,
        actorUserId: null,
        action: "traceability.request.worker.failed",
        outcome: number < 3 ? "retry_scheduled" : "failed",
        targetType: "trace_export_run",
        targetId: c.scope.runId,
        before: null,
        createdAt: attempt.finishedAt,
      });
      expect(audit?.after).toEqual({
        actorKind: "system",
        initiatorId: c.source.actorId,
        requestId: c.source.request.id,
        runId: c.scope.runId,
        runRevision: c.source.run.revision,
        mode: "export_ready",
        attemptId: attempt.id,
        attemptNumber: number,
        cycle: 1,
        cycleAttemptCount: number,
        lifecycleVersion: number * 2,
        commandDigest: c.source.run.commandDigest,
        scopedContentDigest: c.source.run.scopedContentDigest,
        inputDigest: c.source.run.inputDigest,
        failureCode: "us_request_package_storage_transport_failed",
        retryable: true,
        terminalFailureCode: number < 3 ? null : "us_request_worker_retry_limit",
        nextAttemptAt: dueAt,
      });
      expect(state.run.nextAttemptAt?.toISOString() ?? null).toBe(dueAt);
      if (number < 3) await due(c);
    }
    expect(await c.recreate().runOne()).toEqual({ kind: "idle" });
    expect((await c.lifecycle.read(c.scope)).artifacts).toEqual([]);
  }, 60_000);

  it("uses the actual reserved owner provisioning path and exact server attestation/audit", async () => {
    const f = await customDatabase();
    const requestId = randomUUID();
    const owner = await new UsDevelopmentOwnerStore(f.db).provision(
      "Synthetic-local-owner-password-42!",
      requestId,
    );
    await f.db.insert(schema.traceabilityProfiles).values({
      tenantId: owner.tenantId,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: owner.userId,
    });
    await f.db
      .insert(schema.orgProfiles)
      .values({ tenantId: owner.tenantId, timeZone: "America/Chicago" });
    const partyId = randomUUID();
    await f.db
      .insert(schema.traceabilityParties)
      .values({ id: partyId, tenantId: owner.tenantId, name: "Synthetic source" });
    await f.db.insert(schema.traceabilityLocations).values({
      tenantId: owner.tenantId,
      partyId,
      name: "Synthetic source",
      businessName: "Synthetic source",
      phoneNumber: "+1 555 0100",
      streetAddress: "10 Main",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["tlc_source"],
    });
    const source = await prepareUsWorkerSource(
      clock.db,
      { tenant: owner.tenantId, actor: owner.userId },
      "available_records_incomplete",
      { tlcs: ["NO-MATCH-RESERVED-WORKER"] },
    );
    const c = (fixture = bindUsRequestWorkerFixture(clock.db, source));
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.action, "us.development.owner.provisioned"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: owner.tenantId,
      actorUserId: owner.userId,
      action: "us.development.owner.provisioned",
      outcome: "success",
      targetType: "tenant",
      targetId: owner.tenantId,
      requestId,
      before: null,
    });
    expect(audits[0]?.after).toEqual({ synthetic: true, seedVersion: "us-development-owner-v1" });
    expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
    const { actual } = await c.verifyReady();
    expect(actual.manifest.tenantOrigin).toEqual({
      schemaVersion: 1,
      verificationPolicy: "us-request-tenant-origin-v1",
      result: "trusted_synthetic",
      trustedSeed: { seedId: owner.tenantId, verifiedBy: "us-development-owner-v1" },
    });
    expect(
      await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.action, "us.development.owner.provisioned")),
    ).toEqual(audits);
    await publishedOnce(c);
  }, 60_000);

  it.each(["transformation", "shipping"] as const)(
    "publishes real %s frozen event workbook with exact saved-run renderer bytes",
    async (type) => {
      const f = await customDatabase();
      let scopeLot: string;
      let tenant: string;
      let actor: string;
      if (type === "transformation") {
        const c = await seedFinalizableTransformation(f);
        await f.db
          .update(schema.productTraceabilityProfiles)
          .set({ packagingStyle: "Case", packagingSizeValue: "10", packagingSizeUom: "lb" })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
        const readiness = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
          expectedDraftVersion: 1,
        });
        const finalized = await c.store.finalize(
          c.tenant,
          c.actor,
          c.saved.id,
          { ...c.command, expectedInputDigest: readiness.inputDigest },
          "worker-real-transformation",
        );
        const lot = finalized.snapshot.outputs[0]?.lotId;
        if (!lot) throw new Error("Missing real finalized output lot");
        scopeLot = lot;
        tenant = c.tenant;
        actor = c.actor;
      } else {
        const c = await seedShippingLifecycle(f.db);
        await f.db
          .update(schema.traceabilityLocations)
          .set({ roles: ["receive_at", "ship_from", "tlc_source"] })
          .where(eq(schema.traceabilityLocations.id, c.location));
        await f.db
          .update(schema.productTraceabilityProfiles)
          .set({ packagingStyle: "Case", packagingSizeValue: "10", packagingSizeUom: "lb" })
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
        await finalizeFixtureShipment(c, "20");
        scopeLot = c.lot;
        tenant = c.tenant;
        actor = c.actor;
      }
      const source = await prepareUsWorkerSource(
        clock.db,
        { tenant, actor },
        "available_records_incomplete",
        { lotId: scopeLot },
      );
      const c = (fixture = bindUsRequestWorkerFixture(clock.db, source));
      const expected = await renderUsRequestPayloads(source.run, tenant);
      expect(
        requireUsRequestPackageEvidence(source.run, tenant).exportInput?.events.some(
          (event) => event.type === type,
        ),
      ).toBe(true);
      if (!expected.workbook) throw new Error("Missing real frozen workbook");
      expect(await c.recreate().runOne()).toEqual({ kind: "ready", scope: c.scope });
      const { actual } = await c.verifyReady();
      expect(actual.files.find((file) => file.name === "records.xlsx")?.bytes).toEqual(
        expected.workbook.bytes,
      );
      await publishedOnce(c);
    },
    60_000,
  );

  it.each(["workbook_unrepresentable", "workbook_writer_failed"] as const)(
    "keeps accepted %s omission permanent across automatic/manual restart",
    async (code) => {
      const c = await setup({ mode: "available_records_incomplete", withPlan: false });
      const render = payloadModule.renderUsRequestPayloads;
      vi.spyOn(payloadModule, "renderUsRequestPayloads").mockImplementationOnce(
        async (...args) => ({
          ...(await render(...args)),
          workbook: null,
          missingWorkbook: { code },
        }),
      );
      let fail = true;
      c.storage.faults.before = async (command) => {
        if (command instanceof PutObjectCommand && fail) {
          fail = false;
          throw { code: "ECONNRESET" };
        }
      };
      expect(await c.worker.runOne()).toEqual({ kind: "retry_scheduled", scope: c.scope });
      const first = await c.lifecycle.read(c.scope);
      expect(first.checkpoint?.model.missingFiles).toEqual([
        { name: "records.xlsx", code },
        { name: "plan.pdf", code: "plan_absent" },
      ]);
      c.storage.faults.before = null;
      await due(c);
      expect(await c.recreate().runOne()).toEqual({
        kind: "failed",
        scope: c.scope,
        code: "us_request_worker_checkpoint_mismatch",
      });
      const failed = await c.lifecycle.read(c.scope);
      await c.instances().lifecycle.retry(c.scope, c.source.actorId, {
        expectedLifecycleVersion: failed.run.lifecycleVersion,
        idempotencyKey: randomUUID(),
        reason: "Synthetic manual retry cannot change omission",
      });
      expect(await c.recreate().runOne()).toEqual({
        kind: "failed",
        scope: c.scope,
        code: "us_request_worker_checkpoint_mismatch",
      });
      const after = await c.lifecycle.read(c.scope);
      expect(after.checkpoint).toEqual(first.checkpoint);
      expect(after.artifacts).toEqual([]);
      // Corrected source is explicitly validated and prepared as a new run revision.
      await new UsRequestValidationStore(clock.db).validate(
        c.scope.tenantId,
        c.source.actorId,
        c.source.request.id,
        requestWorkerFixtureBuild,
      );
      const fresh = await new UsRequestPrepareStore(clock.db).prepare(
        c.scope.tenantId,
        c.source.actorId,
        c.source.request.id,
        { mode: "available_records_incomplete", idempotencyKey: randomUUID() },
        requestWorkerFixtureBuild,
      );
      expect(fresh.id).not.toBe(c.scope.runId);
      expect(fresh.revision).toBe(c.source.run.revision + 1);
      expect(await c.recreate().runOne()).toEqual({
        kind: "ready",
        scope: { tenantId: c.scope.tenantId, runId: fresh.id },
      });
      expect((await c.lifecycle.read(c.scope)).run.status).toBe("failed");
    },
    60_000,
  );

  it("fails pinned execution-version drift permanently after a real accepted checkpoint", async () => {
    const c = await setup();
    c.storage.faults.before = async (command) => {
      if (command instanceof PutObjectCommand) throw { code: "ECONNRESET" };
    };
    expect(await c.worker.runOne()).toEqual({ kind: "retry_scheduled", scope: c.scope });
    const first = await c.lifecycle.read(c.scope);
    c.storage.faults.before = null;
    await due(c);
    const create = executions.createSyntheticUsRequestExecutionIdentity;
    vi.spyOn(executions, "createSyntheticUsRequestExecutionIdentity").mockImplementation(
      (build, source) => create({ ...build, gitSha: "b".repeat(40) }, source),
    );
    expect(await c.recreate().runOne()).toEqual({
      kind: "failed",
      scope: c.scope,
      code: "us_request_worker_execution_invalid",
    });
    const failed = await c.lifecycle.read(c.scope);
    await c.instances().lifecycle.retry(c.scope, c.source.actorId, {
      expectedLifecycleVersion: failed.run.lifecycleVersion,
      idempotencyKey: randomUUID(),
      reason: "Synthetic retry retains version pin",
    });
    expect(await c.recreate().runOne()).toEqual({
      kind: "failed",
      scope: c.scope,
      code: "us_request_worker_execution_invalid",
    });
    expect((await c.lifecycle.read(c.scope)).checkpoint).toEqual(first.checkpoint);
    expect((await c.lifecycle.read(c.scope)).artifacts).toEqual([]);
  }, 60_000);

  it.each(["entriesTotal", "zip"] as const)(
    "rejects bounded %s with a restored lower-limit seam before upload (not maximum-size performance)",
    async (limit) => {
      const c = await setup();
      const descriptor = Object.getOwnPropertyDescriptor(US_REQUEST_PACKAGE_LIMITS, limit);
      if (!descriptor) throw new Error("Missing default bound");
      expect(US_REQUEST_PACKAGE_LIMITS.entriesTotal).toBe(48 * 1024 * 1024);
      expect(US_REQUEST_PACKAGE_LIMITS.zip).toBe(64 * 1024 * 1024);
      try {
        Object.defineProperty(US_REQUEST_PACKAGE_LIMITS, limit, { ...descriptor, value: 1 });
        expect(await c.worker.runOne()).toEqual({
          kind: "failed",
          scope: c.scope,
          code: "us_request_package_size_limit",
        });
        expect(c.storage.calls).toEqual([]);
        expect((await c.lifecycle.read(c.scope)).artifacts).toEqual([]);
      } finally {
        Object.defineProperty(US_REQUEST_PACKAGE_LIMITS, limit, descriptor);
      }
      expect(US_REQUEST_PACKAGE_LIMITS[limit]).toBe(descriptor.value);
    },
    60_000,
  );

  it("rejects actual streamed overrun and closes body without artifact publication", async () => {
    const c = await setup();
    let body: Readable | undefined;
    c.storage.faults.after = async (command, result) => {
      if (
        command instanceof GetObjectCommand &&
        result &&
        typeof result === "object" &&
        "ContentLength" in result &&
        typeof result.ContentLength === "number"
      ) {
        if ("Body" in result && result.Body instanceof Readable) result.Body.destroy();
        body = Readable.from([Buffer.alloc(result.ContentLength + 1)]);
        return { ...result, Body: body };
      }
      return result;
    };
    expect(await c.worker.runOne()).toEqual({
      kind: "failed",
      scope: c.scope,
      code: "us_request_package_storage_evidence_invalid",
    });
    expect(body?.destroyed).toBe(true);
    expect((await c.lifecycle.read(c.scope)).artifacts).toEqual([]);
  }, 60_000);
});
