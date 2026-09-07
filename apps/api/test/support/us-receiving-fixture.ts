import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import type { ReceivingDraft, ReceivingDraftItem } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";

export const emptyReceivingItem: ReceivingDraftItem = {
  productId: null,
  lotId: null,
  lotLinkMode: "create_on_finalize",
  tlc: null,
  source: null,
  exemptSupplier: false,
  exemptReason: null,
  supplierLotReference: null,
  quantity: null,
  unitOfMeasure: null,
  notes: null,
};
export const emptyReceivingDraft: ReceivingDraft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [],
  documentIds: [],
};

export async function seedReceivingTenant(db: Db) {
  const tenant = randomUUID(),
    actor = randomUUID(),
    member = randomUUID(),
    party = randomUUID(),
    location = randomUUID(),
    product = randomUUID(),
    lot = randomUUID(),
    document = randomUUID();
  await db
    .insert(schema.organization)
    .values({ id: tenant, name: "Synthetic receiving", slug: tenant, createdAt: new Date() });
  await db
    .insert(schema.user)
    .values({ id: actor, name: "Synthetic actor", email: `${actor}@example.test` });
  await db.insert(schema.member).values({
    id: member,
    organizationId: tenant,
    userId: actor,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(schema.traceabilityProfiles).values({
    tenantId: tenant,
    code: "US_FSMA204_PROCESSOR",
    baselineVersion: "US-REG-2026-09-03",
    retentionYears: 5,
    effectiveAt: new Date(),
    updatedByUserId: actor,
  });
  await db.insert(schema.orgProfiles).values({ tenantId: tenant, timeZone: "America/Chicago" });
  await db
    .insert(schema.traceabilityParties)
    .values({ id: party, tenantId: tenant, name: "Synthetic supplier" });
  await db.insert(schema.traceabilityLocations).values({
    id: location,
    tenantId: tenant,
    partyId: party,
    name: "Dock",
    businessName: "Synthetic supplier",
  });
  await db
    .insert(schema.products)
    .values({ id: product, tenantId: tenant, name: "Synthetic apples" });
  await db.insert(schema.traceabilityLots).values({
    id: lot,
    tenantId: tenant,
    productId: product,
    tlc: "00001",
    assignmentBasis: "imported",
    createdBy: actor,
    updatedBy: actor,
  });
  await db.insert(schema.referenceDocuments).values({
    id: document,
    tenantId: tenant,
    type: "bol",
    number: "00001",
    partyId: party,
    createdBy: actor,
  });
  return { tenant, actor, member, party, location, product, lot, document };
}

export async function seedCompleteReceiving(
  db: Db,
  existing?: Awaited<ReturnType<typeof seedReceivingTenant>>,
) {
  const context = existing ?? (await seedReceivingTenant(db));
  await db
    .update(schema.traceabilityLocations)
    .set({
      phoneNumber: "+1 555 010 0100",
      streetAddress: "1 Test Street",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["receive_at"],
    })
    .where(eq(schema.traceabilityLocations.id, context.location));
  await db.insert(schema.productTraceabilityProfiles).values({
    tenantId: context.tenant,
    productId: context.product,
    productName: "Synthetic apples",
    coverageStatus: "not_covered",
    coverageRationale: "Synthetic QA review",
    reviewedBy: context.actor,
    reviewedAt: new Date(),
  });
  await db
    .update(schema.traceabilityLots)
    .set({ sourceLocationId: context.location })
    .where(eq(schema.traceabilityLots.id, context.lot));
  const draft: ReceivingDraft = {
    ...emptyReceivingDraft,
    dateReceived: "2026-09-07",
    locationId: context.location,
    previousSourceLocationId: context.location,
    documentIds: [context.document],
    items: [
      {
        ...emptyReceivingItem,
        productId: context.product,
        tlc: "000NEW",
        quantity: "500.000",
        unitOfMeasure: "lb",
        source: { kind: "location", locationId: context.location },
      },
      {
        ...emptyReceivingItem,
        productId: context.product,
        tlc: "00001",
        quantity: "0.250",
        unitOfMeasure: "kg",
        source: { kind: "location", locationId: context.location },
        lotLinkMode: "link_existing",
        lotId: context.lot,
      },
    ],
  };
  return { ...context, draft };
}

export async function seedExemptReceiving(
  db: Db,
  existing?: Awaited<ReturnType<typeof seedReceivingTenant>>,
) {
  const context = await seedCompleteReceiving(db, existing);
  const first = context.draft.items[0];
  if (!first) throw new Error("Missing synthetic receiving line");
  first.exemptSupplier = true;
  first.exemptReason = "Synthetic receipt-specific supplier declaration";
  first.tlc = null;
  first.exemptReceipt = {
    evidenceUrl: "https://supplier.example.test/declarations/2026-09",
    tlcHandling: "assign_if_missing",
    proposedTlc: "=Own/Ä-001",
  };
  return context;
}
