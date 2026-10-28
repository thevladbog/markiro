import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import {
  SHIPPING_READINESS_RULE_VERSION,
  shippingReadinessSchema,
  type ShippingReadiness,
} from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-draft";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedReceivingTenant } from "./support/us-receiving-fixture";

// Assertions apply to readiness semantics, while opaque metadata is validated separately.
function expectNoFdaReadinessAssertion(ready: ShippingReadiness) {
  const assertions = Object.fromEntries(
    Object.entries(shippingReadinessSchema.parse(ready)).filter(
      ([key]) => key !== "eventId" && key !== "inputDigest",
    ),
  );
  expect(JSON.stringify(assertions)).not.toMatch(/FDA|FSMA|export.ready/i);
}

describe("generic Shipping readiness assertion", () => {
  const ready: ShippingReadiness = {
    eventId: "fdafdafd-0000-4000-8000-000000000000",
    expectedDraftVersion: 1,
    ruleVersion: SHIPPING_READINESS_RULE_VERSION,
    inputDigest: "fda" + "0".repeat(61),
    state: "incomplete",
    profileCode: "US_GENERIC_LOT_TRACEABILITY",
    issues: [{ severity: "error", path: "eventDate", code: "required", line: null }],
  };
  it("does not mistake validated opaque UUID and digest bytes for regulatory assertions", () => {
    expectNoFdaReadinessAssertion(ready);
  });
  it("still rejects actual FDA, FSMA and export-ready readiness assertions", () => {
    for (const text of ["FDA", "FSMA", "export-ready"]) {
      expect(() =>
        expectNoFdaReadinessAssertion({
          ...ready,
          eventId: "00000000-0000-4000-8000-000000000000",
          inputDigest: "0".repeat(64),
          issues: [{ severity: "error", path: "readiness", code: text, line: null }],
        }),
      ).toThrow();
    }
  });
  it("rejects malformed opaque metadata instead of excluding it unchecked", () => {
    for (const value of [
      { ...ready, eventId: "invalid" },
      { ...ready, inputDigest: "invalid" },
    ])
      expect(() => expectNoFdaReadinessAssertion(value)).toThrow();
  });
});

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Shipping saved readiness", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsShippingStore;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
    store = new UsShippingStore(f.db);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("uses fresh references and balance, with a stable versioned digest", async () => {
    const c = await seedReceivingTenant(f.db);
    const draft = {
      eventDate: "2026-09-27",
      shipFromLocationId: c.location,
      recipientLocationId: c.location,
      carrierReference: null,
      notes: null,
      items: [{ lotId: c.lot, quantity: "1", unitOfMeasure: "case" }],
      documentIds: [c.document],
    };
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "create",
    );
    const read = () =>
      store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 });
    const initial = await read();
    expect(initial.state).toBe("incomplete");
    expect(initial.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "recipientLocationId", code: "same_location" }),
        expect.objectContaining({ path: "items[0].origin", code: "origin_missing" }),
      ]),
    );
    expect(await read()).toEqual(initial);
    await expect(
      store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 2 }),
    ).rejects.toMatchObject({ response: { code: "shipping_draft_conflict" } });
    await f.db
      .update(schema.referenceDocuments)
      .set({ archivedAt: new Date() })
      .where(eq(schema.referenceDocuments.id, c.document));
    const changed = await read();
    expect(changed.issues).toContainEqual(
      expect.objectContaining({ path: "documentIds", code: "inactive" }),
    );
    expect(changed.inputDigest).not.toBe(initial.inputDigest);
  });

  it("generic profile carries no FDA readiness assertion", async () => {
    const c = await seedReceivingTenant(f.db);
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    const draft = {
      eventDate: null,
      shipFromLocationId: null,
      recipientLocationId: null,
      carrierReference: null,
      notes: null,
      items: [],
      documentIds: [],
    };
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "generic",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready).toMatchObject({
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      state: "incomplete",
    });
    expectNoFdaReadinessAssertion(ready);
  });

  it("checks current ship-from and recipient roles after a draft was saved", async () => {
    const c = await seedReceivingTenant(f.db);
    const recipientId = randomUUID();
    await f.db.insert(schema.traceabilityLocations).values({
      id: recipientId,
      tenantId: c.tenant,
      partyId: c.party,
      name: "Recipient dock",
      businessName: "Synthetic recipient",
    });
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: "2026-09-27",
          shipFromLocationId: c.location,
          recipientLocationId: recipientId,
          carrierReference: null,
          notes: null,
          items: [],
          documentIds: [c.document],
        },
      },
      "roles",
    );
    const readiness = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(readiness.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "shipFromLocationId", code: "wrong_role" }),
        expect.objectContaining({ path: "recipientLocationId", code: "wrong_role" }),
      ]),
    );
  });

  it("reads a current Receiving origin and blocks an exact over-shipment", async () => {
    const c = await seedCompleteReceiving(f.db);
    await f.db
      .update(schema.traceabilityLocations)
      .set({ roles: ["receive_at", "ship_from"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({
        coverageStatus: "covered",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "Synthetic 2026",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const recipientId = randomUUID();
    await f.db.insert(schema.traceabilityLocations).values({
      id: recipientId,
      tenantId: c.tenant,
      partyId: c.party,
      name: "Recipient",
      businessName: "Synthetic recipient",
      phoneNumber: "+1 555 010 0200",
      streetAddress: "2 Test Street",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["recipient"],
    });
    const receiving = new UsReceivingStore(f.db);
    const receipt = await receiving.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "receipt",
    );
    const receiptReady = await receiving.checkReadiness(c.tenant, c.actor, receipt.id, {
      expectedDraftVersion: 1,
    });
    expect(receiptReady.state).toBe("complete");
    await receiving.finalize(
      c.tenant,
      c.actor,
      receipt.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: receiptReady.inputDigest,
      },
      "receipt-final",
    );
    const draft = {
      eventDate: "2026-09-27",
      shipFromLocationId: c.location,
      recipientLocationId: recipientId,
      carrierReference: null,
      notes: null,
      items: [{ lotId: c.lot, quantity: "0.250", unitOfMeasure: "kg" }],
      documentIds: [c.document],
    };
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "ship",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready).toMatchObject({ state: "complete", issues: [] });
    const larger = await store.saveDraft(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...draft, items: [{ lotId: c.lot, quantity: "0.251", unitOfMeasure: "kg" }] },
      },
      "larger",
    );
    const over = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: larger.draftVersion,
    });
    expect(over.issues).toContainEqual(
      expect.objectContaining({ path: "items[0].quantity", code: "over_shipment" }),
    );
    expect(over.inputDigest).not.toBe(ready.inputDigest);
    await f.db
      .update(schema.traceabilityLots)
      .set({ status: "quarantined" })
      .where(eq(schema.traceabilityLots.id, c.lot));
    await f.db
      .update(schema.productTraceabilityProfiles)
      .set({ coverageStatus: "unknown", reviewedBy: null, reviewedAt: null })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const blocked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: larger.draftVersion,
    });
    expect(blocked.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "items[0].lotId", code: "status_blocked" }),
        expect.objectContaining({ path: "items[0].coverage", code: "coverage_unresolved" }),
      ]),
    );
  });
});
