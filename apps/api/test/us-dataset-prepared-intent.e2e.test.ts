import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest, type UsPlanSections } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import type { UsDemoTransaction } from "../src/modules/traceability/demo/us-demo-atomic-stage-contract";
import {
  type UsDatasetContext,
  type UsDatasetHeader,
  type UsDatasetIntent,
  type UsDatasetStage,
} from "../src/modules/traceability/demo/us-dataset-contract";
import { parseUsDemoReceipt } from "../src/modules/traceability/demo/us-demo-journal-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsPlanStore } from "../src/modules/traceability/plans/us-plan-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "",
    formats: [],
    recordLocations: [],
    responsibleRoles: [],
    backupAndRecovery: "",
    narrative: ["Private synthetic prepared Plan text"],
  },
  ftlIdentification: { procedure: "", reviewCadence: "" },
  tlcAssignment: { procedure: "" },
  pointOfContact: { name: "", title: "", phone: "", email: null },
  farmActivity: { status: "unknown", explanation: "" },
  reviewAndUpdate: { procedure: "" },
};
const draftInput = { sections, changeSummary: "Synthetic prepared draft" };
const address = (operationKey = randomUUID()) => ({
  unitKey: "plan",
  stage: "plan" as const,
  operationKey,
});

describe.skipIf(!base)("guarded dataset intent preparation on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: UsDatasetContext;
  let header: UsDatasetHeader;
  let journal: UsDatasetJournalStore;
  let plans: UsPlanStore;
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
  async function prepare(
    tx: UsDemoTransaction,
    checked: UsDatasetContext,
    target = address(),
  ): Promise<UsDatasetIntent> {
    const draft = await plans.createDraftCommandInTransaction(
      tx,
      checked.tenantId,
      checked.actorUserId,
      draftInput,
      "prepared-plan",
    );
    const input = {
      synthetic: true,
      draftId: draft.id,
      versionNumber: draft.versionNumber,
      draftRevision: draft.draftRevision,
      createdBy: draft.createdBy,
    };
    return { ...target, input, inputDigest: canonicalExportDigest(input) };
  }
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
        journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
        plans = new UsPlanStore(f.db);
        console.info(`Owned prepared intent database: ${f.databaseName}`);
      }),
    );
    await acquisition;
  }, 60_000);
  beforeEach(async () => {
    if (work.size) throw new Error("prepared_intent_prior_work_live");
    await track(
      (async () => {
        context = await f.provision();
        header = await journal.initialize(context);
      })(),
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
      console.info(`Prepared intent work drained: ${f.databaseName}`);
    } finally {
      await f.close();
    }
  }, 60_000);

  it(
    "commits the service-generated draft, exact success audit and pending intent together",
    phase(async () => {
      const target = address();
      const result = await journal.prepareStageIntent(context, header.id, target, (tx, checked) =>
        prepare(tx, checked, target),
      );
      const [draft] = await drafts();
      if (!draft) throw new Error("Missing prepared draft");
      expect(result).toEqual({
        unitKey: "plan",
        stage: "plan",
        revision: 1,
        intent: {
          ...target,
          input: {
            synthetic: true,
            draftId: draft.id,
            versionNumber: 1,
            draftRevision: 1,
            createdBy: context.actorUserId,
          },
          inputDigest: canonicalExportDigest({
            synthetic: true,
            draftId: draft.id,
            versionNumber: 1,
            draftRevision: 1,
            createdBy: context.actorUserId,
          }),
        },
        receipt: null,
      });
      expect(await drafts()).toHaveLength(1);
      expect(
        await plans.getVersion(context.tenantId, context.actorUserId, draft.id, "read"),
      ).toMatchObject({ ...draftInput, id: draft.id, status: "draft", versionNumber: 1 });
      expect(await audits()).toEqual([
        {
          id: expect.any(String),
          createdAt: expect.any(Date),
          organizationId: context.tenantId,
          actorUserId: context.actorUserId,
          requestId: "prepared-plan",
          action: "traceability.plan.draft_created",
          outcome: "success",
          targetType: "traceability_plan_version",
          targetId: draft.id,
          before: null,
          after: { versionNumber: 1, draftRevision: 1 },
        },
      ]);
      expect(await journal.readStage(context, header.id, "plan", "plan")).toEqual(result);
    }),
  );

  it.each(["SQL", "callback"])("rolls back draft, success audit and intent on %s failure", (kind) =>
    track(
      (async () => {
        const target = address();
        const failure = new Error("synthetic_preparation_failure");
        if (kind === "SQL") {
          await f.pool.query(
            "CREATE FUNCTION reject_prepared_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_prepared_sql_failure' USING ERRCODE='XX000'; END $$",
          );
          await f.pool.query(
            "CREATE TRIGGER reject_prepared_stage BEFORE INSERT ON traceability_demo_dataset_stages FOR EACH ROW EXECUTE FUNCTION reject_prepared_stage()",
          );
        }
        const before = await f.snapshot();
        try {
          const result = journal.prepareStageIntent(
            context,
            header.id,
            target,
            async (tx, checked) => {
              const intent = await prepare(tx, checked, target);
              if (kind === "callback") throw failure;
              return intent;
            },
          );
          if (kind === "callback") await expect(result).rejects.toBe(failure);
          else
            await expect(result).rejects.toMatchObject({
              cause: { code: "XX000", message: "synthetic_prepared_sql_failure" },
            });
          expect(await f.snapshot()).toEqual(before);
          expect(await drafts()).toEqual([]);
          expect(await audits()).toEqual([]);
          expect(await journal.readStage(context, header.id, "plan", "plan")).toBeNull();
        } finally {
          if (kind === "SQL") {
            await f.pool.query(
              "DROP TRIGGER reject_prepared_stage ON traceability_demo_dataset_stages",
            );
            await f.pool.query("DROP FUNCTION reject_prepared_stage()");
          }
        }
      })(),
    ),
  );

  it.each(["unit", "stage", "key", "digest", "body", "extra"])(
    "rolls back the real draft and audit for invalid returned %s",
    (kind) =>
      track(
        (async () => {
          const target = address();
          const before = await f.snapshot();
          await expect(
            journal.prepareStageIntent(context, header.id, target, async (tx, checked) => {
              const value = await prepare(tx, checked, target);
              if (kind === "unit") return { ...value, unitKey: "references" };
              if (kind === "stage") return { ...value, stage: "request" };
              if (kind === "key") return { ...value, operationKey: randomUUID() };
              if (kind === "digest") return { ...value, inputDigest: "a".repeat(64) };
              if (kind === "body") return { ...value, input: { synthetic: true, value: Infinity } };
              return { ...value, extra: true };
            }),
          ).rejects.toThrow(
            ["unit", "stage", "key"].includes(kind)
              ? "us_dataset_intent_conflict"
              : kind === "digest"
                ? "us_dataset_intent_digest_mismatch"
                : kind === "body"
                  ? "us_demo_json_invalid"
                  : "us_dataset_intent_invalid",
          );
          expect(await f.snapshot()).toEqual(before);
          expect(await drafts()).toEqual([]);
          expect(await audits()).toEqual([]);
        })(),
      ),
  );

  it(
    "serializes different proposed keys to the same original identity and one creation callback",
    phase(async () => {
      let creations = 0;
      const results = await Promise.all(
        [address(), address(), address()].map((target) =>
          journal.prepareStageIntent(context, header.id, target, (tx, checked) => {
            creations++;
            return prepare(tx, checked, target);
          }),
        ),
      );
      expect(creations).toBe(1);
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(await drafts()).toHaveLength(1);
      expect(await audits()).toHaveLength(1);
      expect((await journal.readPage(context, header.id, null, 100)).rows).toEqual([results[0]]);
    }),
  );

  it.each([false, true])(
    "replays completed=%s with original key and no callback or writes",
    (done) =>
      track(
        (async () => {
          const target = address();
          let result = await journal.prepareStageIntent(context, header.id, target, (tx, checked) =>
            prepare(tx, checked, target),
          );
          if (done) {
            const frozen = { synthetic: true, bookkeepingOnly: true };
            result = await journal.recordReceipt(
              context,
              header.id,
              1,
              "plan",
              "plan",
              target.operationKey,
              parseUsDemoReceipt({
                recordIds: [String(result.intent.input["draftId"])],
                result: frozen,
                resultDigest: canonicalExportDigest(frozen),
              }),
            );
          }
          const before = await f.snapshot();
          expect(
            await journal.prepareStageIntent(context, header.id, address(), () => {
              throw new Error("replay_must_not_create");
            }),
          ).toEqual(result);
          expect(await f.snapshot()).toEqual(before);
        })(),
      ),
  );

  it.each([
    "database",
    "actual-user",
    "actor",
    "tenant",
    "read-only",
    "provenance",
    "header-owner",
    "header-manifest",
    "dataset",
    "unit",
    "stage",
    "operation-key",
    "address-extra",
    "address-input",
    "address-digest",
    "predecessor",
    "collision",
  ])("denies %s before invoking the preparation callback", (kind) =>
    track(
      (async () => {
        let selected = journal;
        let checked = context;
        let datasetId = header.id;
        let target: { unitKey: string; stage: UsDatasetStage; operationKey: string } = address();
        let code = "us_dataset_target_invalid";
        if (kind === "database") checked = { ...context, expectedDatabaseName: "markiro_us_dev" };
        if (kind === "actual-user")
          selected = new UsDatasetJournalStore(await f.alternateRole(), usSixMonthDefinition);
        if (kind === "actor") checked = { ...context, actorUserId: randomUUID() };
        if (kind === "tenant") checked = { ...context, tenantId: randomUUID() };
        if (kind === "read-only")
          await f.db
            .update(schema.member)
            .set({ role: "traceability_auditor" })
            .where(eq(schema.member.organizationId, context.tenantId));
        if (kind === "provenance")
          await f.db
            .update(schema.tenantAuditEvents)
            .set({ outcome: "failure" })
            .where(eq(schema.tenantAuditEvents.action, "us.development.owner.provisioned"));
        if (kind === "header-owner" || kind === "header-manifest") {
          await f.db
            .update(schema.traceabilityDemoDatasets)
            .set(
              kind === "header-owner"
                ? { createdBy: randomUUID() }
                : { manifest: { synthetic: true, changed: true } },
            );
          code = "us_dataset_journal_invalid";
        }
        if (kind === "dataset") {
          datasetId = randomUUID();
          code = "us_dataset_conflict";
        }
        if (kind === "unit") {
          target = { ...target, unitKey: "unknown" };
          code = "us_dataset_unit_invalid";
        }
        if (kind === "stage") {
          target = { ...target, stage: "receiving" };
          code = "us_dataset_unit_invalid";
        }
        if (kind === "operation-key") {
          target = { ...target, operationKey: "invalid" };
          code = "us_dataset_intent_invalid";
        }
        if (kind === "address-extra") {
          target = { ...target, extra: true } as typeof target;
          code = "us_dataset_intent_invalid";
        }
        if (kind === "address-input" || kind === "address-digest") {
          target = {
            ...target,
            ...(kind === "address-input" ? { input: {} } : { inputDigest: "a".repeat(64) }),
          };
          code = "us_dataset_intent_invalid";
        }
        if (kind === "predecessor") {
          target = { ...target, unitKey: "chain_0000", stage: "transformation" };
          code = "us_dataset_predecessor_incomplete";
        }
        if (kind === "collision") {
          const input = { synthetic: true };
          await journal.captureIntent(context, header.id, {
            unitKey: "references",
            stage: "references",
            operationKey: target.operationKey,
            input,
            inputDigest: canonicalExportDigest(input),
          });
          code = "us_dataset_intent_conflict";
        }
        const before = await f.snapshot();
        let creations = 0;
        await expect(
          selected.prepareStageIntent(checked, datasetId, target, (tx, value) => {
            creations++;
            return prepare(tx, value);
          }),
        ).rejects.toThrow(code);
        expect(creations).toBe(0);
        expect(await f.snapshot()).toEqual(before);
        expect(await drafts()).toEqual([]);
        expect(await audits()).toEqual([]);
      })(),
    ),
  );
});
