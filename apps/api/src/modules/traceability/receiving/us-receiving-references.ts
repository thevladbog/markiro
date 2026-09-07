import { ConflictException, NotFoundException } from "@nestjs/common";
import { schema } from "@markiro/db";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

const ids = (values: (string | null)[]) =>
  [...new Set(values.filter((id): id is string => id !== null))].sort();
const absent = () => new NotFoundException({ code: "receiving_reference_not_found" });
const inactive = () => new ConflictException({ code: "receiving_reference_inactive" });

/** Existence/activity only. Required KDEs and cross-field consistency belong to finalization. */
export async function assertReceivingReferences(
  tx: UsMasterDataTransaction,
  tenantId: string,
  draft: ReceivingDraft,
) {
  const products = schema.products,
    lots = schema.traceabilityLots,
    locations = schema.traceabilityLocations,
    parties = schema.traceabilityParties,
    documents = schema.referenceDocuments;
  const productIds = ids(draft.items.map((row) => row.productId));
  if (productIds.length) {
    const rows = await tx
      .select({ archived: products.archived })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)))
      .orderBy(asc(products.id))
      .for("share");
    if (rows.length !== productIds.length) throw absent();
    if (rows.some((row) => row.archived)) throw inactive();
  }
  const lotIds = ids(draft.items.map((row) => row.lotId));
  if (lotIds.length) {
    const rows = await tx
      .select({ status: lots.status })
      .from(lots)
      .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, lotIds)))
      .orderBy(asc(lots.id))
      .for("share");
    if (rows.length !== lotIds.length) throw absent();
    if (rows.some((row) => row.status !== "active")) throw inactive();
  }
  const locationIds = ids([
    draft.locationId,
    draft.previousSourceLocationId,
    ...draft.items.map((row) =>
      row.source?.kind === "location"
        ? row.source.locationId
        : (row.source?.resolvedLocationId ?? null),
    ),
  ]);
  if (locationIds.length) {
    const rows = await tx
      .select({ archived: locations.archived, partyArchived: parties.archived })
      .from(locations)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, locations.tenantId), eq(parties.id, locations.partyId)),
      )
      .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, locationIds)))
      .orderBy(asc(locations.id))
      .for("share");
    if (rows.length !== locationIds.length) throw absent();
    if (rows.some((row) => row.archived || row.partyArchived)) throw inactive();
  }
  if (draft.documentIds.length) {
    const rows = await tx
      .select({ archivedAt: documents.archivedAt })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, draft.documentIds)))
      .orderBy(asc(documents.id))
      .for("share");
    if (rows.length !== draft.documentIds.length) throw absent();
    if (rows.some((row) => row.archivedAt !== null)) throw inactive();
  }
}
