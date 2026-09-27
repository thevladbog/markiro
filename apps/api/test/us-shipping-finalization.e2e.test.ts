import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!url)("Shipping finalization", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsShippingStore;
  beforeAll(async () => {
    fixture = await createUsProfileTestDatabase(url!);
    store = new UsShippingStore(fixture.db);
  }, 60000);
  afterAll(async () => fixture?.close());

  async function setup(sourceReference = false) {
    const c = await seedCompleteReceiving(fixture.db);
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["receive_at", "ship_from"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({
        coverageStatus: "covered",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "Synthetic 2026",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const recipient = randomUUID();
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: recipient,
      tenantId: c.tenant,
      partyId: c.party,
      name: "Recipient",
      businessName: "Synthetic buyer",
      phoneNumber: "+1 555 010 0200",
      streetAddress: "2 Test Street",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["recipient"],
    });
    const invoice = randomUUID();
    await fixture.db.insert(schema.referenceDocuments).values({
      id: invoice,
      tenantId: c.tenant,
      type: "invoice",
      number: "INV-100",
      partyId: c.party,
      createdBy: c.actor,
    });
    const second = c.draft.items[1];
    if (!second) throw new Error("Missing linked Receiving line");
    second.quantity = "100";
    second.unitOfMeasure = "case";
    if (sourceReference) {
      const source = {
        kind: "reference" as const,
        referenceKind: "web_url" as const,
        referenceValue: "https://supplier.example.test/Exact/Case?batch=0001",
        resolvedLocationId: c.location,
      };
      second.source = source;
      await fixture.db
        .update(schema.traceabilityLots)
        .set({
          sourceLocationId: null,
          sourceReferenceKind: source.referenceKind,
          sourceReferenceValue: source.referenceValue,
          sourceReferenceLocationId: source.resolvedLocationId,
        })
        .where(eq(schema.traceabilityLots.id, c.lot));
    }
    const receiving = new UsReceivingStore(fixture.db);
    const receipt = await receiving.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "receipt",
    );
    const ready = await receiving.checkReadiness(c.tenant, c.actor, receipt.id, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
    await receiving.finalize(
      c.tenant,
      c.actor,
      receipt.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "receipt-final",
    );
    const draft = {
      eventDate: "2026-09-27",
      shipFromLocationId: c.location,
      recipientLocationId: recipient,
      carrierReference: "Truck 1",
      notes: null,
      items: [{ lotId: c.lot, quantity: "60", unitOfMeasure: "case" }],
      documentIds: [c.document, invoice],
    };
    return { ...c, recipient, invoice, draft };
  }

  async function createReady(c: Awaited<ReturnType<typeof setup>>, quantity = "60") {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: { ...c.draft, items: [{ ...c.draft.items[0]!, quantity }] },
      },
      "ship-create",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    return { saved, ready };
  }

  it("freezes exact KDEs, status and audit for a 100-case BOL/invoice shipment", async () => {
    const c = await setup();
    const { saved, ready } = await createReady(c, "100");
    expect(ready.state).toBe("complete");
    const result = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "ship-final",
    );
    expect(result.status).toBe("finalized");
    expect(result.snapshot.items[0]).toMatchObject({
      lotId: c.lot,
      quantity: "100",
      unitOfMeasure: "case",
      tlc: "00001",
    });
    const sourceLocation = {
      schemaVersion: 1,
      locationId: c.location,
      partyId: c.party,
      businessName: "Synthetic supplier",
      phoneNumber: "+1 555 010 0100",
      address: { kind: "street", streetAddress: "1 Test Street" },
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      countryDisplay: "United States",
    };
    const recipientLocation = {
      schemaVersion: 1,
      locationId: c.recipient,
      partyId: c.party,
      businessName: "Synthetic buyer",
      phoneNumber: "+1 555 010 0200",
      address: { kind: "street", streetAddress: "2 Test Street" },
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      countryDisplay: "United States",
    };
    const productDescription = {
      snapshotVersion: 1,
      sourceProductId: c.product,
      productName: "Synthetic apples",
      brandName: null,
      commodity: null,
      variety: null,
      packagingSize: null,
      packagingStyle: null,
      gtin: null,
    };
    expect(result.snapshot.shipFrom).toEqual(sourceLocation);
    expect(result.snapshot.recipient).toEqual(recipientLocation);
    expect(result.snapshot.items[0]?.source).toEqual({
      kind: "location",
      location: sourceLocation,
    });
    expect(result.snapshot.items[0]?.product).toEqual({
      id: c.product,
      description: productDescription,
      coverage: expect.objectContaining({ coverageStatus: "covered" }),
    });
    expect(result.snapshot.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "bol",
          number: "00001",
          issuer: expect.objectContaining({ id: c.party }),
        }),
        expect.objectContaining({
          type: "invoice",
          number: "INV-100",
          issuer: expect.objectContaining({ id: c.party }),
        }),
      ]),
    );
    const [lot] = await fixture.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(lot?.status).toBe("shipped");
    const audit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.targetId, saved.id),
          eq(schema.tenantAuditEvents.action, "traceability.shipping.finalized"),
        ),
      );
    expect(audit).toEqual([
      expect.objectContaining({
        actorUserId: c.actor,
        organizationId: c.tenant,
        action: "traceability.shipping.finalized",
        outcome: "success",
        targetType: "traceability_event",
        targetId: saved.id,
        requestId: "ship-final",
      }),
    ]);
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed buyer" })
      .where(eq(schema.traceabilityLocations.id, c.recipient));
    await fixture.db
      .update(schema.referenceDocuments)
      .set({ number: "CHANGED-INV" })
      .where(eq(schema.referenceDocuments.id, c.invoice));
    const historical = await store.getRecord(c.tenant, c.actor, saved.id);
    expect(historical.status).toBe("finalized");
    if (historical.status !== "finalized") throw new Error("Expected finalized Shipping record");
    expect(historical.snapshot).toEqual(result.snapshot);
    const [detail] = await fixture.db
      .select()
      .from(schema.shippingEventDetails)
      .where(eq(schema.shippingEventDetails.eventId, saved.id));
    const [item] = await fixture.db
      .select()
      .from(schema.shippingEventItems)
      .where(eq(schema.shippingEventItems.eventId, saved.id));
    expect(detail?.recipientSnapshot).toEqual({
      id: c.recipient,
      description:
        "Synthetic buyer, 2 Test Street, Chicago, IL, 60601, United States, +1 555 010 0200",
      location: recipientLocation,
    });
    expect(item?.sourceSnapshot).toEqual({ kind: "location", location: sourceLocation });
    expect(item?.productSnapshot).toEqual(result.snapshot.items[0]?.product);
  });

  it("preserves coordinate address, commas, nullable product fields and country display", async () => {
    const c = await setup();
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({
        businessName: "Supplier, Inc.",
        phoneNumber: "+1 555 010 0100 ext 42",
        streetAddress: "1 Test Street, Suite 4",
      })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({
        businessName: "Buyer, LLC",
        addressKind: "coordinates",
        streetAddress: null,
        latitude: "41.881832",
        longitude: "-87.627761",
      })
      .where(eq(schema.traceabilityLocations.id, c.recipient));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({
        productName: "Apples, sliced",
        brandName: null,
        commodity: "Fruit, fresh-cut",
        variety: null,
        packagingSizeValue: "12.000",
        packagingSizeUom: "case",
        packagingStyle: "Case, sealed",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const { saved, ready } = await createReady(c);
    expect(ready.state).toBe("complete");
    const result = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "structured-snapshot",
    );
    expect(result.snapshot.shipFrom).toEqual({
      schemaVersion: 1,
      locationId: c.location,
      partyId: c.party,
      businessName: "Supplier, Inc.",
      phoneNumber: "+1 555 010 0100 ext 42",
      address: { kind: "street", streetAddress: "1 Test Street, Suite 4" },
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      countryDisplay: "United States",
    });
    expect(result.snapshot.recipient).toEqual({
      schemaVersion: 1,
      locationId: c.recipient,
      partyId: c.party,
      businessName: "Buyer, LLC",
      phoneNumber: "+1 555 010 0200",
      address: { kind: "coordinates", latitude: "41.881832", longitude: "-87.627761" },
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      countryDisplay: "United States",
    });
    const [coordinateDetail] = await fixture.db
      .select()
      .from(schema.shippingEventDetails)
      .where(eq(schema.shippingEventDetails.eventId, saved.id));
    expect(coordinateDetail?.recipientSnapshot).toEqual({
      id: c.recipient,
      description:
        "Buyer, LLC, 41.881832, -87.627761, Chicago, IL, 60601, United States, +1 555 010 0200",
      location: result.snapshot.recipient,
    });
    expect(result.snapshot.items[0]?.product).toEqual({
      id: c.product,
      description: {
        snapshotVersion: 1,
        sourceProductId: c.product,
        productName: "Apples, sliced",
        brandName: null,
        commodity: "Fruit, fresh-cut",
        variety: null,
        packagingSize: { value: "12.000", uom: "case" },
        packagingStyle: "Case, sealed",
        gtin: null,
      },
      coverage: expect.objectContaining({ coverageStatus: "covered" }),
    });
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({
        businessName: "New buyer",
        latitude: "40.000000",
        longitude: "-80.000000",
      })
      .where(eq(schema.traceabilityLocations.id, c.recipient));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({
        productName: "Changed apples",
        commodity: null,
        packagingStyle: null,
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const historical = await store.getRecord(c.tenant, c.actor, saved.id);
    if (historical.status !== "finalized") throw new Error("Expected finalized Shipping record");
    expect(historical.snapshot).toEqual(result.snapshot);
  });

  it("pins source-reference URL and resolved full Location Description", async () => {
    const c = await setup(true);
    const { saved, ready } = await createReady(c);
    expect(ready.state).toBe("complete");
    const result = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "source-reference",
    );
    const source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/Exact/Case?batch=0001",
      resolvedLocation: {
        schemaVersion: 1,
        locationId: c.location,
        partyId: c.party,
        businessName: "Synthetic supplier",
        phoneNumber: "+1 555 010 0100",
        address: { kind: "street", streetAddress: "1 Test Street" },
        city: "Chicago",
        stateOrRegion: "IL",
        zipOrPostalCode: "60601",
        countryCode: "US",
        countryDisplay: "United States",
      },
    };
    expect(result.snapshot.items[0]?.source).toEqual(source);
    const [item] = await fixture.db
      .select()
      .from(schema.shippingEventItems)
      .where(eq(schema.shippingEventItems.eventId, saved.id));
    expect(item?.sourceSnapshot).toEqual(source);
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed supplier" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    const historical = await store.getRecord(c.tenant, c.actor, saved.id);
    if (historical.status !== "finalized") throw new Error("Expected finalized Shipping record");
    expect(historical.snapshot.items[0]?.source).toEqual(source);
  });

  it("replays the same operation, but rejects a changed operation intent", async () => {
    const c = await setup();
    const { saved, ready } = await createReady(c);
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: ready.inputDigest,
    };
    const first = await store.finalize(c.tenant, c.actor, saved.id, command, "first");
    expect(await store.finalize(c.tenant, c.actor, saved.id, command, "replay")).toEqual(first);
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        { ...command, expectedDraftVersion: 2 },
        "collision",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_operation_conflict" } });
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(first);
  });

  it("rejects incomplete, over-shipped and UOM-mismatched saved drafts", async () => {
    const c = await setup();
    const cases = [
      { change: { recipientLocationId: null }, code: "required", path: "recipientLocationId" },
      { change: { documentIds: [] }, code: "required", path: "documentIds" },
      {
        change: { items: [{ lotId: c.lot, quantity: "101", unitOfMeasure: "case" }] },
        code: "over_shipment",
        path: "items[0].quantity",
      },
      {
        change: { items: [{ lotId: c.lot, quantity: "1", unitOfMeasure: "kg" }] },
        code: "uom_mismatch",
        path: "items[0].unitOfMeasure",
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const saved = await store.createDraft(
        c.tenant,
        c.actor,
        {
          operationKey: randomUUID(),
          draft: { ...c.draft, ...scenario.change },
        },
        `negative-${index}`,
      );
      const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
        expectedDraftVersion: 1,
      });
      expect(ready.issues).toContainEqual(
        expect.objectContaining({ path: scenario.path, code: scenario.code }),
      );
      await expect(
        store.finalize(
          c.tenant,
          c.actor,
          saved.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: ready.inputDigest,
          },
          `negative-final-${index}`,
        ),
      ).rejects.toMatchObject({ response: { code: "event_incomplete" } });
    }
  });

  it("rechecks archived recipient/document and coverage changes after readiness", async () => {
    const c = await setup();
    const { saved, ready } = await createReady(c);
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ archived: true })
      .where(eq(schema.traceabilityLocations.id, c.recipient));
    await fixture.db
      .update(schema.referenceDocuments)
      .set({ archivedAt: new Date() })
      .where(eq(schema.referenceDocuments.id, c.invoice));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({ coverageStatus: "unknown", reviewedBy: null, reviewedAt: null })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const current = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(current.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "recipientLocationId", code: "inactive" }),
        expect.objectContaining({ path: "documentIds", code: "inactive" }),
        expect.objectContaining({ path: "items[0].coverage", code: "coverage_unresolved" }),
      ]),
    );
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        "changed",
      ),
    ).rejects.toMatchObject({ response: { code: "event_incomplete" } });
  });

  it("checks version/digest, current membership and tenant identity", async () => {
    const c = await setup();
    const { saved, ready } = await createReady(c);
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 2,
          expectedInputDigest: ready.inputDigest,
        },
        "stale",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_draft_conflict" } });
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: "0".repeat(64),
        },
        "digest",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_readiness_changed" } });
    const foreign = await seedCompleteReceiving(fixture.db);
    await expect(
      store.finalize(
        foreign.tenant,
        foreign.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        "foreign",
      ),
    ).rejects.toMatchObject({ response: { code: "shipping_not_found" } });
    await fixture.db
      .update(schema.member)
      .set({ role: "manager" })
      .where(eq(schema.member.id, c.member));
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
        "wrong-role",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
