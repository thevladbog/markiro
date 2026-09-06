import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DomainError } from "@markiro/domain";
import { schema } from "@markiro/db";
import {
  traceabilityLotSchema,
  type TraceabilityLot,
  type TraceabilityLotSource,
} from "@markiro/platform-contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

export type LotRow = typeof schema.traceabilityLots.$inferSelect;
export function lotResponse(row: LotRow): TraceabilityLot {
  let source: unknown = null;
  if (row.sourceLocationId !== null) {
    if (
      row.sourceReferenceKind !== null ||
      row.sourceReferenceValue !== null ||
      row.sourceReferenceLocationId !== null
    )
      throw new ServiceUnavailableException({ code: "us_database_unavailable" });
    source = { kind: "location", locationId: row.sourceLocationId };
  } else if (
    row.sourceReferenceKind !== null ||
    row.sourceReferenceValue !== null ||
    row.sourceReferenceLocationId !== null
  ) {
    source = {
      kind: "reference",
      referenceKind: row.sourceReferenceKind,
      referenceValue: row.sourceReferenceValue,
      resolvedLocationId: row.sourceReferenceLocationId,
    };
  }
  const parsed = traceabilityLotSchema.safeParse({
    id: row.id,
    productId: row.productId,
    tlc: row.tlc,
    source,
    sourceLockedAt: row.sourceLockedAt?.toISOString() ?? null,
    assignmentBasis: row.assignmentBasis,
    status: row.status,
    revision: row.revision,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
  return parsed.data;
}

export function lotSourceColumns(source: TraceabilityLotSource) {
  return {
    sourceLocationId: source?.kind === "location" ? source.locationId : null,
    sourceReferenceKind: source?.kind === "reference" ? source.referenceKind : null,
    sourceReferenceValue: source?.kind === "reference" ? source.referenceValue : null,
    sourceReferenceLocationId: source?.kind === "reference" ? source.resolvedLocationId : null,
  };
}

export function sourceIdentityPredicate(source: TraceabilityLotSource) {
  const table = schema.traceabilityLots;
  if (source?.kind === "location") return eq(table.sourceLocationId, source.locationId);
  if (source?.kind === "reference")
    return and(
      isNull(table.sourceLocationId),
      eq(table.sourceReferenceKind, source.referenceKind),
      eq(table.sourceReferenceValue, source.referenceValue),
    );
  return and(isNull(table.sourceLocationId), isNull(table.sourceReferenceKind));
}

export function applyLotRule(rule: () => void): void {
  try {
    rule();
  } catch (error) {
    if (error instanceof DomainError) throw new UnprocessableEntityException({ code: error.code });
    throw error;
  }
}

/** Shared locks keep master records from being archived between validation and insert. */
export async function assertLotReferences(
  tx: UsMasterDataTransaction,
  tenantId: string,
  productId: string,
  source: TraceabilityLotSource,
): Promise<void> {
  const [product] = await tx
    .select({ archived: schema.products.archived })
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
    .limit(1)
    .for("share");
  if (!product) throw new NotFoundException({ code: "lot_product_not_found" });
  if (product.archived) throw new ConflictException({ code: "lot_reference_archived" });
  if (source === null) return;
  const locationId = source.kind === "location" ? source.locationId : source.resolvedLocationId;
  const locations = schema.traceabilityLocations,
    parties = schema.traceabilityParties;
  const [location] = await tx
    .select({ archived: locations.archived, partyArchived: parties.archived })
    .from(locations)
    .innerJoin(
      parties,
      and(eq(parties.tenantId, locations.tenantId), eq(parties.id, locations.partyId)),
    )
    .where(and(eq(locations.tenantId, tenantId), eq(locations.id, locationId)))
    .limit(1)
    .for("share");
  if (!location) throw new NotFoundException({ code: "lot_source_not_found" });
  if (location.archived || location.partyArchived)
    throw new ConflictException({ code: "lot_reference_archived" });
}
