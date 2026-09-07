import { schema } from "@markiro/db";
import type { ReceivingRetainedBinding } from "@markiro/domain";
import type { ReceivingAmendmentDraft } from "@markiro/platform-contracts";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

const ids = (values: (string | null)[]) =>
  [...new Set(values.filter((id): id is string => id !== null))].sort();
const absent = () => new NotFoundException({ code: "receiving_reference_not_found" });
const inactive = () => new ConflictException({ code: "receiving_reference_inactive" });

/** Existence/activity only. Caller has validated immutable predecessor bindings.
 * Root/events precede sorted lots, then product/profile, party, location, document locks.
 * Required KDEs, new create/link consistency and fresh QA review belong to readiness/finalize.
 */
export async function assertReceivingAmendmentReferences(
  tx: UsMasterDataTransaction,
  tenantId: string,
  draft: ReceivingAmendmentDraft,
  retainedBindings: readonly ReceivingRetainedBinding[],
) {
  const lots = schema.traceabilityLots,
    products = schema.products,
    profiles = schema.productTraceabilityProfiles,
    parties = schema.traceabilityParties,
    locations = schema.traceabilityLocations,
    documents = schema.referenceDocuments;
  const lotIds = ids(draft.items.map((i) => i.lotId));
  const lotRows = lotIds.length
    ? await tx
        .select()
        .from(lots)
        .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, lotIds)))
        .orderBy(asc(lots.id))
        .for("share")
    : [];
  if (lotRows.length !== lotIds.length) throw absent();
  const retained = new Map(retainedBindings.map((b) => [b.lineNo, b.lotId]));
  const lotById = new Map(lotRows.map((l) => [l.id, l]));
  draft.items.forEach((line, index) => {
    if (
      line.lotId !== null &&
      retained.get(index + 1) !== line.lotId &&
      lotById.get(line.lotId)?.status !== "active"
    )
      throw inactive();
  });
  const productIds = ids(draft.items.map((i) => i.productId));
  if (productIds.length) {
    const rows = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)))
      .orderBy(asc(products.id))
      .for("share");
    if (rows.length !== productIds.length) throw absent();
    if (rows.some((r) => r.archived)) throw inactive();
    await tx
      .select()
      .from(profiles)
      .where(and(eq(profiles.tenantId, tenantId), inArray(profiles.productId, productIds)))
      .orderBy(asc(profiles.productId))
      .for("share");
  }
  const locationIds = ids([
    draft.locationId,
    draft.previousSourceLocationId,
    ...draft.items.map((i) =>
      i.source?.kind === "location" ? i.source.locationId : (i.source?.resolvedLocationId ?? null),
    ),
  ]);
  const locationRows = locationIds.length
    ? await tx
        .select()
        .from(locations)
        .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, locationIds)))
        .orderBy(asc(locations.id))
    : [];
  const documentIds = [...draft.documentIds].sort();
  const documentRows = documentIds.length
    ? await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, documentIds)))
        .orderBy(asc(documents.id))
    : [];
  if (locationRows.length !== locationIds.length || documentRows.length !== documentIds.length)
    throw absent();
  const partyIds = ids([
    ...locationRows.map((l) => l.partyId),
    ...documentRows.map((d) => d.partyId),
  ]);
  if (partyIds.length) {
    const rows = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), inArray(parties.id, partyIds)))
      .orderBy(asc(parties.id))
      .for("share");
    if (rows.length !== partyIds.length) throw absent();
    if (rows.some((r) => r.archived)) throw inactive();
  }
  if (locationIds.length) {
    const rows = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, locationIds)))
      .orderBy(asc(locations.id))
      .for("share");
    if (rows.some((r) => r.archived)) throw inactive();
  }
  if (documentIds.length) {
    const rows = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, documentIds)))
      .orderBy(asc(documents.id))
      .for("share");
    if (rows.some((r) => r.archivedAt !== null)) throw inactive();
  }
}
