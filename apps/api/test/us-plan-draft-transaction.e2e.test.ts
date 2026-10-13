import { randomUUID } from "node:crypto";
import { setTimeout as pollInterval } from "node:timers/promises";
import { schema } from "@markiro/db";
import type { UsPlanSections } from "@markiro/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsPlanStore } from "../src/modules/traceability/plans/us-plan-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { barrier } from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "",
    formats: [],
    recordLocations: [],
    responsibleRoles: [],
    backupAndRecovery: "",
    narrative: ["Private synthetic Plan text"],
  },
  ftlIdentification: { procedure: "", reviewCadence: "" },
  tlcAssignment: { procedure: "" },
  pointOfContact: { name: "", title: "", phone: "", email: null },
  farmActivity: { status: "unknown", explanation: "" },
  reviewAndUpdate: { procedure: "" },
};
const input = { sections, changeSummary: "Synthetic transaction draft" };

describe.skipIf(!base)("Plan draft caller-owned transaction on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: Awaited<ReturnType<typeof f.provision>>;
  let store: UsPlanStore;
  let acquisition: Promise<void> | undefined;
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
  const native = (requestId: string, value: unknown = input) =>
    f.db.transaction((tx) =>
      store.createDraftCommandInTransaction(
        tx,
        context.tenantId,
        context.actorUserId,
        value,
        requestId,
      ),
    );
  const drafts = () => f.db.select().from(schema.traceabilityPlanVersions);
  const audits = () =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.action, "traceability.plan.draft_created"));
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    acquisition = track(
      createUsDatasetJournalFixture(base).then((fixture) => {
        f = fixture;
        store = new UsPlanStore(f.db);
        console.info(`Owned Plan draft seam database: ${f.databaseName}`);
      }),
    );
    await acquisition;
  }, 60_000);
  beforeEach(async () => {
    if (work.size) throw new Error("plan_draft_prior_work_live");
    await track(
      f.provision().then((value) => {
        context = value;
      }),
    );
  }, 60_000);
  afterEach(drain, 60_000);
  afterAll(async () => {
    await acquisition?.catch(() => undefined);
    await drain();
    if (!f) return;
    try {
      const active = await f.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle'",
      );
      expect(active.rows).toEqual([{ n: 0 }]);
      console.info(`Plan draft seam work drained: ${f.databaseName}`);
    } finally {
      await f.close();
    }
  }, 60_000);

  it(
    "commits a service-owned draft and exact metadata-only success audit in the caller transaction",
    phase(async () => {
      const draft = await f.db.transaction(async (tx) => {
        const created = await store.createDraftCommandInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          input,
          "native-commit",
        );
        expect(
          await tx
            .select({ id: schema.traceabilityPlanVersions.id })
            .from(schema.traceabilityPlanVersions),
        ).toEqual([{ id: created.id }]);
        expect(
          await tx
            .select({ targetId: schema.tenantAuditEvents.targetId })
            .from(schema.tenantAuditEvents)
            .where(eq(schema.tenantAuditEvents.requestId, "native-commit")),
        ).toEqual([{ targetId: created.id }]);
        return created;
      });
      expect(draft).toEqual({
        id: expect.any(String),
        versionNumber: 1,
        status: "draft",
        draftRevision: 1,
        schemaVersion: 1,
        sections,
        changeSummary: "Synthetic transaction draft",
        createdBy: context.actorUserId,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        statementOwnership: "operator_pending",
      });
      expect(
        await store.getVersion(context.tenantId, context.actorUserId, draft.id, "read"),
      ).toEqual(draft);
      expect(await audits()).toEqual([
        {
          id: expect.any(String),
          createdAt: expect.any(Date),
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          requestId: "native-commit",
          action: "traceability.plan.draft_created",
          outcome: "success",
          targetType: "traceability_plan_version",
          targetId: draft.id,
          before: null,
          after: { versionNumber: 1, draftRevision: 1 },
        },
      ]);
    }),
  );

  it(
    "rolls back both draft and success audit when the caller fails after creation",
    phase(async () => {
      const before = await f.snapshot();
      const failure = new Error("synthetic caller rollback");
      await expect(
        f.db.transaction(async (tx) => {
          await store.createDraftCommandInTransaction(
            tx,
            context.tenantId,
            context.actorUserId,
            input,
            "rollback",
          );
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await drafts()).toEqual([]);
      expect(await audits()).toEqual([]);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each(["wrong-tenant", "non-member", "read-only", "unsupported-profile"])(
    "denies %s before malformed input or existing draft facts and writes no rejection audit",
    (denial) =>
      track(
        (async () => {
          await native("existing");
          let tenantId = context.tenantId;
          let actorUserId = context.actorUserId;
          let code = "insufficient_permission";
          if (denial === "wrong-tenant") tenantId = randomUUID();
          else if (denial === "non-member") actorUserId = randomUUID();
          else if (denial === "read-only") {
            await f.db
              .update(schema.member)
              .set({ role: "traceability_auditor" })
              .where(eq(schema.member.organizationId, context.tenantId));
          } else {
            await f.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
            try {
              await f.db
                .update(schema.traceabilityProfiles)
                .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
                .where(eq(schema.traceabilityProfiles.tenantId, context.tenantId));
            } finally {
              await f.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
            }
            code = "us_plan_profile_unsupported";
          }
          const before = await f.snapshot();
          await expect(
            f.db.transaction((tx) =>
              store.createDraftCommandInTransaction(tx, tenantId, actorUserId, {}, "denied"),
            ),
          ).rejects.toMatchObject({ status: 403, response: { code } });
          expect(await f.snapshot()).toEqual(before);
        })(),
      ),
  );

  it.each([
    { sections: {}, changeSummary: "" },
    { ...input, id: "forged", versionNumber: 42 },
    { ...input, status: "effective", approvedBy: "forged", approvedEvidence: {} },
  ])("rejects malformed or caller-forged draft fields without writes", (value) =>
    track(
      (async () => {
        const before = await f.snapshot();
        await expect(native("malformed", value)).rejects.toMatchObject({
          status: 400,
          response: { code: "invalid_master_data" },
        });
        expect(await f.snapshot()).toEqual(before);
      })(),
    ),
  );

  it.each(["40001", "40P01", "XX000"])(
    "propagates native %s without retrying or persisting draft or audit",
    (code) =>
      track(
        (async () => {
          await f.pool.query("CREATE SEQUENCE plan_seam_attempt");
          await f.pool.query(
            `CREATE FUNCTION fail_plan_seam_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              PERFORM nextval('plan_seam_attempt');
              RAISE EXCEPTION 'synthetic_plan_native_failure' USING ERRCODE='${code}'; END $$`,
          );
          await f.pool.query(
            "CREATE TRIGGER fail_plan_seam_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW WHEN (NEW.action='traceability.plan.draft_created') EXECUTE FUNCTION fail_plan_seam_audit()",
          );
          const before = await f.snapshot();
          try {
            await expect(native("native-infrastructure-failure")).rejects.toMatchObject({
              cause: { code, message: "synthetic_plan_native_failure" },
            });
            expect(await f.snapshot()).toEqual(before);
            expect((await f.pool.query("SELECT last_value FROM plan_seam_attempt")).rows).toEqual([
              { last_value: "1" },
            ]);
          } finally {
            await f.pool.query("DROP TRIGGER fail_plan_seam_audit ON tenant_audit_events");
            await f.pool.query("DROP FUNCTION fail_plan_seam_audit()");
            await f.pool.query("DROP SEQUENCE plan_seam_attempt");
          }
        })(),
      ),
  );

  it(
    "serializes two native creates to one winner without outside rejection audit",
    phase(async () => {
      const results = await Promise.allSettled([native("native-a"), native("native-b")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((result) => result.status === "rejected");
      expect(loser?.status === "rejected" ? loser.reason : null).toMatchObject({
        status: 409,
        response: { code: "us_plan_draft_exists" },
      });
      const winner = results.find((result) => result.status === "fulfilled");
      if (!winner || winner.status !== "fulfilled") throw new Error("Expected native winner");
      expect(await drafts()).toHaveLength(1);
      expect(await audits()).toEqual([
        expect.objectContaining({
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          targetId: winner.value.id,
          outcome: "success",
          after: { versionNumber: 1, draftRevision: 1 },
          requestId: results[0]?.status === "fulfilled" ? "native-a" : "native-b",
        }),
      ]);
    }),
  );

  it(
    "holds the native organization lock against public creation and retains the public loser audit",
    phase(async () => {
      const locked = barrier();
      const release = barrier();
      let blocker: number | undefined;
      const nativeWork = track(
        f.db.transaction(async (tx) => {
          try {
            const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            blocker = pid.rows[0]?.pid;
            const draft = await store.createDraftCommandInTransaction(
              tx,
              context.tenantId,
              context.actorUserId,
              input,
              "native-winner",
            );
            locked.release();
            await release.promise;
            return draft;
          } finally {
            locked.release();
          }
        }),
      );
      let publicWork: Promise<unknown> | undefined;
      // Register rejection handlers before observing either owned transaction.
      const nativeResult = Promise.allSettled([nativeWork]);
      let publicResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await locked.promise;
        publicWork = track(
          store.createDraft(context.tenantId, context.actorUserId, input, "public-loser"),
        );
        publicResult = Promise.allSettled([publicWork]);
        const signal = AbortSignal.timeout(5000);
        for (;;) {
          signal.throwIfAborted();
          const blocked = await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
            [blocker],
          );
          if (blocked.rows[0]?.n === 1) break;
          await pollInterval(10, undefined, { signal });
        }
      } finally {
        release.release();
        await nativeResult;
        await publicResult;
      }
      const [winner] = await nativeResult;
      expect(winner?.status).toBe("fulfilled");
      const [loser] = await (publicResult ?? Promise.resolve([]));
      expect(loser?.status === "rejected" ? loser.reason : null).toMatchObject({
        status: 409,
        response: { code: "us_plan_draft_exists" },
      });
      if (!winner || winner.status !== "fulfilled") throw new Error("Expected native winner");
      expect(await drafts()).toHaveLength(1);
      expect(await audits()).toEqual(
        expect.arrayContaining([
          {
            id: expect.any(String),
            createdAt: expect.any(Date),
            organizationId: context.tenantId,
            actorUserId: context.actorUserId,
            requestId: "native-winner",
            action: "traceability.plan.draft_created",
            outcome: "success",
            targetType: "traceability_plan_version",
            targetId: winner.value.id,
            before: null,
            after: { versionNumber: 1, draftRevision: 1 },
          },
          {
            id: expect.any(String),
            createdAt: expect.any(Date),
            organizationId: context.tenantId,
            actorUserId: context.actorUserId,
            requestId: "public-loser",
            action: "traceability.plan.draft_created",
            outcome: "conflict",
            targetType: "traceability_plan_version",
            targetId: null,
            before: null,
            after: { code: "us_plan_draft_exists" },
          },
        ]),
      );
      expect(await audits()).toHaveLength(2);
    }),
  );
});
