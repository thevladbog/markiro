import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetPlanSeedStore } from "../src/modules/traceability/demo/us-dataset-plan-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { createUsRequestPlanFixture } from "./support/us-request-plan-fixture";
import { UsPlanStore } from "../src/modules/traceability/plans/us-plan-store";
import { UsPlanApprovalStore } from "../src/modules/traceability/plans/us-plan-approval";
import { parsePlanInput } from "../src/modules/traceability/demo/us-dataset-plan-contract";
import { usDatasetPlanContent } from "../src/modules/traceability/demo/us-dataset-plan-content";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("owned synthetic dataset Plan on PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: UsDatasetContext;
  let provider: ReturnType<typeof createUsRequestPlanFixture>;
  const store = () => new UsDatasetPlanSeedStore(f.db, provider.artifacts);
  const journal = () => new UsDatasetJournalStore(f.db, usSixMonthDefinition);
  async function stage() {
    const header = await journal().read(context);
    if (!header) throw new Error("Missing owned dataset");
    return journal().readStage(context, header.id, "plan", "plan");
  }
  async function interrupt(at: "prepare" | "publish" | "receipt") {
    await f.pool.query(
      "CREATE FUNCTION reject_plan_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_plan_sql_failure' USING ERRCODE='XX000'; END $$",
    );
    const target =
      at === "publish" ? "traceability_plan_versions" : "traceability_demo_dataset_stages";
    const event =
      at === "prepare" ? "INSERT" : at === "publish" ? "UPDATE OF status" : "UPDATE OF receipt";
    const condition = at === "publish" ? "NEW.status='effective'" : "NEW.unit_key='plan'";
    await f.pool.query(
      `CREATE TRIGGER reject_plan_stage BEFORE ${event} ON ${target} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION reject_plan_stage()`,
    );
    return async () => {
      await f.pool.query(`DROP TRIGGER reject_plan_stage ON ${target}`);
      await f.pool.query("DROP FUNCTION reject_plan_stage()");
    };
  }
  async function pending(at: "publish" | "receipt") {
    const remove = await interrupt(at);
    try {
      await expect(store().initialize(context)).rejects.toMatchObject(
        at === "publish"
          ? { response: { code: "us_plan_approval_failed" }, status: 503 }
          : { cause: { code: "XX000" } },
      );
    } finally {
      await remove();
    }
    const saved = await stage();
    if (!saved || saved.receipt) throw new Error("Missing pending stage");
    return saved;
  }
  async function corrupt(run: () => Promise<unknown>) {
    await f.pool.query("ALTER TABLE traceability_plan_versions DISABLE TRIGGER USER");
    try {
      await run();
    } finally {
      await f.pool.query("ALTER TABLE traceability_plan_versions ENABLE TRIGGER USER");
    }
  }
  async function assertConflict() {
    const before = await f.snapshot();
    const writes = provider.transport.calls.filter(
      ({ command }) => command !== "GetObjectCommand",
    ).length;
    for (const run of [() => store().initialize(context), () => store().verify(context)]) {
      await expect(run()).rejects.toMatchObject({
        message: "us_dataset_plan_conflict",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
    }
    expect(
      provider.transport.calls.filter(({ command }) => command !== "GetObjectCommand"),
    ).toHaveLength(writes);
  }
  const work = new Set<Promise<unknown>>();
  function track<T>(pending: Promise<T>): Promise<T> {
    work.add(pending);
    void pending.then(
      () => work.delete(pending),
      () => work.delete(pending),
    );
    return pending;
  }
  const phase = (run: () => Promise<void>) => () => track(Promise.resolve().then(run));
  async function drain() {
    while (work.size) await Promise.allSettled([...work]);
  }
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    await track(
      createUsDatasetJournalFixture(base).then((value) => {
        f = value;
      }),
    );
    console.info(`Owned Plan dataset database: ${f.databaseName}`);
  }, 60_000);
  beforeEach(async () => {
    if (work.size) throw new Error("plan_dataset_prior_work_live");
    await track(
      (async () => {
        context = await f.provision();
        await new UsDatasetReferenceSeedStore(f.db).initialize(context);
        provider = createUsRequestPlanFixture(f.db, {
          tenant: context.tenantId,
          actor: context.actorUserId,
        });
      })(),
    );
  }, 60_000);
  afterEach(async () => {
    await drain();
    vi.restoreAllMocks();
    provider?.destroy();
  }, 60_000);
  afterAll(async () => {
    await drain();
    if (!f) return;
    try {
      const active = await f.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle'",
      );
      expect(active.rows).toEqual([{ n: 0 }]);
      console.info(`Plan dataset work drained: ${f.databaseName}`);
    } finally {
      await f.close();
    }
  }, 60_000);
  it(
    "publishes one service-owned synthetic Plan and completed stage",
    phase(async () => {
      const result = await new UsDatasetPlanSeedStore(f.db, provider.artifacts).initialize(context);
      const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
      const header = await journal.read(context);
      if (!header) throw new Error("Missing owned dataset");
      const stage = await journal.readStage(context, header.id, "plan", "plan");
      expect(stage?.receipt, "owned Plan stage must complete after initialization").toBeTruthy();
      expect(await f.db.select().from(schema.traceabilityPlanVersions)).toMatchObject([
        { status: "effective", createdBy: context.actorUserId, approvedBy: context.actorUserId },
      ]);
      expect(result).toMatchObject({
        datasetId: header.id,
        state: "plan_verified",
        datasetComplete: false,
        plan: { versionNumber: 1, draftRevision: 1, approvedBy: context.actorUserId },
        artifact: { contentType: "application/pdf", rendererVersion: "us-plan-pdf-v2" },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.plan)).toBe(true);
      expect(Object.isFrozen(result.artifact)).toBe(true);
      expect(stage?.revision).toBe(2);
      expect(stage?.receipt?.recordIds).toEqual([result.plan.id]);
      const bytes = [...provider.objects.values()][0];
      if (!bytes) throw new Error("Missing real PDF");
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.length).toBe(result.artifact.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.artifact.sha256);
      const text = execFileSync("pdftotext", ["-layout", "-", "-"], {
        input: bytes,
        encoding: "utf8",
      }).replace(/\s+/g, " ");
      for (const fragment of [
        "Synthetic",
        "manually",
        "processing",
        "example.test",
        "no growing",
        "Demonstration procedure",
      ])
        expect(text).toContain(fragment);
      const audits = await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, result.plan.id));
      expect(audits).toEqual([
        {
          id: expect.any(String),
          createdAt: expect.any(Date),
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          requestId: stage?.intent.operationKey,
          targetType: "traceability_plan_version",
          targetId: result.plan.id,
          action: "traceability.plan.draft_created",
          outcome: "success",
          before: null,
          after: { versionNumber: 1, draftRevision: 1 },
        },
        {
          id: expect.any(String),
          createdAt: expect.any(Date),
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          requestId: stage?.intent.operationKey,
          targetType: "traceability_plan_version",
          targetId: result.plan.id,
          action: "traceability.plan.approved",
          outcome: "success",
          before: { versionNumber: 1, draftRevision: 1 },
          after: {
            versionNumber: 1,
            draftRevision: 1,
            sha256: result.artifact.sha256,
            objectKey: [...provider.objects.keys()][0],
            configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      ]);
      expect(Date.parse(result.plan.approvedAt)).toBeGreaterThan(
        Date.parse("2026-09-30T00:00:00Z"),
      );
      const before = await f.snapshot();
      const puts = provider.transport.calls.filter(
        ({ command }) => command === "PutObjectCommand",
      ).length;
      expect(await store().initialize(context)).toEqual(result);
      expect(await store().verify(context)).toEqual(result);
      expect(await f.snapshot()).toEqual(before);
      expect(
        provider.transport.calls.filter(({ command }) => command === "PutObjectCommand"),
      ).toHaveLength(puts);
      expect(provider.objects.size).toBe(1);
    }),
  );
  it(
    "refuses absent Plan verification without mutations or provider calls",
    phase(async () => {
      const before = await f.snapshot();
      await expect(store().verify(context)).rejects.toMatchObject({
        message: "us_dataset_plan_incomplete",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
      expect(provider.transport.calls).toEqual([]);
    }),
  );
  it(
    "rolls back draft, audit and pending intent when preparation SQL fails",
    phase(async () => {
      const remove = await interrupt("prepare");
      const before = await f.snapshot();
      try {
        await expect(store().initialize(context)).rejects.toMatchObject({
          cause: { code: "XX000" },
        });
      } finally {
        await remove();
      }
      expect(await f.snapshot()).toEqual(before);
      expect(await stage()).toBeNull();
      expect(provider.objects.size).toBe(0);
      expect(provider.transport.calls).toEqual([]);
    }),
  );
  it.each(["publish", "receipt"] as const)(
    "resumes original owned identity after %s SQL interruption",
    (at) =>
      track(
        (async () => {
          const saved = await pending(at);
          const input = parsePlanInput(saved.intent.input);
          const [row] = await f.db.select().from(schema.traceabilityPlanVersions);
          expect(row?.status).toBe(at === "publish" ? "draft" : "effective");
          const before = await f.snapshot();
          const calls = provider.transport.calls.length;
          await expect(store().verify(context)).rejects.toMatchObject({
            message: "us_dataset_plan_incomplete",
            unitKey: "plan",
            stage: "plan",
          });
          expect(await f.snapshot()).toEqual(before);
          expect(provider.transport.calls).toHaveLength(calls);
          const bytes =
            at === "receipt" ? Buffer.from([...provider.objects.values()][0] ?? []) : null;
          const result = await store().initialize(context);
          expect(result.plan).toMatchObject(input.draft);
          expect((await stage())?.intent).toEqual(saved.intent);
          if (at === "receipt") {
            expect(result.plan.approvedAt).toBe(row?.approvedAt?.toISOString());
            expect([...provider.objects.values()]).toEqual([bytes]);
            expect(
              provider.transport.calls
                .slice(calls)
                .every(({ command }) => command === "GetObjectCommand"),
            ).toBe(true);
          }
          expect(await f.db.select().from(schema.traceabilityPlanVersions)).toHaveLength(1);
          expect((await stage())?.revision).toBe(2);
        })(),
      ),
  );
  it(
    "rejects an unowned draft instead of adopting matching content",
    phase(async () => {
      await new UsPlanStore(f.db).createDraft(
        context.tenantId,
        context.actorUserId,
        usDatasetPlanContent,
        "unowned",
      );
      const before = await f.snapshot();
      await expect(store().initialize(context)).rejects.toMatchObject({
        message: "us_dataset_plan_conflict",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
      expect(await stage()).toBeNull();
      expect(provider.transport.calls).toEqual([]);
    }),
  );
  it.each([
    "sections",
    "revision",
    "creator",
    "key",
    "request",
    "approver",
    "evidence",
    "artifact",
    "sha",
    "size",
    "renderer",
  ] as const)("rejects completed %s drift with no writes", (kind) =>
    track(
      (async () => {
        await store().initialize(context);
        const [row] = await f.db.select().from(schema.traceabilityPlanVersions);
        if (!row) throw new Error("Missing owned Plan");
        await corrupt(async () => {
          if (kind === "sections")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ changeSummary: "Different synthetic content" })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "revision")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ draftRevision: 2 })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "key")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ idempotencyKeyHash: "a".repeat(64) })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "request")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ approvalRequestDigest: "b".repeat(64) })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "sha")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ pdfSha256: "c".repeat(64) })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "size")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ pdfByteSize: (row.pdfByteSize ?? 0) + 1 })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "renderer")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ rendererVersion: "us-plan-pdf-v1" })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "creator" || kind === "approver") {
            const id = randomUUID();
            await f.db
              .insert(schema.user)
              .values({ id, name: "Synthetic other QA", email: `${id}@example.test` });
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set(kind === "creator" ? { createdBy: id } : { approvedBy: id })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          }
          if (kind === "evidence")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ approvedEvidence: { changed: true } })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          if (kind === "artifact") {
            const original = row.pdfObjectKey;
            if (!original) throw new Error("Missing artifact");
            const replacement = `us/plans/${context.tenantId}/${row.id}/${randomUUID()}.pdf`;
            provider.objects.set(replacement, Buffer.from(provider.objects.get(original) ?? []));
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ pdfObjectKey: replacement })
              .where(eq(schema.traceabilityPlanVersions.id, row.id));
          }
        });
        await assertConflict();
      })(),
    ),
  );
  it(
    "rejects coherently replaced synthetic confirmation seed during pending publication recovery",
    phase(async () => {
      await pending("receipt");
      const [row] = await f.db.select().from(schema.traceabilityPlanVersions);
      if (!row) throw new Error("Missing Plan");
      // Replace only the trustedSeed identities, preserving configured tenant-owned location IDs.
      const original = row.approvedEvidence;
      if (
        !original ||
        typeof original !== "object" ||
        !("confirmations" in original) ||
        !("factSources" in original)
      )
        throw new Error("Missing evidence");
      function replace(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              key === "seedId" ? "synthetic-other-seed" : replace(child),
            ]),
          );
        return value;
      }
      await corrupt(() =>
        f.db
          .update(schema.traceabilityPlanVersions)
          .set({ approvedEvidence: replace(original) })
          .where(eq(schema.traceabilityPlanVersions.id, row.id)),
      );
      const before = await f.snapshot();
      await expect(store().initialize(context)).rejects.toMatchObject({
        message: "us_dataset_plan_conflict",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
      expect((await stage())?.receipt).toBeNull();
    }),
  );
  it(
    "keeps provider I/O outside dataset advisory and organization locks",
    phase(async () => {
      const original = provider.transport.send.bind(provider.transport);
      const spy = vi
        .spyOn(provider.transport, "send")
        .mockImplementation(async (command, options) => {
          const client = await f.pool.connect();
          try {
            await client.query("BEGIN");
            const lock = await client.query<{ available: boolean }>(
              "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS available",
              [context.tenantId + ":us-processor-demo-v1"],
            );
            expect(lock.rows).toEqual([{ available: true }]);
            await client.query("SELECT id FROM organization WHERE id=$1 FOR UPDATE NOWAIT", [
              context.tenantId,
            ]);
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
          return original(command, options);
        });
      await store().initialize(context);
      await store().verify(context);
      expect(spy.mock.calls.length).toBeGreaterThan(2);
    }),
  );
  it(
    "rejects pending configured-facts drift before approving or calling provider",
    phase(async () => {
      await pending("publish");
      await f.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
      try {
        await f.db
          .update(schema.traceabilityProfiles)
          .set({ retentionYears: 6 })
          .where(eq(schema.traceabilityProfiles.tenantId, context.tenantId));
      } finally {
        await f.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
      }
      const before = await f.snapshot();
      const calls = provider.transport.calls.length;
      await expect(store().initialize(context)).rejects.toMatchObject({
        message: "us_dataset_plan_conflict",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
      expect(provider.transport.calls).toHaveLength(calls);
      expect((await stage())?.receipt).toBeNull();
    }),
  );
  it(
    "rejects changed owned reference facts before provider access",
    phase(async () => {
      await store().initialize(context);
      const [party] = await f.db.select().from(schema.traceabilityParties).limit(1);
      if (!party) throw new Error("Missing owned reference");
      await f.db
        .update(schema.traceabilityParties)
        .set({ name: "Changed synthetic party" })
        .where(eq(schema.traceabilityParties.id, party.id));
      const before = await f.snapshot();
      const calls = provider.transport.calls.length;
      await expect(store().verify(context)).rejects.toMatchObject({
        message: "us_dataset_reference_mismatch",
        unitKey: "references",
        stage: "references",
      });
      expect(await f.snapshot()).toEqual(before);
      expect(provider.transport.calls).toHaveLength(calls);
    }),
  );
  it(
    "propagates upload failure while retaining one resumable service draft",
    phase(async () => {
      const original = provider.transport.send.bind(provider.transport);
      const spy = vi
        .spyOn(provider.transport, "send")
        .mockImplementation(async (command, options) => {
          if (command.constructor.name === "PutObjectCommand")
            throw new Error("Synthetic upload unavailable");
          return original(command, options);
        });
      await expect(store().initialize(context)).rejects.toMatchObject({
        response: { code: "us_plan_approval_failed" },
        status: 503,
      });
      const saved = await stage();
      if (!saved || saved.receipt) throw new Error("Missing original pending draft");
      const input = parsePlanInput(saved.intent.input);
      expect(provider.objects.size).toBe(0);
      spy.mockRestore();
      const result = await store().initialize(context);
      expect(result.plan).toMatchObject(input.draft);
      expect((await stage())?.intent).toEqual(saved.intent);
      expect(await f.db.select().from(schema.traceabilityPlanVersions)).toHaveLength(1);
    }),
  );
  it(
    "rechecks lifecycle after verified provider bytes and refuses a superseded pending receipt",
    phase(async () => {
      await pending("receipt");
      const original = provider.artifacts.readVerified.bind(provider.artifacts);
      const spy = vi
        .spyOn(provider.artifacts, "readVerified")
        .mockImplementation(async (scope, artifact) => {
          const bytes = await original(scope, artifact);
          spy.mockRestore();
          const draft = await new UsPlanStore(f.db).createDraft(
            context.tenantId,
            context.actorUserId,
            usDatasetPlanContent,
            "later-publication",
          );
          await new UsPlanApprovalStore(f.db, provider.artifacts).approve(
            context.tenantId,
            context.actorUserId,
            {
              versionId: draft.id,
              expectedRevision: 1,
              idempotencyKey: randomUUID(),
              confirmations: {
                procedures: true,
                backupAndRecovery: true,
                contact: true,
                nonFarmScope: true,
              },
            },
            "later-approval",
          );
          return bytes;
        });
      await expect(store().initialize(context)).rejects.toMatchObject({
        message: "us_dataset_plan_conflict",
        unitKey: "plan",
        stage: "plan",
      });
      expect((await stage())?.receipt).toBeNull();
    }),
  );
  it(
    "rejects a matching Plan published with a different key during pending recovery",
    phase(async () => {
      const saved = await pending("publish");
      const input = parsePlanInput(saved.intent.input);
      await new UsPlanApprovalStore(f.db, provider.artifacts).approve(
        context.tenantId,
        context.actorUserId,
        { ...input.approval, idempotencyKey: randomUUID() },
        "different-key",
      );
      const before = await f.snapshot();
      const calls = provider.transport.calls.length;
      await expect(store().initialize(context)).rejects.toMatchObject({
        message: "us_dataset_plan_conflict",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
      expect(provider.transport.calls).toHaveLength(calls);
      expect((await stage())?.receipt).toBeNull();
    }),
  );
  it(
    "refuses initialization before completed owned references",
    phase(async () => {
      context = await f.provision();
      await journal().initialize(context);
      const before = await f.snapshot();
      await expect(store().initialize(context)).rejects.toMatchObject({
        message: "us_dataset_plan_incomplete",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
      expect(await stage()).toBeNull();
      expect(provider.transport.calls).toEqual([]);
    }),
  );
  it.each(["content", "revision", "approval_key"] as const)(
    "refuses pending draft %s drift",
    (kind) =>
      track(
        (async () => {
          const saved = await pending("publish");
          const input = parsePlanInput(saved.intent.input);
          if (kind === "content")
            await new UsPlanStore(f.db).saveDraft(
              context.tenantId,
              context.actorUserId,
              input.draft.id,
              {
                expectedRevision: 1,
                sections: usDatasetPlanContent.sections,
                changeSummary: "Changed synthetic summary",
              },
              "drift",
            );
          if (kind === "revision")
            await f.db
              .update(schema.traceabilityPlanVersions)
              .set({ draftRevision: 2 })
              .where(eq(schema.traceabilityPlanVersions.id, input.draft.id));
          if (kind === "approval_key") {
            const changed = {
              ...input,
              approval: { ...input.approval, idempotencyKey: randomUUID() },
            };
            await f.db
              .update(schema.traceabilityDemoDatasetStages)
              .set({ input: changed, inputDigest: canonicalExportDigest(changed) })
              .where(
                eq(schema.traceabilityDemoDatasetStages.operationKey, saved.intent.operationKey),
              );
          }
          const before = await f.snapshot();
          await expect(store().initialize(context)).rejects.toMatchObject({
            message: "us_dataset_plan_conflict",
            unitKey: "plan",
            stage: "plan",
          });
          expect(await f.snapshot()).toEqual(before);
          expect((await stage())?.receipt).toBeNull();
        })(),
      ),
  );
  it.each(["unavailable", "type", "length", "body", "oversize"] as const)(
    "propagates %s provider read faults without writes",
    (fault) =>
      track(
        (async () => {
          await store().initialize(context);
          provider.transport.fault = fault;
          const before = await f.snapshot();
          await expect(store().verify(context)).rejects.toThrow("us_plan_artifact_read_failed");
          expect(await f.snapshot()).toEqual(before);
        })(),
      ),
  );
  it(
    "rejects changed immutable bytes",
    phase(async () => {
      await store().initialize(context);
      const path = [...provider.objects.keys()][0];
      if (!path) throw new Error("Missing bytes");
      const bytes = Buffer.from(provider.objects.get(path) ?? []);
      bytes[0] = 0;
      provider.objects.set(path, bytes);
      const before = await f.snapshot();
      await expect(store().verify(context)).rejects.toThrow("us_plan_artifact_read_failed");
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it.each(["tenant", "owner", "read_only", "database", "role"] as const)(
    "denies %s context before provider or writes",
    (kind) =>
      track(
        (async () => {
          await store().initialize(context);
          let denied = context;
          let service = store();
          if (kind === "tenant") denied = { ...context, tenantId: randomUUID() };
          if (kind === "owner") denied = { ...context, actorUserId: randomUUID() };
          if (kind === "database") denied = { ...context, expectedDatabaseName: "markiro_us_dev" };
          if (kind === "read_only")
            await f.db
              .update(schema.member)
              .set({ role: "traceability_auditor" })
              .where(eq(schema.member.organizationId, context.tenantId));
          if (kind === "role")
            service = new UsDatasetPlanSeedStore(await f.alternateRole(), provider.artifacts);
          const before = await f.snapshot();
          const calls = provider.transport.calls.length;
          for (const run of [() => service.initialize(denied), () => service.verify(denied)])
            await expect(run()).rejects.toThrow("us_dataset_target_invalid");
          expect(await f.snapshot()).toEqual(before);
          expect(provider.transport.calls).toHaveLength(calls);
        })(),
      ),
  );
  it(
    "rejects same-key publication by a different QA actor on pending recovery",
    phase(async () => {
      const saved = await pending("publish");
      const input = parsePlanInput(saved.intent.input);
      const actor = randomUUID();
      await f.db
        .insert(schema.user)
        .values({ id: actor, name: "Synthetic substitute QA", email: `${actor}@example.test` });
      await f.db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: context.tenantId,
        userId: actor,
        role: "owner",
        createdAt: new Date(),
      });
      await new UsPlanApprovalStore(f.db, provider.artifacts).approve(
        context.tenantId,
        actor,
        input.approval,
        "other-actor",
      );
      const before = await f.snapshot();
      await expect(store().initialize(context)).rejects.toMatchObject({
        message: "us_dataset_plan_conflict",
        unitKey: "plan",
        stage: "plan",
      });
      expect(await f.snapshot()).toEqual(before);
      expect((await stage())?.receipt).toBeNull();
    }),
  );
  it(
    "rejects supersession even though native original-key retry masks lifecycle",
    phase(async () => {
      const result = await store().initialize(context);
      const saved = await stage();
      if (!saved) throw new Error("Missing stage");
      const draft = await new UsPlanStore(f.db).createDraft(
        context.tenantId,
        context.actorUserId,
        usDatasetPlanContent,
        "next-draft",
      );
      await new UsPlanApprovalStore(f.db, provider.artifacts).approve(
        context.tenantId,
        context.actorUserId,
        {
          versionId: draft.id,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          confirmations: {
            procedures: true,
            backupAndRecovery: true,
            contact: true,
            nonFarmScope: true,
          },
        },
        "supersede",
      );
      const retry = await new UsPlanApprovalStore(f.db, provider.artifacts).approve(
        context.tenantId,
        context.actorUserId,
        parsePlanInput(saved.intent.input).approval,
        "masked-retry",
      );
      expect(retry).toMatchObject({ id: result.plan.id, status: "effective", supersededAt: null });
      await assertConflict();
    }),
  );
});
