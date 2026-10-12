import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsRequestReadStore } from "../src/modules/traceability/requests/us-request-read";
import { authorizeUsRequestHttp } from "../src/modules/traceability/requests/us-request-http-context";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  legacyRequestBuild as build,
  seedLegacyUsRequestRun,
} from "./support/us-request-v1-fixture";
import { createUsWorkerDatabaseTransport } from "./support/us-request-worker-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("authorized US request reads in owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let reads: UsRequestReadStore;
  const ctx = () => ({ tenantId: c.tenant, userId: c.actor, httpRequestId: randomUUID() });
  beforeEach(async () => {
    if (!url) throw new Error("Explicit isolated US database URL required");
    f = await createUsProfileTestDatabase(url);
    c = await seedCompleteReceiving(f.db);
    reads = new UsRequestReadStore(f.db);
  }, 60_000);
  afterEach(async () => {
    await f?.close();
  });
  const create = (requestNumber: string = randomUUID()) =>
    new UsRequestStore(f.db).create(c.tenant, c.actor, {
      requestNumber,
      requesterName: "Synthetic saved requester",
      requesterOrganization: null,
      requesterContact: "private@example.test",
      receivedAt: "2026-10-05T00:00:00Z",
      scope: { tlcs: ["NO-MATCH-HTTP-READ"] },
    });
  const prepare = async () => {
    const request = await create();
    await new UsRequestValidationStore(f.db).validate(c.tenant, c.actor, request.id, build);
    return new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      request.id,
      { mode: "available_records_incomplete", idempotencyKey: randomUUID() },
      build,
    );
  };
  const state = async () => ({
    requests: await f.db
      .select()
      .from(schema.traceRequests)
      .where(eq(schema.traceRequests.tenantId, c.tenant)),
    runs: await f.db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.tenantId, c.tenant)),
    attempts: await f.db
      .select()
      .from(schema.traceExportAttempts)
      .where(eq(schema.traceExportAttempts.tenantId, c.tenant)),
    audits: await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant))
      .orderBy(schema.tenantAuditEvents.id),
  });

  // Breaks caught: missing tenant filters and accidental private summary fields.
  it("hides foreign IDs and requester contact from summary pages", async () => {
    const own = await create();
    const foreign = await seedCompleteReceiving(f.db);
    const row = await new UsRequestStore(f.db).create(foreign.tenant, foreign.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic foreign requester",
      requesterOrganization: null,
      requesterContact: "foreign-private@example.test",
      receivedAt: "2026-10-05T00:00:00Z",
      scope: { lotId: foreign.lot },
    });
    await expect(reads.get(ctx(), row.id)).rejects.toMatchObject({ status: 404 });
    const page = await reads.list(ctx(), {});
    expect(page.items.map((item) => item.id)).toEqual([own.id]);
    expect(JSON.stringify(page)).not.toContain("private@example.test");
    expect(await reads.get(ctx(), own.id)).toMatchObject({
      requesterContact: "private@example.test",
      savedValidation: null,
    });
    await expect(reads.listRuns(ctx(), row.id, {})).rejects.toMatchObject({ status: 404 });
    const foreignRun = await seedLegacyUsRequestRun(f.db, foreign, "available_records_incomplete");
    await expect(reads.getRun(ctx(), foreignRun.id)).rejects.toMatchObject({ status: 404 });
    await expect(reads.listAttempts(ctx(), foreignRun.id, {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it("reloads role before input parsing and denies unsupported profiles", async () => {
    const row = await create();
    await f.db
      .update(schema.member)
      .set({ role: "unknown" })
      .where(and(eq(schema.member.organizationId, c.tenant), eq(schema.member.userId, c.actor)));
    await expect(reads.get(ctx(), "malformed")).rejects.toMatchObject({ status: 403 });
    await f.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(and(eq(schema.member.organizationId, c.tenant), eq(schema.member.userId, c.actor)));
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(reads.get(ctx(), row.id)).rejects.toMatchObject({ status: 403 });
  });

  it("marks saved validation as not rechecked and keeps frozen requester after a live edit", async () => {
    const run = await prepare();
    expect(await reads.get(ctx(), run.requestId)).toMatchObject({
      savedValidation: { freshness: "not_rechecked", matchedRevisionCount: 0 },
      latestRun: { runId: run.id },
    });
    await new UsRequestStore(f.db).update(c.tenant, c.actor, run.requestId, {
      expectedRevision: 1,
      requesterName: "Changed current requester",
    });
    const [updated] = await f.db
      .select({
        createdAt: schema.traceRequests.createdAt,
        updatedAt: schema.traceRequests.updatedAt,
        closedAt: schema.traceRequests.closedAt,
      })
      .from(schema.traceRequests)
      .where(eq(schema.traceRequests.id, run.requestId));
    if (!updated) throw new Error("Missing owned updated request");
    expect(await reads.get(ctx(), run.requestId)).toMatchObject({
      revision: 2,
      requesterName: "Changed current requester",
      savedValidation: null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      closedAt: null,
    });
    expect(await reads.getRun(ctx(), run.id)).toMatchObject({
      requestRevision: 1,
      request: { requesterName: "Synthetic saved requester" },
      scope: { tlcs: ["NO-MATCH-HTTP-READ"] },
      artifacts: [],
      missingFiles: null,
    });
    expect(JSON.stringify(await reads.listRuns(ctx(), run.requestId, {}))).not.toContain(
      "private@example.test",
    );
    await new UsRequestStore(f.db).close(c.tenant, c.actor, run.requestId, { expectedRevision: 2 });
    const [closed] = await f.db
      .select({
        createdAt: schema.traceRequests.createdAt,
        updatedAt: schema.traceRequests.updatedAt,
        closedAt: schema.traceRequests.closedAt,
      })
      .from(schema.traceRequests)
      .where(eq(schema.traceRequests.id, run.requestId));
    if (!closed?.closedAt) throw new Error("Missing owned closed request");
    expect(await reads.get(ctx(), run.requestId)).toMatchObject({
      status: "closed",
      createdAt: closed.createdAt.toISOString(),
      updatedAt: closed.updatedAt.toISOString(),
      closedAt: closed.closedAt.toISOString(),
    });
    expect(await reads.getRun(ctx(), run.id)).toMatchObject({
      status: "queued",
      requestRevision: 1,
    });
  });

  it("reads v1 evidence with unknown provenance and refuses malformed stored evidence", async () => {
    const run = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    expect(await reads.getRun(ctx(), run.id)).toMatchObject({
      provenance: "not_verified",
      generationStartedAt: null,
      latestAttempt: null,
    });
    const id = randomUUID();
    await f.db.insert(schema.traceExportRuns).values({
      ...run,
      id,
      revision: run.revision + 1,
      idempotencyKey: randomUUID(),
      inputSnapshot: { selectionKind: "empty" },
    });
    await expect(reads.getRun(ctx(), id)).rejects.toMatchObject({ status: 503 });
    await expect(reads.listRuns(ctx(), run.requestId, {})).rejects.toMatchObject({ status: 503 });
  });

  it("refuses malformed request metadata and validation without repairing saved values", async () => {
    const request = await create();
    await f.db
      .update(schema.traceRequests)
      .set({ requesterName: " Noncanonical " })
      .where(eq(schema.traceRequests.id, request.id));
    const before = await state();
    await expect(reads.get(ctx(), request.id)).rejects.toMatchObject({ status: 503 });
    expect(await state()).toEqual(before);
    await f.db
      .update(schema.traceRequests)
      .set({
        requesterName: "Synthetic saved requester",
        lastValidation: { unexpected: true },
        lastValidationDigest: "a".repeat(64),
        lastValidatedAt: new Date(),
      })
      .where(eq(schema.traceRequests.id, request.id));
    await expect(reads.get(ctx(), request.id)).rejects.toMatchObject({ status: 503 });
  });

  it("paginates stable request summaries with canonical bounded filters", async () => {
    for (let n = 0; n < 4; n++) await create(`HTTP-PAGE-${n}`);
    expect(await reads.list(ctx(), { limit: "2", offset: "1" })).toMatchObject({
      limit: 2,
      offset: 1,
      hasMore: true,
    });
    expect(await reads.list(ctx(), { limit: "2", offset: "3" })).toMatchObject({
      hasMore: false,
    });
    expect((await reads.list(ctx(), { requestNumber: "HTTP-PAGE-2" })).items).toHaveLength(1);
    expect(await reads.list(ctx(), {})).toMatchObject({ limit: 25, offset: 0, hasMore: false });
    for (const query of [
      { limit: "51" },
      { offset: "01" },
      { offset: "10001" },
      { limit: ["1", "2"] },
      { unknown: "1" },
      { limit: 2 },
    ])
      await expect(reads.list(ctx(), query)).rejects.toMatchObject({ status: 400 });
  });

  // Breaks caught: creation-order queues and unstable UUID ties at page boundaries.
  it("queues earliest deadlines first and keeps ascending UUID ties across pages", async () => {
    const createAtReceipt = (requestNumber: string, receivedAt: string) =>
      new UsRequestStore(f.db).create(c.tenant, c.actor, {
        requestNumber,
        requesterName: "Synthetic deadline queue",
        requesterOrganization: null,
        requesterContact: null,
        receivedAt,
        scope: { lotId: c.lot },
      });
    // Creation sequence intentionally differs from due sequence; default deadline = receipt +24h.
    const late = await createAtReceipt("HTTP-QUEUE-LATE", "2026-10-07T00:00:00Z");
    const tieA = await createAtReceipt("HTTP-QUEUE-TIE-A", "2026-10-06T00:00:00Z");
    const early = await createAtReceipt("HTTP-QUEUE-EARLY", "2026-10-05T00:00:00Z");
    const tieB = await createAtReceipt("HTTP-QUEUE-TIE-B", "2026-10-06T00:00:00Z");
    expect(late.dueAt.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(early.dueAt.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(tieA.dueAt.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(tieB.dueAt.toISOString()).toBe("2026-10-07T00:00:00.000Z");
    // Canonical lowercase UUIDs follow lexical string order; no production SQL comparator is reused.
    const ties = [tieA.id, tieB.id].sort();
    const first = await reads.list(ctx(), { limit: "2", offset: "0" });
    const second = await reads.list(ctx(), { limit: "2", offset: "2" });
    expect(first.items.map((item) => item.id)).toEqual([early.id, ties[0]]);
    expect(second.items.map((item) => item.id)).toEqual([ties[1], late.id]);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(first.items.map((item) => item.dueAt)).toEqual([
      "2026-10-06T00:00:00.000Z",
      "2026-10-07T00:00:00.000Z",
    ]);
    expect(second.items.map((item) => item.dueAt)).toEqual([
      "2026-10-07T00:00:00.000Z",
      "2026-10-08T00:00:00.000Z",
    ]);
  });

  it("bounds run pages and never reconciles a processing lease or writes audits", async () => {
    const run = await prepare();
    for (let n = 0; n < 3; n++)
      await new UsRequestPrepareStore(f.db).prepare(
        c.tenant,
        c.actor,
        run.requestId,
        { mode: "available_records_incomplete", idempotencyKey: randomUUID() },
        build,
      );
    const lease = await new UsRequestWorkerLifecycle(f.db).claimNext();
    if (!lease) throw new Error("Missing real claimed lease");
    const transport = createUsWorkerDatabaseTransport(f.db);
    reads = new UsRequestReadStore(transport.db);
    const before = await state();
    const page = await reads.listRuns(ctx(), run.requestId, { limit: "2", offset: "1" });
    expect(page.items.map((item) => item.runRevision)).toEqual([3, 2]);
    expect(page.hasMore).toBe(true);
    expect(await reads.getRun(ctx(), lease.runId)).toMatchObject({
      status: "processing",
      latestAttempt: { status: "active" },
    });
    await reads.listAttempts(ctx(), lease.runId, {});
    await reads.get(ctx(), run.requestId);
    await reads.list(ctx(), {});
    expect(await state()).toEqual(before);
    expect(transport.statements.some(({ raw }) => /^\s*(insert|update|delete)\b/i.test(raw))).toBe(
      false,
    );
    const runPageQuery = transport.statements.find(({ raw }) =>
      /select "id" from "trace_export_runs"/.test(raw),
    );
    expect(runPageQuery?.raw).toContain("limit");
  });

  it("paginates actual attempt history across many manual retry cycles", async () => {
    const run = await prepare();
    const lifecycle = new UsRequestWorkerLifecycle(f.db);
    for (let n = 0; n < 8; n++) {
      const lease = await lifecycle.claimNext();
      if (!lease) throw new Error("Missing real retry lease");
      await lifecycle.finishFailure(lease, {
        code: "us_request_worker_unknown_failure",
        retryable: false,
      });
      if (n < 7) {
        const [saved] = await f.db
          .select()
          .from(schema.traceExportRuns)
          .where(eq(schema.traceExportRuns.id, run.id));
        if (!saved) throw new Error("Missing run");
        await lifecycle.retry({ tenantId: c.tenant, runId: run.id }, c.actor, {
          expectedLifecycleVersion: saved.lifecycleVersion,
          idempotencyKey: randomUUID(),
          reason: "Synthetic manual retry",
        });
      }
    }
    expect(await reads.listAttempts(ctx(), run.id, { limit: "3", offset: "2" })).toMatchObject({
      limit: 3,
      offset: 2,
      hasMore: true,
      items: [
        { attemptNumber: 6, cycle: 6 },
        { attemptNumber: 5, cycle: 5 },
        { attemptNumber: 4, cycle: 4 },
      ],
    });
    expect(await reads.listAttempts(ctx(), run.id, { limit: "3", offset: "6" })).toMatchObject({
      hasMore: false,
      items: [{ attemptNumber: 2 }, { attemptNumber: 1 }],
    });
    expect(JSON.stringify(await reads.listAttempts(ctx(), run.id, {}))).not.toMatch(
      /token|objectKey|leaseExpiresAt|deadlineAt/,
    );
  });

  it("requires every requested capability and denies an empty authorization set", async () => {
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(and(eq(schema.member.organizationId, c.tenant), eq(schema.member.userId, c.actor)));
    await expect(
      f.db.transaction((tx) => authorizeUsRequestHttp(tx, ctx(), [US_CAPABILITY.EXPORT_READ])),
    ).resolves.toBeUndefined();
    await expect(
      f.db.transaction((tx) =>
        authorizeUsRequestHttp(tx, ctx(), [US_CAPABILITY.EXPORT_READ, US_CAPABILITY.QA_MANAGE]),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.db.transaction((tx) => authorizeUsRequestHttp(tx, ctx(), [])),
    ).rejects.toMatchObject({ status: 403 });
    await f.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(reads.list(ctx(), {})).rejects.toMatchObject({ status: 403 });
  });

  it("does not invent attempts for pre-worker legacy counts", async () => {
    const original = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    const id = randomUUID();
    await f.db.insert(schema.traceExportRuns).values({
      ...original,
      id,
      revision: original.revision + 1,
      idempotencyKey: randomUUID(),
      attemptCount: 7,
    });
    expect(await reads.getRun(ctx(), id)).toMatchObject({
      attemptCount: 7,
      generationStartedAt: null,
      reportRenderedAt: null,
      latestAttempt: null,
    });
    expect(await reads.listAttempts(ctx(), id, {})).toEqual({
      items: [],
      limit: 25,
      offset: 0,
      hasMore: false,
    });
    await expect(reads.listAttempts(ctx(), id, { offset: "10001" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(reads.listRuns(ctx(), original.requestId, { limit: "01" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses extra saved-validation keys instead of hiding them during projection", async () => {
    const run = await prepare();
    await f.db
      .update(schema.traceRequests)
      .set({
        lastValidation: { matchedRevisionCount: 0, findings: [], digest: "unexpected-saved-key" },
      })
      .where(eq(schema.traceRequests.id, run.requestId));
    await expect(reads.get(ctx(), run.requestId)).rejects.toMatchObject({ status: 503 });
  });
});
