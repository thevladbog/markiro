import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCurrentShippingBalance } from "../src/modules/traceability/shipping/us-shipping-balance";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  finalizeFixtureShipment,
  seedShippingLifecycle,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Shipping amendment revisions", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("keeps predecessor current, replaces 30 with 25, and preserves frozen history", async () => {
    const c = await seedShippingLifecycle(f.db);
    await finalizeFixtureShipment(c, "20");
    const original = await finalizeFixtureShipment(c, "30");
    const frozen = structuredClone(original.snapshot);
    const started = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: original.lifecycle?.lifecycleVersion,
        reason: "Correct 30 to 25",
      },
      "amend-start",
    );
    expect(started.command).toBe("shipping.amend");
    expect(started.record).toMatchObject({ status: "draft", revision: 2, draft: original.draft });
    const pending = await c.store.getRecord(c.tenant, c.actor, original.id);
    expect(pending).toMatchObject({
      status: "finalized",
      lifecycle: { currentEventId: original.id, pendingDraftId: started.eventId },
    });
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      started.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...original.draft,
          items: [{ lotId: c.lot, quantity: "25", unitOfMeasure: "case" }],
        },
      },
      "amend-save",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, started.eventId, {
      expectedDraftVersion: saved.draftVersion,
    });
    expect(ready.state).toBe("complete");
    const successor = await c.store.finalize(
      c.tenant,
      c.actor,
      started.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "amend-final",
    );
    expect(successor).toMatchObject({
      status: "finalized",
      revision: 2,
      lifecycle: { currentEventId: started.eventId, pendingDraftId: null },
    });
    const old = await c.store.getRecord(c.tenant, c.actor, original.id);
    expect(old).toMatchObject({
      status: "amended",
      lifecycle: { supersededByEventId: successor.id },
    });
    if (old.status !== "amended") throw new Error("Expected amended history");
    expect(old.snapshot).toEqual(frozen);
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot)),
    ).toMatchObject({ state: "known", remaining: "55" });
    const page = await c.store.listRevisions(c.tenant, c.actor, original.id, {
      limit: 2,
      offset: 0,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items.map((row) => row.status)).toEqual(["amended", "finalized"]);
    const after = await c.store.listRevisions(c.tenant, c.actor, successor.id, {
      limit: 1,
      offset: 1,
    });
    expect(after.items.map((row) => row.id)).toEqual([successor.id]);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.targetId, successor.id),
        ),
      );
    expect(
      audits.some(
        (row) =>
          row.action === "traceability.shipping.finalized" &&
          row.actorUserId === c.actor &&
          row.requestId === "amend-final",
      ),
    ).toBe(true);
  });

  it("retries an amendment key and rejects stale lifecycle versions without extra revisions", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "20");
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: original.lifecycle!.lifecycleVersion,
      reason: "Reviewed correction",
    };
    const started = await c.store.amend(c.tenant, c.actor, original.id, command, "amend");
    expect(await c.store.amend(c.tenant, c.actor, original.id, command, "retry")).toEqual(started);
    await expect(
      c.store.amend(
        c.tenant,
        c.actor,
        original.id,
        { ...command, reason: "Changed reason" },
        "different",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_operation_conflict" } });
    await expect(
      c.store.amend(
        c.tenant,
        c.actor,
        original.id,
        { ...command, operationKey: randomUUID() },
        "stale",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_lifecycle_conflict" } });
    expect(
      (await c.store.listRevisions(c.tenant, c.actor, original.id, { limit: 100, offset: 0 }))
        .items,
    ).toHaveLength(2);
  });

  it("replaces a full shipment without treating predecessor-owned shipped status as a manual block", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "100");
    const started = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: original.lifecycle!.lifecycleVersion,
        reason: "Correct quantity",
      },
      "full-amend",
    );
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      started.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...original.draft,
          items: [{ lotId: c.lot, quantity: "90", unitOfMeasure: "case" }],
        },
      },
      "full-save",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, started.eventId, {
      expectedDraftVersion: saved.draftVersion,
    });
    expect(ready).toMatchObject({ state: "complete", issues: [] });
    await c.store.finalize(
      c.tenant,
      c.actor,
      started.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "full-final",
    );
    const [lot] = await f.db
      .select({ status: schema.traceabilityLots.status })
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(lot?.status).toBe("active");
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot)),
    ).toMatchObject({ state: "known", remaining: "10" });
  });

  it("transfers a full-to-full status owner to the finalized successor in one transaction", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "100");
    const started = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: original.lifecycle!.lifecycleVersion,
        reason: "Correct documentation",
      },
      "full-start",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, started.eventId, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
    const successor = await c.store.finalize(
      c.tenant,
      c.actor,
      started.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "full-replace",
    );
    const [lot] = await f.db
      .select({ status: schema.traceabilityLots.status })
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(lot?.status).toBe("shipped");
    const effects = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(eq(schema.shippingLotStatusEffects.lotId, c.lot));
    expect(effects).toHaveLength(2);
    expect(effects.find((row) => row.eventId === original.id)?.compensatedAt).toBeInstanceOf(Date);
    expect(effects.find((row) => row.eventId === successor.id)?.compensatedAt).toBeNull();
    expect((await c.store.getRecord(c.tenant, c.actor, original.id)).status).toBe("amended");
    const transfer = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.action, "traceability.shipping.status_effect_transferred"),
          eq(schema.tenantAuditEvents.requestId, "full-replace"),
        ),
      );
    expect(transfer).toMatchObject([
      {
        organizationId: c.tenant,
        actorUserId: c.actor,
        targetType: "shipping_status_effect",
        targetId: effects.find((row) => row.eventId === successor.id)?.id,
        before: { eventId: original.id, lotId: c.lot, status: "shipped" },
        after: { eventId: successor.id, lotId: c.lot, status: "shipped" },
      },
    ]);
  });

  it("rolls back predecessor and status ownership after a successor write fails", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "100");
    const started = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: original.lifecycle!.lifecycleVersion,
        reason: "Correct quantity",
      },
      "rollback-start",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, started.eventId, {
      expectedDraftVersion: 1,
    });
    await f.db.execute(
      sql.raw(
        `CREATE FUNCTION shipping_test_fail_successor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${started.eventId}' AND NEW.status = 'finalized' THEN RAISE EXCEPTION 'synthetic successor failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await f.db.execute(
      sql.raw(
        "CREATE TRIGGER shipping_test_fail_successor BEFORE UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION shipping_test_fail_successor()",
      ),
    );
    try {
      await expect(
        c.store.finalize(
          c.tenant,
          c.actor,
          started.eventId,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: ready.inputDigest,
          },
          "rollback-final",
        ),
      ).rejects.toMatchObject({ cause: { message: "synthetic successor failure" } });
    } finally {
      await f.db.execute(
        sql.raw("DROP TRIGGER shipping_test_fail_successor ON traceability_events"),
      );
      await f.db.execute(sql.raw("DROP FUNCTION shipping_test_fail_successor()"));
    }
    expect(await c.store.getRecord(c.tenant, c.actor, original.id)).toMatchObject({
      status: "finalized",
      lifecycle: { currentEventId: original.id, pendingDraftId: started.eventId },
    });
    expect((await c.store.getRecord(c.tenant, c.actor, started.eventId)).status).toBe("draft");
    const active = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(eq(schema.shippingLotStatusEffects.lotId, c.lot));
    expect(active).toMatchObject([{ eventId: original.id, compensatedAt: null }]);
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot)),
    ).toMatchObject({ state: "known", remaining: "0" });
  });
});
