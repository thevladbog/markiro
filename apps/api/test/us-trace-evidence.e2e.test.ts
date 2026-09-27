import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { receivingFinalizationSnapshotV3Schema } from "@markiro/platform-contracts";
import { eq, sql } from "drizzle-orm";
import { ServiceUnavailableException } from "@nestjs/common";
import { traceCandidateQuery } from "../src/modules/traceability/trace/us-trace-query";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readCurrentTraceFrontier,
  assertCurrentTraceOrigin,
  validateCurrentTraceEvent,
} from "../src/modules/traceability/trace/us-trace-evidence";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import {
  seedTwoByTwoGenealogy,
  seedZeroFtlGenealogy,
} from "./support/us-transformation-genealogy-fixture";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Current trace frozen evidence", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("preserves both saved lines at one location and excludes pending amendments", async () => {
    const c = await seedFinalizableTransformation(f);
    const event = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      c.command,
      "trace-finalize",
    );
    await c.store.amend(
      c.tenant,
      c.actor,
      event.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Pending correction" },
      "trace-amend",
    );
    const ids = c.origin.snapshot.items.map((line) => line.lotId);
    const page = await f.db.transaction((tx) =>
      readCurrentTraceFrontier(tx, c.tenant, ids, "both", 20),
    );
    expect(page.hasMore).toBe(false);
    expect(page.events.map((item) => item.id)).toEqual([c.origin.id, event.id]);
    expect(
      page.events[0]?.lines.map((line) => [line.lineNo, line.quantity, line.unitOfMeasure]),
    ).toEqual([
      [1, "500", "lb"],
      [2, "500", "lb"],
    ]);
    expect(new Set(page.events[0]?.lines.map((line) => line.nodeId)).size).toBe(1);
    expect(page.events[1]?.lines.map((line) => [line.side, line.lineNo, line.quantity])).toEqual([
      ["input", 1, "500"],
      ["input", 2, "500"],
      ["output", 1, "100"],
    ]);
    await f.db
      .update(schema.products)
      .set({ name: "Changed master name" })
      .where(eq(schema.products.id, c.product));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed master location" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    expect(
      await f.db.transaction((tx) => readCurrentTraceFrontier(tx, c.tenant, ids, "both", 20)),
    ).toEqual(page);
    expect(
      await f.db.transaction((tx) => readCurrentTraceFrontier(tx, randomUUID(), ids, "both", 20)),
    ).toEqual({ events: [], hasMore: false });
    const limited = await f.db.transaction((tx) =>
      readCurrentTraceFrontier(tx, c.tenant, ids, "both", 1),
    );
    expect(limited.events.map((item) => item.id)).toEqual([c.origin.id]);
    expect(limited.hasMore).toBe(true);
  });

  it("selects the current 2-to-2 revision with four independent quantity lines", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const ids = c.revision.snapshot.outputs.map((line) => line.lotId);
    const page = await f.db.transaction((tx) =>
      readCurrentTraceFrontier(tx, c.tenant, ids, "backward", 20),
    );
    expect(page.events.map((event) => event.id)).toEqual([c.revision.id]);
    expect(page.events[0]?.lines.map((line) => [line.side, line.lineNo, line.quantity])).toEqual([
      ["input", 1, "500"],
      ["input", 2, "500"],
      ["output", 1, "110"],
      ["output", 2, "70"],
    ]);
    expect(await f.db.transaction((tx) => assertCurrentTraceOrigin(tx, c.tenant, ids))).toEqual(
      new Set(ids),
    );
    expect(
      await f.db.transaction((tx) => readCurrentTraceFrontier(tx, c.tenant, ids, "forward", 20)),
    ).toEqual({ events: [], hasMore: false });
  });

  it("reads saved Shipping quantities and recipient while excluding its amendment draft", async () => {
    const c = await seedShippingLifecycle(f.db);
    const event = await finalizeFixtureShipment(c, "20");
    await c.store.amend(
      c.tenant,
      c.actor,
      event.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Pending shipping correction",
      },
      "trace-shipping-amend",
    );
    const page = await f.db.transaction((tx) =>
      readCurrentTraceFrontier(tx, c.tenant, [c.lot], "forward", 20),
    );
    expect(page.events.map((item) => item.id)).toEqual([event.id]);
    expect(page.events[0]?.lines).toEqual([
      expect.objectContaining({
        side: "shipping",
        lineNo: 1,
        lotId: c.lot,
        nodeId: `location:${c.recipient}`,
        quantity: "20",
        unitOfMeasure: "case",
      }),
    ]);
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed recipient" })
      .where(eq(schema.traceabilityLocations.id, c.recipient));
    expect(
      await f.db.transaction((tx) =>
        readCurrentTraceFrontier(tx, c.tenant, [c.lot], "forward", 20),
      ),
    ).toEqual(page);
  });

  it("recognizes supported void as an origin gap without throwing", async () => {
    const c = await seedZeroFtlGenealogy(f);
    const ids = c.revision.snapshot.outputs.map((line) => line.lotId);
    expect(await f.db.transaction((tx) => assertCurrentTraceOrigin(tx, c.tenant, ids))).toEqual(
      new Set(),
    );
    expect(
      await f.db.transaction((tx) => readCurrentTraceFrontier(tx, c.tenant, ids, "both", 20)),
    ).toEqual({ events: [], hasMore: false });
  });

  it("reads all three event types in civil-date order inside a read-only transaction", async () => {
    const c = await seedFinalizableTransformation(f);
    const transformed = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      c.command,
      "trace-chain-transformation",
    );
    const output = transformed.snapshot.outputs[0];
    if (!output) throw new Error("Missing output");
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["processor", "ship_from"] })
      .where(eq(schema.traceabilityLocations.id, c.processor));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["receive_at", "recipient"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    const shipping = new UsShippingStore(f.db);
    const draft = await shipping.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: "2026-09-27",
          shipFromLocationId: c.processor,
          recipientLocationId: c.location,
          carrierReference: null,
          notes: null,
          items: [{ lotId: output.lotId, quantity: "20", unitOfMeasure: "case" }],
          documentIds: [c.document],
        },
      },
      "trace-chain-shipping",
    );
    const ready = await shipping.checkReadiness(c.tenant, c.actor, draft.id, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
    const shipped = await shipping.finalize(
      c.tenant,
      c.actor,
      draft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "trace-chain-shipping-finalize",
    );
    const ids = [...c.origin.snapshot.items.map((line) => line.lotId), output.lotId];
    await f.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const page = await readCurrentTraceFrontier(tx, c.tenant, ids, "both", 20);
        expect(page.events.map((event) => [event.type, event.id])).toEqual([
          ["receiving", c.origin.id],
          ["transformation", transformed.id],
          ["shipping", shipped.id],
        ]);
        const plan = await tx.execute(
          sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${traceCandidateQuery(c.tenant, ids, "both", 20)}`,
        );
        if (process.env.US_TRACE_EXPLAIN === "1")
          process.stdout.write(`Trace candidate EXPLAIN\n${JSON.stringify(plan.rows)}\n`);
      },
      { isolationLevel: "repeatable read" },
    );
  });

  it("rejects a frozen Shipping source mismatch in the saved child", async () => {
    const c = await seedShippingLifecycle(f.db);
    const event = await finalizeFixtureShipment(c, "20");
    const [row] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.id, event.id));
    const [root] = await f.db
      .select()
      .from(schema.shippingEventRoots)
      .where(eq(schema.shippingEventRoots.id, event.id));
    const [item] = await f.db
      .select()
      .from(schema.shippingEventItems)
      .where(eq(schema.shippingEventItems.eventId, event.id));
    const [shippingDetail] = await f.db
      .select()
      .from(schema.shippingEventDetails)
      .where(eq(schema.shippingEventDetails.eventId, event.id));
    if (!row || !root || !item || !shippingDetail) throw new Error("Missing fixture");
    expect(() =>
      validateCurrentTraceEvent(row, root, {
        items: [item],
        inputs: [],
        outputs: [],
        shippingDetail,
      }),
    ).not.toThrow();
    expect(() =>
      validateCurrentTraceEvent(row, root, {
        items: [{ ...item, sourceSnapshot: null }],
        inputs: [],
        outputs: [],
        shippingDetail,
      }),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      validateCurrentTraceEvent(row, root, { items: [item], inputs: [], outputs: [] }),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      validateCurrentTraceEvent(row, root, {
        items: [item],
        inputs: [],
        outputs: [],
        shippingDetail: { ...shippingDetail, recipientLocationId: randomUUID() },
      }),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      validateCurrentTraceEvent(row, root, {
        items: [item],
        inputs: [],
        outputs: [],
        shippingDetail: {
          ...shippingDetail,
          recipientSnapshot: {
            id: event.snapshot.recipient.locationId,
            description: "Wrong saved recipient",
            location: event.snapshot.recipient,
          },
        },
      }),
    ).toThrow(ServiceUnavailableException);
  });

  it("reads v3 retained Receiving bindings after a supported amendment", async () => {
    const c = await seedFinalizableTransformation(f);
    const amended = await c.receiving.amend(
      c.tenant,
      c.actor,
      c.origin.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correct receipt notes",
      },
      "trace-receiving-amend",
    );
    const ready = await c.receiving.checkRevisionReadiness(c.tenant, c.actor, amended.eventId, {
      expectedDraftVersion: 1,
    });
    await c.receiving.finalizeRevision(
      c.tenant,
      c.actor,
      amended.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: ready.exemptReviewRequiredLines,
      },
      "trace-receiving-revision",
    );
    const page = await f.db.transaction((tx) =>
      readCurrentTraceFrontier(
        tx,
        c.tenant,
        c.origin.snapshot.items.map((line) => line.lotId),
        "backward",
        20,
      ),
    );
    expect(page.events.map((event) => [event.id, event.revision])).toEqual([[amended.eventId, 2]]);
    expect(page.events[0]?.lines.map((line) => [line.lineNo, line.quantity])).toEqual([
      [1, "500"],
      [2, "500"],
    ]);
    const [row] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.id, amended.eventId));
    const [root] = await f.db
      .select()
      .from(schema.receivingEventRoots)
      .where(eq(schema.receivingEventRoots.id, c.origin.id));
    const items = await f.db
      .select()
      .from(schema.receivingEventItems)
      .where(eq(schema.receivingEventItems.eventId, amended.eventId));
    if (!row || !root) throw new Error("Missing retained fixture");
    const snapshot = receivingFinalizationSnapshotV3Schema.parse(row.finalizationSnapshot);
    const wrongBinding = receivingFinalizationSnapshotV3Schema.parse({
      ...snapshot,
      items: snapshot.items.map((line) => ({
        ...line,
        lotBinding: { kind: line.lotLinkMode === "create_on_finalize" ? "created" : "linked" },
      })),
    });
    expect(() =>
      validateCurrentTraceEvent({ ...row, finalizationSnapshot: wrongBinding }, root, {
        items,
        inputs: [],
        outputs: [],
      }),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      validateCurrentTraceEvent(row, root, {
        items: items.map((item) => ({
          ...item,
          lotLinkMode:
            item.lotLinkMode === "create_on_finalize" ? "link_existing" : "create_on_finalize",
        })),
        inputs: [],
        outputs: [],
      }),
    ).toThrow(ServiceUnavailableException);
  });

  it("rejects contradictory current pointers and frozen child bindings without weakening database constraints", async () => {
    const c = await seedFinalizableTransformation(f);
    const event = await c.store.finalize(
      c.tenant,
      c.actor,
      c.saved.id,
      c.command,
      "trace-validator-finalize",
    );
    const [row] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.id, event.id));
    const [root] = await f.db
      .select()
      .from(schema.transformationEventRoots)
      .where(eq(schema.transformationEventRoots.id, event.id));
    const inputs = await f.db
      .select()
      .from(schema.transformationEventInputs)
      .where(eq(schema.transformationEventInputs.eventId, event.id));
    const outputs = await f.db
      .select()
      .from(schema.transformationEventOutputs)
      .where(eq(schema.transformationEventOutputs.eventId, event.id));
    const output = outputs[0];
    if (!row || !root || !output) throw new Error("Missing fixture");
    expect(() =>
      validateCurrentTraceEvent(
        row,
        { ...root, currentEventId: randomUUID() },
        { inputs, outputs, items: [] },
      ),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      validateCurrentTraceEvent(row, root, {
        inputs,
        outputs: [{ ...output, lotId: randomUUID() }],
        items: [],
      }),
    ).toThrow(ServiceUnavailableException);
    expect(() =>
      validateCurrentTraceEvent({ ...row, dateReceived: "2026-09-01" }, root, {
        inputs,
        outputs,
        items: [],
      }),
    ).toThrow(ServiceUnavailableException);
  });

  it("rejects an invalid saved Receiving timezone even though old snapshots have no timezone field", async () => {
    const c = await seedFinalizableTransformation(f);
    const [row] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.id, c.origin.id));
    const [root] = await f.db
      .select()
      .from(schema.receivingEventRoots)
      .where(eq(schema.receivingEventRoots.id, c.origin.id));
    const items = await f.db
      .select()
      .from(schema.receivingEventItems)
      .where(eq(schema.receivingEventItems.eventId, c.origin.id));
    if (!row || !root) throw new Error("Missing fixture");
    expect(() =>
      validateCurrentTraceEvent({ ...row, timeZone: "Not/AZone" }, root, {
        items,
        inputs: [],
        outputs: [],
      }),
    ).toThrow(ServiceUnavailableException);
  });
});
