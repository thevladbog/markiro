import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyShippingStatusEffect,
  compensateShippingStatusEffect,
} from "../src/modules/traceability/shipping/us-shipping-status-effects";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { readCurrentShippingBalance } from "../src/modules/traceability/shipping/us-shipping-balance";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Shipping status ownership in disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => f?.close());
  let nextNumber = 9100;
  async function seedTwoShippingEvents(
    c: Awaited<ReturnType<typeof seedFinalizableTransformation>>,
    lotId: string,
  ) {
    const a = randomUUID(),
      b = randomUUID();
    await f.db.transaction(async (tx) => {
      const recipientId = randomUUID();
      await tx.insert(schema.traceabilityLocations).values({
        id: recipientId,
        tenantId: c.tenant,
        partyId: c.party,
        name: "Synthetic recipient",
        businessName: "Synthetic recipient",
      });
      for (const [id, quantity] of [
        [a, "70"],
        [b, "30"],
      ] as const) {
        const eventNumber = `SHP-26-${++nextNumber}`;
        await tx.insert(schema.traceabilityEvents).values({
          id,
          tenantId: c.tenant,
          rootEventId: id,
          type: "shipping",
          eventNumber,
          timeZone: "America/Chicago",
          dateReceived: "2026-09-27",
          locationId: c.location,
          createdBy: c.actor,
          updatedBy: c.actor,
        });
        await tx.insert(schema.shippingEventRoots).values({
          id,
          tenantId: c.tenant,
          eventNumber,
          pendingDraftId: id,
        });
        await tx.insert(schema.shippingEventDetails).values({
          tenantId: c.tenant,
          eventId: id,
          recipientLocationId: recipientId,
          recipientSnapshot: { id: recipientId, description: "Synthetic recipient" },
        });
        await tx.insert(schema.shippingEventItems).values({
          tenantId: c.tenant,
          eventId: id,
          lineNo: 1,
          lotId,
          quantity,
          unitOfMeasure: "case",
          tlcSnapshot: "NEW-OUTPUT",
          sourceSnapshot: {},
          productSnapshot: {},
        });
        await tx.insert(schema.shippingEventDocuments).values({
          tenantId: c.tenant,
          eventId: id,
          documentId: c.document,
          position: 1,
        });
        const now = new Date();
        await tx
          .update(schema.traceabilityEvents)
          .set({
            status: "finalized",
            finalizedAt: now,
            finalizedBy: c.actor,
            updatedAt: now,
            updatedBy: c.actor,
            finalizationSnapshot: {},
          })
          .where(
            and(
              eq(schema.traceabilityEvents.tenantId, c.tenant),
              eq(schema.traceabilityEvents.id, id),
            ),
          );
        await tx
          .update(schema.shippingEventRoots)
          .set({
            currentEventId: id,
            pendingDraftId: null,
            lifecycleVersion: 2,
          })
          .where(
            and(
              eq(schema.shippingEventRoots.tenantId, c.tenant),
              eq(schema.shippingEventRoots.id, id),
            ),
          );
      }
    });
    return { a, b };
  }

  it("reopens B-owned shipped status when voiding earlier partial Shipping A", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    const { a, b } = await seedTwoShippingEvents(c, lotId);
    await f.db.transaction(async (tx) => {
      const exhausted = await readCurrentShippingBalance(tx, c.tenant, lotId);
      expect(exhausted).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "100",
        remaining: "0",
      });
      await applyShippingStatusEffect(tx, c.tenant, lotId, b, exhausted, {
        actorUserId: c.actor,
        requestId: "ship-b",
        reason: "A 70 plus B 30",
      });
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "void",
          voidedAt: new Date(),
          voidedBy: c.actor,
          voidReason: "Void A 70",
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, c.tenant),
            eq(schema.traceabilityEvents.id, a),
          ),
        );
      await tx
        .update(schema.shippingEventRoots)
        .set({
          currentEventId: null,
          lifecycleVersion: 3,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, c.tenant),
            eq(schema.shippingEventRoots.id, a),
          ),
        );
      const restored = await readCurrentShippingBalance(tx, c.tenant, lotId);
      expect(restored).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "30",
        remaining: "70",
      });
      await compensateShippingStatusEffect(tx, c.tenant, lotId, a, restored, {
        actorUserId: c.actor,
        requestId: "void-a",
        reason: "Void A 70",
      });
    });
    const [lot] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(eq(schema.traceabilityLots.tenantId, c.tenant), eq(schema.traceabilityLots.id, lotId)),
      );
    expect(lot?.status).toBe("active");
    const [effect] = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(
        and(
          eq(schema.shippingLotStatusEffects.tenantId, c.tenant),
          eq(schema.shippingLotStatusEffects.lotId, lotId),
        ),
      );
    expect(effect).toMatchObject({ eventId: b, compensationReason: "Void A 70" });
    expect(effect?.compensatedAt).not.toBeNull();
    const [audit] = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.requestId, "void-a"),
        ),
      );
    expect(audit).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.lot.status_changed",
      outcome: "success",
      targetType: "traceability_lot",
      targetId: lotId,
      requestId: "void-a",
      before: { id: lotId, status: "shipped", eventId: b },
      after: {
        id: lotId,
        status: "active",
        eventId: a,
        ownerEventId: b,
        initiatingEventId: a,
        reason: "Void A 70",
        origin: "shipping",
      },
    });
  });

  it("retains B ownership through equal-net C amendment, then reopens on void of A's root", async () => {
    const fixture = await seedFinalizableTransformation(f);
    const finalized = await fixture.store.finalize(
      fixture.tenant,
      fixture.actor,
      fixture.saved.id,
      fixture.command,
      "transform",
    );
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    const { a, b } = await seedTwoShippingEvents(fixture, lotId);
    const c = randomUUID();
    await f.db.transaction(async (tx) => {
      const exhausted = await readCurrentShippingBalance(tx, fixture.tenant, lotId);
      expect(exhausted).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "100",
        remaining: "0",
      });
      await applyShippingStatusEffect(tx, fixture.tenant, lotId, b, exhausted, {
        actorUserId: fixture.actor,
        requestId: "c-sequence-ship-b",
        reason: "A 70 plus B 30",
      });
    });
    await f.db.transaction(async (tx) => {
      const [priorEvent] = await tx
        .select()
        .from(schema.traceabilityEvents)
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, fixture.tenant),
            eq(schema.traceabilityEvents.id, a),
          ),
        );
      const [priorDetails] = await tx
        .select()
        .from(schema.shippingEventDetails)
        .where(
          and(
            eq(schema.shippingEventDetails.tenantId, fixture.tenant),
            eq(schema.shippingEventDetails.eventId, a),
          ),
        );
      const [priorLine] = await tx
        .select()
        .from(schema.shippingEventItems)
        .where(
          and(
            eq(schema.shippingEventItems.tenantId, fixture.tenant),
            eq(schema.shippingEventItems.eventId, a),
          ),
        );
      const [priorDocument] = await tx
        .select()
        .from(schema.shippingEventDocuments)
        .where(
          and(
            eq(schema.shippingEventDocuments.tenantId, fixture.tenant),
            eq(schema.shippingEventDocuments.eventId, a),
          ),
        );
      if (!priorEvent || !priorDetails || !priorLine || !priorDocument)
        throw new Error("Missing A revision evidence");
      await tx.insert(schema.traceabilityEvents).values({
        id: c,
        tenantId: fixture.tenant,
        rootEventId: a,
        type: "shipping",
        eventNumber: priorEvent.eventNumber,
        revision: 2,
        previousRevisionId: a,
        amendmentReason: "Same quantity, corrected document",
        timeZone: "America/Chicago",
        dateReceived: "2026-09-27",
        locationId: fixture.location,
        createdBy: fixture.actor,
        updatedBy: fixture.actor,
      });
      await tx
        .update(schema.shippingEventRoots)
        .set({
          pendingDraftId: c,
          nextRevision: 3,
          lifecycleVersion: 3,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, fixture.tenant),
            eq(schema.shippingEventRoots.id, a),
          ),
        );
      await tx.insert(schema.shippingEventDetails).values({ ...priorDetails, eventId: c });
      await tx.insert(schema.shippingEventItems).values({ ...priorLine, eventId: c });
      await tx.insert(schema.shippingEventDocuments).values({ ...priorDocument, eventId: c });
      const now = new Date();
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "amended",
          supersededByEventId: c,
          supersededAt: now,
          supersededBy: fixture.actor,
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, fixture.tenant),
            eq(schema.traceabilityEvents.id, a),
          ),
        );
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "finalized",
          finalizedAt: now,
          finalizedBy: fixture.actor,
          updatedAt: now,
          updatedBy: fixture.actor,
          finalizationSnapshot: {},
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, fixture.tenant),
            eq(schema.traceabilityEvents.id, c),
          ),
        );
      await tx
        .update(schema.shippingEventRoots)
        .set({
          currentEventId: c,
          pendingDraftId: null,
          lifecycleVersion: 4,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, fixture.tenant),
            eq(schema.shippingEventRoots.id, a),
          ),
        );
      const balance = await readCurrentShippingBalance(tx, fixture.tenant, lotId);
      expect(balance).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "100",
        remaining: "0",
      });
      await compensateShippingStatusEffect(tx, fixture.tenant, lotId, c, balance, {
        actorUserId: fixture.actor,
        requestId: "amend-c",
        reason: "Equal-net correction",
      });
    });
    const [stillShipped] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(
          eq(schema.traceabilityLots.tenantId, fixture.tenant),
          eq(schema.traceabilityLots.id, lotId),
        ),
      );
    expect(stillShipped?.status).toBe("shipped");
    const [stillOwned] = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(
        and(
          eq(schema.shippingLotStatusEffects.tenantId, fixture.tenant),
          eq(schema.shippingLotStatusEffects.lotId, lotId),
        ),
      );
    expect(stillOwned).toMatchObject({ eventId: b, compensatedAt: null, compensationReason: null });
    const amendmentAudits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenant),
          eq(schema.tenantAuditEvents.requestId, "amend-c"),
        ),
      );
    expect(amendmentAudits).toEqual([]);
    await f.db.transaction(async (tx) => {
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "void",
          voidedAt: new Date(),
          voidedBy: fixture.actor,
          voidReason: "Void A root",
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, fixture.tenant),
            eq(schema.traceabilityEvents.id, c),
          ),
        );
      await tx
        .update(schema.shippingEventRoots)
        .set({
          currentEventId: null,
          lifecycleVersion: 5,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, fixture.tenant),
            eq(schema.shippingEventRoots.id, a),
          ),
        );
      const balance = await readCurrentShippingBalance(tx, fixture.tenant, lotId);
      expect(balance).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "30",
        remaining: "70",
      });
      await compensateShippingStatusEffect(tx, fixture.tenant, lotId, c, balance, {
        actorUserId: fixture.actor,
        requestId: "void-a-root",
        reason: "Void A root",
      });
    });
    const [reopened] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(
          eq(schema.traceabilityLots.tenantId, fixture.tenant),
          eq(schema.traceabilityLots.id, lotId),
        ),
      );
    expect(reopened?.status).toBe("active");
    const [closed] = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(
        and(
          eq(schema.shippingLotStatusEffects.tenantId, fixture.tenant),
          eq(schema.shippingLotStatusEffects.lotId, lotId),
        ),
      );
    expect(closed).toMatchObject({ eventId: b, compensationReason: "Void A root" });
    expect(closed?.compensatedAt).not.toBeNull();
    const [audit] = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenant),
          eq(schema.tenantAuditEvents.requestId, "void-a-root"),
        ),
      );
    expect(audit).toMatchObject({
      organizationId: fixture.tenant,
      actorUserId: fixture.actor,
      action: "traceability.lot.status_changed",
      outcome: "success",
      targetType: "traceability_lot",
      targetId: lotId,
      before: { id: lotId, status: "shipped", eventId: b },
      after: {
        id: lotId,
        status: "active",
        eventId: c,
        ownerEventId: b,
        initiatingEventId: c,
        reason: "Void A root",
        origin: "shipping",
      },
    });
  });

  it("keeps manual recall when voiding A after B's status ownership was invalidated", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    const { a, b } = await seedTwoShippingEvents(c, lotId);
    await f.db.transaction(async (tx) => {
      const exhausted = await readCurrentShippingBalance(tx, c.tenant, lotId);
      expect(exhausted).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "100",
        remaining: "0",
      });
      await applyShippingStatusEffect(tx, c.tenant, lotId, b, exhausted, {
        actorUserId: c.actor,
        requestId: "manual-ship-b",
        reason: "A 70 plus B 30",
      });
    });
    await new UsLotStore(f.db).changeStatus(
      c.tenant,
      c.actor,
      lotId,
      {
        status: "recalled",
        expectedRevision: 2,
        reason: "Manual recall",
      },
      "manual-recall-b",
    );
    await f.db.transaction(async (tx) => {
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "void",
          voidedAt: new Date(),
          voidedBy: c.actor,
          voidReason: "Void A 70",
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, c.tenant),
            eq(schema.traceabilityEvents.id, a),
          ),
        );
      await tx
        .update(schema.shippingEventRoots)
        .set({
          currentEventId: null,
          lifecycleVersion: 3,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, c.tenant),
            eq(schema.shippingEventRoots.id, a),
          ),
        );
      const restored = await readCurrentShippingBalance(tx, c.tenant, lotId);
      expect(restored).toEqual({
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "30",
        remaining: "70",
      });
      await compensateShippingStatusEffect(tx, c.tenant, lotId, a, restored, {
        actorUserId: c.actor,
        requestId: "manual-void-a",
        reason: "Void A 70",
      });
    });
    const [lot] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(eq(schema.traceabilityLots.tenantId, c.tenant), eq(schema.traceabilityLots.id, lotId)),
      );
    expect(lot?.status).toBe("recalled");
    const [effect] = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(
        and(
          eq(schema.shippingLotStatusEffects.tenantId, c.tenant),
          eq(schema.shippingLotStatusEffects.lotId, lotId),
        ),
      );
    expect(effect).toMatchObject({ eventId: b, compensationReason: "Manual recall" });
    const voidAudits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.requestId, "manual-void-a"),
        ),
      );
    expect(voidAudits).toEqual([]);
  });

  it("preserves a later manual recall when the Shipping effect is compensated", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    const eventId = randomUUID();
    const context = {
      actorUserId: c.actor,
      requestId: "shipping-effect",
      reason: "Synthetic shipment",
    };
    await f.db.transaction(async (tx) => {
      await tx.insert(schema.traceabilityEvents).values({
        id: eventId,
        tenantId: c.tenant,
        rootEventId: eventId,
        type: "shipping",
        eventNumber: "SHP-26-9001",
        timeZone: "America/Chicago",
        createdBy: c.actor,
        updatedBy: c.actor,
      });
      await tx.insert(schema.shippingEventRoots).values({
        id: eventId,
        tenantId: c.tenant,
        eventNumber: "SHP-26-9001",
        pendingDraftId: eventId,
      });
      await applyShippingStatusEffect(
        tx,
        c.tenant,
        lotId,
        eventId,
        {
          state: "known",
          unitOfMeasure: "case",
          supply: "100",
          used: "100",
          remaining: "0",
        },
        context,
      );
    });
    const [automaticAudit] = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.requestId, "shipping-effect"),
        ),
      );
    expect(automaticAudit).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.lot.status_changed",
      outcome: "success",
      targetType: "traceability_lot",
      targetId: lotId,
      requestId: "shipping-effect",
      before: { id: lotId, status: "active" },
      after: {
        id: lotId,
        status: "shipped",
        eventId,
        origin: "shipping",
        reason: "Synthetic shipment",
      },
    });
    await new UsLotStore(f.db).changeStatus(
      c.tenant,
      c.actor,
      lotId,
      {
        status: "recalled",
        expectedRevision: 2,
        reason: "Manual recall",
      },
      "manual-recall",
    );
    await f.db.transaction(async (tx) => {
      await compensateShippingStatusEffect(
        tx,
        c.tenant,
        lotId,
        eventId,
        {
          state: "known",
          unitOfMeasure: "case",
          supply: "100",
          used: "0",
          remaining: "100",
        },
        { ...context, requestId: "void", reason: "Voided shipment" },
      );
    });
    const [lot] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(eq(schema.traceabilityLots.tenantId, c.tenant), eq(schema.traceabilityLots.id, lotId)),
      );
    expect(lot?.status).toBe("recalled");
    const effects = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(
        and(
          eq(schema.shippingLotStatusEffects.tenantId, c.tenant),
          eq(schema.shippingLotStatusEffects.lotId, lotId),
        ),
      );
    expect(effects).toHaveLength(1);
    expect(effects[0]?.compensationReason).toBe("Manual recall");
  });

  it("reopens only a still-owned shipped lot after positive balance returns", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    const eventId = randomUUID();
    await f.db.transaction(async (tx) => {
      await tx.insert(schema.traceabilityEvents).values({
        id: eventId,
        tenantId: c.tenant,
        rootEventId: eventId,
        type: "shipping",
        eventNumber: "SHP-26-9002",
        timeZone: "America/Chicago",
        createdBy: c.actor,
        updatedBy: c.actor,
      });
      await tx.insert(schema.shippingEventRoots).values({
        id: eventId,
        tenantId: c.tenant,
        eventNumber: "SHP-26-9002",
        pendingDraftId: eventId,
      });
      await applyShippingStatusEffect(
        tx,
        c.tenant,
        lotId,
        eventId,
        {
          state: "known",
          unitOfMeasure: "case",
          supply: "100",
          used: "100",
          remaining: "0",
        },
        { actorUserId: c.actor, requestId: "full-ship", reason: "Full shipment" },
      );
      await compensateShippingStatusEffect(
        tx,
        c.tenant,
        lotId,
        eventId,
        {
          state: "known",
          unitOfMeasure: "case",
          supply: "100",
          used: "0",
          remaining: "100",
        },
        { actorUserId: c.actor, requestId: "void-ship", reason: "Shipment void" },
      );
    });
    const [lot] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(eq(schema.traceabilityLots.tenantId, c.tenant), eq(schema.traceabilityLots.id, lotId)),
      );
    expect(lot?.status).toBe("active");
    const [effect] = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(
        and(
          eq(schema.shippingLotStatusEffects.tenantId, c.tenant),
          eq(schema.shippingLotStatusEffects.lotId, lotId),
        ),
      );
    expect(effect?.compensationReason).toBe("Shipment void");
    const [audit] = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.requestId, "void-ship"),
        ),
      );
    expect(audit).toMatchObject({
      actorUserId: c.actor,
      action: "traceability.lot.status_changed",
      outcome: "success",
      targetType: "traceability_lot",
      targetId: lotId,
      before: { id: lotId, status: "shipped" },
      after: { id: lotId, status: "active", eventId, origin: "shipping", reason: "Shipment void" },
    });
  });

  it("retains ownership without reopening when a recalculation has unknown balance", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    const eventId = randomUUID();
    await f.db.transaction(async (tx) => {
      await tx.insert(schema.traceabilityEvents).values({
        id: eventId,
        tenantId: c.tenant,
        rootEventId: eventId,
        type: "shipping",
        eventNumber: "SHP-26-9003",
        timeZone: "America/Chicago",
        createdBy: c.actor,
        updatedBy: c.actor,
      });
      await tx.insert(schema.shippingEventRoots).values({
        id: eventId,
        tenantId: c.tenant,
        eventNumber: "SHP-26-9003",
        pendingDraftId: eventId,
      });
      await applyShippingStatusEffect(
        tx,
        c.tenant,
        lotId,
        eventId,
        {
          state: "known",
          unitOfMeasure: "case",
          supply: "100",
          used: "100",
          remaining: "0",
        },
        { actorUserId: c.actor, requestId: "ship-unknown", reason: "Full shipment" },
      );
      await compensateShippingStatusEffect(
        tx,
        c.tenant,
        lotId,
        eventId,
        {
          state: "unknown",
          reason: "mixed_uom",
        },
        { actorUserId: c.actor, requestId: "void-unknown", reason: "Voided shipment" },
      );
    });
    const [lot] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(eq(schema.traceabilityLots.tenantId, c.tenant), eq(schema.traceabilityLots.id, lotId)),
      );
    expect(lot?.status).toBe("shipped");
    const [effect] = await f.db
      .select()
      .from(schema.shippingLotStatusEffects)
      .where(
        and(
          eq(schema.shippingLotStatusEffects.tenantId, c.tenant),
          eq(schema.shippingLotStatusEffects.lotId, lotId),
        ),
      );
    expect(effect).toMatchObject({ eventId, compensationReason: null, compensatedAt: null });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.requestId, "void-unknown"),
        ),
      );
    expect(audits).toEqual([]);
  });
});
