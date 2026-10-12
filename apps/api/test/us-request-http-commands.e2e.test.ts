import { randomUUID } from "node:crypto";
import { schema, type createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
  type LoadedUsRequestBuildDescriptor,
} from "../src/deployment/us-request-build-descriptor";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import { verifyUsRequestRunEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";
import { createUsRequestWorkerStorageFixture } from "./support/us-request-worker-storage-fixture";
import { seedLegacyUsRequestRun } from "./support/us-request-v1-fixture";
import {
  seedUsRequestPayloadPlan,
  finalizeUsRequestPayloadReceiving,
} from "./support/us-request-payload-fixture";

type Pool = ReturnType<typeof createDb>["pool"];
async function waitForRequestBlock(pool: Pool, blockerPid: number): Promise<void> {
  for (let probe = 0; probe < 100; probe++) {
    const state = await pool.query<{ blocked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
      [blockerPid],
    );
    if (state.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected request-row lock was not observed");
}

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("transactional US request HTTP commands in owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let buildFixture: Awaited<ReturnType<typeof createUsRequestBuildFixture>>;
  let loaded: LoadedUsRequestBuildDescriptor;
  let storage: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  let requests: UsRequestStore;
  let validation: UsRequestValidationStore;
  let prepare: UsRequestPrepareStore;
  const ctx = () => ({ tenantId: c.tenant, userId: c.actor, httpRequestId: randomUUID() });
  const build = () => loaded.document.build;
  const createBody = () => ({
    requestNumber: randomUUID(),
    requesterName: "Synthetic requester",
    requesterOrganization: null,
    requesterContact: "private@example.test",
    receivedAt: "2026-10-04T00:00:00Z",
    scope: { lotId: c.lot },
  });
  const create = () => requests.create(c.tenant, c.actor, createBody());
  const read = async (id: string) => {
    const [row] = await f.db
      .select()
      .from(schema.traceRequests)
      .where(eq(schema.traceRequests.id, id));
    if (!row) throw new Error("Missing owned request");
    return row;
  };
  const runs = () =>
    f.db.select().from(schema.traceExportRuns).where(eq(schema.traceExportRuns.tenantId, c.tenant));
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
  const audit = (
    correlation: string | null,
    action: string,
    targetId: string | null,
    outcome: string,
    before: unknown,
    after: unknown,
    targetType = "trace_request",
  ) => ({
    id: expect.any(String),
    createdAt: expect.any(Date),
    organizationId: c.tenant,
    actorUserId: c.actor,
    requestId: correlation,
    action: `traceability.request.${action}`,
    targetType,
    targetId,
    outcome,
    before,
    after,
  });
  const http = async (
    gates = { loadBuild: async () => loaded, requirePackageStore: () => storage.store },
  ) => {
    const { UsRequestHttpCommands } =
      await import("../src/modules/traceability/requests/us-request-http-commands");
    return new UsRequestHttpCommands(f.db, gates);
  };
  const prepared = async () => {
    const request = await create();
    const checked = await validation.validate(c.tenant, c.actor, request.id, build());
    const body = {
      expectedRevision: request.revision,
      validationDigest: checked.digest,
      mode: "available_records_incomplete" as const,
      idempotencyKey: randomUUID(),
    };
    return { request, checked, body };
  };
  // US-07 emits error/info. This valid saved-warning fixture exercises the
  // acknowledgement seam without inventing a production warning policy.
  const savedWarning = async (
    id: string,
    checked: Awaited<ReturnType<UsRequestValidationStore["validate"]>>,
  ) => {
    await f.db
      .update(schema.traceRequests)
      .set({
        lastValidation: {
          matchedRevisionCount: checked.matchedRevisionCount,
          findings: [
            ...checked.findings,
            {
              code: "synthetic_warning",
              severity: "warning",
              sourceRecord: `request:${id}`,
              message: "Synthetic reviewed warning",
            },
          ],
        },
      })
      .where(eq(schema.traceRequests.id, id));
  };
  beforeAll(async () => {
    buildFixture = await createUsRequestBuildFixture();
    await buildFixture.writeDocument(
      await captureUsRequestBuildDescriptor(buildFixture.cleanBuild, buildFixture.roots),
    );
    loaded = await loadUsRequestBuildDescriptor(await localBuildEnv(), buildFixture.roots);
  });
  afterAll(async () => {
    await buildFixture?.dispose();
  });
  beforeEach(async () => {
    if (!url) throw new Error("Explicit isolated US database URL required");
    f = await createUsProfileTestDatabase(url);
    c = await seedCompleteReceiving(f.db);
    storage = createUsRequestWorkerStorageFixture();
    requests = new UsRequestStore(f.db);
    validation = new UsRequestValidationStore(f.db);
    prepare = new UsRequestPrepareStore(f.db);
  }, 60_000);
  afterEach(async () => {
    storage?.destroy();
    await f?.close();
  });

  // Missing locked revision guards would overwrite validation for an obsolete envelope.
  it("rejects stale Validate with exact correlated conflict and no saved validation or run", async () => {
    const request = await create(),
      context = ctx();
    await requests.update(c.tenant, c.actor, request.id, {
      expectedRevision: 1,
      requesterName: "Changed synthetic requester",
    });
    const prior = await audits();
    await expect(
      validation.validateHttp(
        c.tenant,
        c.actor,
        request.id,
        { expectedRevision: 1 },
        build(),
        context.httpRequestId,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_revision_conflict" } });
    const ids = new Set(prior.map((row) => row.id));
    expect((await audits()).filter((row) => !ids.has(row.id))).toEqual([
      audit(context.httpRequestId, "validated", request.id, "conflict", null, {
        code: "us_request_revision_conflict",
        revision: 2,
        digest: null,
        warningAckDigest: null,
        expectedRevision: 1,
      }),
    ]);
    expect((await read(request.id)).lastValidationDigest).toBeNull();
    expect(await runs()).toEqual([]);
  });

  it("observes a real blocked request lock and rejects revision 1 after the concurrent revision 2 commit", async () => {
    const request = await create(),
      context = ctx(),
      blocker = await f.pool.connect();
    let settlement: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (!pid.rows[0]) throw new Error("Missing owned blocker PID");
      await blocker.query("SELECT id FROM trace_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        c.tenant,
        request.id,
      ]);
      const pending = validation.validateHttp(
        c.tenant,
        c.actor,
        request.id,
        { expectedRevision: 1 },
        build(),
        context.httpRequestId,
      );
      settlement = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waitForRequestBlock(f.pool, pid.rows[0].pid);
      await blocker.query(
        "UPDATE trace_requests SET requester_name=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [c.tenant, request.id, "Concurrent synthetic editor"],
      );
      await blocker.query("COMMIT");
      await expect(pending).rejects.toMatchObject({
        status: 409,
        response: { code: "us_request_revision_conflict" },
      });
      expect((await audits()).filter((row) => row.requestId === context.httpRequestId)).toEqual([
        audit(context.httpRequestId, "validated", request.id, "conflict", null, {
          code: "us_request_revision_conflict",
          revision: 2,
          digest: null,
          warningAckDigest: null,
          expectedRevision: 1,
        }),
      ]);
      expect((await read(request.id)).lastValidationDigest).toBeNull();
      expect(await runs()).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await settlement;
    }
  });

  it("binds warning acknowledgement to locked revision and saved digest", async () => {
    const { request, checked } = await prepared(),
      context = ctx();
    await savedWarning(request.id, checked);
    await expect(
      validation.acknowledgeWarningsHttp(
        c.tenant,
        c.actor,
        request.id,
        { expectedRevision: 2, digest: checked.digest, reason: "Reviewed synthetic warning" },
        context.httpRequestId,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_revision_conflict" } });
    await expect(
      validation.acknowledgeWarningsHttp(
        c.tenant,
        c.actor,
        request.id,
        { expectedRevision: 1, digest: "b".repeat(64), reason: "Reviewed synthetic warning" },
        context.httpRequestId,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_validation_stale" } });
    const accepted = ctx();
    await validation.acknowledgeWarningsHttp(
      c.tenant,
      c.actor,
      request.id,
      { expectedRevision: 1, digest: checked.digest, reason: "Reviewed synthetic warning" },
      accepted.httpRequestId,
    );
    expect((await audits()).filter((row) => row.requestId === accepted.httpRequestId)).toEqual([
      audit(
        accepted.httpRequestId,
        "warnings_acknowledged",
        request.id,
        "success",
        { revision: 1, digest: checked.digest, warningAckDigest: null },
        { revision: 1, digest: checked.digest, warningAckDigest: checked.digest },
      ),
    ]);
  });

  it("checks stale HTTP revision before closed-request eligibility for Validate and acknowledgement", async () => {
    const { request, checked } = await prepared();
    await requests.close(c.tenant, c.actor, request.id, { expectedRevision: 1 });
    await expect(
      validation.validateHttp(
        c.tenant,
        c.actor,
        request.id,
        { expectedRevision: 1 },
        build(),
        ctx().httpRequestId,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_revision_conflict" } });
    await expect(
      validation.acknowledgeWarningsHttp(
        c.tenant,
        c.actor,
        request.id,
        { expectedRevision: 1, digest: checked.digest, reason: "Reviewed synthetic warning" },
        ctx().httpRequestId,
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_revision_conflict" } });
  });

  it.each([
    { expectedRevision: 2, validationDigest: null, code: "us_request_revision_conflict" },
    { expectedRevision: 1, validationDigest: "b".repeat(64), code: "us_request_validation_stale" },
  ])(
    "refuses first Prepare with $code before allocating a run",
    async ({ expectedRevision, validationDigest, code }) => {
      const { request, body } = await prepared(),
        context = ctx();
      await expect(
        prepare.prepareHttp(
          c.tenant,
          c.actor,
          request.id,
          {
            ...body,
            expectedRevision,
            validationDigest: validationDigest ?? body.validationDigest,
          },
          build(),
          context.httpRequestId,
        ),
      ).rejects.toMatchObject({ status: 409, response: { code } });
      expect(await runs()).toEqual([]);
      expect((await audits()).filter((row) => row.requestId === context.httpRequestId)).toEqual([
        audit(context.httpRequestId, "prepared", request.id, "conflict", null, {
          code,
          mode: body.mode,
          requestRevision: 1,
          digest: body.validationDigest,
        }),
      ]);
    },
  );

  it("serializes identical Prepare keys without changing the legacy command digest", async () => {
    const { request, body } = await prepared(),
      first = ctx(),
      second = ctx();
    const results = await Promise.all(
      [first, second].map((context) =>
        prepare.prepareHttp(c.tenant, c.actor, request.id, body, build(), context.httpRequestId),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    expect(await runs()).toHaveLength(1);
    expect(results[0]?.commandDigest).toBe(
      canonicalExportDigest({ schemaVersion: 1, requestId: request.id, mode: body.mode }),
    );
    expect(
      (await audits()).filter((row) =>
        new Set<string>([first.httpRequestId, second.httpRequestId]).has(row.requestId ?? ""),
      ),
    ).toHaveLength(2);
  });

  it("replays frozen evidence after edit and closure but conflicts on divergent HTTP envelopes", async () => {
    const { request, body } = await prepared(),
      context = ctx();
    const run = await prepare.prepareHttp(
      c.tenant,
      c.actor,
      request.id,
      body,
      build(),
      context.httpRequestId,
    );
    await requests.update(c.tenant, c.actor, request.id, {
      expectedRevision: 1,
      requesterName: "Edited after acceptance",
    });
    await requests.close(c.tenant, c.actor, request.id, { expectedRevision: 2 });
    await f.db
      .update(schema.products)
      .set({ name: "Source changed after acceptance" })
      .where(eq(schema.products.id, c.product));
    await seedUsRequestPayloadPlan(f.db, c);
    const replay = ctx();
    expect(
      await prepare.prepareHttp(
        c.tenant,
        c.actor,
        request.id,
        body,
        { ...build(), gitSha: "b".repeat(40) },
        replay.httpRequestId,
      ),
    ).toEqual(run);
    expect((await audits()).filter((row) => row.requestId === replay.httpRequestId)).toEqual([
      audit(replay.httpRequestId, "prepare_replayed", request.id, "success", null, {
        runId: run.id,
        revision: run.revision,
        mode: run.mode,
        digest: run.scopedContentDigest,
        inputDigest: run.inputDigest,
      }),
    ]);
    for (const patch of [
      { expectedRevision: 2 },
      { validationDigest: "b".repeat(64) },
      { mode: "export_ready" as const },
    ])
      await expect(
        prepare.prepareHttp(
          c.tenant,
          c.actor,
          request.id,
          { ...body, ...patch },
          build(),
          ctx().httpRequestId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "us_request_idempotency_conflict" },
      });
    const other = await create();
    await expect(
      prepare.prepareHttp(c.tenant, c.actor, other.id, body, build(), ctx().httpRequestId),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_idempotency_conflict" } });
    expect(await runs()).toEqual([run]);
  });

  it.each(["source", "plan", "build"] as const)(
    "rejects first Prepare after %s drift while preserving saved validation",
    async (drift) => {
      await finalizeUsRequestPayloadReceiving(f.db, c);
      const { request, body } = await prepared();
      if (drift === "source")
        await f.db
          .update(schema.products)
          .set({ name: "Changed source description" })
          .where(eq(schema.products.id, c.product));
      if (drift === "plan") await seedUsRequestPayloadPlan(f.db, c);
      await expect(
        prepare.prepareHttp(
          c.tenant,
          c.actor,
          request.id,
          body,
          drift === "build" ? { ...build(), gitSha: "b".repeat(40) } : build(),
          ctx().httpRequestId,
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: "us_request_validation_stale" } });
      expect((await read(request.id)).lastValidationDigest).toBe(body.validationDigest);
      expect(await runs()).toEqual([]);
    },
  );

  it("accepts matching v1 HTTP replay without rewriting its frozen receipt", async () => {
    const run = await seedLegacyUsRequestRun(f.db, c, "available_records_incomplete");
    const frozen = verifyUsRequestRunEvidence(run, c.tenant);
    const replay = await prepare.prepareHttp(
      c.tenant,
      c.actor,
      run.requestId,
      {
        expectedRevision: frozen.validationSnapshot.request.revision,
        validationDigest: run.scopedContentDigest,
        mode: frozen.mode,
        idempotencyKey: run.idempotencyKey,
      },
      build(),
      ctx().httpRequestId,
    );
    expect(replay).toEqual(run);
    expect(frozen.schemaVersion).toBe(1);
  });

  it("returns strict CRUD acknowledgements with atomic correlation and no extra audit for an unchanged update", async () => {
    const commands = await http({
        loadBuild: async () => {
          throw new Error("Descriptor intentionally unavailable");
        },
        requirePackageStore: () => {
          throw new Error("Storage intentionally unavailable");
        },
      }),
      context = ctx();
    const receipt = await commands.create(context, createBody());
    expect(Object.keys(receipt).sort()).toEqual([
      "httpRequestId",
      "requestId",
      "revision",
      "status",
    ]);
    expect((await audits()).filter((row) => row.requestId === context.httpRequestId)).toEqual([
      audit(context.httpRequestId, "created", receipt.requestId, "success", null, {
        revision: 1,
        status: "open",
        lastValidationDigest: null,
      }),
    ]);
    const prior = await audits();
    expect(
      await commands.update(ctx(), receipt.requestId, {
        expectedRevision: 1,
        requesterName: "Synthetic requester",
      }),
    ).toMatchObject({ revision: 1, status: "open" });
    expect(await audits()).toEqual(prior);
    const changed = ctx();
    expect(
      await commands.update(changed, receipt.requestId, {
        expectedRevision: 1,
        requesterName: "Changed requester",
      }),
    ).toMatchObject({ revision: 2 });
    expect((await audits()).filter((row) => row.requestId === changed.httpRequestId)).toEqual([
      audit(
        changed.httpRequestId,
        "updated",
        receipt.requestId,
        "success",
        { revision: 1, status: "open", lastValidationDigest: null },
        { revision: 2, status: "open", lastValidationDigest: null },
      ),
    ]);
    expect(await commands.close(ctx(), receipt.requestId, { expectedRevision: 2 })).toMatchObject({
      revision: 3,
      status: "closed",
    });
  });

  it("returns exact facade Prepare receipts and requires gates even for a matching frozen replay", async () => {
    const { request, body } = await prepared(),
      context = ctx(),
      commands = await http();
    const receipt = await commands.prepare(context, request.id, body);
    const [run] = await runs();
    if (!run) throw new Error("Missing HTTP run");
    expect((await audits()).filter((row) => row.requestId === context.httpRequestId)).toEqual([
      audit(context.httpRequestId, "prepared", request.id, "success", null, {
        runId: run.id,
        revision: 1,
        requestRevision: 1,
        mode: body.mode,
        digest: body.validationDigest,
        inputDigest: run.inputDigest,
      }),
    ]);
    expect(receipt).toEqual({
      httpRequestId: context.httpRequestId,
      requestId: request.id,
      requestRevision: 1,
      runId: run.id,
      runRevision: 1,
      mode: body.mode,
      idempotencyKey: body.idempotencyKey,
      scopedContentDigest: body.validationDigest,
    });
    await requests.close(c.tenant, c.actor, request.id, { expectedRevision: 1 });
    const replay = ctx();
    expect(await commands.prepare(replay, request.id, body)).toEqual({
      ...receipt,
      httpRequestId: replay.httpRequestId,
    });
    const blocked = await http({
      loadBuild: async () => {
        throw new Error("Private descriptor detail");
      },
      requirePackageStore: () => storage.store,
    });
    await expect(blocked.prepare(ctx(), request.id, body)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_request_build_unavailable" },
    });
    expect(await runs()).toEqual([run]);
  });

  it("acknowledges saved warnings without loading a descriptor or package storage", async () => {
    const { request, checked } = await prepared();
    await savedWarning(request.id, checked);
    const commands = await http({
        loadBuild: async () => {
          throw new Error("Unavailable descriptor");
        },
        requirePackageStore: () => {
          throw new Error("Unavailable storage");
        },
      }),
      context = ctx();
    expect(
      await commands.acknowledgeWarnings(context, request.id, {
        expectedRevision: 1,
        digest: checked.digest,
        reason: "Reviewed synthetic warning",
      }),
    ).toEqual({
      httpRequestId: context.httpRequestId,
      requestId: request.id,
      revision: 1,
      status: "open",
    });
  });

  it("preflights tenant target and current authority before dependency gates without leaking foreign facts", async () => {
    const foreign = await seedCompleteReceiving(f.db);
    const foreignRequest = await requests.create(foreign.tenant, foreign.actor, {
      ...createBody(),
      requesterContact: "foreign-private@example.test",
    });
    const commands = await http({
      loadBuild: async () => {
        throw new Error("private descriptor path");
      },
      requirePackageStore: () => {
        throw new Error("private storage credentials");
      },
    });
    await expect(
      commands.validate(ctx(), foreignRequest.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      commands.prepare(ctx(), foreignRequest.id, {
        expectedRevision: 1,
        validationDigest: "a".repeat(64),
        mode: "available_records_incomplete",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await f.db
      .update(schema.member)
      .set({ role: "unknown" })
      .where(and(eq(schema.member.organizationId, c.tenant), eq(schema.member.userId, c.actor)));
    await expect(commands.validate(ctx(), "invalid", {})).rejects.toMatchObject({ status: 403 });
    const evidence = JSON.stringify(await audits());
    expect(evidence).not.toContain("foreign-private");
    expect(evidence).not.toContain("private descriptor");
    expect(evidence).not.toContain("private storage");
  });

  it("rejects a null command target before loading unavailable dependencies", async () => {
    const commands = await http({
      loadBuild: async () => {
        throw new Error("Unavailable descriptor");
      },
      requirePackageStore: () => storage.store,
    });
    await expect(commands.validate(ctx(), null, { expectedRevision: 1 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("records sanitized gate refusals and rejects unbranded builds while Validate remains independent of storage", async () => {
    const request = await create(),
      context = ctx();
    const refusing = await http({
      loadBuild: async () => {
        throw new Error("private path /credentials");
      },
      requirePackageStore: () => storage.store,
    });
    await expect(
      refusing.validate(context, request.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_request_build_unavailable" } });
    expect((await audits()).filter((row) => row.requestId === context.httpRequestId)).toEqual([
      audit(context.httpRequestId, "validated", request.id, "rejected", null, {
        code: "us_request_build_unavailable",
      }),
    ]);
    const unbranded = await http({
      loadBuild: async () => ({ ...loaded }),
      requirePackageStore: () => storage.store,
    });
    await expect(
      unbranded.validate(ctx(), request.id, { expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 503 });
    const noStorage = await http({
      loadBuild: async () => loaded,
      requirePackageStore: () => {
        throw new Error("private credentials");
      },
    });
    const valid = await noStorage.validate(ctx(), request.id, { expectedRevision: 1 });
    expect(valid.requestId).toBe(request.id);
    const blocked = ctx();
    await expect(
      noStorage.prepare(blocked, request.id, {
        expectedRevision: 1,
        validationDigest: valid.digest,
        mode: "available_records_incomplete",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: "us_request_package_storage_unavailable" },
    });
    expect((await audits()).filter((row) => row.requestId === blocked.httpRequestId)).toEqual([
      audit(blocked.httpRequestId, "prepared", request.id, "rejected", null, {
        code: "us_request_package_storage_unavailable",
      }),
    ]);
    expect(await runs()).toEqual([]);
  });

  it("rechecks write authority after a successful preflight and gates", async () => {
    const { request, body } = await prepared(),
      context = ctx();
    const commands = await http({
      loadBuild: async () => {
        await f.db
          .update(schema.member)
          .set({ role: "unknown" })
          .where(
            and(eq(schema.member.organizationId, c.tenant), eq(schema.member.userId, c.actor)),
          );
        return loaded;
      },
      requirePackageStore: () => storage.store,
    });
    await expect(commands.prepare(context, request.id, body)).rejects.toMatchObject({
      status: 403,
    });
    expect(await runs()).toEqual([]);
    expect((await audits()).filter((row) => row.requestId === context.httpRequestId)).toEqual([
      audit(context.httpRequestId, "prepared", request.id, "rejected", null, {
        code: "insufficient_permission",
        mode: body.mode,
      }),
    ]);
  });

  it("rolls back validation, run and CRUD mutations when their atomic success audit fails", async () => {
    const { request, body, checked } = await prepared();
    await savedWarning(request.id, checked);
    const before = await read(request.id),
      prior = await audits();
    await f.pool.query(
      "CREATE FUNCTION reject_http_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id IS NOT NULL AND NEW.outcome='success' THEN RAISE EXCEPTION 'synthetic private audit failure'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_http_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_http_audit()",
    );
    const commands = await http();
    await expect(commands.create(ctx(), createBody())).rejects.toThrow();
    await expect(
      commands.update(ctx(), request.id, {
        expectedRevision: 1,
        requesterName: "Audit must roll back",
      }),
    ).rejects.toThrow();
    await expect(commands.close(ctx(), request.id, { expectedRevision: 1 })).rejects.toThrow();
    await expect(commands.validate(ctx(), request.id, { expectedRevision: 1 })).rejects.toThrow();
    await expect(
      commands.acknowledgeWarnings(ctx(), request.id, {
        expectedRevision: 1,
        digest: body.validationDigest,
        reason: "Reviewed synthetic warning",
      }),
    ).rejects.toThrow();
    await expect(commands.prepare(ctx(), request.id, body)).rejects.toThrow();
    expect(await read(request.id)).toEqual(before);
    expect(await runs()).toEqual([]);
    expect(await audits()).toEqual(prior);
  });

  it("preserves null correlation and legacy validation without HTTP guards", async () => {
    const request = await create();
    await requests.update(c.tenant, c.actor, request.id, {
      expectedRevision: 1,
      requesterName: "Legacy current requester",
    });
    const checked = await validation.validate(c.tenant, c.actor, request.id, build());
    expect(checked.revision).toBe(2);
    await savedWarning(request.id, checked);
    await validation.acknowledgeWarnings(
      c.tenant,
      c.actor,
      request.id,
      checked.digest,
      "Reviewed synthetic warning",
    );
    const body = { mode: "available_records_incomplete" as const, idempotencyKey: randomUUID() };
    const run = await prepare.prepare(c.tenant, c.actor, request.id, body, build());
    expect(await prepare.prepare(c.tenant, c.actor, request.id, body, build())).toEqual(run);
    expect((await audits()).every((row) => row.requestId === null)).toBe(true);
  });

  it("preserves retry receipt replay after processing with correlated audit and current initiator authority before storage", async () => {
    const { request, body } = await prepared();
    const run = await prepare.prepareHttp(
      c.tenant,
      c.actor,
      request.id,
      body,
      build(),
      ctx().httpRequestId,
    );
    const lifecycle = new UsRequestWorkerLifecycle(f.db);
    const lease = await lifecycle.claimNext();
    if (!lease) throw new Error("Expected owned lease");
    await lifecycle.finishFailure(lease, { code: "insufficient_permission", retryable: false });
    const state = await lifecycle.read({ tenantId: c.tenant, runId: run.id });
    const retryBody = {
      expectedLifecycleVersion: state.run.lifecycleVersion,
      reason: "Reviewed synthetic failure",
      idempotencyKey: randomUUID(),
    };
    const commands = await http({
        loadBuild: async () => {
          throw new Error("Unavailable descriptor");
        },
        requirePackageStore: () => storage.store,
      }),
      context = ctx();
    const receipt = await commands.retry(context, run.id, retryBody);
    expect(Object.keys(receipt).sort()).toEqual([
      "cycle",
      "httpRequestId",
      "idempotencyKey",
      "lifecycleVersion",
      "requestedBy",
      "runId",
    ]);
    const claimed = await lifecycle.claimNext();
    if (!claimed) throw new Error("Expected second claim");
    const replay = ctx();
    expect(await commands.retry(replay, run.id, retryBody)).toEqual({
      ...receipt,
      httpRequestId: replay.httpRequestId,
    });
    const rows = (await audits()).filter(
      (row) => row.requestId === context.httpRequestId || row.requestId === replay.httpRequestId,
    );
    expect(rows.map((row) => row.action).sort()).toEqual([
      "traceability.request.worker.retried",
      "traceability.request.worker.retry_replayed",
    ]);
    const metadata = {
      actorKind: "user",
      initiatorId: c.actor,
      requestId: request.id,
      runId: run.id,
      runRevision: 1,
      mode: body.mode,
      attemptId: null,
      cycle: 2,
      commandDigest: run.commandDigest,
      scopedContentDigest: run.scopedContentDigest,
      inputDigest: run.inputDigest,
      requestedBy: c.actor,
      reason: retryBody.reason,
      idempotencyKey: retryBody.idempotencyKey,
      expectedLifecycleVersion: state.run.lifecycleVersion,
    };
    expect(rows.find((row) => row.requestId === context.httpRequestId)).toEqual(
      audit(
        context.httpRequestId,
        "worker.retried",
        run.id,
        "success",
        null,
        {
          ...metadata,
          attemptNumber: 1,
          cycleAttemptCount: 0,
          lifecycleVersion: receipt.lifecycleVersion,
        },
        "trace_export_run",
      ),
    );
    expect(rows.find((row) => row.requestId === replay.httpRequestId)).toEqual(
      audit(
        replay.httpRequestId,
        "worker.retry_replayed",
        run.id,
        "success",
        null,
        {
          ...metadata,
          attemptNumber: 2,
          cycleAttemptCount: 1,
          lifecycleVersion: receipt.lifecycleVersion + 1,
          receiptCycle: 2,
          receiptLifecycleVersion: receipt.lifecycleVersion,
        },
        "trace_export_run",
      ),
    );
    const conflict = ctx();
    await expect(
      commands.retry(conflict, run.id, { ...retryBody, reason: "Divergent synthetic retry" }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "us_request_worker_retry_conflict" },
    });
    expect((await audits()).filter((row) => row.requestId === conflict.httpRequestId)).toEqual([
      audit(
        conflict.httpRequestId,
        "worker.retried",
        run.id,
        "conflict",
        null,
        { code: "us_request_worker_retry_conflict" },
        "trace_export_run",
      ),
    ]);
    const caller = randomUUID();
    await f.db
      .insert(schema.user)
      .values({ id: caller, name: "Synthetic retry caller", email: `${caller}@example.test` });
    await f.db.insert(schema.member).values({
      id: randomUUID(),
      userId: caller,
      organizationId: c.tenant,
      role: "owner",
      createdAt: new Date(),
    });
    await f.db
      .update(schema.member)
      .set({ role: "unknown" })
      .where(and(eq(schema.member.organizationId, c.tenant), eq(schema.member.userId, c.actor)));
    const unavailable = await http({
      loadBuild: async () => loaded,
      requirePackageStore: () => {
        throw new ServiceUnavailableException({ code: "us_request_package_storage_unavailable" });
      },
    });
    await expect(
      unavailable.retry({ ...ctx(), userId: caller }, run.id, retryBody),
    ).rejects.toMatchObject({ status: 403, response: { code: "insufficient_permission" } });
  });

  it("rolls back retry cycle and receipt if its correlated audit fails", async () => {
    const { request, body } = await prepared();
    const run = await prepare.prepareHttp(
      c.tenant,
      c.actor,
      request.id,
      body,
      build(),
      ctx().httpRequestId,
    );
    const lifecycle = new UsRequestWorkerLifecycle(f.db),
      scope = { tenantId: c.tenant, runId: run.id };
    const lease = await lifecycle.claimNext();
    if (!lease) throw new Error("Missing owned claim");
    await lifecycle.finishFailure(lease, { code: "insufficient_permission", retryable: false });
    const prior = await lifecycle.read(scope),
      previous = await audits();
    await f.pool.query(
      "CREATE FUNCTION reject_retry_http_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id IS NOT NULL THEN RAISE EXCEPTION 'private synthetic audit failure'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_retry_http_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_retry_http_audit()",
    );
    const commands = await http();
    await expect(
      commands.retry(ctx(), run.id, {
        expectedLifecycleVersion: prior.run.lifecycleVersion,
        reason: "Reviewed synthetic failure",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: "us_request_worker_unknown_failure" },
    });
    expect(await lifecycle.read(scope)).toEqual(prior);
    expect(await f.db.select().from(schema.traceExportRetryReceipts)).toEqual([]);
    expect(await audits()).toEqual(previous);
  });
});
