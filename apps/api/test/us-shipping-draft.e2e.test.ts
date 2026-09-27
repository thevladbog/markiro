import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const empty = {
  eventDate: null,
  shipFromLocationId: null,
  recipientLocationId: null,
  carrierReference: null,
  notes: null,
  items: [],
  documentIds: [],
};
describe.skipIf(!url)("Shipping draft commands", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsShippingStore;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
    store = new UsShippingStore(f.db);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("creates an incomplete SHP draft once, replays it, and audits exact result", async () => {
    const c = await seedReceivingTenant(f.db);
    const command = { operationKey: randomUUID(), draft: empty };
    const saved = await store.createDraft(c.tenant, c.actor, command, "create-shipping");
    expect(saved).toMatchObject({
      eventNumber: expect.stringMatching(/^SHP-\d{2}-0001$/),
      status: "draft",
      draftVersion: 1,
      timeZone: "America/Chicago",
      draft: empty,
    });
    expect(await store.createDraft(c.tenant, c.actor, command, "retry")).toEqual(saved);
    await expect(
      store.createDraft(
        c.tenant,
        c.actor,
        { ...command, draft: { ...empty, notes: "changed" } },
        "changed",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_operation_conflict" } });
    const audit = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, saved.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.shipping.draft_created",
      outcome: "success",
      targetType: "traceability_event",
      targetId: saved.id,
      before: null,
      after: saved,
      requestId: "create-shipping",
    });
  });

  it("persists selected lot with incomplete quantity and rejects stale save without writes", async () => {
    const c = await seedReceivingTenant(f.db);
    const original = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: empty },
      "create",
    );
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...empty, items: [{ lotId: c.lot, quantity: null, unitOfMeasure: null }] },
    };
    const saved = await store.saveDraft(c.tenant, c.actor, original.id, command, "save");
    expect(saved).toMatchObject({ draftVersion: 2, draft: command.draft });
    expect(await store.saveDraft(c.tenant, c.actor, original.id, command, "retry")).toEqual(saved);
    await expect(
      store.saveDraft(
        c.tenant,
        c.actor,
        original.id,
        { ...command, operationKey: randomUUID() },
        "stale",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_draft_conflict" } });
    expect(await store.getRecord(c.tenant, c.actor, original.id)).toEqual(saved);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, original.id));
    expect(audits).toHaveLength(2);
    expect(audits.find((row) => row.action === "traceability.shipping.draft_saved")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      before: original,
      after: saved,
      requestId: "save",
    });
  });

  it("hides wrong-tenant references and refuses client-owned TLC fields", async () => {
    const c = await seedReceivingTenant(f.db),
      foreign = await seedReceivingTenant(f.db);
    for (const draft of [
      { ...empty, items: [{ lotId: foreign.lot, quantity: null, unitOfMeasure: null }] },
      { ...empty, shipFromLocationId: foreign.location },
      { ...empty, recipientLocationId: foreign.location },
      { ...empty, documentIds: [foreign.document] },
    ])
      await expect(
        store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft }, "foreign"),
      ).rejects.toMatchObject({ status: 404, response: { code: "shipping_reference_not_found" } });
    await expect(
      store.createDraft(
        c.tenant,
        c.actor,
        {
          operationKey: randomUUID(),
          draft: {
            ...empty,
            items: [{ lotId: c.lot, quantity: "1", unitOfMeasure: "case", tlc: "NEW" }],
          },
        },
        "tlc",
      ),
    ).rejects.toMatchObject({ status: 400 });
    const foreignEvent = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      { operationKey: randomUUID(), draft: empty },
      "event",
    );
    await expect(store.getRecord(c.tenant, c.actor, foreignEvent.id)).rejects.toMatchObject({
      status: 404,
      response: { code: "shipping_not_found" },
    });
  });

  it("rechecks current membership before command replay", async () => {
    const c = await seedReceivingTenant(f.db);
    const command = { operationKey: randomUUID(), draft: empty };
    await store.createDraft(c.tenant, c.actor, command, "allowed");
    await f.db.update(schema.member).set({ role: "viewer" }).where(eq(schema.member.id, c.member));
    await expect(store.createDraft(c.tenant, c.actor, command, "denied")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("serializes concurrent retries of one create key to one event", async () => {
    const c = await seedReceivingTenant(f.db);
    const command = { operationKey: randomUUID(), draft: empty };
    const [first, second] = await Promise.all([
      store.createDraft(c.tenant, c.actor, command, "concurrent-1"),
      store.createDraft(c.tenant, c.actor, command, "concurrent-2"),
    ]);
    expect(second.id).toBe(first.id);
    const receipts = await f.db
      .select()
      .from(schema.shippingOperations)
      .where(eq(schema.shippingOperations.tenantId, c.tenant));
    expect(receipts).toHaveLength(1);
  });
});
