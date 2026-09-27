import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCurrentShippingBalance } from "../src/modules/traceability/shipping/us-shipping-balance";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  finalizeFixtureShipment,
  seedShippingLifecycle,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Shipping void and status compensation", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("voids the second of two shipments, keeps frozen bytes and allows no fictitious blocker", async () => {
    const c = await seedShippingLifecycle(f.db);
    await finalizeFixtureShipment(c, "20");
    const second = await finalizeFixtureShipment(c, "30");
    const frozen = structuredClone(second.snapshot);
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: second.lifecycle!.lifecycleVersion,
      reason: "Shipment cancelled",
    };
    const receipt = await c.store.void(c.tenant, c.actor, second.id, command, "void-second");
    expect(receipt).toMatchObject({ command: "shipping.void", record: { status: "void" } });
    expect(await c.store.void(c.tenant, c.actor, second.id, command, "retry")).toEqual(receipt);
    const historical = await c.store.getRecord(c.tenant, c.actor, second.id);
    expect(historical.status).toBe("void");
    if (historical.status !== "void" || !("snapshot" in historical))
      throw new Error("Expected finalized void history");
    expect(historical.snapshot).toEqual(frozen);
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot)),
    ).toMatchObject({ state: "known", remaining: "80" });
    expect(
      (await c.store.listRevisions(c.tenant, c.actor, second.id, { limit: 100, offset: 0 })).items,
    ).toMatchObject([{ status: "void" }]);
  });

  it("reopens only a still-owned full-shipment status effect", async () => {
    const c = await seedShippingLifecycle(f.db);
    const full = await finalizeFixtureShipment(c, "100");
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: full.lifecycle!.lifecycleVersion,
      reason: "Void dispatch",
    };
    await c.store.void(c.tenant, c.actor, full.id, command, "void-full");
    const [lot] = await f.db
      .select({ status: schema.traceabilityLots.status })
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(lot?.status).toBe("active");
    const effects = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(eq(schema.shippingLotStatusEffects.lotId, c.lot));
    expect(effects).toMatchObject([
      { eventId: full.id, compensatedAt: expect.any(Date), compensationReason: "Void dispatch" },
    ]);
  });

  it("preserves a manual recall that invalidated Shipping ownership before void", async () => {
    const c = await seedShippingLifecycle(f.db);
    const full = await finalizeFixtureShipment(c, "100");
    await f.db.transaction(async (tx) => {
      const lots = schema.traceabilityLots;
      await tx.select().from(lots).where(eq(lots.id, c.lot)).for("update");
      await tx
        .update(schema.shippingLotStatusEffects)
        .set({ compensatedAt: new Date(), compensationReason: "Manual recall" })
        .where(eq(schema.shippingLotStatusEffects.lotId, c.lot));
      await tx.update(lots).set({ status: "recalled" }).where(eq(lots.id, c.lot));
    });
    await c.store.void(
      c.tenant,
      c.actor,
      full.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: full.lifecycle!.lifecycleVersion,
        reason: "Void recalled shipment",
      },
      "void-recalled",
    );
    const [lot] = await f.db
      .select({ status: schema.traceabilityLots.status })
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(lot?.status).toBe("recalled");
  });

  it("voids a pending amendment without withdrawing its finalized predecessor", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "20");
    const started = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: original.lifecycle!.lifecycleVersion,
        reason: "Review",
      },
      "start",
    );
    await expect(
      c.store.void(
        c.tenant,
        c.actor,
        started.eventId,
        {
          operationKey: randomUUID(),
          expectedLifecycleVersion: started.record.lifecycle!.lifecycleVersion,
          reason: "Cancel",
          expectedDraftVersion: 2,
        },
        "stale-draft",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_draft_conflict" } });
    const receipt = await c.store.void(
      c.tenant,
      c.actor,
      started.eventId,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: started.record.lifecycle!.lifecycleVersion,
        reason: "Cancel",
        expectedDraftVersion: 1,
      },
      "void-draft",
    );
    expect(receipt.record.status).toBe("void");
    const old = await c.store.getRecord(c.tenant, c.actor, original.id);
    expect(old).toMatchObject({
      status: "finalized",
      lifecycle: { currentEventId: original.id, pendingDraftId: null },
    });
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot)),
    ).toMatchObject({ state: "known", remaining: "80" });
  });

  it("hides foreign tenant revisions and denies their lifecycle commands", async () => {
    const owner = await seedShippingLifecycle(f.db);
    const foreign = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(owner, "20");
    await expect(
      foreign.store.getRecord(foreign.tenant, foreign.actor, shipment.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      foreign.store.listRevisions(foreign.tenant, foreign.actor, shipment.id, {
        limit: 10,
        offset: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      foreign.store.amend(
        foreign.tenant,
        foreign.actor,
        shipment.id,
        {
          operationKey: randomUUID(),
          expectedLifecycleVersion: shipment.lifecycle!.lifecycleVersion,
          reason: "Foreign amend",
        },
        "foreign-amend",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      foreign.store.void(
        foreign.tenant,
        foreign.actor,
        shipment.id,
        {
          operationKey: randomUUID(),
          expectedLifecycleVersion: shipment.lifecycle!.lifecycleVersion,
          reason: "Foreign void",
        },
        "foreign-void",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await owner.store.getRecord(owner.tenant, owner.actor, shipment.id)).status).toBe(
      "finalized",
    );
  });
});
