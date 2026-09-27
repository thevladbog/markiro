import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { TransformationDraft } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../../src/modules/traceability/transformation/us-transformation-store";
import type { createUsProfileTestDatabase } from "./us-profile-database";
import { seedCompleteReceiving } from "./us-receiving-fixture";

export type TransformationFixtureDatabase = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
export async function seedFinalizableTransformation(
  f: TransformationFixtureDatabase,
  referenceInput = false,
) {
  const c = await seedCompleteReceiving(f.db);
  const processor = randomUUID(),
    processorParty = randomUUID();
  await f.db
    .insert(schema.traceabilityParties)
    .values({ id: processorParty, tenantId: c.tenant, name: "Synthetic processor" });
  await f.db.insert(schema.traceabilityLocations).values({
    id: processor,
    tenantId: c.tenant,
    partyId: processorParty,
    name: "Processing facility",
    businessName: "Synthetic processor",
    roles: ["processor"],
    phoneNumber: "+1 555 020 0200",
    streetAddress: "2 Processing Street",
    city: "Madison",
    stateOrRegion: "WI",
    zipOrPostalCode: "53703",
    countryCode: "US",
  });
  await f.db
    .update(schema.productTraceabilityProfiles)
    .set({
      coverageStatus: "covered",
      ftlCategory: "Fresh-cut fruits",
      ftlSourceUrl:
        "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
      ftlSourceVersion: "Synthetic 2026",
      reviewedAt: new Date("2026-09-25T13:14:15.123Z"),
    })
    .where(eq(schema.productTraceabilityProfiles.productId, c.product));
  const receiving = new UsReceivingStore(f.db);
  const r = await receiving.createDraft(
    c.tenant,
    c.actor,
    {
      operationKey: randomUUID(),
      draft: {
        ...c.draft,
        items: c.draft.items.map((line, index) => ({
          ...line,
          quantity: "500",
          unitOfMeasure: "lb",
          ...(referenceInput && index === 0
            ? {
                source: {
                  kind: "reference",
                  referenceKind: "web_url",
                  referenceValue: "https://supplier.example.test/source/Ä?lot=001",
                  resolvedLocationId: c.location,
                },
              }
            : {}),
        })),
      },
    },
    "receiving",
  );
  const ready = await receiving.checkReadiness(c.tenant, c.actor, r.id, {
    expectedDraftVersion: 1,
  });
  const origin = await receiving.finalize(
    c.tenant,
    c.actor,
    r.id,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: ready.inputDigest,
    },
    "receiving-finalize",
  );
  const draft: TransformationDraft = {
    eventDate: "2026-09-26",
    processorLocationId: processor,
    reason: "commingling_and_repacking",
    reasonNote: "Synthetic two-lot run",
    notes: "Office fixture",
    inputs: origin.snapshot.items.map((line) => ({
      kind: "ftl_lot",
      lotId: line.lotId,
      quantity: "500",
      unitOfMeasure: "lb",
    })),
    outputs: [{ productId: c.product, tlc: "NEW-OUTPUT", quantity: "100", unitOfMeasure: "case" }],
    documentIds: [c.document],
  };
  const store = new UsTransformationStore(f.db);
  const saved = await store.createDraft(
    c.tenant,
    c.actor,
    { operationKey: randomUUID(), draft },
    "transformation",
  );
  const readiness = await store.checkReadiness(c.tenant, c.actor, saved.id, {
    expectedDraftVersion: 1,
  });
  const command = {
    operationKey: randomUUID(),
    expectedDraftVersion: 1,
    expectedInputDigest: readiness.inputDigest,
  };
  return { ...c, processor, store, saved, origin, command, receiving };
}

export async function transformationEffects(
  f: TransformationFixtureDatabase,
  tenant: string,
  eventId: string,
) {
  const { rows } = await f.pool.query(
    `SELECT
    (SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1 AND assignment_basis='transformation') AS lots,
    (SELECT count(*)::int FROM lot_genealogy_edges WHERE tenant_id=$1 AND event_id=$2) AS edges,
    (SELECT count(*)::int FROM transformation_event_outputs WHERE tenant_id=$1 AND event_id=$2 AND lot_id IS NOT NULL) AS bindings,
    (SELECT count(*)::int FROM transformation_operations WHERE tenant_id=$1 AND event_id=$2 AND command='transformation.finalize') AS receipts,
    (SELECT count(*)::int FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.transformation.finalized' AND target_id=$2::text) AS audits`,
    [tenant, eventId],
  );
  return rows[0];
}
