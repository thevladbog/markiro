import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { UsTraceRequestScopeV1 } from "@markiro/platform-contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { selectUsRequestScope } from "../src/modules/traceability/requests/us-request-selection";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { transformationTransaction } from "../src/modules/traceability/transformation/us-transformation-operations";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { seedTwoByTwoGenealogy } from "./support/us-transformation-genealogy-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US request complete selection", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  const select = (tenant: string, scope: UsTraceRequestScopeV1) =>
    transformationTransaction(f.db, (tx) => selectUsRequestScope(tx, tenant, scope));

  it("rejects empty or client-authority scope fields before querying sources", async () => {
    const c = await seedCompleteReceiving(f.db);
    await expect(select(c.tenant, {})).rejects.toMatchObject({ status: 400 });
    await expect(
      select(c.tenant, { tlc: "00001", tenantId: c.tenant } as UsTraceRequestScopeV1),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("maps the real transaction-local PostgreSQL statement deadline to technical 503", async () => {
    const c = await seedCompleteReceiving(f.db);
    const lock = await f.pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE traceability_lots IN ACCESS EXCLUSIVE MODE");
      await expect(select(c.tenant, { lotId: c.lot })).rejects.toMatchObject({
        status: 503,
        response: { code: "us_database_unavailable" },
      });
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    expect((await select(c.tenant, { lotId: c.lot })).lotIds).toEqual([c.lot]);
  }, 40_000);

  it("restarts the whole repeatable-read selection after a concurrent amendment changes a locked root", async () => {
    const c = await seedFinalizableTransformation(f);
    const original = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      c.command,
      "retry-original",
    );
    let attempts = 0;
    let amendmentId: string | undefined;
    const selected = await transformationTransaction(f.db, async (tx) => {
      attempts++;
      // Establish an old MVCC snapshot without a row lock, then commit a real
      // competing amendment. The selector's later FOR SHARE raises SQLSTATE 40001.
      await tx.execute(
        sql`SELECT current_event_id FROM transformation_event_roots WHERE tenant_id=${c.tenant} AND id=${original.id}`,
      );
      if (attempts === 1) {
        const amendment = await c.store.amend(
          c.tenant,
          c.actor,
          original.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Concurrent correction",
          },
          "retry-amendment",
        );
        amendmentId = amendment.record.id;
      }
      return selectUsRequestScope(tx, c.tenant, { tlc: "NEW-OUTPUT" });
    });
    expect(attempts).toBe(2);
    expect(amendmentId).toBeDefined();
    expect(selected.records.map((record) => record.eventId)).toEqual(
      expect.arrayContaining([original.id, amendmentId]),
    );
    expect(selected.records).toHaveLength(3);
  });

  it("preserves nested deadlock errors for the transaction owner's retry policy", async () => {
    const c = await seedCompleteReceiving(f.db);
    let attempts = 0;
    const selected = await transformationTransaction(f.db, async (tx) => {
      attempts++;
      // Deterministic driver-wrapper injection avoids nondeterministic victim
      // election. The retry itself opens a real new transaction and executes SQL.
      const deadlock = Object.assign(new Error("Synthetic deadlock"), { code: "40P01" });
      const hook =
        attempts === 1
          ? vi.spyOn(tx, "execute").mockImplementationOnce(() => {
              throw new Error("Synthetic driver wrapper", { cause: deadlock });
            })
          : null;
      try {
        return await selectUsRequestScope(tx, c.tenant, { lotId: c.lot });
      } finally {
        hook?.mockRestore();
      }
    });
    expect(attempts).toBe(2);
    expect(selected.lotIds).toEqual([c.lot]);
    expect(selected.records).toEqual([]);
  });

  async function chain() {
    const c = await seedCompleteReceiving(f.db);
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["receive_at", "processor", "ship_from", "recipient"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({
        coverageStatus: "covered",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "Synthetic",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const receiving = new UsReceivingStore(f.db);
    const origins = [];
    for (const line of c.draft.items) {
      const saved = await receiving.createDraft(
        c.tenant,
        c.actor,
        {
          operationKey: randomUUID(),
          draft: { ...c.draft, items: [{ ...line, quantity: "500", unitOfMeasure: "lb" }] },
        },
        "request-origin",
      );
      const ready = await receiving.checkReadiness(c.tenant, c.actor, saved.id, {
        expectedDraftVersion: 1,
      });
      origins.push(
        await receiving.finalize(
          c.tenant,
          c.actor,
          saved.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: ready.inputDigest,
          },
          "request-origin-final",
        ),
      );
    }
    const transform = new UsTransformationStore(f.db);
    const draft = await transform.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: "2026-09-26",
          processorLocationId: c.location,
          reason: "commingling_and_repacking",
          reasonNote: null,
          notes: null,
          inputs: origins.flatMap((o) =>
            o.snapshot.items.map((line) => ({
              kind: "ftl_lot" as const,
              lotId: line.lotId,
              quantity: "500",
              unitOfMeasure: "lb",
            })),
          ),
          outputs: ["OUT-A", "OUT-B"].map((tlc) => ({
            productId: c.product,
            tlc,
            quantity: "100",
            unitOfMeasure: "case",
          })),
          documentIds: [c.document],
        },
      },
      "request-transform",
    );
    const ready = await transform.checkReadiness(c.tenant, c.actor, draft.id, {
      expectedDraftVersion: 1,
    });
    if (ready.state !== "complete") throw new Error(JSON.stringify(ready.issues));
    const transformed = await transform.finalize(
      c.tenant,
      c.actor,
      draft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "request-transform-final",
    );
    const output = transformed.snapshot.outputs[0];
    if (!output) throw new Error("Missing output");
    const [location] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, c.location));
    if (!location) throw new Error("Missing location");
    const recipient = randomUUID();
    await f.db
      .insert(schema.traceabilityLocations)
      .values({ ...location, id: recipient, name: "Buyer", roles: ["recipient"] });
    const shipping = new UsShippingStore(f.db);
    const saved = await shipping.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: "2026-09-27",
          shipFromLocationId: c.location,
          recipientLocationId: recipient,
          carrierReference: null,
          notes: null,
          items: [{ lotId: output.lotId, quantity: "20", unitOfMeasure: "case" }],
          documentIds: [c.document],
        },
      },
      "request-shipping",
    );
    const shippingReady = await shipping.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    if (shippingReady.state !== "complete") throw new Error(JSON.stringify(shippingReady.issues));
    const shipped = await shipping.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: shippingReady.inputDigest,
      },
      "request-shipping-final",
    );
    return { ...c, origins, transformed, shipped };
  }

  it("closes a TLC seed through two independent Receiving origins, 2-to-2 Transformation and later Shipping", async () => {
    const c = await chain();
    const selected = await select(c.tenant, { tlc: "00001", eventDateTo: "2026-09-07" });
    expect(selected.seeds).toContainEqual({ kind: "lot", id: c.lot });
    expect(selected.records).toHaveLength(4);
    for (const id of [...c.origins.map((o) => o.id), c.transformed.id, c.shipped.id])
      expect(selected.records.map((row) => row.eventId)).toContain(id);
    expect(selected.records).toContainEqual({
      eventId: c.shipped.id,
      rootEventId: c.shipped.id,
      revision: 1,
      reason: "dependency",
    });
    expect(selected.records.find((r) => r.eventId === c.origins[1]?.id)?.reason).toBe("match");
    expect(selected.lotIds).toHaveLength(4);
    expect(selected.lotIds).toEqual(
      expect.arrayContaining(c.transformed.snapshot.outputs.map((o) => o.lotId)),
    );
    expect(
      selected.relations
        .filter((r) => r.eventId === c.transformed.id)
        .map((r) => [r.role, r.lineNo]),
    ).toEqual([
      ["input", 1],
      ["input", 2],
      ["output", 1],
      ["output", 2],
    ]);
    expect(await select(c.tenant, { tlc: "00001", eventDateTo: "2026-09-07" })).toEqual(selected);
  });

  it("requires date, location and document on the same revision, including draft-only matches", async () => {
    const c = await seedCompleteReceiving(f.db);
    const other = randomUUID();
    const [location] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, c.location));
    if (!location) throw new Error("Missing location");
    await f.db
      .insert(schema.traceabilityLocations)
      .values({ ...location, id: other, name: "Other dock" });
    const store = new UsReceivingStore(f.db);
    const line = c.draft.items[1];
    if (!line) throw new Error("Missing linked item");
    for (const [date, locationId, documents] of [
      ["2026-09-10", c.location, []],
      ["2026-09-11", other, []],
      ["2026-09-12", c.location, [c.document]],
    ] as const) {
      await store.createDraft(
        c.tenant,
        c.actor,
        {
          operationKey: randomUUID(),
          draft: {
            ...c.draft,
            dateReceived: date,
            locationId,
            previousSourceLocationId: null,
            items: [{ ...line, source: null }],
            documentIds: [...documents],
          },
        },
        "same-event",
      );
    }
    expect(
      (
        await select(c.tenant, {
          lotId: c.lot,
          eventDateFrom: "2026-09-10",
          eventDateTo: "2026-09-10",
          locationIds: [other],
          documentNumber: "00001",
        })
      ).seeds,
    ).toEqual([]);
    const draft = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...c.draft,
          dateReceived: "2026-09-10",
          locationId: other,
          items: [],
          documentIds: [c.document],
        },
      },
      "draft-only",
    );
    const selected = await select(c.tenant, {
      eventDateFrom: "2026-09-10",
      eventDateTo: "2026-09-10",
      locationIds: [other],
      documentNumber: "00001",
    });
    expect(selected.seeds).toEqual([{ kind: "event", id: draft.id }]);
    expect(selected.records).toEqual([
      { eventId: draft.id, rootEventId: draft.id, revision: 1, reason: "match" },
    ]);
  });

  it("combines TLC/location lists with OR and distinct filters with AND; preserves exact zero-match and tenant isolation", async () => {
    const c = await chain();
    const selected = await select(c.tenant, {
      tlcs: ["missing", "00001"],
      locationIds: [randomUUID(), c.location],
      productId: c.product,
    });
    expect(selected.records).toHaveLength(4);
    expect((await select(c.tenant, { tlcs: ["00001"], productId: randomUUID() })).seeds).toEqual(
      [],
    );
    expect(await select(c.tenant, { tlc: "absent" })).toEqual({
      scope: { tlc: "absent" },
      seeds: [],
      records: [],
      lotIds: [],
      relations: [],
    });
    expect((await select(randomUUID(), { lotId: c.lot })).seeds).toEqual([]);
    expect(
      (await select(c.tenant, { tlcFrom: "OUT-A", tlcTo: "OUT-B" })).seeds.filter(
        (s) => s.kind === "lot",
      ),
    ).toHaveLength(2);
    expect((await select(c.tenant, { productText: "%" })).seeds).toEqual([]);
    expect((await select(c.tenant, { productText: "apples" })).records).toHaveLength(4);
  });

  it("retains linked historical, current, draft and void revisions", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const pending = await c.store.amend(
      c.tenant,
      c.actor,
      c.revision.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "Pending" },
      "request-amend",
    );
    expect((await select(c.tenant, { tlc: "NEW-OUTPUT" })).records.map((r) => r.eventId)).toEqual(
      expect.arrayContaining([c.original.id, c.revision.id, pending.record.id]),
    );
    if (pending.record.status !== "draft") throw new Error("Expected draft");
    await c.store.void(
      c.tenant,
      c.actor,
      pending.record.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 5,
        expectedDraftVersion: pending.record.draftVersion,
        reason: "Cancel",
      },
      "request-void",
    );
    expect((await select(c.tenant, { tlc: "NEW-OUTPUT" })).records.map((r) => r.eventId)).toEqual(
      expect.arrayContaining([c.original.id, c.revision.id, pending.record.id]),
    );
  });

  it("matches frozen documents and source locations for every CTE type, including nested Shipping sources", async () => {
    const c = await seedFinalizableTransformation(f, true);
    const transformed = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      c.command,
      "frozen-transform",
    );
    for (const [date, location, id] of [
      ["2026-09-07", c.location, c.origin.id],
      ["2026-09-26", c.processor, transformed.id],
    ] as const) {
      const selected = await select(c.tenant, {
        eventDateFrom: date,
        eventDateTo: date,
        locationIds: [location],
        documentNumber: "00001",
      });
      expect(selected.seeds).toEqual([{ kind: "event", id }]);
    }
    expect(
      (
        await select(c.tenant, {
          sourceReferenceValue: "https://supplier.example.test/source/Ä?lot=001",
        })
      ).records.map((r) => r.eventId),
    ).toContain(transformed.id);
    const s = await seedShippingLifecycle(f.db);
    const [location] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, s.location));
    if (!location) throw new Error("Missing location");
    const shipFrom = randomUUID();
    await f.db
      .insert(schema.traceabilityLocations)
      .values({ ...location, id: shipFrom, name: "Other ship from", roles: ["ship_from"] });
    s.draft.shipFromLocationId = shipFrom;
    const shipment = await finalizeFixtureShipment(s, "20");
    expect(
      (
        await select(s.tenant, {
          eventDateFrom: "2026-09-27",
          eventDateTo: "2026-09-27",
          locationIds: [s.location],
          documentNumber: "00001",
        })
      ).seeds,
    ).toEqual([{ kind: "event", id: shipment.id }]);
  });

  it("does not impose the revision limit on unlinked lot matches or silently truncate their seeds", async () => {
    const c = await seedCompleteReceiving(f.db);
    await f.db.insert(schema.traceabilityLots).values(
      Array.from({ length: 501 }, (_, i) => ({
        tenantId: c.tenant,
        productId: c.product,
        tlc: `UNLINKED-${i}`,
        assignmentBasis: "imported" as const,
        createdBy: c.actor,
        updatedBy: c.actor,
      })),
    );
    const selected = await select(c.tenant, { tlcFrom: "UNLINKED-", tlcTo: "UNLINKED-z" });
    expect(selected.seeds).toHaveLength(501);
    expect(selected.lotIds).toHaveLength(501);
    expect(selected.records).toEqual([]);
  });

  it("rejects a frozen event/header date mismatch as corrupt source", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ dateReceived: "2026-09-28" })
        .where(eq(schema.traceabilityEvents.id, shipment.id));
    });
    await expect(select(c.tenant, { lotId: c.lot })).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a same-tenant line pointing to a foreign tenant lot", async () => {
    const c = await chain();
    const foreign = await seedCompleteReceiving(f.db);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.shippingEventItems)
        .set({ lotId: foreign.lot })
        .where(eq(schema.shippingEventItems.eventId, c.shipped.id));
    });
    await expect(select(c.tenant, { tlc: "00001" })).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a corrupt root chain and a missing relation instead of returning partial data", async () => {
    const c = await chain();
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.transformationEventRoots)
        .set({ nextRevision: 3 })
        .where(eq(schema.transformationEventRoots.id, c.transformed.id));
    });
    await expect(select(c.tenant, { tlc: "00001" })).rejects.toMatchObject({ status: 503 });
    const d = await chain();
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .delete(schema.transformationEventOutputs)
        .where(eq(schema.transformationEventOutputs.eventId, d.transformed.id));
    });
    await expect(select(d.tenant, { tlc: "00001" })).rejects.toMatchObject({ status: 503 });
  });

  it("accepts exactly 500 linked revisions and rejects the 501st before returning a clipped result", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    const [event] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.id, shipment.id));
    const [root] = await f.db
      .select()
      .from(schema.shippingEventRoots)
      .where(eq(schema.shippingEventRoots.id, shipment.id));
    if (!event || !root) throw new Error("Missing source");
    // A valid historical chain is generated only in this test's owned disposable DB.
    const ids = [shipment.id, ...Array.from({ length: 499 }, () => randomUUID())];
    const extend = async (count: number) => {
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        const rows = ids.slice(0, count).map((id, index) => ({
          ...event,
          id,
          revision: index + 1,
          status: index === count - 1 ? ("finalized" as const) : ("amended" as const),
          previousRevisionId: ids[index - 1] ?? null,
          amendmentReason: index ? "Correction" : null,
          supersededByEventId: index < count - 1 ? (ids[index + 1] ?? null) : null,
          supersededAt: index < count - 1 ? event.finalizedAt : null,
          supersededBy: index < count - 1 ? c.actor : null,
          finalizationSnapshot: {
            ...shipment.snapshot,
            eventId: id,
            revision: index + 1,
            ...(index ? { previousRevisionId: ids[index - 1] } : {}),
          },
        }));
        for (const row of rows) {
          const { receivingRootKey, transformationRootKey, shippingRootKey, ...writable } = row;
          void receivingRootKey;
          void transformationRootKey;
          void shippingRootKey;
          await tx
            .insert(schema.traceabilityEvents)
            .values(writable)
            .onConflictDoUpdate({ target: schema.traceabilityEvents.id, set: writable });
        }
        await tx
          .update(schema.shippingEventRoots)
          .set({
            currentEventId: ids[count - 1],
            nextRevision: count + 1,
            lifecycleVersion: count * 2,
          })
          .where(eq(schema.shippingEventRoots.id, root.id));
        await tx.execute(sql`INSERT INTO shipping_event_items (tenant_id,event_id,line_no,lot_id,quantity,unit_of_measure,tlc_snapshot,source_snapshot,product_snapshot)
          SELECT tenant_id,id,1,${c.lot}::uuid,'20','case',${shipment.snapshot.items[0]?.tlc},${sql.param(shipment.snapshot.items[0]?.source)}::jsonb,${sql.param(shipment.snapshot.items[0]?.product)}::jsonb
          FROM traceability_events WHERE tenant_id=${c.tenant} AND root_event_id=${shipment.id} ON CONFLICT DO NOTHING`);
        await tx.execute(sql`INSERT INTO shipping_event_details (tenant_id,event_id,recipient_location_id,recipient_snapshot,carrier_reference) SELECT d.tenant_id,e.id,d.recipient_location_id,d.recipient_snapshot,d.carrier_reference
          FROM shipping_event_details d JOIN traceability_events e ON e.tenant_id=d.tenant_id AND e.root_event_id=d.event_id
          WHERE d.tenant_id=${c.tenant} AND d.event_id=${shipment.id} ON CONFLICT DO NOTHING`);
      });
    };
    await extend(499);
    expect((await select(c.tenant, { lotId: c.lot })).records).toHaveLength(500);
    await extend(500);
    // The last revision is a legitimate empty pending draft: only root expansion
    // discovers it. There are still 500 direct pins, but 501 total revisions.
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .delete(schema.shippingEventItems)
        .where(eq(schema.shippingEventItems.eventId, ids[499] ?? ""));
      await tx
        .update(schema.traceabilityEvents)
        .set({ status: "draft", finalizationSnapshot: null, finalizedAt: null, finalizedBy: null })
        .where(eq(schema.traceabilityEvents.id, ids[499] ?? ""));
      await tx
        .update(schema.shippingEventDetails)
        .set({ recipientSnapshot: null })
        .where(eq(schema.shippingEventDetails.eventId, ids[499] ?? ""));
      await tx
        .update(schema.traceabilityEvents)
        .set({
          status: "finalized",
          supersededByEventId: null,
          supersededAt: null,
          supersededBy: null,
        })
        .where(eq(schema.traceabilityEvents.id, ids[498] ?? ""));
      await tx
        .update(schema.shippingEventRoots)
        .set({ currentEventId: ids[498], pendingDraftId: ids[499], lifecycleVersion: 999 })
        .where(eq(schema.shippingEventRoots.id, shipment.id));
    });
    await expect(select(c.tenant, { lotId: c.lot })).rejects.toMatchObject({
      status: 409,
      response: { code: "us_request_selection_limit" },
    });
  }, 60_000);
});
