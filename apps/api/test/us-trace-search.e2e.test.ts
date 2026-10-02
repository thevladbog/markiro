import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { buildSscc } from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import * as relations from "../src/modules/traceability/trace/us-trace-query";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { traceSearchCandidateQuery } from "../src/modules/traceability/trace/us-trace-search";
import { parseUsTraceSearchQuery } from "../src/modules/traceability/trace/us-trace-search-query";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";
import { seedTwoByTwoGenealogy } from "./support/us-transformation-genealogy-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import { seedCaseBridge, caseState } from "./support/us-case-bridge-fixture";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US trace search", () => {
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedLargeCurrentHistory() {
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
    const [item] = await f.db
      .select()
      .from(schema.shippingEventItems)
      .where(eq(schema.shippingEventItems.eventId, shipment.id));
    const [detail] = await f.db
      .select()
      .from(schema.shippingEventDetails)
      .where(eq(schema.shippingEventDetails.eventId, shipment.id));
    if (!event || !root || !item || !detail) throw new Error("Missing volume fixture source");
    // Reuse a real frozen Shipping shape, creating internally consistent current roots/rows.
    // 2,001 additional 0.001-case shipments remain within the 100-case receipt.
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      for (let start = 0; start < 2001; start += 200) {
        const copies = Array.from({ length: Math.min(200, 2001 - start) }, (_, index) => ({
          id: randomUUID(),
          number: `SHP-26-${10000 + start + index}`,
        }));
        await tx.insert(schema.traceabilityEvents).values(
          copies.map(({ id, number }) => ({
            ...event,
            id,
            rootEventId: id,
            eventNumber: number,
            dateReceived: "2026-09-29",
            finalizationSnapshot: {
              ...shipment.snapshot,
              eventId: id,
              eventNumber: number,
              eventDate: "2026-09-29",
              items: shipment.snapshot.items.map((line) => ({ ...line, quantity: "0.001" })),
            },
          })),
        );
        await tx.insert(schema.shippingEventRoots).values(
          copies.map(({ id, number }) => ({
            ...root,
            id,
            eventNumber: number,
            currentEventId: id,
          })),
        );
        await tx
          .insert(schema.shippingEventItems)
          .values(copies.map(({ id }) => ({ ...item, eventId: id, quantity: "0.001" })));
        await tx
          .insert(schema.shippingEventDetails)
          .values(copies.map(({ id }) => ({ ...detail, eventId: id })));
        await tx.insert(schema.shippingEventDocuments).values(
          copies.map(({ id }) => ({
            tenantId: c.tenant,
            eventId: id,
            documentId: c.document,
            position: 1,
          })),
        );
      }
    });
    const selectiveLot = randomUUID();
    await f.db.insert(schema.traceabilityLots).values({
      id: selectiveLot,
      tenantId: c.tenant,
      productId: c.product,
      tlc: "SELECTIVE",
      assignmentBasis: "imported",
      createdBy: c.actor,
      updatedBy: c.actor,
    });
    return { ...c, selectiveLot };
  }

  it("keeps selective limit-1 search available with over 2,000 unrelated current events", async () => {
    const c = await seedLargeCurrentHistory();
    const started = performance.now();
    const page = await store.search(c.tenant, c.actor, { q: "SELECTIVE", limit: "1" });
    expect(page.items.map((item) => item.lotId)).toEqual([c.selectiveLot]);
    expect(page.items[0]?.currentCteCount).toBe(0);
    process.stdout.write(
      JSON.stringify({
        volumeSearch: "selective",
        tenantCurrentEvents: 2003,
        elapsedMs: Number((performance.now() - started).toFixed(2)),
      }) + "\n",
    );
  }, 20_000);

  it("aggregates every current event for a selected lot with over 2,000 events", async () => {
    const c = await seedLargeCurrentHistory();
    const started = performance.now();
    const page = await store.search(c.tenant, c.actor, {
      lotId: c.lot,
      eventType: "shipping",
      limit: "1",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      lotId: c.lot,
      currentCteCount: 2003,
      firstEventDate: "2026-09-07",
      lastEventDate: "2026-09-29",
    });
    process.stdout.write(
      JSON.stringify({
        volumeSearch: "selected_lot",
        currentCteCount: page.items[0]?.currentCteCount,
        elapsedMs: Number((performance.now() - started).toFixed(2)),
      }) + "\n",
    );
  }, 20_000);

  it("requires structured CTE filters to match one event and document fields one document", async () => {
    const c = await seedShippingLifecycle(f.db);
    const otherDocument = randomUUID();
    await f.db.insert(schema.referenceDocuments).values({
      id: otherDocument,
      tenantId: c.tenant,
      type: "invoice",
      number: "INVOICE-ONLY",
      partyId: c.party,
      createdBy: c.actor,
    });
    c.draft.documentIds.push(otherDocument);
    await finalizeFixtureShipment(c, "20");
    expect(
      (
        await store.search(c.tenant, c.actor, {
          lotId: c.lot,
          eventType: "shipping",
          eventDateTo: "2026-09-07",
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await store.search(c.tenant, c.actor, {
          lotId: c.lot,
          eventType: "receiving",
          documentNumber: "INVOICE-ONLY",
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await store.search(c.tenant, c.actor, {
          lotId: c.lot,
          documentType: "bol",
          documentNumber: "INVOICE-ONLY",
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await store.search(c.tenant, c.actor, {
          lotId: c.lot,
          documentType: "invoice",
          documentNumber: "INVOICE-ONLY",
        })
      ).items,
    ).toHaveLength(1);
  });

  it("does not let unrelated corrupt evidence poison a selective hit", async () => {
    const c = await seedShippingLifecycle(f.db);
    const selectiveLot = randomUUID();
    await f.db.insert(schema.traceabilityLots).values({
      id: selectiveLot,
      tenantId: c.tenant,
      productId: c.product,
      tlc: "HEALTHY",
      assignmentBasis: "imported",
      createdBy: c.actor,
      updatedBy: c.actor,
    });
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot, '{snapshotVersion}', '999') WHERE tenant_id=${c.tenant} AND status='finalized'`,
      );
    });
    expect(
      (await store.search(c.tenant, c.actor, { q: "HEALTHY", limit: "1" })).items.map(
        (item) => item.lotId,
      ),
    ).toEqual([selectiveLot]);
  });

  it("disambiguates same TLC by source and implements every identity filter with C lexical order", async () => {
    const c = await seedReceivingTenant(f.db);
    const ref = "https://supplier.example.test/lot/10";
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await f.db.insert(schema.traceabilityLots).values([
      {
        id: ids[0],
        tenantId: c.tenant,
        productId: c.product,
        tlc: "10",
        sourceLocationId: c.location,
        assignmentBasis: "imported",
        createdBy: c.actor,
        updatedBy: c.actor,
      },
      {
        id: ids[1],
        tenantId: c.tenant,
        productId: c.product,
        tlc: "10",
        sourceReferenceKind: "web_url",
        sourceReferenceValue: ref,
        sourceReferenceLocationId: c.location,
        assignmentBasis: "imported",
        createdBy: c.actor,
        updatedBy: c.actor,
      },
      {
        id: ids[2],
        tenantId: c.tenant,
        productId: c.product,
        tlc: "2",
        assignmentBasis: "imported",
        createdBy: c.actor,
        updatedBy: c.actor,
      },
      {
        id: ids[3],
        tenantId: c.tenant,
        productId: c.product,
        tlc: "a",
        assignmentBasis: "imported",
        createdBy: c.actor,
        updatedBy: c.actor,
      },
    ]);
    const exact = await store.search(c.tenant, c.actor, { tlc: "10" });
    expect(new Set(exact.items.map((x) => x.lotId))).toEqual(new Set(ids.slice(0, 2)));
    expect(exact.items.map((x) => x.source?.kind).sort()).toEqual(["location", "reference"]);
    expect((await store.search(c.tenant, c.actor, { tlc: "A" })).items).toEqual([]);
    expect(
      (await store.search(c.tenant, c.actor, { tlcFrom: "10", tlcTo: "2" })).items,
    ).toHaveLength(3);
    expect(
      (await store.search(c.tenant, c.actor, { tlcList: JSON.stringify(["10", "a"]) })).items,
    ).toHaveLength(3);
    expect((await store.search(c.tenant, c.actor, { q: ids[0] })).items[0]?.matchedBy).toEqual([
      "lot_id",
    ]);
    for (const filter of [
      { lotId: ids[0] },
      { sourceLocationId: c.location, tlc: "10" },
      { sourceReferenceValue: ref },
    ]) {
      expect((await store.search(c.tenant, c.actor, filter)).items.length).toBeGreaterThan(0);
    }
    const filtered = await store.search(c.tenant, c.actor, {
      productId: c.product,
      productText: "apples",
      status: "active",
      sourceReferenceValue: ref,
    });
    expect(filtered.items.map((x) => x.lotId)).toEqual([ids[1]]);
    expect(filtered.items[0]?.matchedBy).toEqual([
      "product_id",
      "product_text_current",
      "source_reference",
      "status",
    ]);
    expect(filtered.items[0]).toMatchObject({
      currentCteCount: 0,
      firstEventDate: null,
      lastEventDate: null,
    });
  });

  it("uses distinct current CTEs and frozen documents, excluding superseded evidence", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const output = c.revision.snapshot.outputs[0];
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
    const shipment = await shipping.createDraft(
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
          items: [{ lotId: output.lotId, quantity: "10", unitOfMeasure: "case" }],
          documentIds: [c.document],
        },
      },
      "search-2x2-shipping",
    );
    const shippingReady = await shipping.checkReadiness(c.tenant, c.actor, shipment.id, {
      expectedDraftVersion: shipment.draftVersion,
    });
    await shipping.finalize(
      c.tenant,
      c.actor,
      shipment.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: shipment.draftVersion,
        expectedInputDigest: shippingReady.inputDigest,
      },
      "search-2x2-shipping-final",
    );
    await f.db
      .update(schema.referenceDocuments)
      .set({ number: "MUTABLE-NUMBER" })
      .where(eq(schema.referenceDocuments.id, c.document));
    await f.db
      .update(schema.products)
      .set({ name: "Current renamed apples" })
      .where(eq(schema.products.id, c.product));
    const page = await store.search(c.tenant, c.actor, {
      lotId: output.lotId,
      eventType: "transformation",
      eventDateFrom: "2026-09-26",
      eventDateTo: "2026-09-26",
      locationId: c.processor,
      documentType: "bol",
      documentNumber: "00001",
      productText: "renamed",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      currentCteCount: 2,
      firstEventDate: "2026-09-26",
      lastEventDate: "2026-09-27",
    });
    expect(page.items[0]?.matchedBy).toEqual([
      "document_number",
      "document_type",
      "event_date",
      "event_type",
      "location",
      "lot_id",
      "product_text_current",
    ]);
    expect(
      (await store.search(c.tenant, c.actor, { documentNumber: "MUTABLE-NUMBER" })).items,
    ).toEqual([]);
    expect((await store.search(c.tenant, c.actor, { lotId: c.lot })).items[0]).toMatchObject({
      currentCteCount: 2,
      firstEventDate: "2026-09-07",
      lastEventDate: "2026-09-26",
    });
    expect((await store.search(c.tenant, c.actor, { eventDateFrom: "2026-09-28" })).items).toEqual(
      [],
    );
  });

  it("does not match a document found only in a superseded CTE", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const output = c.revision.snapshot.outputs[0];
    if (!output) throw new Error("Missing output");
    await f.db
      .update(schema.referenceDocuments)
      .set({ number: "NEW-CURRENT-NUMBER" })
      .where(eq(schema.referenceDocuments.id, c.document));
    const amendment = await c.store.amend(
      c.tenant,
      c.actor,
      c.revision.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "Update reference" },
      "search-doc-amend",
    );
    if (amendment.record.status !== "draft") throw new Error("Missing amendment");
    const ready = await c.store.checkReadiness(c.tenant, c.actor, amendment.record.id, {
      expectedDraftVersion: amendment.record.draftVersion,
    });
    await c.store.finalize(
      c.tenant,
      c.actor,
      amendment.record.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: amendment.record.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "search-doc-final",
    );
    expect(
      (await store.search(c.tenant, c.actor, { lotId: output.lotId, documentNumber: "00001" }))
        .items,
    ).toEqual([]);
    expect(
      (
        await store.search(c.tenant, c.actor, {
          lotId: output.lotId,
          documentNumber: "NEW-CURRENT-NUMBER",
        })
      ).items,
    ).toHaveLength(1);
  });

  it("evaluates numeric q across TLC, frozen document and both SSCC states", async () => {
    const c = await seedFinalizableTransformation(f);
    const code = buildSscc(0, "1234567", 12);
    await f.db
      .update(schema.referenceDocuments)
      .set({ number: code, type: "other", typeOtherLabel: "Frozen custom form" })
      .where(eq(schema.referenceDocuments.id, c.document));
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...c.saved.draft,
          outputs: [{ productId: c.product, tlc: code, quantity: "100", unitOfMeasure: "case" }],
        },
      },
      "search-numeric-save",
    );
    const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: saved.draftVersion,
    });
    const finalized = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: saved.draftVersion,
        expectedInputDigest: ready.inputDigest,
      },
      "search-numeric-final",
    );
    const lot = finalized.snapshot.outputs[0]?.lotId;
    if (!lot) throw new Error("Missing output");
    const shift = randomUUID(),
      box = randomUUID();
    await f.db.insert(schema.shifts).values({
      id: shift,
      tenantId: c.tenant,
      productId: c.product,
      mode: "aggregation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
    });
    await f.db.insert(schema.boxes).values({
      id: box,
      tenantId: c.tenant,
      shiftId: shift,
      deviceBoxId: "search-existing",
      sscc: code,
    });
    const cases = new UsCaseStore(f.db);
    await cases.link(
      c.tenant,
      c.actor,
      lot,
      { operationKey: randomUUID(), ssccs: [code] },
      "search-link",
    );
    const first = await cases.lookup(c.tenant, c.actor, { sscc: code });
    if (!first.activeLink) throw new Error("Missing link");
    await cases.unlink(
      c.tenant,
      c.actor,
      lot,
      first.activeLink.linkId,
      { operationKey: randomUUID(), reason: "Replace link" },
      "search-unlink",
    );
    await cases.link(
      c.tenant,
      c.actor,
      lot,
      { operationKey: randomUUID(), ssccs: [code] },
      "search-relink",
    );
    const page = await store.search(c.tenant, c.actor, { q: code, tlc: code, limit: "1" });
    expect(page.items[0]?.matchedBy).toEqual([
      "document_number",
      "sscc_current",
      "sscc_historical",
      "tlc",
    ]);
    expect(page.items[0]?.ssccLinks.map((x) => x.state).sort()).toEqual(["current", "historical"]);
    expect(page.items[0]?.ssccLinks.every((x) => x.provenance === "existing_record")).toBe(true);
    expect(page.items[0]?.ssccLinks.find((x) => x.state === "historical")?.unlinkReason).toBe(
      "Replace link",
    );
    expect(
      (
        await store.search(c.tenant, c.actor, { documentType: "Frozen custom form", tlc: code })
      ).items.map((x) => x.lotId),
    ).toEqual([lot]);
    await f.db
      .update(schema.boxes)
      .set({ sscc: buildSscc(0, "1234567", 999) })
      .where(eq(schema.boxes.id, box));
    expect((await store.search(c.tenant, c.actor, { sscc: code })).items[0]?.lotId).toBe(lot);
  });

  it("returns a saved multiline unlink reason through ordinary lot search", async () => {
    const c = await seedCaseBridge(f);
    const code = c.codes[0];
    if (!code) throw new Error("Missing case code");
    const cases = new UsCaseStore(f.db);
    await cases.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [code] },
      "multiline-link",
    );
    const current = await cases.lookup(c.tenant, c.actor, { sscc: code });
    if (!current.activeLink) throw new Error("Missing case link");
    const reason = "Damaged case\nRepacked on another pallet";
    await cases.unlink(
      c.tenant,
      c.actor,
      c.lotId,
      current.activeLink.linkId,
      { operationKey: randomUUID(), reason },
      "multiline-unlink",
    );
    const saved = await cases.list(c.tenant, c.actor, c.lotId, { history: true, limit: 100 });
    expect(saved.rows.find((row) => row.linkId === current.activeLink?.linkId)?.unlinkReason).toBe(
      reason,
    );
    const page = await store.search(c.tenant, c.actor, { lotId: c.lotId });
    expect(
      page.items[0]?.ssccLinks.find((link) => link.linkId === current.activeLink?.linkId),
    ).toMatchObject({ state: "historical", unlinkReason: reason });
  });

  it("bounds case samples, retains searched historical and current evidence, and drills down through all links", async () => {
    const c = await seedCaseBridge(f);
    const cases = new UsCaseStore(f.db);
    await cases.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: c.codes.slice(0, 30) },
      "sample-links",
    );
    const code = c.codes[29];
    if (!code) throw new Error("Missing code");
    const link = await cases.lookup(c.tenant, c.actor, { sscc: code });
    if (!link.activeLink) throw new Error("Missing link");
    await cases.unlink(
      c.tenant,
      c.actor,
      c.lotId,
      link.activeLink.linkId,
      { operationKey: randomUUID(), reason: "Retain history" },
      "sample-unlink",
    );
    await cases.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [code] },
      "sample-relink",
    );
    for (let i = 0; i < 21; i++) {
      const current = await cases.lookup(c.tenant, c.actor, { sscc: code });
      if (!current.activeLink) throw new Error("Missing relink");
      await cases.unlink(
        c.tenant,
        c.actor,
        c.lotId,
        current.activeLink.linkId,
        { operationKey: randomUUID(), reason: `Historical replacement ${i}` },
        `sample-repeat-unlink-${i}`,
      );
      await cases.link(
        c.tenant,
        c.actor,
        c.lotId,
        { operationKey: randomUUID(), ssccs: [code] },
        `sample-repeat-link-${i}`,
      );
    }
    const before = await caseState(f, c.tenant);
    const auditBefore = await f.pool.query(
      "SELECT to_jsonb(a) AS row FROM tenant_audit_events a WHERE organization_id=$1 ORDER BY id",
      [c.tenant],
    );
    const page = await store.search(c.tenant, c.actor, { sscc: code });
    expect(page.items[0]).toMatchObject({
      moreCaseHistory: true,
      matchedBy: ["sscc_current", "sscc_historical"],
    });
    expect(page.items[0]?.ssccLinks).toHaveLength(20);
    expect(page.items[0]?.ssccLinks.every((x) => x.provenance === "synthetic_demo")).toBe(true);
    expect(
      new Set(page.items[0]?.ssccLinks.filter((x) => x.ssccAtLink === code).map((x) => x.state)),
    ).toEqual(new Set(["current", "historical"]));
    const all = await cases.list(c.tenant, c.actor, c.lotId, { history: true, limit: 100 });
    expect(all.rows).toHaveLength(52);
    expect(await caseState(f, c.tenant)).toEqual(before);
    expect(
      (
        await f.pool.query(
          "SELECT to_jsonb(a) AS row FROM tenant_audit_events a WHERE organization_id=$1 ORDER BY id",
          [c.tenant],
        )
      ).rows,
    ).toEqual(auditBefore.rows);
  });

  it("uses keyset pagination with microsecond precision, default 50 and maximum 100", async () => {
    const c = await seedReceivingTenant(f.db);
    const ids = Array.from({ length: 103 }, () => randomUUID()).sort();
    await f.db.insert(schema.traceabilityLots).values(
      ids.map((id, i) => ({
        id,
        tenantId: c.tenant,
        productId: c.product,
        tlc: `P-${i}`,
        assignmentBasis: "imported" as const,
        createdBy: c.actor,
        updatedBy: c.actor,
      })),
    );
    await f.pool.query(
      "UPDATE traceability_lots SET created_at='2026-09-27T00:00:00.123456Z' WHERE tenant_id=$1",
      [c.tenant],
    );
    const first = await store.search(c.tenant, c.actor, {});
    expect(first.items).toHaveLength(50);
    const seen = first.items.map((x) => x.lotId);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await store.search(c.tenant, c.actor, { cursor, limit: "17" });
      seen.push(...page.items.map((x) => x.lotId));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...ids, c.lot].sort());
    expect((await store.search(c.tenant, c.actor, { limit: "100" })).items).toHaveLength(100);
    expect(
      (await store.search(c.tenant, c.actor, { tlc: "P-102", limit: "1" })).items,
    ).toHaveLength(1);
  });

  it("keeps tenant data invisible and reloads current membership", async () => {
    const a = await seedShippingLifecycle(f.db),
      b = await seedReceivingTenant(f.db);
    expect((await store.search(b.tenant, b.actor, { lotId: a.lot })).items).toEqual([]);
    expect((await store.search(b.tenant, b.actor, { q: a.lot })).items).toEqual([]);
    expect((await store.search(b.tenant, b.actor, { documentNumber: "00001" })).items).toEqual([]);
    await f.db.delete(schema.member).where(eq(schema.member.id, b.member));
    await expect(store.search(b.tenant, b.actor, {})).rejects.toMatchObject({ status: 403 });
  });

  it("reads Receiving and Shipping in one repeatable snapshot during concurrent finalization", async () => {
    const c = await seedShippingLifecycle(f.db);
    const actual = relations.assertTraceRelations;
    let finalized = false;
    vi.spyOn(relations, "assertTraceRelations").mockImplementation(async (...args) => {
      const result = await actual(...args);
      if (!finalized) {
        finalized = true;
        await finalizeFixtureShipment(c, "20");
      }
      return result;
    });
    expect(
      (await store.search(c.tenant, c.actor, { lotId: c.lot })).items[0]?.currentCteCount,
    ).toBe(1);
    expect(
      (
        await store.search(c.tenant, c.actor, {
          lotId: c.lot,
          eventType: "shipping",
          locationId: c.recipient,
          documentNumber: "00001",
        })
      ).items[0],
    ).toMatchObject({ currentCteCount: 2, lastEventDate: "2026-09-27" });
  });

  it("fails closed for corrupt matching frozen-document evidence", async () => {
    const c = await seedShippingLifecycle(f.db);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot, '{snapshotVersion}', '999') WHERE tenant_id=${c.tenant} AND status='finalized'`,
      );
    });
    await expect(
      store.search(c.tenant, c.actor, { lotId: c.lot, documentNumber: "00001" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("converts a real statement timeout to sanitized 503", async () => {
    const c = await seedShippingLifecycle(f.db);
    vi.spyOn(relations, "assertTraceRelations").mockImplementation(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='1ms'`);
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
    });
    await expect(store.search(c.tenant, c.actor, {})).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
  });

  it("reports actual TLC, SSCC and frozen-document query plans without performance pass thresholds", async () => {
    const c = await seedCaseBridge(f);
    await new UsCaseStore(f.db).link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: c.codes },
      "search-plan-links",
    );
    await f.db.insert(schema.traceabilityLots).values(
      Array.from({ length: 300 }, (_, index) => ({
        id: randomUUID(),
        tenantId: c.tenant,
        productId: c.product,
        tlc: `PLAN-${index}`,
        assignmentBasis: "imported" as const,
        createdBy: c.actor,
        updatedBy: c.actor,
      })),
    );
    for (const [label, raw] of [
      ["TLC", { tlc: "NEW-OUTPUT" }],
      ["SSCC", { sscc: c.codes[99] }],
      ["document", { documentNumber: "00001" }],
    ] as const) {
      const plan = await f.db.execute<{ "QUERY PLAN": string }>(
        sql`EXPLAIN (ANALYZE, BUFFERS) ${traceSearchCandidateQuery(c.tenant, parseUsTraceSearchQuery(raw))}`,
      );
      const timings = plan.rows
        .map((row) => row["QUERY PLAN"])
        .filter((line) => /Planning Time|Execution Time|Buffers:/.test(line));
      const started = performance.now();
      const result = await store.search(c.tenant, c.actor, raw);
      expect(result.items.length).toBeGreaterThan(0);
      process.stdout.write(
        JSON.stringify({
          searchPlan: label,
          tenantLots: 303,
          caseLinks: 100,
          fullSearchMs: Number((performance.now() - started).toFixed(2)),
          timings,
          scans: plan.rows
            .map((row) => row["QUERY PLAN"])
            .filter((line) => /Scan|Sort Method/.test(line)),
        }) + "\n",
      );
    }
  });
});
