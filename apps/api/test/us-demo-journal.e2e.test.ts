import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsDemoJournalStore } from "../src/modules/traceability/demo/us-demo-journal";
import {
  parseUsDemoIntent,
  parseUsDemoReceipt,
  type UsDemoJournalContext,
  type UsDemoStage,
} from "../src/modules/traceability/demo/us-demo-journal-contract";
import { usDemoDefinitionDigest } from "../src/modules/traceability/demo/us-demo-definition";
import { createUsDemoJournalFixture } from "./support/us-demo-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const intent = (stage: UsDemoStage = "receiving", input = { eventDate: "2026-09-14" }) =>
  parseUsDemoIntent({
    stage,
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  });
const receipt = (result = { eventDate: "2026-09-14" }) =>
  parseUsDemoReceipt({
    recordIds: [randomUUID()],
    result,
    resultDigest: canonicalExportDigest(result),
  });

describe.skipIf(!base)("guarded US demo journal on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDemoJournalFixture>>;
  let context: UsDemoJournalContext;
  let store: UsDemoJournalStore;
  let Store: typeof UsDemoJournalStore;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US test database");
    f = await createUsDemoJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    context = await f.provision();
    // RED acquires/provisions the real DB before discovering the missing store.
    Store = (await import("../src/modules/traceability/demo/us-demo-journal")).UsDemoJournalStore;
    store = new Store(f.db);
  }, 60000);

  async function denied(action: () => Promise<unknown>, code: string) {
    const before = await f.snapshot();
    await expect(action()).rejects.toThrow(code);
    expect(await f.snapshot()).toEqual(before);
  }
  async function allDenied(target = context, selected = store) {
    const first = await store.initialize(context);
    const value = intent();
    const captured = await store.captureIntent(context, first.id, first.revision, value);
    for (const action of [
      () => selected.read(target),
      () => selected.initialize(target),
      () => selected.captureIntent(target, first.id, captured.revision, intent("references")),
      () =>
        selected.recordReceipt(
          target,
          first.id,
          captured.revision,
          value.stage,
          value.operationKey,
          receipt(),
        ),
    ])
      await denied(action, "us_demo_target_invalid");
  }

  it("reads an absent journal without writes and initializes exactly once", async () => {
    const before = await f.snapshot();
    expect(await store.read(context)).toBeNull();
    expect(await f.snapshot()).toEqual(before);
    const business = await f.snapshot(false);
    const first = await store.initialize(context);
    expect(first).toEqual({
      id: expect.any(String),
      tenantId: context.tenantId,
      scenarioVersion: "us-processor-demo-v1",
      definitionDigest: usDemoDefinitionDigest,
      revision: 1,
      stages: [],
    });
    const saved = await f.snapshot();
    expect(await store.initialize(context)).toEqual(first);
    expect(await store.read(context)).toEqual(first);
    expect(await f.snapshot()).toEqual(saved);
    expect(await f.snapshot(false)).toEqual(business);
    expect(await f.db.select().from(schema.traceabilityDemoSeeds)).toHaveLength(1);
  });
  it("serializes concurrent initialize to one identical header", async () => {
    const business = await f.snapshot(false);
    const journals = await Promise.all(Array.from({ length: 4 }, () => store.initialize(context)));
    expect(
      journals.every((journal) => JSON.stringify(journal) === JSON.stringify(journals[0])),
    ).toBe(true);
    expect(await f.db.select().from(schema.traceabilityDemoSeeds)).toHaveLength(1);
    expect(await f.snapshot(false)).toEqual(business);
  });
  it("captures intent and receipt once, replays lost committed replies before stale CAS", async () => {
    const business = await f.snapshot(false);
    const first = await store.initialize(context);
    const value = intent();
    // Discard a real committed result; replay must recover it with the original revision.
    await store.captureIntent(context, first.id, first.revision, value);
    const captured = await store.read(context);
    expect(captured).toMatchObject({
      revision: 2,
      stages: [{ revision: 1, intent: value, receipt: null }],
    });
    const saved = await f.snapshot();
    expect(await store.captureIntent(context, first.id, first.revision, value)).toEqual(captured);
    expect(await f.snapshot()).toEqual(saved);
    const result = receipt();
    await store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, result);
    const recorded = await store.read(context);
    expect(recorded).toMatchObject({
      revision: 3,
      stages: [{ revision: 2, intent: value, receipt: result }],
    });
    const complete = await f.snapshot();
    expect(
      await store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, result),
    ).toEqual(recorded);
    expect(await f.snapshot()).toEqual(complete);
    expect(await f.snapshot(false)).toEqual(business);
    // Receipts are bookkeeping: not a status, business event or completed demo.
    expect(Object.keys(recorded ?? {}).sort()).toEqual([
      "definitionDigest",
      "id",
      "revision",
      "scenarioVersion",
      "stages",
      "tenantId",
    ]);
  });
  it("serializes concurrent identical intents and receipts to one advancement each", async () => {
    const first = await store.initialize(context);
    const value = intent();
    const captured = await Promise.all(
      Array.from({ length: 4 }, () => store.captureIntent(context, first.id, 1, value)),
    );
    expect(captured.every((journal) => journal.revision === 2)).toBe(true);
    const result = receipt();
    const recorded = await Promise.all(
      Array.from({ length: 4 }, () =>
        store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, result),
      ),
    );
    expect(recorded.every((journal) => journal.revision === 3)).toBe(true);
    expect(await f.db.select().from(schema.traceabilityDemoSeedStages)).toHaveLength(1);
  });
  it.each([NaN, Infinity, 0, -1, 1.5, 2147483648])(
    "rejects malformed revision %s even for a committed exact replay",
    async (expectedRevision) => {
      const first = await store.initialize(context);
      const value = intent();
      const result = receipt();
      await store.captureIntent(context, first.id, 1, value);
      await store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, result);
      await denied(
        () => store.captureIntent(context, first.id, expectedRevision, value),
        "us_demo_revision_conflict",
      );
      await denied(
        () =>
          store.recordReceipt(
            context,
            first.id,
            expectedRevision,
            value.stage,
            value.operationKey,
            result,
          ),
        "us_demo_revision_conflict",
      );
    },
  );
  it("strictly validates new evidence before any journal mutation", async () => {
    const first = await store.initialize(context);
    const value = intent();
    await denied(
      () => store.captureIntent(context, first.id, 1, { ...value, inputDigest: "a".repeat(64) }),
      "us_demo_intent_digest_mismatch",
    );
    await store.captureIntent(context, first.id, 1, value);
    const result = receipt();
    await denied(
      () =>
        store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, {
          ...result,
          resultDigest: "b".repeat(64),
        }),
      "us_demo_receipt_digest_mismatch",
    );
  });
  it("returns canonical stage order and returns the current journal on an older exact replay", async () => {
    let current = await store.initialize(context);
    const shipping = intent("shipping");
    current = await store.captureIntent(context, current.id, current.revision, shipping);
    current = await store.captureIntent(
      context,
      current.id,
      current.revision,
      intent("references"),
    );
    current = await store.captureIntent(context, current.id, current.revision, intent());
    expect(current.stages.map(({ stage }) => stage)).toEqual([
      "references",
      "receiving",
      "shipping",
    ]);
    const before = await f.snapshot();
    expect(await store.captureIntent(context, current.id, 1, shipping)).toEqual(current);
    expect(await f.snapshot()).toEqual(before);
  });
  it("allows one winner for concurrent divergent CAS and refuses the loser without writes", async () => {
    const first = await store.initialize(context);
    const left = intent();
    const right = intent("shipping");
    const outcomes = await Promise.allSettled([
      store.captureIntent(context, first.id, 1, left),
      store.captureIntent(context, first.id, 1, right),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await store.read(context)).toMatchObject({ revision: 2, stages: [expect.any(Object)] });
    const rejected = outcomes[0]?.status === "rejected" ? left : right;
    await denied(
      () => store.captureIntent(context, first.id, 1, rejected),
      "us_demo_revision_conflict",
    );
  });
  it("does not reuse a stage or operation key with another body, even at a stale revision", async () => {
    const first = await store.initialize(context);
    const value = intent();
    const current = await store.captureIntent(context, first.id, 1, value);
    const changed = intent("receiving", { eventDate: "2026-09-15" });
    await denied(
      () =>
        store.captureIntent(context, first.id, 1, { ...changed, operationKey: value.operationKey }),
      "us_demo_intent_conflict",
    );
    await denied(
      () => store.captureIntent(context, first.id, current.revision, changed),
      "us_demo_intent_conflict",
    );
    await denied(
      () =>
        store.captureIntent(context, first.id, current.revision, {
          ...intent("shipping"),
          operationKey: value.operationKey,
        }),
      "us_demo_intent_conflict",
    );
  });
  it("requires prior intent, exact operation binding and immutable receipts", async () => {
    const first = await store.initialize(context);
    const value = intent();
    const result = receipt();
    await denied(
      () => store.recordReceipt(context, first.id, 1, value.stage, value.operationKey, result),
      "us_demo_receipt_conflict",
    );
    await store.captureIntent(context, first.id, 1, value);
    await denied(
      () => store.recordReceipt(context, first.id, 2, value.stage, randomUUID(), result),
      "us_demo_receipt_conflict",
    );
    await denied(
      () => store.recordReceipt(context, first.id, 1, value.stage, value.operationKey, result),
      "us_demo_revision_conflict",
    );
    await store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, result);
    await denied(
      () =>
        store.recordReceipt(
          context,
          first.id,
          2,
          value.stage,
          value.operationKey,
          receipt({ eventDate: "2026-09-15" }),
        ),
      "us_demo_receipt_conflict",
    );
    await denied(
      () =>
        store.recordReceipt(context, first.id, 3, value.stage, value.operationKey, {
          ...result,
          recordIds: [randomUUID()],
        }),
      "us_demo_receipt_conflict",
    );
  });
  it.each([
    "wrong database",
    "wrong expected user",
    "wrong tenant",
    "wrong actor",
    "extra context",
  ])("rejects %s on every method without writes", async (kind) => {
    const target = {
      ...context,
      ...(kind === "wrong database" ? { expectedDatabaseName: "markiro_us_dev" } : {}),
      ...(kind === "wrong expected user" ? { expectedDatabaseUser: "postgres" } : {}),
      ...(kind === "wrong tenant" ? { tenantId: randomUUID() } : {}),
      ...(kind === "wrong actor" ? { actorUserId: randomUUID() } : {}),
      ...(kind === "extra context" ? { unexpected: "private-context-value" } : {}),
    };
    await allDenied(target as UsDemoJournalContext);
  });
  it("rejects a different actual current_user using an existing connection-local builtin role", async () => {
    await allDenied(context, new Store(await f.alternateRole()));
  });
  it.each([
    "revoked",
    "demoted",
    "QA",
    "other owner",
    "other QA",
    "metadata",
    "audit",
    "user name",
    "credential",
  ])("rechecks original owner provenance: %s", async (kind) => {
    const first = await store.initialize(context);
    const value = intent();
    await store.captureIntent(context, first.id, 1, value);
    if (kind === "revoked")
      await f.db.delete(schema.member).where(eq(schema.member.userId, context.actorUserId));
    if (kind === "demoted" || kind === "QA")
      await f.db
        .update(schema.member)
        .set({ role: kind === "QA" ? "traceability_qa" : "member" })
        .where(eq(schema.member.userId, context.actorUserId));
    let target = context;
    if (kind === "other owner" || kind === "other QA") {
      const actorUserId = randomUUID();
      await f.db
        .insert(schema.user)
        .values({ id: actorUserId, name: "Other", email: `${actorUserId}@example.test` });
      await f.db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: context.tenantId,
        userId: actorUserId,
        role: kind === "other QA" ? "traceability_qa" : "owner",
        createdAt: new Date(),
      });
      target = { ...context, actorUserId };
    }
    if (kind === "metadata")
      await f.db
        .update(schema.organization)
        .set({ metadata: "private-corrupt-metadata" })
        .where(eq(schema.organization.id, context.tenantId));
    if (kind === "audit")
      await f.db
        .update(schema.tenantAuditEvents)
        .set({ outcome: "failure" })
        .where(eq(schema.tenantAuditEvents.action, "us.development.owner.provisioned"));
    if (kind === "user name")
      await f.db
        .update(schema.user)
        .set({ name: "private-corrupt-name" })
        .where(eq(schema.user.id, context.actorUserId));
    if (kind === "credential")
      await f.db.delete(schema.account).where(eq(schema.account.userId, context.actorUserId));
    for (const action of [
      () => store.read(target),
      () => store.initialize(target),
      () => store.captureIntent(target, first.id, 2, intent("references")),
      () => store.recordReceipt(target, first.id, 2, value.stage, value.operationKey, receipt()),
    ])
      await denied(action, "us_demo_target_invalid");
  });
  it.each(["timezone", "generic profile", "missing profile"])(
    "rejects %s on every call",
    async (kind) => {
      const first = await store.initialize(context);
      const value = intent();
      await store.captureIntent(context, first.id, 1, value);
      if (kind === "timezone")
        await f.db
          .update(schema.orgProfiles)
          .set({ timeZone: "America/Chicago" })
          .where(eq(schema.orgProfiles.tenantId, context.tenantId));
      if (kind === "generic profile")
        await f.db
          .update(schema.traceabilityProfiles)
          .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
          .where(eq(schema.traceabilityProfiles.tenantId, context.tenantId));
      if (kind === "missing profile")
        await f.db
          .delete(schema.traceabilityProfiles)
          .where(eq(schema.traceabilityProfiles.tenantId, context.tenantId));
      for (const action of [
        () => store.read(context),
        () => store.initialize(context),
        () => store.captureIntent(context, first.id, 2, intent("references")),
        () => store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, receipt()),
      ])
        await denied(action, "us_demo_target_invalid");
    },
  );
  it("does not adopt another tenant's seed id", async () => {
    const other = randomUUID();
    await f.db
      .insert(schema.organization)
      .values({ id: other, name: "Other", slug: other, createdAt: new Date() });
    const rows = await f.db
      .insert(schema.traceabilityDemoSeeds)
      .values({
        tenantId: other,
        scenarioVersion: "us-processor-demo-v1",
        definitionDigest: usDemoDefinitionDigest,
        createdBy: context.actorUserId,
      })
      .returning();
    const id = rows[0]?.id;
    if (!id) throw new Error("Missing fixture seed");
    await denied(() => store.captureIntent(context, id, 1, intent()), "us_demo_seed_conflict");
    await denied(
      () => store.recordReceipt(context, id, 1, "receiving", randomUUID(), receipt()),
      "us_demo_seed_conflict",
    );
  });
  it.each([
    "definition",
    "version",
    "creator",
    "receipt",
    "input digest",
    "stage revision",
    "header revision",
  ])("fails closed on corrupt stored %s without repairing it", async (kind) => {
    const first = await store.initialize(context);
    const value = intent();
    await store.captureIntent(context, first.id, 1, value);
    if (kind === "definition")
      await f.db.update(schema.traceabilityDemoSeeds).set({ definitionDigest: "a".repeat(64) });
    if (kind === "version")
      await f.db
        .update(schema.traceabilityDemoSeeds)
        .set({ scenarioVersion: "unsupported-demo-v99" });
    if (kind === "creator")
      await f.db.update(schema.traceabilityDemoSeeds).set({ createdBy: randomUUID() });
    if (kind === "receipt")
      await f.db.update(schema.traceabilityDemoSeedStages).set({
        receipt: {
          resultDigest: "b".repeat(64),
          result: { note: "private-receipt-text" },
          recordIds: [],
        },
      });
    if (kind === "input digest")
      await f.db.update(schema.traceabilityDemoSeedStages).set({ inputDigest: "b".repeat(64) });
    if (kind === "stage revision")
      await f.db.update(schema.traceabilityDemoSeedStages).set({ revision: 7 });
    if (kind === "header revision")
      await f.db.update(schema.traceabilityDemoSeeds).set({ revision: 9 });
    for (const action of [
      () => store.read(context),
      () => store.initialize(context),
      () => store.captureIntent(context, first.id, 2, value),
      () => store.recordReceipt(context, first.id, 2, value.stage, value.operationKey, receipt()),
    ])
      await denied(action, "us_demo_journal_invalid");
  });
  it("propagates a genuine database write failure and atomically rolls back the journal", async () => {
    const first = await store.initialize(context);
    await f.pool.query(
      "CREATE FUNCTION reject_demo_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic stage rejection'; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_demo_stage BEFORE INSERT ON traceability_demo_seed_stages FOR EACH ROW EXECUTE FUNCTION reject_demo_stage()",
    );
    const before = await f.snapshot();
    await expect(store.captureIntent(context, first.id, 1, intent())).rejects.toMatchObject({
      cause: { code: "P0001" },
    });
    expect(await f.snapshot()).toEqual(before);
    await f.pool.query("DROP TRIGGER reject_demo_stage ON traceability_demo_seed_stages");
    await f.pool.query("DROP FUNCTION reject_demo_stage()");
  });
});
