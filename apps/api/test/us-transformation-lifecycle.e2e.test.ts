import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation amendment draft lifecycle", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("starts one copied revision under QA, preserves current evidence, and replays exactly", async () => {
    const c = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "original");
    const [lotBefore] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, original.snapshot.outputs[0]!.lotId));
    const input = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correct documents",
    };
    const receipt = await c.store.amend(c.tenant, c.actor, original.id, input, "amend");
    expect(receipt).toMatchObject({
      receiptVersion: 1,
      command: "transformation.amend",
      eventId: expect.any(String),
      record: {
        status: "draft",
        revision: 2,
        draft: original.snapshot ? c.saved.draft : undefined,
      },
    });
    expect(receipt.record.id).not.toBe(original.id);
    expect(await c.store.amend(c.tenant, c.actor, original.id, input, "replay")).toEqual(receipt);
    const [root] = await f.db
      .select()
      .from(schema.transformationEventRoots)
      .where(eq(schema.transformationEventRoots.id, original.id));
    expect(root).toMatchObject({
      currentEventId: original.id,
      pendingDraftId: receipt.eventId,
      nextRevision: 3,
      lifecycleVersion: 3,
    });
    expect(await c.store.getRecord(c.tenant, c.actor, original.id)).toMatchObject({
      status: "finalized",
      snapshot: original.snapshot,
    });
    const outputs = await f.db
      .select()
      .from(schema.transformationEventOutputs)
      .where(
        and(
          eq(schema.transformationEventOutputs.tenantId, c.tenant),
          eq(schema.transformationEventOutputs.eventId, receipt.eventId),
        ),
      );
    expect(
      outputs.map(({ lineNo, lotId, productId, tlc }) => ({ lineNo, lotId, productId, tlc })),
    ).toEqual(
      original.snapshot.outputs.map(({ lineNo, lotId, product, tlc }) => ({
        lineNo,
        lotId,
        productId: product.id,
        tlc,
      })),
    );
    const edges = await f.db
      .select()
      .from(schema.lotGenealogyEdges)
      .where(eq(schema.lotGenealogyEdges.eventId, receipt.eventId));
    expect(edges).toEqual([]);
    const [lotAfter] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, original.snapshot.outputs[0]!.lotId));
    expect(lotAfter).toEqual(lotBefore);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.targetId, receipt.eventId),
        ),
      );
    expect(audits).toMatchObject([
      {
        organizationId: c.tenant,
        actorUserId: c.actor,
        action: "traceability.transformation.amendment_started",
        targetType: "traceability_event",
        targetId: receipt.eventId,
        outcome: "success",
        before: original,
        after: {
          rootId: original.id,
          reason: input.reason,
          result: "draft_started",
          record: receipt.record,
        },
        requestId: "amend",
      },
    ]);
    await expect(
      c.store.amend(
        c.tenant,
        c.actor,
        original.id,
        { ...input, operationKey: randomUUID(), expectedLifecycleVersion: 3 },
        "second",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_pending_amendment" } });
    await expect(
      c.store.amend(c.tenant, c.actor, original.id, { ...input, reason: "Other" }, "digest"),
    ).rejects.toMatchObject({ response: { code: "transformation_operation_conflict" } });
  });

  it("rejects stale versions and unauthorized replay without creating a draft", async () => {
    const c = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "original");
    const input = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 1,
      reason: "Wrong version",
    };
    await expect(
      c.store.amend(c.tenant, c.actor, original.id, input, "stale"),
    ).rejects.toMatchObject({ response: { code: "transformation_lifecycle_conflict" } });
    const [root] = await f.db
      .select()
      .from(schema.transformationEventRoots)
      .where(eq(schema.transformationEventRoots.id, original.id));
    expect(root?.pendingDraftId).toBeNull();
    const good = { ...input, operationKey: randomUUID(), expectedLifecycleVersion: 2 };
    await f.db.update(schema.member).set({ role: "viewer" }).where(eq(schema.member.id, c.member));
    await expect(
      c.store.amend(c.tenant, c.actor, original.id, good, "unauthorized"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps each output lot binding through save and rejects detectable swaps", async () => {
    const c = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "original");
    const receipt = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Quantity correction" },
      "amend",
    );
    const eventId = receipt.eventId;
    const draft = receipt.record.status === "draft" ? receipt.record.draft : c.saved.draft;
    const changed = {
      ...draft,
      outputs: draft.outputs.map((line) => ({ ...line, quantity: "101" })),
    };
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      eventId,
      { operationKey: randomUUID(), expectedDraftVersion: 1, draft: changed },
      "save",
    );
    expect(saved).toMatchObject({ draftVersion: 2, draft: changed });
    const [bound] = await f.db
      .select()
      .from(schema.transformationEventOutputs)
      .where(eq(schema.transformationEventOutputs.eventId, eventId));
    expect(bound?.lotId).toBe(original.snapshot.outputs[0]?.lotId);
    for (const outputs of [
      [],
      [{ ...changed.outputs[0], tlc: "SWAPPED" }],
      [changed.outputs[0], changed.outputs[0]],
    ]) {
      await expect(
        c.store.saveDraft(
          c.tenant,
          c.actor,
          eventId,
          { operationKey: randomUUID(), expectedDraftVersion: 2, draft: { ...changed, outputs } },
          "invalid",
        ),
      ).rejects.toMatchObject({ response: { code: "transformation_output_identity_locked" } });
    }
    await expect(
      c.store.saveDraft(
        c.tenant,
        c.actor,
        eventId,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 2,
          draft: { ...changed, processorLocationId: c.location },
        },
        "processor-change",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_output_identity_locked" } });
    await expect(
      c.store.saveDraft(
        c.tenant,
        c.actor,
        eventId,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 2,
          draft: { ...changed, outputs: [{ ...changed.outputs[0], lotId: randomUUID() }] },
        },
        "client-lot",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect((await c.store.getRecord(c.tenant, c.actor, original.id)).status).toBe("finalized");
    expect((await c.store.getRecord(c.tenant, c.actor, eventId)).draftVersion).toBe(2);
  });

  it("rejects reordering two distinct output identities by line number", async () => {
    const c = await seedFinalizableTransformation(f);
    const secondOutput = { ...c.saved.draft.outputs[0]!, tlc: "NEW-OUTPUT-B" };
    const twoOutputs = { ...c.saved.draft, outputs: [...c.saved.draft.outputs, secondOutput] };
    await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.saved.id,
      { operationKey: randomUUID(), expectedDraftVersion: 1, draft: twoOutputs },
      "two-outputs",
    );
    const readiness = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
      expectedDraftVersion: 2,
    });
    const original = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 2,
        expectedInputDigest: readiness.inputDigest,
      },
      "finalize-two",
    );
    const amendment = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Correction" },
      "amend-two",
    );
    if (amendment.record.status !== "draft") throw new Error("Expected amendment draft");
    const swapped = {
      ...amendment.record.draft,
      outputs: [amendment.record.draft.outputs[1]!, amendment.record.draft.outputs[0]!],
    };
    await expect(
      c.store.saveDraft(
        c.tenant,
        c.actor,
        amendment.eventId,
        { operationKey: randomUUID(), expectedDraftVersion: 1, draft: swapped },
        "swap",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_output_identity_locked" } });
    const bound = await f.db
      .select()
      .from(schema.transformationEventOutputs)
      .where(eq(schema.transformationEventOutputs.eventId, amendment.eventId));
    expect(bound.sort((a, b) => a.lineNo - b.lineNo).map((line) => line.lotId)).toEqual(
      original.snapshot.outputs.map((line) => line.lotId),
    );
  });

  it("voids only the pending draft and preserves the current predecessor", async () => {
    const c = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "original");
    const amendment = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Incorrect note" },
      "amend",
    );
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 3,
      expectedDraftVersion: 1,
      reason: "Cancel draft",
    };
    const receipt = await c.store.void(c.tenant, c.actor, amendment.eventId, command, "void-draft");
    expect(receipt).toMatchObject({
      command: "transformation.void",
      record: {
        status: "void",
        revision: 2,
        lifecycle: {
          currentEventId: original.id,
          pendingDraftId: null,
          voidReason: "Cancel draft",
        },
      },
    });
    expect(await c.store.void(c.tenant, c.actor, amendment.eventId, command, "replay")).toEqual(
      receipt,
    );
    expect(await c.store.getRecord(c.tenant, c.actor, original.id)).toMatchObject({
      status: "finalized",
      snapshot: original.snapshot,
    });
    const [root] = await f.db
      .select()
      .from(schema.transformationEventRoots)
      .where(eq(schema.transformationEventRoots.id, original.id));
    expect(root).toMatchObject({
      currentEventId: original.id,
      pendingDraftId: null,
      lifecycleVersion: 4,
      nextRevision: 3,
    });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.targetId, amendment.eventId),
        ),
      );
    expect(
      audits.find((audit) => audit.action === "traceability.transformation.voided"),
    ).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.transformation.voided",
      targetType: "traceability_event",
      targetId: amendment.eventId,
      outcome: "success",
      before: amendment.record,
      after: {
        rootId: original.id,
        reason: "Cancel draft",
        result: "voided",
        record: receipt.record,
      },
      requestId: "void-draft",
    });
    await expect(
      c.store.void(
        c.tenant,
        c.actor,
        original.id,
        { ...command, operationKey: randomUUID(), expectedLifecycleVersion: 4 },
        "finalized-with-draft-version",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_draft_conflict" } });
  });

  it("hides foreign and wrong-type IDs before exposing lifecycle details", async () => {
    const c = await seedFinalizableTransformation(f);
    const other = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "original");
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correction",
    };
    await expect(
      other.store.amend(other.tenant, other.actor, original.id, command, "foreign"),
    ).rejects.toMatchObject({ status: 404, response: { code: "transformation_not_found" } });
    await expect(
      c.store.amend(c.tenant, c.actor, c.origin.id, command, "receiving-id"),
    ).rejects.toMatchObject({ status: 404, response: { code: "transformation_not_found" } });
  });

  it("rolls back copied children, pointer, receipt, and audit when audit insertion fails", async () => {
    const c = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "original");
    await f.pool.query(
      `CREATE FUNCTION reject_transformation_amendment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.transformation.amendment_started' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`,
    );
    await f.pool.query(
      `CREATE TRIGGER reject_transformation_amendment_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_transformation_amendment_audit()`,
    );
    try {
      await expect(
        c.store.amend(
          c.tenant,
          c.actor,
          original.id,
          { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Correction" },
          "failure",
        ),
      ).rejects.toThrow();
    } finally {
      await f.pool.query(
        `DROP TRIGGER reject_transformation_amendment_audit ON tenant_audit_events`,
      );
      await f.pool.query(`DROP FUNCTION reject_transformation_amendment_audit()`);
    }
    const [root] = await f.db
      .select()
      .from(schema.transformationEventRoots)
      .where(eq(schema.transformationEventRoots.id, original.id));
    expect(root).toMatchObject({
      currentEventId: original.id,
      pendingDraftId: null,
      nextRevision: 2,
      lifecycleVersion: 2,
    });
    const revisions = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(
        and(
          eq(schema.traceabilityEvents.tenantId, c.tenant),
          eq(schema.traceabilityEvents.rootEventId, original.id),
        ),
      );
    expect(revisions.map((revision) => revision.id)).toEqual([original.id]);
    const operations = await f.db
      .select()
      .from(schema.transformationOperations)
      .where(
        and(
          eq(schema.transformationOperations.tenantId, c.tenant),
          eq(schema.transformationOperations.command, "transformation.amend"),
        ),
      );
    expect(operations).toEqual([]);
    expect(await c.store.getRecord(c.tenant, c.actor, original.id)).toMatchObject({
      status: "finalized",
      snapshot: original.snapshot,
    });
  });
});
