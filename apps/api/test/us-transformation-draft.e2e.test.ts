import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { TransformationDraft } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { readTransformationRecord } from "../src/modules/traceability/transformation/us-transformation-persistence";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { emptyReceivingDraft, seedReceivingTenant } from "./support/us-receiving-fixture";
import { seedTransformationRevision } from "./support/us-transformation-revision-fixture";

export const emptyTransformation: TransformationDraft = {
  eventDate: null,
  processorLocationId: null,
  reason: null,
  reasonNote: null,
  notes: null,
  inputs: [],
  outputs: [],
  documentIds: [],
};
const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation draft commands", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsTransformationStore;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
    store = new UsTransformationStore(f.db);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("production creates incomplete drafts, captures timezone and allocates one counter on replay", async () => {
    const c = await seedReceivingTenant(f.db);
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    const command = { operationKey: randomUUID(), draft: emptyTransformation };
    const record = await store.createDraft(c.tenant, c.actor, command, "create-test");
    expect(record).toMatchObject({
      status: "draft",
      draftVersion: 1,
      revision: 1,
      timeZone: "America/Chicago",
      draft: emptyTransformation,
    });
    expect(record.eventNumber).toMatch(/^TRN-\d{2}-0001$/);
    const readiness = await store.checkReadiness(c.tenant, c.actor, record.id, {
      expectedDraftVersion: 1,
    });
    expect(readiness.state).toBe("incomplete");
    expect(readiness.issues.map((issue) => [issue.group, issue.field, issue.code])).toEqual([
      ["event", "eventDate", "required"],
      ["event", "processorLocationId", "required"],
      ["event", "reason", "required"],
      ["inputs", "inputs", "required"],
      ["outputs", "outputs", "required"],
      ["documents", "documentIds", "required"],
    ]);
    expect(await store.createDraft(c.tenant, c.actor, command, "replay")).toEqual(record);
    const next = await store.createDraft(
      c.tenant,
      c.actor,
      { ...command, operationKey: randomUUID() },
      "next",
    );
    expect(next.eventNumber).toMatch(/^TRN-\d{2}-0002$/);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, record.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.transformation.draft_created",
      outcome: "success",
      targetType: "traceability_event",
      targetId: record.id,
      before: null,
      after: record,
      requestId: "create-test",
    });
    await expect(
      store.createDraft(
        c.tenant,
        c.actor,
        { ...command, draft: { ...emptyTransformation, notes: "changed" } },
        "conflict",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_operation_conflict" } });
  });

  it("replaces ordered children, increments once and replays historical save", async () => {
    const c = await seedReceivingTenant(f.db);
    const second = randomUUID();
    await f.db.insert(schema.referenceDocuments).values({
      id: second,
      tenantId: c.tenant,
      type: "bol",
      number: "second",
      createdBy: c.actor,
    });
    const draft: TransformationDraft = {
      ...emptyTransformation,
      eventDate: "2026-09-26",
      processorLocationId: c.location,
      reason: "repacking",
      documentIds: [second, c.document],
      inputs: [
        {
          kind: "non_ftl",
          productId: c.product,
          sourceLocationId: c.location,
          reference: "flour",
          quantity: "1.000",
          unitOfMeasure: "kg",
        },
        { kind: "ftl_lot", lotId: c.lot, quantity: "500", unitOfMeasure: "lb" },
      ],
      outputs: [
        { productId: c.product, tlc: "=Output/Ä", quantity: "100", unitOfMeasure: "case" },
        { productId: null, tlc: null, quantity: null, unitOfMeasure: null },
      ],
    };
    const record = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "create",
    );
    expect(await store.getRecord(c.tenant, c.actor, record.id)).toMatchObject({ draft });
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: emptyTransformation,
    };
    const saved = await store.saveDraft(c.tenant, c.actor, record.id, command, "save");
    expect(saved).toMatchObject({ draftVersion: 2, draft: emptyTransformation });
    expect(await store.saveDraft(c.tenant, c.actor, record.id, command, "replay")).toEqual(saved);
    await expect(
      store.saveDraft(
        c.tenant,
        c.actor,
        record.id,
        { ...command, operationKey: randomUUID() },
        "stale",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_draft_conflict" } });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, record.id));
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => a.action.endsWith("draft_saved"))).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      outcome: "success",
      targetType: "traceability_event",
      targetId: record.id,
      before: record,
      after: saved,
      requestId: "save",
    });
    await new UsReceivingStore(f.db).createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: emptyReceivingDraft },
      "receiving",
    );
    expect(await store.getRecord(c.tenant, c.actor, record.id)).toEqual(saved);
  });

  it("authorizes before parsing and before replay, and denies absent or RU profiles without writes", async () => {
    const c = await seedReceivingTenant(f.db);
    const command = { operationKey: randomUUID(), draft: emptyTransformation };
    await store.createDraft(c.tenant, c.actor, command, "create");
    await f.db.update(schema.member).set({ role: "viewer" }).where(eq(schema.member.id, c.member));
    for (const input of [null, command])
      await expect(store.createDraft(c.tenant, c.actor, input, "denied")).rejects.toMatchObject({
        status: 403,
      });
    await expect(store.getRecord(c.tenant, c.actor, "invalid")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      store.saveDraft(c.tenant, c.actor, "invalid", null, "denied"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(store.checkReadiness(c.tenant, c.actor, "invalid", null)).rejects.toMatchObject({
      status: 403,
    });
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    await f.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(store.createDraft(c.tenant, c.actor, null, "absent")).rejects.toMatchObject({
      status: 403,
    });
    await f.db.insert(schema.traceabilityProfiles).values({
      tenantId: c.tenant,
      code: "RU_CHZ",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: c.actor,
    });
    await expect(store.createDraft(c.tenant, c.actor, null, "ru")).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
    expect(
      await f.db
        .select()
        .from(schema.traceabilityEvents)
        .where(eq(schema.traceabilityEvents.tenantId, c.tenant)),
    ).toHaveLength(1);
  });

  it("returns the same safe not-found for foreign tenant and Receiving IDs", async () => {
    const c = await seedReceivingTenant(f.db),
      other = await seedReceivingTenant(f.db);
    const foreign = await store.createDraft(
      other.tenant,
      other.actor,
      { operationKey: randomUUID(), draft: emptyTransformation },
      "foreign",
    );
    const receiving = await new UsReceivingStore(f.db).createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: emptyReceivingDraft },
      "receiving",
    );
    for (const id of [foreign.id, receiving.id, randomUUID()]) {
      await expect(store.getRecord(c.tenant, c.actor, id)).rejects.toMatchObject({
        status: 404,
        response: { code: "transformation_not_found" },
      });
      await expect(
        store.saveDraft(
          c.tenant,
          c.actor,
          id,
          { operationKey: randomUUID(), expectedDraftVersion: 1, draft: emptyTransformation },
          "wrong",
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it("requires fresh QA for amendment save and exact replay before parsing the body", async () => {
    const c = await seedTransformationRevision(f);
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...c.amendment.draft, notes: "QA correction" },
    };
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    await expect(
      c.store.saveDraft(c.tenant, c.actor, c.amendment.id, command, "denied-save"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      c.store.saveDraft(c.tenant, c.actor, c.amendment.id, null, "denied-before-body"),
    ).rejects.toMatchObject({ status: 403 });
    await f.db
      .update(schema.member)
      .set({ role: "traceability_qa" })
      .where(eq(schema.member.id, c.member));
    const saved = await c.store.saveDraft(c.tenant, c.actor, c.amendment.id, command, "qa-save");
    expect(saved).toMatchObject({ id: c.amendment.id, revision: 2, draftVersion: 2 });
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    await expect(
      c.store.saveDraft(c.tenant, c.actor, c.amendment.id, command, "denied-replay"),
    ).rejects.toMatchObject({ status: 403 });
    await f.db
      .update(schema.member)
      .set({ role: "traceability_qa" })
      .where(eq(schema.member.id, c.member));
    expect(
      await c.store.saveDraft(c.tenant, c.actor, c.amendment.id, command, "qa-replay"),
    ).toEqual(saved);
    await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: (
          await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
            expectedDraftVersion: saved.draftVersion,
          })
        ).inputDigest,
      },
      "qa-finalize",
    );
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    await expect(
      c.store.saveDraft(c.tenant, c.actor, c.amendment.id, command, "denied-finalized-replay"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("serializes concurrent saves and concurrent same-key creates", async () => {
    const c = await seedReceivingTenant(f.db);
    const command = { operationKey: randomUUID(), draft: emptyTransformation };
    const creates = await Promise.all([
      store.createDraft(c.tenant, c.actor, command, "a"),
      store.createDraft(c.tenant, c.actor, command, "b"),
    ]);
    expect(creates[0]).toEqual(creates[1]);
    const record = creates[0]!;
    const saves = await Promise.allSettled(
      ["a", "b"].map((notes) =>
        store.saveDraft(
          c.tenant,
          c.actor,
          record.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            draft: { ...emptyTransformation, notes },
          },
          notes,
        ),
      ),
    );
    expect(saves.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(saves.find((result) => result.status === "rejected")).toMatchObject({
      reason: { response: { code: "transformation_draft_conflict" } },
    });
    expect(await store.getRecord(c.tenant, c.actor, record.id)).toMatchObject({ draftVersion: 2 });
    const same = {
      operationKey: randomUUID(),
      expectedDraftVersion: 2,
      draft: emptyTransformation,
    };
    const repeated = await Promise.all([
      store.saveDraft(c.tenant, c.actor, record.id, same, "a"),
      store.saveDraft(c.tenant, c.actor, record.id, same, "b"),
    ]);
    expect(repeated[0]).toEqual(repeated[1]);
    expect(repeated[0]).toMatchObject({ draftVersion: 3 });
    await expect(
      store.saveDraft(
        c.tenant,
        c.actor,
        record.id,
        { ...same, draft: { ...emptyTransformation, notes: "different" } },
        "conflict",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_operation_conflict" } });
  });

  it("rejects foreign references and client supplied server facts without leaking rows", async () => {
    const c = await seedReceivingTenant(f.db),
      other = await seedReceivingTenant(f.db);
    for (const draft of [
      { ...emptyTransformation, processorLocationId: other.location },
      { ...emptyTransformation, documentIds: [other.document] },
      {
        ...emptyTransformation,
        inputs: [{ kind: "ftl_lot", lotId: other.lot, quantity: "1", unitOfMeasure: "lb" }],
      },
      {
        ...emptyTransformation,
        outputs: [{ productId: other.product, tlc: "x", quantity: "1", unitOfMeasure: "lb" }],
      },
    ])
      await expect(
        store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft }, "foreign"),
      ).rejects.toMatchObject({ response: { code: "transformation_reference_not_found" } });
    await expect(
      store.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: { ...emptyTransformation, coverage: "covered" } },
        "injected",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await f.db
        .select()
        .from(schema.transformationOperations)
        .where(eq(schema.transformationOperations.tenantId, c.tenant)),
    ).toHaveLength(0);
    expect(
      await f.db
        .select()
        .from(schema.transformationCounters)
        .where(eq(schema.transformationCounters.tenantId, c.tenant)),
    ).toHaveLength(0);
  });

  it("rolls back header, children, counter and receipt when audit insertion fails", async () => {
    const c = await seedReceivingTenant(f.db);
    const other = await seedReceivingTenant(f.db);
    const saved = await store.createDraft(
      other.tenant,
      other.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...emptyTransformation,
          reason: "repacking",
          documentIds: [other.document],
          outputs: [
            { productId: other.product, tlc: "kept", quantity: "1", unitOfMeasure: "case" },
          ],
        },
      },
      "before-failure",
    );
    await f.pool.query(
      "CREATE FUNCTION fail_transformation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'traceability.transformation.%' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_transformation_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION fail_transformation_audit()",
    );
    try {
      await expect(
        store.createDraft(
          c.tenant,
          c.actor,
          { operationKey: randomUUID(), draft: emptyTransformation },
          "audit",
        ),
      ).rejects.toThrow();
      for (const table of [
        schema.traceabilityEvents,
        schema.transformationEventRoots,
        schema.transformationEventDetails,
        schema.transformationCounters,
        schema.transformationOperations,
      ])
        expect(await f.db.select().from(table).where(eq(table.tenantId, c.tenant))).toHaveLength(0);
      await expect(
        store.saveDraft(
          other.tenant,
          other.actor,
          saved.id,
          { operationKey: randomUUID(), expectedDraftVersion: 1, draft: emptyTransformation },
          "audit-save",
        ),
      ).rejects.toThrow();
      expect(await store.getRecord(other.tenant, other.actor, saved.id)).toEqual(saved);
      expect(
        await f.db
          .select()
          .from(schema.transformationOperations)
          .where(eq(schema.transformationOperations.tenantId, other.tenant)),
      ).toHaveLength(1);
    } finally {
      await f.pool.query(
        "DROP TRIGGER fail_transformation_audit ON tenant_audit_events; DROP FUNCTION fail_transformation_audit()",
      );
    }
  });

  it("preserves typed roots and fails closed on absent details in a damaged transaction view", async () => {
    const c = await seedReceivingTenant(f.db);
    const record = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: emptyTransformation },
      "create",
    );
    await expect(
      f.db
        .delete(schema.transformationEventRoots)
        .where(eq(schema.transformationEventRoots.tenantId, c.tenant)),
    ).rejects.toThrow();
    for (const table of [schema.transformationEventDetails]) {
      await expect(
        f.db.transaction(async (tx) => {
          await tx.delete(table).where(eq(table.tenantId, c.tenant));
          await expect(readTransformationRecord(tx, c.tenant, record.id)).rejects.toMatchObject({
            status: 503,
            response: { code: "us_database_unavailable" },
          });
          throw new Error("rollback damaged specimen");
        }),
      ).rejects.toThrow("rollback damaged specimen");
    }
    expect(await store.getRecord(c.tenant, c.actor, record.id)).toEqual(record);
  });
});
