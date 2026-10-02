import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCaseBridge, caseState } from "./support/us-case-bridge-fixture";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";
import { emptyReceivingDraft, emptyReceivingItem } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US current lot card", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsTraceStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
    store = new UsTraceStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  it("preserves the full Receiving description, frozen documents and exact current evidence", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipping = await finalizeFixtureShipment(c, "20");
    const before = await caseState(f, c.tenant);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    const card = await store.card(c.tenant, c.actor, c.lot);
    const page = await store.cardEvidence(c.tenant, c.actor, c.lot, {});
    const search = await store.search(c.tenant, c.actor, { lotId: c.lot });
    expect(card).toMatchObject({
      originState: "current",
      currentCteCount: 2,
      firstEventDate: "2026-09-07",
      lastEventDate: "2026-09-27",
      balance: {
        state: "known",
        supply: "100",
        used: "20",
        remaining: "80",
        unitOfMeasure: "case",
      },
      currentOriginProducts: [
        { kind: "receiving", productId: c.product, description: { sourceProductId: c.product } },
      ],
    });
    expect(search.items[0]).toMatchObject({
      currentCteCount: card.currentCteCount,
      firstEventDate: card.firstEventDate,
      lastEventDate: card.lastEventDate,
    });
    expect(page.items.map((event) => event.type)).toEqual(["receiving", "shipping"]);
    expect(page.items[1]).toMatchObject({
      eventId: shipping.id,
      revision: 1,
      eventDate: "2026-09-27",
      lines: [{ kind: "shipping", lineNo: 1, quantity: "20", unitOfMeasure: "case" }],
      documents: [{ documentId: c.document, number: shipping.snapshot.documents[0]?.number }],
    });
    expect(await caseState(f, c.tenant)).toEqual(before);
    expect(
      await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, c.tenant)),
    ).toEqual(audits);
    await f.db
      .update(schema.products)
      .set({ name: "Changed master" })
      .where(eq(schema.products.id, c.product));
    await f.db
      .update(schema.referenceDocuments)
      .set({ number: "Changed document" })
      .where(eq(schema.referenceDocuments.id, c.document));
    const after = await store.card(c.tenant, c.actor, c.lot);
    expect(after.currentMasterProduct?.name).toBe("Changed master");
    expect(after.currentOriginProducts).toEqual(card.currentOriginProducts);
    expect(await store.cardEvidence(c.tenant, c.actor, c.lot, {})).toEqual(page);
  });

  it("keeps identity and case links after void, with explicit origin gap and unknown balance", async () => {
    const c = await seedCaseBridge(f);
    const cases = new UsCaseStore(f.db);
    const linked = await cases.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0], c.codes[1]] },
      "card-case",
    );
    const removed = linked.created[1];
    if (!removed) throw new Error("Missing second link");
    await cases.unlink(
      c.tenant,
      c.actor,
      c.lotId,
      removed.linkId,
      { operationKey: randomUUID(), reason: "Historical link" },
      "card-unlink",
    );
    const before = await store.card(c.tenant, c.actor, c.lotId);
    expect(before.currentOriginProducts).toEqual([
      expect.objectContaining({
        kind: "transformation",
        productId: c.product,
        description: c.original.snapshot.outputs[0]?.product.description,
      }),
    ]);
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Void unused origin" },
      "card-void",
    );
    const after = await store.card(c.tenant, c.actor, c.lotId);
    expect(after.lot).toEqual(before.lot);
    expect(after).toMatchObject({
      originState: "gap",
      currentOriginProducts: [],
      currentOriginProductCount: 0,
      moreCurrentOriginProducts: false,
      caseSummary: { activeCount: 1, historicalCount: 1 },
      balance: { state: "unknown" },
      currentCteCount: 0,
    });
    expect((await store.cardEvidence(c.tenant, c.actor, c.lotId, {})).items).toEqual([]);
  });

  it("returns same missing/foreign 404, reloads membership, and validates queries", async () => {
    const c = await seedShippingLifecycle(f.db);
    const foreign = await seedShippingLifecycle(f.db);
    for (const id of [randomUUID(), foreign.lot]) {
      await expect(store.card(c.tenant, c.actor, id)).rejects.toMatchObject({
        status: 404,
        response: { code: "trace_lot_not_found" },
      });
      await expect(store.cardEvidence(c.tenant, c.actor, id, {})).rejects.toMatchObject({
        status: 404,
      });
    }
    await expect(
      store.cardEvidence(c.tenant, c.actor, c.lot, { limit: "51" }),
    ).rejects.toMatchObject({ status: 400 });
    await f.pool.query("DELETE FROM member WHERE id=$1", [c.member]);
    await expect(store.card(c.tenant, c.actor, c.lot)).rejects.toMatchObject({ status: 403 });
    await expect(store.cardEvidence(c.tenant, c.actor, c.lot, {})).rejects.toMatchObject({
      status: 403,
    });
  });

  it("fails safely on a damaged selected snapshot", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ finalizationSnapshot: { ...shipment.snapshot, snapshotVersion: 999 } })
        .where(eq(schema.traceabilityEvents.id, shipment.id));
    });
    await expect(store.card(c.tenant, c.actor, c.lot)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    await expect(store.cardEvidence(c.tenant, c.actor, c.lot, {})).rejects.toMatchObject({
      status: 503,
    });
  });

  it("retains every origin line across 51-event pages and exposes a bounded 50-origin preview", async () => {
    const c = await seedShippingLifecycle(f.db);
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({ productName: "Second frozen name", brandName: "Second brand", variety: "Gala" })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const receiving = new UsReceivingStore(f.db);
    const line = {
      ...emptyReceivingItem,
      productId: c.product,
      lotId: c.lot,
      lotLinkMode: "link_existing" as const,
      tlc: "00001",
      source: { kind: "location" as const, locationId: c.location },
      quantity: "1",
      unitOfMeasure: "case" as const,
    };
    const saved = await receiving.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          ...emptyReceivingDraft,
          dateReceived: "2026-09-08",
          locationId: c.location,
          previousSourceLocationId: c.location,
          items: [line, line],
          documentIds: [c.document],
        },
      },
      "second-origin",
    );
    const ready = await receiving.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    const second = await receiving.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "second-final",
    );
    const initial = await store.card(c.tenant, c.actor, c.lot);
    expect(initial.currentOriginProductCount).toBe(3);
    expect(initial.currentOriginProducts[1]?.description).toEqual(
      second.snapshot.items[0]?.productDescription,
    );
    expect(initial.currentCteCount).toBe(2);
    expect(
      initial.currentOriginProducts.map((origin) =>
        origin.kind === "receiving" ? origin.description.productName : origin.description,
      ),
    ).toEqual(["Synthetic apples", "Second frozen name", "Second frozen name"]);
    expect(
      initial.currentOriginProducts.slice(1).map((origin) => [origin.eventId, origin.lineNo]),
    ).toEqual([
      [second.id, 1],
      [second.id, 2],
    ]);
    const [event] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.id, second.id));
    const [root] = await f.db
      .select()
      .from(schema.receivingEventRoots)
      .where(eq(schema.receivingEventRoots.id, second.id));
    const items = await f.db
      .select()
      .from(schema.receivingEventItems)
      .where(eq(schema.receivingEventItems.eventId, second.id));
    const documents = await f.db
      .select()
      .from(schema.receivingEventDocuments)
      .where(eq(schema.receivingEventDocuments.eventId, second.id));
    if (!event || !root) throw new Error("Missing current receipt");
    const copies = Array.from({ length: 49 }, (_, i) => ({
      id: randomUUID(),
      number: `REC-26-${10000 + i}`,
    }));
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .insert(schema.traceabilityEvents)
        .values(
          copies.map(({ id, number }) => ({ ...event, id, rootEventId: id, eventNumber: number })),
        );
      await tx.insert(schema.receivingEventRoots).values(
        copies.map(({ id, number }) => ({
          ...root,
          id,
          eventNumber: number,
          currentEventId: id,
        })),
      );
      await tx
        .insert(schema.receivingEventItems)
        .values(copies.flatMap(({ id }) => items.map((item) => ({ ...item, eventId: id }))));
      await tx
        .insert(schema.receivingEventDocuments)
        .values(
          copies.flatMap(({ id }) => documents.map((document) => ({ ...document, eventId: id }))),
        );
    });
    const card = await store.card(c.tenant, c.actor, c.lot);
    expect(card).toMatchObject({
      currentCteCount: 51,
      currentOriginProductCount: 101,
      moreCurrentOriginProducts: true,
    });
    expect(card.currentOriginProducts).toHaveLength(50);
    const first = await store.cardEvidence(c.tenant, c.actor, c.lot, { limit: "50" });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const last = await store.cardEvidence(c.tenant, c.actor, c.lot, {
      limit: "50",
      cursor: first.nextCursor,
    });
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    const all = [...first.items, ...last.items];
    expect(new Set(all.map((event) => event.eventId)).size).toBe(51);
    expect(
      all.flatMap((event) => event.lines).filter((line) => line.originProduct !== null),
    ).toHaveLength(101);
    expect(all.slice(1).map((event) => event.eventId)).toEqual(
      [second.id, ...copies.map((row) => row.id)].sort(),
    );
    expect(
      all
        .slice(1)
        .every((event) =>
          event.lines.every(
            (line) =>
              line.originProduct?.kind === "receiving" &&
              line.originProduct.description.productName === "Second frozen name",
          ),
        ),
    ).toBe(true);
  }, 20_000);

  it("keeps pending predecessor current and replaces it with exact amended Shipping provenance", async () => {
    const c = await seedShippingLifecycle(f.db);
    const original = await finalizeFixtureShipment(c, "20");
    const amendment = await c.store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: original.lifecycle?.lifecycleVersion,
        reason: "Correct shipment",
      },
      "card-amend",
    );
    expect((await store.cardEvidence(c.tenant, c.actor, c.lot, {})).items.at(-1)?.eventId).toBe(
      original.id,
    );
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      amendment.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...original.draft,
          items: [{ lotId: c.lot, quantity: "25", unitOfMeasure: "case" }],
        },
      },
      "card-save",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: saved.draftVersion,
    });
    const amended = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "card-final",
    );
    const page = await store.cardEvidence(c.tenant, c.actor, c.lot, {});
    expect(page.items.map((event) => event.eventId)).not.toContain(original.id);
    expect(page.items.at(-1)).toMatchObject({
      eventId: amended.id,
      rootId: original.id,
      revision: 2,
      lines: [{ kind: "shipping", lineNo: 1, quantity: "25" }],
      documents: [{ documentId: c.document, number: "00001" }],
    });
    expect((await store.card(c.tenant, c.actor, c.lot)).balance).toMatchObject({ remaining: "75" });
  });

  it("reads a card while a production lot row lock is held, without blocking finalization", async () => {
    const c = await seedShippingLifecycle(f.db);
    const holder = await f.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [c.tenant, c.lot],
      );
      expect((await store.card(c.tenant, c.actor, c.lot)).balance).toMatchObject({
        state: "known",
        remaining: "100",
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 10_000);
});
