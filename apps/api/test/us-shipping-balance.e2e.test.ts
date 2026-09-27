import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCurrentShippingBalance } from "../src/modules/traceability/shipping/us-shipping-balance";
import { bumpLotDependencyVersions } from "../src/modules/traceability/lots/us-current-consumers";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("current Shipping balance in disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => f?.close());

  let number = 8000;
  async function writeShipment(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    locationId: string,
    partyId: string,
    documentId: string,
    lotId: string,
    quantity: string,
    unitOfMeasure: string,
    finalize = true,
  ) {
    const eventId = randomUUID(),
      eventNumber = `SHP-26-${++number}`;
    const recipientId = randomUUID();
    await tx.insert(schema.traceabilityLocations).values({
      id: recipientId,
      tenantId,
      partyId,
      name: "Recipient",
      businessName: "Recipient",
    });
    await tx.insert(schema.traceabilityEvents).values({
      id: eventId,
      tenantId,
      rootEventId: eventId,
      type: "shipping",
      eventNumber,
      timeZone: "America/Chicago",
      dateReceived: "2026-09-27",
      locationId,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
    await tx.insert(schema.shippingEventRoots).values({
      id: eventId,
      tenantId,
      eventNumber,
      pendingDraftId: eventId,
    });
    await tx.insert(schema.shippingEventDetails).values({
      tenantId,
      eventId,
      recipientLocationId: recipientId,
      recipientSnapshot: { id: recipientId, description: "Recipient" },
    });
    await tx.insert(schema.shippingEventItems).values({
      tenantId,
      eventId,
      lineNo: 1,
      lotId,
      quantity,
      unitOfMeasure,
      tlcSnapshot: "NEW-OUTPUT",
      sourceSnapshot: {},
      productSnapshot: {},
    });
    await tx.insert(schema.shippingEventDocuments).values({
      tenantId,
      eventId,
      documentId,
      position: 1,
    });
    if (finalize) {
      await bumpLotDependencyVersions(tx, tenantId, [lotId]);
      const now = new Date();
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "finalized",
          finalizedAt: now,
          finalizedBy: actorUserId,
          updatedAt: now,
          updatedBy: actorUserId,
          finalizationSnapshot: {},
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, tenantId),
            eq(schema.traceabilityEvents.id, eventId),
          ),
        );
      await tx
        .update(schema.shippingEventRoots)
        .set({
          currentEventId: eventId,
          pendingDraftId: null,
          lifecycleVersion: 2,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, tenantId),
            eq(schema.shippingEventRoots.id, eventId),
          ),
        );
    }
    return eventId;
  }
  function shipment(
    tenantId: string,
    actorUserId: string,
    locationId: string,
    partyId: string,
    documentId: string,
    lotId: string,
    quantity: string,
    unitOfMeasure: string,
    finalize = true,
  ) {
    return f.db.transaction((tx) =>
      writeShipment(
        tx,
        tenantId,
        actorUserId,
        locationId,
        partyId,
        documentId,
        lotId,
        quantity,
        unitOfMeasure,
        finalize,
      ),
    );
  }

  it("counts only the exact tenant's current finalized Transformation output", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    expect(await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, lotId))).toEqual(
      {
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "0",
        remaining: "100",
      },
    );
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, randomUUID(), lotId)),
    ).toEqual({ state: "unknown", reason: "no_current_origin" });
  });

  it("does not count an unfinalized output or a manually entered lot as supply", async () => {
    const c = await seedFinalizableTransformation(f);
    expect(await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot))).toEqual(
      {
        state: "known",
        unitOfMeasure: "lb",
        supply: "500",
        used: "0",
        remaining: "500",
      },
    );
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, randomUUID())),
    ).toEqual({
      state: "unknown",
      reason: "no_current_origin",
    });
  });

  it("adds every current Receiving support and deducts current Transformation input use", async () => {
    const c = await seedFinalizableTransformation(f);
    const linkedLine = c.draft.items[1];
    if (!linkedLine) throw new Error("Missing linked Receiving line");
    const extra = await c.receiving.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: { ...c.draft, items: [{ ...linkedLine, quantity: "25", unitOfMeasure: "lb" }] },
      },
      "extra-receipt",
    );
    const checked = await c.receiving.checkReadiness(c.tenant, c.actor, extra.id, {
      expectedDraftVersion: 1,
    });
    if (checked.state !== "complete") throw new Error("Extra receipt incomplete");
    await c.receiving.finalize(
      c.tenant,
      c.actor,
      extra.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: checked.inputDigest,
      },
      "extra-finalize",
    );
    expect(await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot))).toEqual(
      { state: "known", unitOfMeasure: "lb", supply: "525", used: "0", remaining: "525" },
    );
    const refreshed = await c.store.checkReadiness(c.tenant, c.actor, c.saved.id, {
      expectedDraftVersion: 1,
    });
    if (refreshed.state !== "complete") throw new Error("Transformation incomplete");
    await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      {
        ...c.command,
        expectedInputDigest: refreshed.inputDigest,
      },
      "transform",
    );
    expect(await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot))).toEqual(
      { state: "known", unitOfMeasure: "lb", supply: "525", used: "500", remaining: "25" },
    );
  });

  it("deducts only current finalized Shipping lines, and excludes the replaced event", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    await shipment(c.tenant, c.actor, c.location, c.party, c.document, lotId, "80", "case", false);
    const voidId = await shipment(
      c.tenant,
      c.actor,
      c.location,
      c.party,
      c.document,
      lotId,
      "25",
      "case",
    );
    await f.db.transaction(async (tx) => {
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "void",
          voidedAt: new Date(),
          voidedBy: c.actor,
          voidReason: "Cancelled",
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, c.tenant),
            eq(schema.traceabilityEvents.id, voidId),
          ),
        );
      await tx
        .update(schema.shippingEventRoots)
        .set({ currentEventId: null, lifecycleVersion: 3 })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, c.tenant),
            eq(schema.shippingEventRoots.id, voidId),
          ),
        );
    });
    const currentId = await shipment(
      c.tenant,
      c.actor,
      c.location,
      c.party,
      c.document,
      lotId,
      "30",
      "case",
    );
    expect(await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, lotId))).toEqual(
      {
        state: "known",
        unitOfMeasure: "case",
        supply: "100",
        used: "30",
        remaining: "70",
      },
    );
    expect(
      await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, lotId, currentId)),
    ).toEqual({
      state: "known",
      unitOfMeasure: "case",
      supply: "100",
      used: "0",
      remaining: "100",
    });
    const successorId = randomUUID();
    await f.db.transaction(async (tx) => {
      const [priorDetails] = await tx
        .select()
        .from(schema.shippingEventDetails)
        .where(
          and(
            eq(schema.shippingEventDetails.tenantId, c.tenant),
            eq(schema.shippingEventDetails.eventId, currentId),
          ),
        );
      const [priorLine] = await tx
        .select()
        .from(schema.shippingEventItems)
        .where(
          and(
            eq(schema.shippingEventItems.tenantId, c.tenant),
            eq(schema.shippingEventItems.eventId, currentId),
          ),
        );
      const [priorDocument] = await tx
        .select()
        .from(schema.shippingEventDocuments)
        .where(
          and(
            eq(schema.shippingEventDocuments.tenantId, c.tenant),
            eq(schema.shippingEventDocuments.eventId, currentId),
          ),
        );
      if (!priorDetails || !priorLine || !priorDocument)
        throw new Error("Missing predecessor Shipping evidence");
      await tx.insert(schema.traceabilityEvents).values({
        id: successorId,
        tenantId: c.tenant,
        rootEventId: currentId,
        previousRevisionId: currentId,
        amendmentReason: "Correct quantity",
        type: "shipping",
        eventNumber: `SHP-26-${number}`,
        revision: 2,
        timeZone: "America/Chicago",
        dateReceived: "2026-09-27",
        locationId: c.location,
        createdBy: c.actor,
        updatedBy: c.actor,
      });
      await tx
        .update(schema.shippingEventRoots)
        .set({
          pendingDraftId: successorId,
          nextRevision: 3,
          lifecycleVersion: 3,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, c.tenant),
            eq(schema.shippingEventRoots.id, currentId),
          ),
        );
      await tx.insert(schema.shippingEventDetails).values({
        ...priorDetails,
        eventId: successorId,
      });
      await tx.insert(schema.shippingEventItems).values({
        ...priorLine,
        eventId: successorId,
        quantity: "35",
      });
      await tx.insert(schema.shippingEventDocuments).values({
        ...priorDocument,
        eventId: successorId,
      });
      const now = new Date();
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "amended",
          supersededByEventId: successorId,
          supersededAt: now,
          supersededBy: c.actor,
        })
        .where(
          and(
            eq(schema.traceabilityEvents.tenantId, c.tenant),
            eq(schema.traceabilityEvents.id, currentId),
          ),
        );
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
            eq(schema.traceabilityEvents.id, successorId),
          ),
        );
      await tx
        .update(schema.shippingEventRoots)
        .set({
          currentEventId: successorId,
          pendingDraftId: null,
          lifecycleVersion: 4,
        })
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, c.tenant),
            eq(schema.shippingEventRoots.id, currentId),
          ),
        );
    });
    expect(await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, lotId))).toEqual(
      { state: "known", unitOfMeasure: "case", supply: "100", used: "35", remaining: "65" },
    );
  });

  it("fails closed as unknown when current quantity evidence mixes units", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    await shipment(c.tenant, c.actor, c.location, c.party, c.document, lotId, "1", "each");
    expect(await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, lotId))).toEqual(
      { state: "unknown", reason: "mixed_uom" },
    );
  });

  it("blocks a Receiving void while a current Shipping event consumes its lot", async () => {
    const c = await seedFinalizableTransformation(f);
    const shippingId = await shipment(
      c.tenant,
      c.actor,
      c.location,
      c.party,
      c.document,
      c.lot,
      "10",
      "lb",
    );
    await expect(
      c.receiving.void(
        c.tenant,
        c.actor,
        c.origin.id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          expectedDraftVersion: null,
          reason: "Incorrect receipt",
        },
        "void-receipt",
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "traceability_downstream_blocked",
        blockers: [{ lotId: c.lot, eventId: shippingId, rootId: shippingId, revision: 1 }],
      },
    });
  });

  it("blocks a Transformation void while Shipping consumes its output lot", async () => {
    const c = await seedFinalizableTransformation(f);
    const finalized = await c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "transform");
    const lotId = finalized.snapshot.outputs[0]?.lotId;
    if (!lotId) throw new Error("Missing output lot");
    const shippingId = await shipment(
      c.tenant,
      c.actor,
      c.location,
      c.party,
      c.document,
      lotId,
      "10",
      "case",
    );
    await expect(
      c.store.void(
        c.tenant,
        c.actor,
        finalized.id,
        {
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Wrong output",
        },
        "void-transform",
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "traceability_downstream_blocked",
        blockers: [{ lotId, eventId: shippingId, rootId: shippingId, revision: 1 }],
      },
    });
  });

  it("serializes a Receiving correction behind Shipping publication on the lot", async () => {
    const c = await seedFinalizableTransformation(f);
    let signalLocked: ((pid: number) => void) | undefined;
    let releaseShipping: (() => void) | undefined;
    const locked = new Promise<number>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseShipping = resolve;
    });
    const publishing = f.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.traceabilityLots.id })
        .from(schema.traceabilityLots)
        .where(
          and(
            eq(schema.traceabilityLots.tenantId, c.tenant),
            eq(schema.traceabilityLots.id, c.lot),
          ),
        )
        .for("update");
      const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
      signalLocked?.(pid.rows[0]?.pid ?? 0);
      await release;
      return writeShipment(
        tx,
        c.tenant,
        c.actor,
        c.location,
        c.party,
        c.document,
        c.lot,
        "10",
        "lb",
      );
    });
    try {
      const holderPid = await locked;
      const correcting = c.receiving.void(
        c.tenant,
        c.actor,
        c.origin.id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          expectedDraftVersion: null,
          reason: "Incorrect receipt",
        },
        "racing-void",
      );
      const settled = correcting.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      await expect
        .poll(
          async () => {
            const result = await f.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
              [holderPid],
            );
            return result.rows[0]?.count ?? 0;
          },
          { timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(1);
      releaseShipping?.();
      const shippingId = await publishing;
      const outcome = await settled;
      expect(outcome.value).toBeNull();
      expect(outcome.error).toMatchObject({
        status: 409,
        response: {
          code: "traceability_downstream_blocked",
          blockers: [{ lotId: c.lot, eventId: shippingId, rootId: shippingId, revision: 1 }],
        },
      });
      expect(
        await f.db.transaction((tx) => readCurrentShippingBalance(tx, c.tenant, c.lot)),
      ).toEqual({
        state: "known",
        unitOfMeasure: "lb",
        supply: "500",
        used: "10",
        remaining: "490",
      });
    } finally {
      releaseShipping?.();
      await publishing;
    }
  }, 15_000);
});
