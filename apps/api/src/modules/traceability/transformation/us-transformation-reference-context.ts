import { schema } from "@markiro/db";
import {
  COVERAGE_STATUSES,
  validateProductDescription,
  type TransformationReadinessInput,
} from "@markiro/domain";
import type { TransformationDraft } from "@markiro/platform-contracts";
import { NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locationResponse,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { profileDefaults } from "../products/us-product-profile-support";
import { readReceivingBasis } from "../receiving/us-receiving-basis";
import { unavailable } from "./us-transformation-persistence";

const ids = (values: (string | null)[]) =>
  [...new Set(values.filter((id): id is string => id !== null))].sort();
function referencedIds(draft: TransformationDraft) {
  return {
    productIds: ids([
      ...draft.outputs.map((line) => line.productId),
      ...draft.inputs.map((line) => (line.kind === "non_ftl" ? line.productId : null)),
    ]),
    lotIds: ids(draft.inputs.map((line) => (line.kind === "ftl_lot" ? line.lotId : null))),
    locationIds: ids([
      draft.processorLocationId,
      ...draft.inputs.map((line) => (line.kind === "non_ftl" ? line.sourceLocationId : null)),
    ]),
  };
}

/** Structural drafts may remain incomplete. Every supplied reference must be tenant-owned. */
export async function assertTransformationReferences(
  tx: UsMasterDataTransaction,
  tenantId: string,
  draft: TransformationDraft,
) {
  const { productIds, lotIds, locationIds } = referencedIds(draft);
  const selections = [
    { table: schema.products, selected: productIds },
    { table: schema.traceabilityLots, selected: lotIds },
    { table: schema.traceabilityLocations, selected: locationIds },
    { table: schema.referenceDocuments, selected: ids(draft.documentIds) },
  ];
  for (const { table, selected } of selections) {
    if (!selected.length) continue;
    const rows = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), inArray(table.id, selected)))
      .orderBy(asc(table.id))
      .for("share");
    if (rows.length !== selected.length)
      throw new NotFoundException({ code: "transformation_reference_not_found" });
  }
}

/** All projections are tenant-scoped and ID ordered inside the caller's consistent transaction. */
export async function readTransformationReferenceContext(
  tx: UsMasterDataTransaction,
  tenantId: string,
  draft: TransformationDraft,
  profileCode: TransformationReadinessInput["profileCode"],
  lockReferences = false,
) {
  const referenced = referencedIds(draft);
  const lots = schema.traceabilityLots,
    products = schema.products,
    profiles = schema.productTraceabilityProfiles,
    locations = schema.traceabilityLocations,
    parties = schema.traceabilityParties,
    documents = schema.referenceDocuments;
  const lotQuery = tx
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, referenced.lotIds)))
    .orderBy(asc(lots.id));
  // Caller has already locked the event root/header; affected lots follow in UUID order.
  const lotRows = referenced.lotIds.length
    ? await (lockReferences ? lotQuery.for("update") : lotQuery)
    : [];
  const productIds = ids([...referenced.productIds, ...lotRows.map((lot) => lot.productId)]);
  if (lockReferences && productIds.length) {
    await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)))
      .orderBy(asc(products.id))
      .for("share");
    await tx
      .select()
      .from(profiles)
      .where(and(eq(profiles.tenantId, tenantId), inArray(profiles.productId, productIds)))
      .orderBy(asc(profiles.productId))
      .for("share");
  }
  const productRows = productIds.length
    ? await tx
        .select({ product: products, profile: profiles })
        .from(products)
        .leftJoin(
          profiles,
          and(eq(profiles.tenantId, products.tenantId), eq(profiles.productId, products.id)),
        )
        .where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds)))
        .orderBy(asc(products.id))
    : [];
  const locationIds = ids([
    ...referenced.locationIds,
    ...lotRows.map((lot) => lot.sourceLocationId ?? lot.sourceReferenceLocationId),
  ]);
  let locationRows = locationIds.length
    ? await tx
        .select()
        .from(locations)
        .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, locationIds)))
        .orderBy(asc(locations.id))
    : [];
  let documentRows = draft.documentIds.length
    ? await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, draft.documentIds)))
        .orderBy(asc(documents.id))
    : [];
  const partyIds = ids([
    ...locationRows.map((row) => row.partyId),
    ...documentRows.map((row) => row.partyId),
  ]);
  const partyQuery = tx
    .select()
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), inArray(parties.id, partyIds)))
    .orderBy(asc(parties.id));
  const partyRows = partyIds.length
    ? await (lockReferences ? partyQuery.for("share") : partyQuery)
    : [];
  if (lockReferences) {
    if (locationIds.length)
      locationRows = await tx
        .select()
        .from(locations)
        .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, locationIds)))
        .orderBy(asc(locations.id))
        .for("share");
    if (draft.documentIds.length)
      documentRows = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, draft.documentIds)))
        .orderBy(asc(documents.id))
        .for("share");
  }
  const partyById = new Map(partyRows.map((row) => [row.id, row]));
  const locationFacts = locationRows.map((row) => ({
    id: row.id,
    roles: row.roles,
    archived: row.archived || (partyById.get(row.partyId)?.archived ?? true),
    descriptionReady: locationResponse(row).descriptionStatus.exportReady,
  }));
  const locationById = new Map(locationFacts.map((row) => [row.id, row]));
  const origins = [];
  for (const lot of lotRows) {
    // This validates current Receiving root integrity, rather than trusting status='active'.
    const receiving = await readReceivingBasis(tx, tenantId, lot.id, { limit: 100, offset: 0 });
    const transformations = await tx.execute<{
      event_id: string;
      root_id: string;
      revision: number;
      snapshot: unknown;
    }>(sql`
      SELECT e.id AS event_id, e.root_event_id AS root_id, e.revision, e.finalization_snapshot AS snapshot
      FROM transformation_event_outputs o
      JOIN traceability_events e ON e.tenant_id=o.tenant_id AND e.id=o.event_id AND e.type='transformation'
      JOIN transformation_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id AND r.current_event_id=e.id
      WHERE o.tenant_id=${tenantId} AND o.lot_id=${lot.id} AND e.status='finalized' AND e.superseded_by_event_id IS NULL
      ORDER BY e.id
    `);
    origins.push({ lotId: lot.id, receiving, transformations: transformations.rows });
  }
  const originById = new Map(origins.map((origin) => [origin.lotId, origin]));
  const input: TransformationReadinessInput = {
    profileCode,
    draft,
    products: productRows.map(({ product, profile }) => {
      const current = profile ?? profileDefaults(product);
      const status = z.enum(COVERAGE_STATUSES).safeParse(current.coverageStatus);
      if (!status.success) throw unavailable();
      return {
        id: product.id,
        archived: product.archived,
        descriptionReady: validateProductDescription(current).length === 0,
        coverage: {
          coverageStatus: status.data,
          coverageRationale: current.coverageRationale,
          ftlCategory: current.ftlCategory,
          ftlSourceUrl: current.ftlSourceUrl,
          ftlSourceVersion: current.ftlSourceVersion,
          reviewedBy: current.reviewedBy,
          reviewedAt: profile?.reviewedAt?.toISOString() ?? null,
        },
      };
    }),
    locations: locationFacts,
    lots: lotRows.map((lot) => {
      const sourceId = lot.sourceLocationId ?? lot.sourceReferenceLocationId;
      const source = sourceId === null ? undefined : locationById.get(sourceId),
        origin = originById.get(lot.id);
      return {
        id: lot.id,
        productId: lot.productId,
        tlc: lot.tlc,
        sourceResolved: Boolean(source && !source.archived && source.descriptionReady),
        currentOrigin: Boolean(
          origin && (origin.receiving.supportCount > 0 || origin.transformations.length > 0),
        ),
      };
    }),
    documents: documentRows.map((row) => ({
      id: row.id,
      archived:
        row.archivedAt !== null ||
        (row.partyId !== null && (partyById.get(row.partyId)?.archived ?? true)),
      type: row.type,
      number: row.number,
    })),
  };
  return { input, productRows, locationRows, partyRows, lotRows, documentRows, origins };
}
