import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import { UsShippingStore } from "../../src/modules/traceability/shipping/us-shipping-draft";
import { seedCompleteReceiving } from "./us-receiving-fixture";

/** A synthetic, finalized 100-case Receiving origin and complete Shipping references. */
export async function seedShippingLifecycle(db: Db) {
  const c = await seedCompleteReceiving(db);
  await db
    .update(schema.traceabilityLocations)
    .set({ roles: ["receive_at", "ship_from"] })
    .where(eq(schema.traceabilityLocations.id, c.location));
  await db
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
  await db.insert(schema.traceabilityLocations).values({
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
  const linked = c.draft.items[1];
  if (!linked) throw new Error("Missing fixture lot line");
  linked.quantity = "100";
  linked.unitOfMeasure = "case";
  const receiving = new UsReceivingStore(db);
  const receipt = await receiving.createDraft(
    c.tenant,
    c.actor,
    { operationKey: randomUUID(), draft: c.draft },
    "seed-receipt",
  );
  const ready = await receiving.checkReadiness(c.tenant, c.actor, receipt.id, {
    expectedDraftVersion: 1,
  });
  if (ready.state !== "complete")
    throw new Error(`Fixture receipt incomplete: ${JSON.stringify(ready.issues)}`);
  await receiving.finalize(
    c.tenant,
    c.actor,
    receipt.id,
    { operationKey: randomUUID(), expectedDraftVersion: 1, expectedInputDigest: ready.inputDigest },
    "seed-receipt-final",
  );
  const store = new UsShippingStore(db);
  const draft = {
    eventDate: "2026-09-27",
    shipFromLocationId: c.location,
    recipientLocationId: recipient,
    carrierReference: null,
    notes: null,
    items: [{ lotId: c.lot, quantity: "20", unitOfMeasure: "case" }],
    documentIds: [c.document],
  };
  return { ...c, recipient, draft, store };
}

export async function finalizeFixtureShipment(
  c: Awaited<ReturnType<typeof seedShippingLifecycle>>,
  quantity: string,
) {
  const draft = { ...c.draft, items: [{ ...c.draft.items[0]!, quantity }] };
  const saved = await c.store.createDraft(
    c.tenant,
    c.actor,
    { operationKey: randomUUID(), draft },
    `seed-shipping-${quantity}`,
  );
  const ready = await c.store.checkReadiness(c.tenant, c.actor, saved.id, {
    expectedDraftVersion: 1,
  });
  if (ready.state !== "complete")
    throw new Error(`Fixture shipment incomplete: ${JSON.stringify(ready.issues)}`);
  return c.store.finalize(
    c.tenant,
    c.actor,
    saved.id,
    { operationKey: randomUUID(), expectedDraftVersion: 1, expectedInputDigest: ready.inputDigest },
    `seed-shipping-final-${quantity}`,
  );
}
