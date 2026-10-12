import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetStage,
} from "../src/modules/traceability/demo/us-dataset-contract";
import { parseUsDemoReceipt } from "../src/modules/traceability/demo/us-demo-journal-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-store";
import { emptyReceivingDraft } from "./support/us-receiving-fixture";
import {
  createUsDatasetJournalFixture,
  datasetDefinition,
} from "./support/us-dataset-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const intent = (unitKey = "chain_000", stage = "receiving", input = { synthetic: true }) =>
  parseUsDatasetIntent({
    unitKey,
    stage,
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  });
const receipt = () => {
  const result = { synthetic: true };
  return parseUsDemoReceipt({
    recordIds: [randomUUID()],
    result,
    resultDigest: canonicalExportDigest(result),
  });
};
describe.skipIf(!base)("large dataset bookkeeping on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: UsDatasetContext;
  let store: UsDatasetJournalStore;
  let Store: typeof UsDatasetJournalStore;
  beforeAll(async () => {
    if (!base) throw new Error("Missing US test database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    context = await f.provision();
    Store = (await import("../src/modules/traceability/demo/us-dataset-journal"))
      .UsDatasetJournalStore;
    store = new Store(f.db, datasetDefinition());
  }, 60000);
  async function denied(action: () => Promise<unknown>, code: string) {
    const before = await f.snapshot();
    await expect(action()).rejects.toThrow(code);
    expect(await f.snapshot()).toEqual(before);
  }
  it.each([false, true])("reads the exact stage with completed=%s without writes", async (done) => {
    const header = await store.initialize(context);
    const value = intent();
    const otherUnit = intent("chain_001");
    const otherStage = intent("chain_000", "transformation");
    await store.captureIntent(context, header.id, value);
    await store.captureIntent(context, header.id, otherUnit);
    const result = done ? receipt() : null;
    if (result) {
      await store.recordReceipt(
        context,
        header.id,
        1,
        value.unitKey,
        value.stage,
        value.operationKey,
        result,
      );
      await store.captureIntent(context, header.id, otherStage);
    }
    const before = await f.snapshot();
    expect(await store.readStage(context, header.id, "chain_000", "receiving")).toEqual({
      unitKey: "chain_000",
      stage: "receiving",
      revision: done ? 2 : 1,
      intent: value,
      receipt: result,
    });
    expect(await f.snapshot()).toEqual(before);
    expect(await store.readStage(context, header.id, "chain_001", "receiving")).toEqual({
      unitKey: "chain_001",
      stage: "receiving",
      revision: 1,
      intent: otherUnit,
      receipt: null,
    });
    expect(await f.snapshot()).toEqual(before);
    if (done) {
      expect(await store.readStage(context, header.id, "chain_000", "transformation")).toEqual({
        unitKey: "chain_000",
        stage: "transformation",
        revision: 1,
        intent: otherStage,
        receipt: null,
      });
      expect(await f.snapshot()).toEqual(before);
    }
  });
  it("returns null for an absent declared references stage without writes", async () => {
    store = new Store(f.db, usSixMonthDefinition);
    const header = await store.initialize(context);
    const before = await f.snapshot();
    expect(await store.readStage(context, header.id, "references", "references")).toBeNull();
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([
    ["unknown", "receiving"],
    ["chain_000", "plan"],
    ["chain_000", "unknown"],
  ])("rejects undeclared stage %s/%s without writes", async (unitKey, stage) => {
    const header = await store.initialize(context);
    await denied(
      () => store.readStage(context, header.id, unitKey, stage as UsDatasetStage),
      "us_dataset_unit_invalid",
    );
  });
  it("rejects a wrong dataset id for an exact stage without writes", async () => {
    const header = await store.initialize(context);
    await store.captureIntent(context, header.id, intent());
    await denied(
      () => store.readStage(context, randomUUID(), "chain_000", "receiving"),
      "us_dataset_conflict",
    );
  });
  it("initializes one immutable header and independently advances two receiving units", async () => {
    expect(await store.read(context)).toBeNull();
    const first = await store.initialize(context);
    expect(await store.initialize(context)).toEqual(first);
    const left = intent();
    const right = intent("chain_001");
    expect(await store.captureIntent(context, first.id, left)).toEqual({
      unitKey: left.unitKey,
      stage: left.stage,
      revision: 1,
      intent: left,
      receipt: null,
    });
    await store.captureIntent(context, first.id, right);
    const result = receipt();
    const done = await store.recordReceipt(
      context,
      first.id,
      1,
      left.unitKey,
      left.stage,
      left.operationKey,
      result,
    );
    expect(done.revision).toBe(2);
    expect(
      await store.recordReceipt(
        context,
        first.id,
        1,
        left.unitKey,
        left.stage,
        left.operationKey,
        result,
      ),
    ).toEqual(done);
    expect(await store.captureIntent(context, first.id, left)).toEqual(done);
    expect(
      (await store.readPage(context, first.id, null, 100)).rows.map((row) => row.revision),
    ).toEqual([2, 1]);
    expect(await f.db.select().from(schema.traceabilityEvents)).toEqual([]);
  });
  it("rejects changed intent, reused operation, absent receipt target and stale CAS", async () => {
    const header = await store.initialize(context);
    const value = intent();
    await store.captureIntent(context, header.id, value);
    const changed = intent(value.unitKey, value.stage, { synthetic: false });
    await denied(
      () =>
        store.captureIntent(context, header.id, { ...changed, operationKey: value.operationKey }),
      "us_dataset_intent_conflict",
    );
    await denied(
      () =>
        store.captureIntent(context, header.id, {
          ...intent("chain_001"),
          operationKey: value.operationKey,
        }),
      "us_dataset_intent_conflict",
    );
    await denied(
      () => store.captureIntent(context, header.id, intent()),
      "us_dataset_intent_conflict",
    );
    await denied(
      () =>
        store.recordReceipt(
          context,
          header.id,
          2,
          value.unitKey,
          value.stage,
          value.operationKey,
          receipt(),
        ),
      "us_dataset_revision_conflict",
    );
    await denied(
      () =>
        store.recordReceipt(
          context,
          header.id,
          1,
          "chain_001",
          value.stage,
          value.operationKey,
          receipt(),
        ),
      "us_dataset_receipt_conflict",
    );
    const result = receipt();
    await store.recordReceipt(
      context,
      header.id,
      1,
      value.unitKey,
      value.stage,
      value.operationKey,
      result,
    );
    await denied(
      () =>
        store.recordReceipt(
          context,
          header.id,
          1,
          value.unitKey,
          value.stage,
          value.operationKey,
          receipt(),
        ),
      "us_dataset_receipt_conflict",
    );
  });
  it("requires the preceding receipt in the same unit only", async () => {
    const header = await store.initialize(context);
    await denied(
      () => store.captureIntent(context, header.id, intent("chain_000", "transformation")),
      "us_dataset_predecessor_incomplete",
    );
    const value = intent();
    await store.captureIntent(context, header.id, value);
    await store.recordReceipt(
      context,
      header.id,
      1,
      value.unitKey,
      value.stage,
      value.operationKey,
      receipt(),
    );
    await store.captureIntent(context, header.id, intent("chain_000", "transformation"));
    await store.captureIntent(context, header.id, intent("chain_001"));
    await denied(
      () => store.captureIntent(context, header.id, intent("unknown")),
      "us_dataset_unit_invalid",
    );
    await denied(
      () => store.captureIntent(context, header.id, intent("chain_000", "plan")),
      "us_dataset_unit_invalid",
    );
  });
  it("pages 101 rows without omissions at limits 1 and 100", async () => {
    store = new Store(f.db, datasetDefinition(101));
    const header = await store.initialize(context);
    for (let i = 0; i < 101; i++)
      await store.captureIntent(context, header.id, intent(`chain_${String(i).padStart(3, "0")}`));
    for (const limit of [1, 100]) {
      let after: { unitKey: string; stage: "receiving" } | null = null;
      const keys: string[] = [];
      do {
        const page = await store.readPage(context, header.id, after, limit);
        keys.push(...page.rows.map((row) => row.unitKey));
        after = page.next as typeof after;
      } while (after);
      expect(keys).toEqual(
        Array.from({ length: 101 }, (_, i) => `chain_${String(i).padStart(3, "0")}`),
      );
    }
    for (const limit of [0, 101, NaN, 1.5])
      await denied(
        () => store.readPage(context, header.id, null, limit),
        "us_dataset_page_invalid",
      );
    await denied(
      () => store.readPage(context, header.id, { unitKey: "unknown", stage: "receiving" }, 1),
      "us_dataset_page_invalid",
    );
    await denied(() => store.readPage(context, randomUUID(), null, 1), "us_dataset_conflict");
  });
  it("pages equal-unit stages in lexical order across execution-order boundaries", async () => {
    const header = await store.initialize(context);
    for (const stage of ["receiving", "transformation", "cases"] as const) {
      const value = intent("chain_000", stage);
      await store.captureIntent(context, header.id, value);
      await store.recordReceipt(
        context,
        header.id,
        1,
        value.unitKey,
        value.stage,
        value.operationKey,
        receipt(),
      );
    }
    await store.captureIntent(context, header.id, intent("chain_001"));
    let after: { unitKey: string; stage: UsDatasetStage } | null = null;
    const identities: string[] = [];
    do {
      const page = await store.readPage(context, header.id, after, 1);
      expect(page.rows).toHaveLength(1);
      identities.push(...page.rows.map((row) => `${row.unitKey}/${row.stage}`));
      after = page.next;
    } while (after);
    expect(identities).toEqual([
      "chain_000/cases",
      "chain_000/receiving",
      "chain_000/transformation",
      "chain_001/receiving",
    ]);
  });
  it("serializes concurrent initialize, capture and receipt without lost rows", async () => {
    const headers = await Promise.all(Array.from({ length: 4 }, () => store.initialize(context)));
    expect(new Set(headers.map((h) => h.id)).size).toBe(1);
    const header = headers[0];
    if (!header) throw new Error("missing header");
    const value = intent();
    const captures = await Promise.all(
      Array.from({ length: 4 }, () => store.captureIntent(context, header.id, value)),
    );
    expect(captures.every((row) => row.revision === 1)).toBe(true);
    const result = receipt();
    const done = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.recordReceipt(
          context,
          header.id,
          1,
          value.unitKey,
          value.stage,
          value.operationKey,
          result,
        ),
      ),
    );
    expect(done.every((row) => row.revision === 2)).toBe(true);
    await Promise.all([
      store.captureIntent(context, header.id, intent("chain_001")),
      store.captureIntent(context, header.id, value),
    ]);
    expect((await store.readPage(context, header.id, null, 100)).rows).toHaveLength(2);
  });
  it.each([
    "database",
    "actor",
    "tenant",
    "user",
    "extra",
    "revoked",
    "metadata",
    "audit",
    "credential",
    "name",
    "demoted",
    "profile",
    "timezone",
    "actual user",
  ])("rejects invalid target %s without writes", async (kind) => {
    const header = await store.initialize(context);
    const value = intent();
    await store.captureIntent(context, header.id, value);
    let target = context;
    let selected = store;
    if (kind === "database") target = { ...context, expectedDatabaseName: "markiro_us_dev" };
    if (kind === "actor") target = { ...context, actorUserId: randomUUID() };
    if (kind === "tenant") target = { ...context, tenantId: randomUUID() };
    if (kind === "user")
      target = { ...context, expectedDatabaseUser: "postgres" } as unknown as UsDatasetContext;
    if (kind === "extra") target = { ...context, extra: true } as UsDatasetContext;
    if (kind === "revoked")
      await f.db.delete(schema.member).where(eq(schema.member.userId, context.actorUserId));
    if (kind === "metadata") await f.db.update(schema.organization).set({ metadata: "invalid" });
    if (kind === "audit")
      await f.db
        .update(schema.tenantAuditEvents)
        .set({ outcome: "failure" })
        .where(eq(schema.tenantAuditEvents.action, "us.development.owner.provisioned"));
    if (kind === "credential")
      await f.db.delete(schema.account).where(eq(schema.account.userId, context.actorUserId));
    if (kind === "name")
      await f.db
        .update(schema.user)
        .set({ name: "Changed synthetic owner" })
        .where(eq(schema.user.id, context.actorUserId));
    if (kind === "demoted")
      await f.db
        .update(schema.member)
        .set({ role: "traceability_qa" })
        .where(eq(schema.member.userId, context.actorUserId));
    if (kind === "profile") await f.db.delete(schema.traceabilityProfiles);
    if (kind === "timezone")
      await f.db.update(schema.orgProfiles).set({ timeZone: "America/Chicago" });
    if (kind === "actual user") selected = new Store(await f.alternateRole(), datasetDefinition());
    for (const action of [
      () => selected.read(target),
      () => selected.initialize(target),
      () => selected.readPage(target, header.id, null, 1),
      () => selected.readStage(target, header.id, value.unitKey, value.stage),
      () => selected.captureIntent(target, header.id, value),
      () =>
        selected.recordReceipt(
          target,
          header.id,
          1,
          value.unitKey,
          value.stage,
          value.operationKey,
          receipt(),
        ),
    ])
      await denied(action, "us_dataset_target_invalid");
  });
  it.each([
    "references",
    "receiving root",
    "transformation root",
    "shipping root",
    "Plan",
    "Request",
    "compact",
  ])("refuses nonfresh target containing %s", async (kind) => {
    if (kind === "references")
      await f.db
        .insert(schema.traceabilityParties)
        .values({ tenantId: context.tenantId, name: "Independent synthetic party" });
    if (kind === "receiving root")
      await new UsReceivingStore(f.db).createDraft(
        context.tenantId,
        context.actorUserId,
        { operationKey: randomUUID(), draft: emptyReceivingDraft },
        "dataset-freshness",
      );
    if (kind === "transformation root")
      await new UsTransformationStore(f.db).createDraft(
        context.tenantId,
        context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            eventDate: null,
            processorLocationId: null,
            reason: null,
            reasonNote: null,
            notes: null,
            inputs: [],
            outputs: [],
            documentIds: [],
          },
        },
        "dataset-freshness",
      );
    if (kind === "shipping root")
      await new UsShippingStore(f.db).createDraft(
        context.tenantId,
        context.actorUserId,
        {
          operationKey: randomUUID(),
          draft: {
            eventDate: null,
            shipFromLocationId: null,
            recipientLocationId: null,
            carrierReference: null,
            notes: null,
            items: [],
            documentIds: [],
          },
        },
        "dataset-freshness",
      );
    if (kind === "Plan")
      await f.db.insert(schema.traceabilityPlanVersions).values({
        tenantId: context.tenantId,
        versionNumber: 1,
        sections: {},
        createdBy: context.actorUserId,
      });
    if (kind === "Request")
      await f.db.insert(schema.traceRequests).values({
        tenantId: context.tenantId,
        requestNumber: "REQ-26-0001",
        requesterName: "Synthetic",
        receivedAt: new Date(),
        dueAt: new Date(Date.now() + 86400000),
        createdBy: context.actorUserId,
      });
    if (kind === "compact") {
      const { UsDemoJournalStore } =
        await import("../src/modules/traceability/demo/us-demo-journal");
      await new UsDemoJournalStore(f.db).initialize(context);
    }
    await denied(() => store.initialize(context), "us_dataset_freshness_conflict");
  });
  it("retains installed identity after independent references and rejects another recipe", async () => {
    const header = await store.initialize(context);
    await f.db
      .insert(schema.traceabilityParties)
      .values({ tenantId: context.tenantId, name: "Independent synthetic party" });
    expect(await store.initialize(context)).toEqual(header);
    const other = new Store(f.db, datasetDefinition(3));
    await denied(() => other.initialize(context), "us_dataset_journal_invalid");
    await f.db
      .update(schema.traceabilityDemoDatasets)
      .set({ manifest: { synthetic: true, changed: true } });
    await denied(() => store.read(context), "us_dataset_journal_invalid");
  });
  it.each(["receipt", "missing receipt", "input"])(
    "fails on corrupted returned %s evidence without repair",
    async (kind) => {
      const header = await store.initialize(context);
      const value = intent();
      await store.captureIntent(context, header.id, value);
      const result = receipt();
      await store.recordReceipt(
        context,
        header.id,
        1,
        value.unitKey,
        value.stage,
        value.operationKey,
        result,
      );
      if (kind === "receipt")
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ receipt: { ...result, resultDigest: "a".repeat(64) } });
      if (kind === "input")
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ inputDigest: "a".repeat(64) });
      if (kind === "missing receipt") {
        await f.pool.query(
          "ALTER TABLE traceability_demo_dataset_stages DROP CONSTRAINT traceability_demo_dataset_stages_completion_valid",
        );
        await f.pool.query("UPDATE traceability_demo_dataset_stages SET receipt = NULL");
      }
      try {
        for (const action of [
          () => store.readPage(context, header.id, null, 100),
          () => store.readStage(context, header.id, value.unitKey, value.stage),
          () => store.captureIntent(context, header.id, value),
          () =>
            store.recordReceipt(
              context,
              header.id,
              1,
              value.unitKey,
              value.stage,
              value.operationKey,
              result,
            ),
        ])
          await denied(action, "us_dataset_journal_invalid");
      } finally {
        if (kind === "missing receipt") {
          await f.pool.query("UPDATE traceability_demo_dataset_stages SET revision = 1");
          await f.pool.query(
            "ALTER TABLE traceability_demo_dataset_stages ADD CONSTRAINT traceability_demo_dataset_stages_completion_valid CHECK ((revision = 1 AND receipt IS NULL) OR (revision = 2 AND receipt IS NOT NULL))",
          );
        }
      }
    },
  );
  it("does not adopt a foreign tenant dataset id", async () => {
    const tenantId = randomUUID();
    await f.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Other synthetic", slug: tenantId, createdAt: new Date() });
    const [foreign] = await f.db
      .insert(schema.traceabilityDemoDatasets)
      .values({
        tenantId,
        version: datasetDefinition().version,
        definitionDigest: datasetDefinition().digest,
        manifest: datasetDefinition().manifest,
        createdBy: context.actorUserId,
      })
      .returning();
    if (!foreign) throw new Error("missing foreign header");
    await store.initialize(context);
    for (const action of [
      () => store.readPage(context, foreign.id, null, 1),
      () => store.readStage(context, foreign.id, "chain_000", "receiving"),
      () => store.captureIntent(context, foreign.id, intent()),
      () =>
        store.recordReceipt(
          context,
          foreign.id,
          1,
          "chain_000",
          "receiving",
          randomUUID(),
          receipt(),
        ),
    ])
      await denied(action, "us_dataset_conflict");
  });
  it("preserves a genuine driver error and rolls back failed insert", async () => {
    const header = await store.initialize(context);
    await f.pool.query(
      "CREATE FUNCTION reject_dataset_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rejection'; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_dataset_stage BEFORE INSERT ON traceability_demo_dataset_stages FOR EACH ROW EXECUTE FUNCTION reject_dataset_stage()",
    );
    try {
      const before = await f.snapshot();
      await expect(store.captureIntent(context, header.id, intent())).rejects.toMatchObject({
        cause: { code: "P0001" },
      });
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.pool.query("DROP TRIGGER reject_dataset_stage ON traceability_demo_dataset_stages");
      await f.pool.query("DROP FUNCTION reject_dataset_stage()");
    }
  });
  it("gives one durable winner for concurrent changed intent and receipt", async () => {
    const header = await store.initialize(context);
    const left = intent();
    const right = intent();
    const captured = await Promise.allSettled([
      store.captureIntent(context, header.id, left),
      store.captureIntent(context, header.id, right),
    ]);
    expect(captured.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(captured.filter((item) => item.status === "rejected")).toHaveLength(1);
    const pending = (await store.readPage(context, header.id, null, 1)).rows[0];
    if (!pending) throw new Error("missing stage");
    const done = await Promise.allSettled(
      [receipt(), receipt()].map((result) =>
        store.recordReceipt(
          context,
          header.id,
          1,
          pending.unitKey,
          pending.stage,
          pending.intent.operationKey,
          result,
        ),
      ),
    );
    expect(done.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(done.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await store.readPage(context, header.id, null, 1)).rows[0]?.revision).toBe(2);
  });
});
