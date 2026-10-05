import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import * as domain from "@markiro/domain";
import {
  buildUsPlanSnapshot,
  buildUsPlanDraftFactSources,
  buildUsPlanApprovedEvidence,
  canonicalExportDigest,
  type UsPlanSections,
} from "@markiro/domain";
import { usExportInputV1Schema, type UsTraceRequestScopeV1 } from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { captureUsRequestTenantOrigin } from "../src/modules/traceability/requests/us-request-tenant-origin";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import * as snapshots from "../src/modules/traceability/requests/us-request-snapshot";
import * as sourceReader from "../src/modules/traceability/export/source-reader";
import { transformationTransaction } from "../src/modules/traceability/transformation/us-transformation-operations";
import { readUsPlanConfiguration } from "../src/modules/traceability/plans/us-plan-configuration";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import {
  createStoredAmendment,
  finalizeStoredAmendment,
  voidStoredEvent,
} from "./support/us-receiving-lifecycle-storage";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const build = { apiVersion: "test-us09", gitSha: "a".repeat(40), dirty: false } as const;
const incomplete = () =>
  ({ mode: "available_records_incomplete", idempotencyKey: randomUUID() }) as const;
const ready = () => ({ mode: "export_ready", idempotencyKey: randomUUID() }) as const;

describe.skipIf(!url)("atomic US request preparation in disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let requests: UsRequestStore;
  let validation: UsRequestValidationStore;
  let prepare: UsRequestPrepareStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
    requests = new UsRequestStore(f.db);
    validation = new UsRequestValidationStore(f.db);
    prepare = new UsRequestPrepareStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    c = await seedCompleteReceiving(f.db);
  });
  const create = (scope: UsTraceRequestScopeV1 = { lotId: c.lot }) =>
    requests.create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic requester",
      requesterOrganization: null,
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope,
    });
  const validate = (id: string) => validation.validate(c.tenant, c.actor, id, build);
  const runRows = () =>
    f.db.select().from(schema.traceExportRuns).where(eq(schema.traceExportRuns.tenantId, c.tenant));
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
  const command = (id: string, body = incomplete()) =>
    prepare.prepare(c.tenant, c.actor, id, body, build);
  const replayAudit = (run: typeof schema.traceExportRuns.$inferSelect) => ({
    id: expect.any(String),
    createdAt: expect.any(Date),
    organizationId: c.tenant,
    actorUserId: c.actor,
    requestId: null,
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
  });
  const envelope = (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("exportInput" in value) ||
      !("validationSnapshot" in value)
    )
      throw new Error("Missing frozen envelope");
    return value;
  };
  const receiving = async (draft = c.draft) => {
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({ packagingStyle: "Case", packagingSizeValue: "10", packagingSizeUom: "lb" })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const store = new UsReceivingStore(f.db);
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "prepare-fixture",
    );
    const checked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    return store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: checked.inputDigest,
      },
      "prepare-fixture-finalize",
    );
  };
  const plan = async (versionNumber = 1) => {
    const sections: UsPlanSections = {
      recordMaintenance: {
        systemOfRecord: "Synthetic register",
        formats: ["PDF"],
        recordLocations: ["QA"],
        responsibleRoles: ["QA"],
        backupAndRecovery: "Synthetic procedure",
        narrative: [],
      },
      ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
      tlcAssignment: { procedure: "Assign" },
      pointOfContact: { name: "Synthetic QA", title: "QA", phone: "+1 555 0100", email: null },
      farmActivity: { status: "no", explanation: "No farming" },
      reviewAndUpdate: { procedure: "Review changes" },
    };
    const facts = await transformationTransaction(f.db, (tx) =>
      readUsPlanConfiguration(tx, c.tenant),
    );
    const snapshot = buildUsPlanSnapshot(facts.facts, sections, "operational");
    const approvedAt = new Date("2026-10-04T00:00:00.000Z");
    const evidence = buildUsPlanApprovedEvidence(
      snapshot,
      buildUsPlanDraftFactSources(facts.facts, sections),
      {
        kind: "operational",
        actorId: c.actor,
        confirmedAt: approvedAt.toISOString(),
        confirmations: {
          procedures: true,
          backupAndRecovery: true,
          contact: true,
          nonFarmScope: true,
        },
      },
    );
    const id = randomUUID();
    const values = {
      id,
      tenantId: c.tenant,
      versionNumber,
      status: "effective",
      changeSummary: "Synthetic revision",
      sections,
      createdBy: c.actor,
      approvedBy: c.actor,
      approvedAt,
      configSnapshot: snapshot,
      configDigest: canonicalExportDigest(snapshot),
      approvedEvidence: evidence,
      idempotencyKeyHash: canonicalExportDigest(id),
      approvalRequestDigest: "c".repeat(64),
      pdfObjectKey: `us/plans/${c.tenant}/${id}/${randomUUID()}.pdf`,
      pdfSha256: "d".repeat(64),
      pdfByteSize: 100,
      rendererVersion: "us-plan-pdf-v2",
    };
    await f.db.transaction(async (tx) => {
      const previous = await tx
        .select()
        .from(schema.traceabilityPlanVersions)
        .where(eq(schema.traceabilityPlanVersions.tenantId, c.tenant));
      await tx
        .insert(schema.traceabilityPlanVersions)
        .values({ id, tenantId: c.tenant, versionNumber, createdBy: c.actor, sections });
      for (const row of previous.filter((row) => row.status === "effective"))
        await tx
          .update(schema.traceabilityPlanVersions)
          .set({
            status: "superseded",
            supersededById: id,
            supersededAt: new Date(),
            retainThrough: "2032-10-04",
          })
          .where(eq(schema.traceabilityPlanVersions.id, row.id));
      await tx
        .update(schema.traceabilityPlanVersions)
        .set(values)
        .where(eq(schema.traceabilityPlanVersions.id, id));
    });
    return id;
  };

  it("freezes exact input, findings and Plan; replays unchanged after amendment, void, supersession and closure", async () => {
    const origin = await receiving();
    const planId = await plan();
    const request = await create();
    const checked = await validate(request.id);
    const body = incomplete();
    const before = await audits();
    const run = await command(request.id, body);
    expect(run).toMatchObject({
      tenantId: c.tenant,
      requestId: request.id,
      revision: 1,
      mode: body.mode,
      status: "queued",
      exportReady: false,
      createdBy: c.actor,
      scopedContentDigest: checked.digest,
      planVersionId: planId,
      planPdfSha256: "d".repeat(64),
      attemptCount: 0,
      completedAt: null,
    });
    const frozen = envelope(run.inputSnapshot);
    const input = usExportInputV1Schema.parse(frozen.exportInput);
    expect(input.events).toEqual([
      {
        eventId: origin.id,
        revision: 1,
        type: "receiving",
        timeZone: "America/Chicago",
        lifecycle: "current_finalized",
        payload: { kind: "frozen", snapshot: origin.snapshot },
      },
    ]);
    expect(input.findings).toEqual(checked.findings);
    expect(input.metadata.generatedAt).toBe(run.startedAt.toISOString());
    expect(run.inputDigest).toBe(canonicalExportDigest(input));
    expect(run.scopedContentDigest).toBe(
      createHash("sha256").update(stableStringify(frozen.validationSnapshot)).digest("hex"),
    );
    const added = (await audits()).filter((a) => !before.some((b) => a.id === b.id));
    expect(added).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        organizationId: c.tenant,
        actorUserId: c.actor,
        requestId: null,
        action: "traceability.request.prepared",
        outcome: "success",
        targetType: "trace_request",
        targetId: request.id,
        before: null,
        after: {
          runId: run.id,
          revision: 1,
          requestRevision: 1,
          mode: body.mode,
          digest: checked.digest,
          inputDigest: run.inputDigest,
        },
      },
    ]);
    expect(JSON.stringify(added)).not.toContain("private@example.test");
    const amendment = await createStoredAmendment(f, c.tenant, origin.id);
    await finalizeStoredAmendment(f, c.tenant, amendment);
    expect(await command(request.id, body)).toEqual(run);
    await expect(command(request.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "us_request_validation_stale" },
    });
    await voidStoredEvent(f, c.tenant, amendment);
    await plan(2);
    await requests.close(c.tenant, c.actor, request.id, { expectedRevision: 1 });
    expect(await command(request.id, body)).toEqual(run);
    expect(await runRows()).toEqual([run]);
    expect(
      (await audits()).filter((row) => row.action === "traceability.request.prepare_replayed"),
    ).toEqual([replayAudit(run), replayAudit(run)]);
    expect(await f.db.select().from(schema.traceExportArtifacts)).toEqual([]);
  });

  it("requires open validated state for new commands and binds replay to mode and request", async () => {
    const request = await create();
    await expect(command(request.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "us_request_validation_required" },
    });
    await validate(request.id);
    const body = incomplete();
    const run = await command(request.id, body);
    await expect(
      prepare.prepare(c.tenant, c.actor, request.id, { ...body, mode: "export_ready" }, build),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_idempotency_conflict" } });
    const other = await create();
    await expect(command(other.id, body)).rejects.toMatchObject({
      status: 409,
      response: { code: "us_request_idempotency_conflict" },
    });
    await requests.close(c.tenant, c.actor, request.id, { expectedRevision: 1 });
    await expect(command(request.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "us_request_closed" },
    });
    expect(await runRows()).toEqual([run]);
  });

  it("serializes actual different-key and same-key races without duplicate run revisions or audits", async () => {
    const request = await create();
    await validate(request.id);
    const different = await Promise.all([command(request.id), command(request.id)]);
    expect(different.map((r) => r.revision).sort()).toEqual([1, 2]);
    const body = incomplete();
    const same = await Promise.all([command(request.id, body), command(request.id, body)]);
    expect(same[0]).toEqual(same[1]);
    expect((await runRows()).map((r) => r.revision).sort()).toEqual([1, 2, 3]);
    expect(
      (await audits()).filter(
        (a) => a.action === "traceability.request.prepared" && a.outcome === "success",
      ),
    ).toHaveLength(3);
    const winner = same[0];
    if (!winner) throw new Error("Missing accepted race winner");
    expect(
      (await audits()).filter((row) => row.action === "traceability.request.prepare_replayed"),
    ).toEqual([replayAudit(winner)]);
  });

  it("fails closed on persisted run corruption without recapture or successful replay audit", async () => {
    await receiving();
    await plan();
    const request = await create();
    await validate(request.id);
    const body = incomplete();
    const run = await command(request.id, body);
    const before = await audits();
    vi.spyOn(snapshots, "captureUsRequestScope").mockRejectedValue(
      new Error("Replay must never recapture live sources"),
    );
    let candidate = structuredClone(run);
    const edit = async (path: string[], value: unknown, rehash = false) => {
      const changed = await f.pool.query<{ snapshot: unknown }>(
        "SELECT jsonb_set($1::jsonb,$2::text[],$3::jsonb) AS snapshot",
        [JSON.stringify(candidate.inputSnapshot), path, JSON.stringify(value)],
      );
      candidate.inputSnapshot = changed.rows[0]?.snapshot;
      if (rehash) {
        const frozen = envelope(candidate.inputSnapshot);
        candidate.scopedContentDigest = canonicalExportDigest(frozen.validationSnapshot);
        candidate.inputDigest =
          frozen.exportInput === null ? null : canonicalExportDigest(frozen.exportInput);
      }
    };
    const corruptions: Array<[string, () => Promise<unknown>]> = [
      ["strict envelope", () => edit(["unexpected"], true)],
      [
        "scoped digest",
        async () => {
          candidate.scopedContentDigest = "0".repeat(64);
        },
      ],
      [
        "input digest",
        async () => {
          candidate.inputDigest = "0".repeat(64);
        },
      ],
      [
        "command digest",
        async () => {
          candidate.commandDigest = "0".repeat(64);
        },
      ],
      [
        "frozen content",
        () => edit(["validationSnapshot", "request", "requesterContact"], "corrupt@example.test"),
      ],
      ["tenant binding", () => edit(["validationSnapshot", "tenantId"], randomUUID(), true)],
      ["request binding", () => edit(["validationSnapshot", "request", "id"], randomUUID(), true)],
      ["mode binding", () => edit(["mode"], "export_ready", true)],
      ["actor binding", () => edit(["preparedBy"], randomUUID(), true)],
      ["Plan identity", () => edit(["validationSnapshot", "plan", "id"], randomUUID(), true)],
      ["Plan hash", () => edit(["validationSnapshot", "plan", "pdfSha256"], "0".repeat(64), true)],
      [
        "registry binding",
        () => edit(["validationSnapshot", "registryHash"], "0".repeat(64), true),
      ],
      ["generation binding", () => edit(["generatedAt"], "2001-01-01T00:00:00.000Z", true)],
      [
        "input time binding",
        () => edit(["exportInput", "metadata", "generatedAt"], "2001-01-01T00:00:00.000Z", true),
      ],
      ["input tenant binding", () => edit(["exportInput", "tenantId"], randomUUID(), true)],
      [
        "input build binding",
        () => edit(["exportInput", "metadata", "build", "gitSha"], "b".repeat(40), true),
      ],
      [
        "input source binding",
        () =>
          edit(
            ["exportInput", "events", "0", "payload", "snapshot", "items", "0", "quantity"],
            "499",
            true,
          ),
      ],
      [
        "empty-selection binding",
        async () => {
          await edit(["exportInput"], null);
          await edit(["selectionKind"], "empty");
          candidate.inputDigest = null;
        },
      ],
      ["byte bound", () => edit(["padding"], "x".repeat(16 * 1024 * 1024 + 1))],
    ];
    for (const [index, [label, corrupt]] of corruptions.entries()) {
      const corruptBody = { ...body, idempotencyKey: randomUUID() };
      candidate = {
        ...structuredClone(run),
        id: randomUUID(),
        revision: index + 2,
        idempotencyKey: corruptBody.idempotencyKey,
      };
      await corrupt();
      await f.db.insert(schema.traceExportRuns).values(candidate);
      const rowsBeforeReplay = await runRows();
      await expect(command(request.id, corruptBody), label).rejects.toMatchObject({
        status: 503,
        response: { code: "us_request_run_stored_invalid" },
      });
      expect(await audits(), label).toEqual(before);
      expect(await runRows(), label).toEqual(rowsBeforeReplay);
    }
    await expect(
      f.pool.query("UPDATE trace_export_runs SET input_snapshot='{}'::jsonb WHERE id=$1", [run.id]),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await runRows()).find((row) => row.id === run.id)).toEqual(run);
    // Worker-owned status/timing can advance while the immutable envelope stays valid.
    await f.db
      .update(schema.traceExportRuns)
      .set({
        status: "failed",
        failureCode: "synthetic_worker_failure",
        completedAt: new Date(),
        attemptCount: 2,
      })
      .where(eq(schema.traceExportRuns.id, run.id));
    const replay = await command(request.id, body);
    expect(replay).toMatchObject({
      id: run.id,
      status: "failed",
      inputSnapshot: run.inputSnapshot,
      inputDigest: run.inputDigest,
    });
    expect(
      (await audits()).filter((row) => row.action === "traceability.request.prepare_replayed"),
    ).toEqual([replayAudit(run)]);
  }, 30_000);

  it.each(["tenant whitespace", "uppercase UUID", "normalized quantity"] as const)(
    "rejects persisted normalization-only mutation: %s",
    async (mutation) => {
      await new UsReceivingStore(f.db).createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: c.draft },
        "normalization-fixture",
      );
      const request = await create();
      await validate(request.id);
      const body = incomplete();
      const run = await command(request.id, body);
      const frozen = envelope(run.inputSnapshot);
      const input = usExportInputV1Schema.parse(frozen.exportInput);
      const source = input.events[0];
      if (source?.type !== "receiving" || source.payload.kind !== "saved_draft")
        throw new Error("Missing saved receiving draft");
      expect(source.payload.draft.items.map((item) => item.quantity)).toEqual(["500.000", "0.250"]);
      // JSONB may reorder object keys; replay must preserve saved arrays, not
      // reject an equivalent object solely because its key insertion order changed.
      const reordered = Object.fromEntries(Object.entries(frozen).reverse());
      await f.db
        .update(schema.traceExportRuns)
        .set({ inputSnapshot: reordered })
        .where(eq(schema.traceExportRuns.id, run.id));
      expect(await command(request.id, body)).toEqual(run);
      const before = await audits();
      const [path, value] =
        mutation === "tenant whitespace"
          ? [["validationSnapshot", "tenantId"], ` ${c.tenant} `]
          : mutation === "uppercase UUID"
            ? [["validationSnapshot", "request", "id"], request.id.toUpperCase()]
            : [
                ["exportInput", "events", "0", "payload", "draft", "items", "0", "quantity"],
                " 500.000 ",
              ];
      // Leave both digests untouched: the old parser silently repaired these
      // changes before hashing, then returned the altered raw persisted bytes.
      const corruptBody = { ...body, idempotencyKey: randomUUID() };
      const changedSnapshot = await f.pool.query<{ snapshot: unknown }>(
        "SELECT jsonb_set($1::jsonb,$2::text[],$3::jsonb) AS snapshot",
        [JSON.stringify(run.inputSnapshot), path, JSON.stringify(value)],
      );
      const corruptId = randomUUID();
      await f.db.insert(schema.traceExportRuns).values({
        ...run,
        id: corruptId,
        revision: run.revision + 1,
        idempotencyKey: corruptBody.idempotencyKey,
        inputSnapshot: changedSnapshot.rows[0]?.snapshot,
      });
      const changed = await runRows();
      expect(changed.find((row) => row.id === corruptId)?.inputSnapshot).not.toEqual(
        run.inputSnapshot,
      );
      await expect(command(request.id, corruptBody)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_request_run_stored_invalid" },
      });
      expect(await audits()).toEqual(before);
      expect(await runRows()).toEqual(changed);
    },
  );

  it("rolls back a failed replay audit while preserving the original run", async () => {
    const request = await create();
    await validate(request.id);
    const body = incomplete();
    const run = await command(request.id, body),
      before = await audits();
    await f.pool.query(
      "CREATE FUNCTION reject_prepare_replay_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.request.prepare_replayed' THEN RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_prepare_replay_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_prepare_replay_audit()",
    );
    try {
      await expect(command(request.id, body)).rejects.toMatchObject({ status: 503 });
      expect(await runRows()).toEqual([run]);
      expect(await audits()).toEqual(before);
    } finally {
      await f.pool.query("DROP TRIGGER reject_prepare_replay_audit ON tenant_audit_events");
      await f.pool.query("DROP FUNCTION reject_prepare_replay_audit()");
    }
  });

  it("arbitrates tenant-actor keys racing across distinct request locks", async () => {
    const first = await create(),
      second = await create();
    await validate(first.id);
    await validate(second.id);
    // Both repeatable-read snapshots reach the insert with no visible winner.
    const capture = snapshots.captureUsRequestScope;
    let arrivals = 0;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(snapshots, "captureUsRequestScope").mockImplementation(async (...args) => {
      const captured = await capture(...args);
      if (++arrivals === 2) release();
      await barrier;
      return captured;
    });
    const body = incomplete();
    const results = await Promise.allSettled([command(first.id, body), command(second.id, body)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409, response: { code: "us_request_idempotency_conflict" } },
    });
    expect(await runRows()).toHaveLength(1);
  });

  it("freezes explicit empty incomplete selection without fabricated workbook input", async () => {
    const request = await create({ lotId: randomUUID() });
    const checked = await validate(request.id);
    const run = await command(request.id);
    expect(run.inputSnapshot).toMatchObject({
      selectionKind: "empty",
      exportInput: null,
      validationSnapshot: { findings: checked.findings, sources: [], plan: null },
    });
    expect(run.inputDigest).toBeNull();
    await expect(
      prepare.prepare(c.tenant, c.actor, request.id, ready(), build),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_not_export_ready" } });
  });

  it("permits a healthy amended current root while retaining historical findings only in validation", async () => {
    const origin = await receiving();
    const amendment = await createStoredAmendment(f, c.tenant, origin.id);
    await finalizeStoredAmendment(f, c.tenant, amendment);
    await plan();
    const request = await create();
    const checked = await validate(request.id);
    expect(checked.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_RECORD_NOT_CURRENT_FINALIZED",
          eventId: origin.id,
        }),
      ]),
    );
    const readyBody = ready();
    const run = await prepare.prepare(c.tenant, c.actor, request.id, readyBody, build);
    const frozen = envelope(run.inputSnapshot);
    const input = usExportInputV1Schema.parse(frozen.exportInput);
    expect(input.mode).toBe("export_ready_candidate");
    expect(input.events.map((e) => e.eventId)).toEqual([amendment]);
    expect(input.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(frozen.validationSnapshot).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ eventId: origin.id })]),
      findings: checked.findings,
    });
    expect(run.exportReady).toBe(false);
    expect(run.status).toBe("queued");
    expect(
      await prepare.prepare(c.tenant, c.actor, request.id, readyBody, {
        ...build,
        gitSha: "b".repeat(40),
      }),
    ).toEqual(run);
  });

  it("rejects ready without Plan and with a required void origin even when shipping remains finalized", async () => {
    const shipping = await seedShippingLifecycle(f.db);
    c = { ...c, ...shipping, draft: c.draft };
    await finalizeFixtureShipment(shipping, "20");
    const request = await create();
    await validate(request.id);
    await expect(
      prepare.prepare(c.tenant, c.actor, request.id, ready(), build),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_not_export_ready" } });
    await plan();
    const origins = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
    const receipt = origins.find((e) => e.type === "receiving");
    if (!receipt) throw new Error("Missing origin");
    await voidStoredEvent(f, c.tenant, receipt.id);
    await validate(request.id);
    await expect(
      prepare.prepare(c.tenant, c.actor, request.id, ready(), build),
    ).rejects.toMatchObject({ status: 409, response: { code: "us_request_not_export_ready" } });
    expect(await runRows()).toEqual([]);
  });

  it("keeps an extra linked draft as evidence without blocking a healthy current chain", async () => {
    const origin = await receiving();
    const draft = await new UsReceivingStore(f.db).createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: { ...c.draft, dateReceived: "2026-09-08" } },
      "linked-draft",
    );
    await plan();
    const request = await create();
    await validate(request.id);
    const run = await prepare.prepare(c.tenant, c.actor, request.id, ready(), build);
    const frozen = envelope(run.inputSnapshot);
    expect(
      usExportInputV1Schema.parse(frozen.exportInput).events.map((event) => event.eventId),
    ).toEqual([origin.id]);
    expect(frozen.validationSnapshot).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ eventId: draft.id, lifecycle: "draft" }),
      ]),
    });
    const direct = await create({ eventDateFrom: "2026-09-08", eventDateTo: "2026-09-08" });
    await validate(direct.id);
    await expect(
      prepare.prepare(c.tenant, c.actor, direct.id, ready(), build),
    ).rejects.toMatchObject({ response: { code: "us_request_not_export_ready" } });
  });

  it("does not include a current branch reachable only through an excluded draft bridge", async () => {
    const origin = await receiving();
    const first = c.draft.items[0],
      linked = c.draft.items[1];
    if (!first || !linked) throw new Error("Missing receiving fixture lines");
    const other = await receiving({ ...c.draft, items: [{ ...first, tlc: "BRANCH-B" }] });
    const lotB = other.snapshot.items[0]?.lotId;
    if (!lotB) throw new Error("Missing branch lot");
    const bridge = await new UsReceivingStore(f.db).createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: { ...c.draft, items: [linked, { ...linked, lotId: lotB, tlc: "BRANCH-B" }] },
      },
      "draft-bridge",
    );
    await plan();
    const request = await create();
    await validate(request.id);
    const run = await prepare.prepare(c.tenant, c.actor, request.id, ready(), build);
    const frozen = envelope(run.inputSnapshot);
    expect(
      usExportInputV1Schema.parse(frozen.exportInput).events.map((event) => event.eventId),
    ).toEqual([origin.id]);
    expect(frozen.validationSnapshot).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ eventId: other.id }),
        expect.objectContaining({ eventId: bridge.id }),
      ]),
    });
  });

  it("rejects a corrupt current provenance cycle technically in both modes", async () => {
    const graph = await seedFinalizableTransformation(f);
    c = { ...c, ...graph };
    const first = await graph.store.finalize(
      c.tenant,
      c.actor,
      graph.saved.id,
      graph.command,
      "cycle-first",
    );
    const output = first.snapshot.outputs[0];
    if (!output) throw new Error("Missing first output");
    const secondDraft = await graph.store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...graph.saved.draft,
          inputs: [{ kind: "ftl_lot", lotId: output.lotId, quantity: "10", unitOfMeasure: "case" }],
          outputs: [
            { productId: c.product, tlc: "CYCLE-B", quantity: "10", unitOfMeasure: "case" },
          ],
        },
      },
      "cycle-second",
    );
    const secondCheck = await graph.store.checkReadiness(c.tenant, c.actor, secondDraft.id, {
      expectedDraftVersion: 1,
    });
    const second = await graph.store.finalize(
      c.tenant,
      c.actor,
      secondDraft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: secondCheck.inputDigest,
      },
      "cycle-second-final",
    );
    const back = second.snapshot.outputs[0],
      old = first.snapshot.inputs[0];
    if (!back || !old || old.kind !== "ftl_lot") throw new Error("Missing cycle input");
    // Deliberately corrupt matching frozen content, authoritative line and edge
    // together, so ordinary identity/edge parity checks cannot hide the cycle.
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE traceability_events DISABLE TRIGGER USER`);
      await tx.execute(sql`ALTER TABLE transformation_event_inputs DISABLE TRIGGER USER`);
      await tx.execute(sql`ALTER TABLE lot_genealogy_edges DISABLE TRIGGER USER`);
      await tx
        .update(schema.traceabilityEvents)
        .set({
          finalizationSnapshot: {
            ...first.snapshot,
            inputs: [
              {
                ...old,
                lotId: back.lotId,
                tlc: back.tlc,
                product: back.product,
                source: back.source,
              },
              ...first.snapshot.inputs.slice(1),
            ],
          },
        })
        .where(eq(schema.traceabilityEvents.id, first.id));
      await tx
        .update(schema.transformationEventInputs)
        .set({ lotId: back.lotId })
        .where(
          and(
            eq(schema.transformationEventInputs.eventId, first.id),
            eq(schema.transformationEventInputs.lineNo, old.lineNo),
          ),
        );
      await tx
        .update(schema.lotGenealogyEdges)
        .set({ inputLotId: back.lotId })
        .where(
          and(
            eq(schema.lotGenealogyEdges.eventId, first.id),
            eq(schema.lotGenealogyEdges.inputLotId, old.lotId),
          ),
        );
      await tx.execute(sql`ALTER TABLE traceability_events ENABLE TRIGGER USER`);
      await tx.execute(sql`ALTER TABLE transformation_event_inputs ENABLE TRIGGER USER`);
      await tx.execute(sql`ALTER TABLE lot_genealogy_edges ENABLE TRIGGER USER`);
    });
    await plan();
    const request = await create({ lotId: output.lotId });
    await validate(request.id);
    for (const body of [ready(), incomplete()])
      await expect(
        prepare.prepare(c.tenant, c.actor, request.id, body, build),
      ).rejects.toMatchObject({ status: 503, response: { code: "us_request_provenance_invalid" } });
    expect(await runRows()).toEqual([]);
  });

  it("reassesses historical-only workbook failure for the current chain while retaining global current errors", async () => {
    const origin = await receiving();
    const amendment = await createStoredAmendment(f, c.tenant, origin.id);
    await finalizeStoredAmendment(f, c.tenant, amendment);
    await plan();
    const request = await create();
    const evaluate = domain.buildUsExportWorkbook;
    const model = vi.spyOn(domain, "buildUsExportWorkbook").mockImplementation((input) => {
      const result = evaluate(input);
      return input.events.some((event) => event.lifecycle === "historical_finalized")
        ? {
            ...result,
            model: null,
            failure: {
              code: "CELL_LIMIT_EXCEEDED",
              sourceRecord: `receiving:${origin.id}:1`,
              fieldKey: "notes",
            },
          }
        : result;
    });
    const checked = await validate(request.id);
    expect(checked.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "workbook_unrepresentable" })]),
    );
    const incompleteRun = await command(request.id);
    expect(incompleteRun.inputSnapshot).toMatchObject({
      selectionKind: "events",
      validationSnapshot: {
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "workbook_unrepresentable", severity: "error" }),
        ]),
      },
    });
    expect(incompleteRun.inputDigest).toBe(
      canonicalExportDigest(
        usExportInputV1Schema.parse(envelope(incompleteRun.inputSnapshot).exportInput),
      ),
    );
    expect(incompleteRun.status).toBe("queued");
    expect(incompleteRun.exportReady).toBe(false);
    const run = await prepare.prepare(c.tenant, c.actor, request.id, ready(), build);
    expect(
      usExportInputV1Schema
        .parse(envelope(run.inputSnapshot).exportInput)
        .findings.some((finding) => finding.severity === "error"),
    ).toBe(false);
    model.mockImplementation((input) => {
      const result = evaluate(input);
      return {
        ...result,
        findings: [
          ...result.findings,
          {
            code: "CURRENT_GLOBAL_ERROR",
            severity: "error",
            sourceRecord: "request",
            message: "Synthetic blocking current policy",
          },
        ],
      };
    });
    await validate(request.id);
    await expect(
      prepare.prepare(c.tenant, c.actor, request.id, ready(), build),
    ).rejects.toMatchObject({ response: { code: "us_request_not_export_ready" } });
  });

  it("uses one repeatable-read view across source amendment and Plan supersession committed during capture", async () => {
    const origin = await receiving();
    const oldPlan = await plan();
    const request = await create();
    const checked = await validate(request.id);
    const read = sourceReader.readUsExportSourcesInTransaction;
    vi.spyOn(sourceReader, "readUsExportSourcesInTransaction").mockImplementationOnce(
      async (...args) => {
        const sources = await read(...args);
        const amendment = await createStoredAmendment(f, c.tenant, origin.id);
        await finalizeStoredAmendment(f, c.tenant, amendment);
        await plan(2);
        return sources;
      },
    );
    const run = await command(request.id);
    expect(run.scopedContentDigest).toBe(checked.digest);
    expect(run.planVersionId).toBe(oldPlan);
    expect(
      usExportInputV1Schema
        .parse(envelope(run.inputSnapshot).exportInput)
        .events.map((source) => source.eventId),
    ).toEqual([origin.id]);
    await expect(command(request.id)).rejects.toMatchObject({
      response: { code: "us_request_validation_stale" },
    });
    expect(await runRows()).toEqual([run]);
  });

  it("bounds the final serialized envelope at exactly 16 MiB including run metadata", async () => {
    const request = await create();
    await f.db.update(schema.products).set({ name: "" }).where(eq(schema.products.id, c.product));
    await validate(request.id);
    const base = await command(request.id);
    const remaining = 16 * 1024 * 1024 - Buffer.byteLength(stableStringify(base.inputSnapshot));
    await f.db
      .update(schema.products)
      .set({ name: "x".repeat(remaining) })
      .where(eq(schema.products.id, c.product));
    await validate(request.id);
    const exact = await command(request.id);
    expect(Buffer.byteLength(stableStringify(exact.inputSnapshot))).toBe(16 * 1024 * 1024);
    await f.db
      .update(schema.products)
      .set({ name: "x".repeat(remaining + 1) })
      .where(eq(schema.products.id, c.product));
    await validate(request.id);
    await expect(command(request.id)).rejects.toMatchObject({
      response: { code: "us_request_snapshot_limit" },
    });
    expect((await runRows()).map((run) => run.id).sort()).toEqual([base.id, exact.id].sort());
  }, 30_000);

  it("rolls back the run and success audit together when audit insertion fails through all transaction retries", async () => {
    const request = await create();
    await validate(request.id);
    const before = await audits();
    await f.pool.query(
      "CREATE FUNCTION reject_prepare_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.request.prepared' THEN RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_prepare_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_prepare_audit()",
    );
    try {
      await expect(command(request.id)).rejects.toMatchObject({ status: 503 });
      expect(await runRows()).toEqual([]);
      expect(await audits()).toEqual(before);
    } finally {
      await f.pool.query("DROP TRIGGER reject_prepare_audit ON tenant_audit_events");
      await f.pool.query("DROP FUNCTION reject_prepare_audit()");
    }
  });

  it("rejects fresh-key source and Plan drift, including previously acknowledged warnings", async () => {
    await receiving();
    await plan();
    const request = await create();
    const checked = await validate(request.id);
    await f.db
      .update(schema.traceRequests)
      .set({
        lastValidation: {
          matchedRevisionCount: 1,
          findings: [
            {
              code: "synthetic_warning",
              severity: "warning",
              sourceRecord: `request:${request.id}`,
              message: "Synthetic warning",
            },
          ],
        },
      })
      .where(eq(schema.traceRequests.id, request.id));
    await validation.acknowledgeWarnings(
      c.tenant,
      c.actor,
      request.id,
      checked.digest,
      "Synthetic QA acknowledgement",
    );
    await f.db
      .update(schema.products)
      .set({ name: "Changed product" })
      .where(eq(schema.products.id, c.product));
    const before = await audits();
    await expect(command(request.id)).rejects.toMatchObject({
      response: { code: "us_request_validation_stale" },
    });
    expect(
      (await audits()).filter((row) => !before.some((previous) => row.id === previous.id)),
    ).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        organizationId: c.tenant,
        actorUserId: c.actor,
        requestId: null,
        action: "traceability.request.prepared",
        outcome: "conflict",
        targetType: "trace_request",
        targetId: request.id,
        before: null,
        after: {
          code: "us_request_validation_stale",
          mode: "available_records_incomplete",
          requestRevision: 1,
          digest: checked.digest,
        },
      },
    ]);
    await validate(request.id);
    await plan(2);
    await expect(command(request.id)).rejects.toMatchObject({
      response: { code: "us_request_validation_stale" },
    });
    expect(await runRows()).toEqual([]);
  });

  it("requires digest-bound warning acknowledgement for ready and retains acknowledgement in the immutable run", async () => {
    await receiving();
    await plan();
    const request = await create();
    // US-07 currently has no native warning rule. Add one at the pure evaluation
    // boundary while retaining all actual DB selection, authorization and freeze work.
    const evaluate = domain.buildUsExportWorkbook;
    vi.spyOn(domain, "buildUsExportWorkbook").mockImplementation((input) => {
      const result = evaluate(input);
      return {
        ...result,
        findings: [
          ...result.findings,
          {
            code: "synthetic_warning",
            severity: "warning",
            sourceRecord: `request:${request.id}`,
            message: "Synthetic review warning",
          },
        ],
      };
    });
    const checked = await validate(request.id);
    await expect(
      prepare.prepare(c.tenant, c.actor, request.id, ready(), build),
    ).rejects.toMatchObject({ response: { code: "us_request_warning_ack_required" } });
    const acknowledged = await validation.acknowledgeWarnings(
      c.tenant,
      c.actor,
      request.id,
      checked.digest,
      "Synthetic QA acknowledgement",
    );
    const run = await prepare.prepare(c.tenant, c.actor, request.id, ready(), build);
    expect(run.inputSnapshot).toMatchObject({
      warningAcknowledgement: {
        digest: checked.digest,
        reason: acknowledged.reason,
        actorId: c.actor,
        acknowledgedAt: acknowledged.acknowledgedAt,
      },
    });
    expect(
      usExportInputV1Schema
        .parse(envelope(run.inputSnapshot).exportInput)
        .findings.filter((finding) => finding.code === "synthetic_warning"),
    ).toHaveLength(1);
    expect(run.exportReady).toBe(false);
    expect(
      JSON.stringify(
        (await audits()).filter((row) => row.action === "traceability.request.prepared"),
      ),
    ).not.toContain(acknowledged.reason);
  });

  it("reloads membership before replay and returns 404 for another tenant without leaking request audit context", async () => {
    const request = await create();
    await validate(request.id);
    const body = incomplete();
    await command(request.id, body);
    const foreign = await seedCompleteReceiving(f.db);
    await expect(
      prepare.prepare(foreign.tenant, foreign.actor, request.id, body, build),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, foreign.tenant)),
    ).toEqual([]);
    await f.db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, c.member));
    await expect(command(request.id, body)).rejects.toMatchObject({
      status: 403,
      response: { code: "insufficient_permission" },
    });
    const rejection = (await audits()).filter(
      (a) => a.action === "traceability.request.prepared" && a.outcome === "rejected",
    );
    expect(rejection).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        organizationId: c.tenant,
        actorUserId: c.actor,
        requestId: null,
        action: "traceability.request.prepared",
        outcome: "rejected",
        targetType: "trace_request",
        targetId: request.id,
        before: null,
        after: { code: "insufficient_permission", mode: body.mode },
      },
    ]);
  });

  it("rejects 16 MiB plus one captured byte and rolls back run creation", async () => {
    const request = await create();
    await f.db.update(schema.products).set({ name: "" }).where(eq(schema.products.id, c.product));
    const base = await transformationTransaction(f.db, async (tx) =>
      snapshots.captureUsRequestScope(
        tx,
        c.tenant,
        c.actor,
        request,
        build,
        await captureUsRequestTenantOrigin(f.db, tx, c.tenant),
      ),
    );
    await f.db
      .update(schema.products)
      .set({ name: "x".repeat(16 * 1024 * 1024 - base.byteSize + 1) })
      .where(eq(schema.products.id, c.product));
    await validate(request.id);
    await expect(command(request.id)).rejects.toMatchObject({
      response: { code: "us_request_snapshot_limit" },
    });
    expect(await runRows()).toEqual([]);
  }, 30_000);

  it("never turns reader corruption, Plan corruption or timeout into incomplete success", async () => {
    await receiving();
    const planId = await plan();
    const request = await create();
    await validate(request.id);
    const technical = new Error("synthetic source failure");
    const spy = vi
      .spyOn(sourceReader, "readUsExportSourcesInTransaction")
      .mockRejectedValueOnce(technical);
    await expect(command(request.id)).rejects.toBe(technical);
    spy.mockRestore();
    await f.pool.query("ALTER TABLE traceability_plan_versions DISABLE TRIGGER USER");
    try {
      await f.db
        .update(schema.traceabilityPlanVersions)
        .set({ configSnapshot: { corrupt: true } })
        .where(eq(schema.traceabilityPlanVersions.id, planId));
      await expect(command(request.id)).rejects.toMatchObject({ status: 503 });
    } finally {
      await f.pool.query("ALTER TABLE traceability_plan_versions ENABLE TRIGGER USER");
    }
    vi.spyOn(snapshots, "captureUsRequestScope").mockImplementationOnce(async (tx) => {
      await tx.execute((await import("drizzle-orm")).sql`SET LOCAL statement_timeout='1ms'`);
      await tx.execute((await import("drizzle-orm")).sql`SELECT pg_sleep(0.05)`);
      throw new Error("Expected database cancellation");
    });
    await expect(command(request.id)).rejects.toThrow();
    expect(await runRows()).toEqual([]);
    expect((await audits()).filter((a) => a.action === "traceability.request.prepared")).toEqual(
      [],
    );
  });
});
