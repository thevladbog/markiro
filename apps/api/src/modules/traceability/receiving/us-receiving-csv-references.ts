import { schema } from "@markiro/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import type { PreparedReceivingCsvFile } from "./us-receiving-csv-input";
import { csvPreviewUnavailable, type ReceivingCsvResolution } from "./us-receiving-csv-preview";

const ids = (values: (string | null)[]) =>
  [...new Set(values.filter((id): id is string => id !== null))].sort();
const referenceIssue = (states: Map<string, boolean>, id: string | null) =>
  id === null ? null : !states.has(id) ? "not_found" : states.get(id) ? null : "inactive";

/** Existence/activity only, in the same lock order as assertReceivingReferences. */
export async function resolveReceivingCsvReferences(
  tx: UsMasterDataTransaction,
  tenantId: string,
  prepared: PreparedReceivingCsvFile,
): Promise<ReceivingCsvResolution> {
  const rows = prepared.content.ok ? prepared.content.rows : [];
  const valid = rows.flatMap((row) => (row.validation.ok ? [row.validation] : []));
  const productIds = ids(
    valid.flatMap((row) => (row.productSelector.kind === "id" ? [row.productSelector.value] : [])),
  );
  const gtins = ids(
    valid.flatMap((row) =>
      row.productSelector.kind === "gtin" ? [row.productSelector.value] : [],
    ),
  );
  const p = schema.products,
    l = schema.traceabilityLots,
    loc = schema.traceabilityLocations,
    party = schema.traceabilityParties,
    doc = schema.referenceDocuments;
  const products =
    productIds.length || gtins.length
      ? await tx
          .select({ id: p.id, gtin: p.gtin14, archived: p.archived })
          .from(p)
          .where(
            and(
              eq(p.tenantId, tenantId),
              or(
                productIds.length ? inArray(p.id, productIds) : undefined,
                gtins.length ? inArray(p.gtin14, gtins) : undefined,
              ),
            ),
          )
          .orderBy(asc(p.id))
          .for("share")
      : [];
  const lotIds = ids(valid.map((row) => row.item.lotId));
  const lots = lotIds.length
    ? await tx
        .select({ id: l.id, status: l.status })
        .from(l)
        .where(and(eq(l.tenantId, tenantId), inArray(l.id, lotIds)))
        .orderBy(asc(l.id))
        .for("share")
    : [];
  const header = prepared.input.header;
  const locationIds = ids([
    header.locationId,
    header.previousSourceLocationId,
    ...valid.map((row) =>
      row.item.source?.kind === "location"
        ? row.item.source.locationId
        : (row.item.source?.resolvedLocationId ?? null),
    ),
  ]);
  const locations = locationIds.length
    ? await tx
        .select({ id: loc.id, archived: loc.archived, partyArchived: party.archived })
        .from(loc)
        .innerJoin(party, and(eq(party.tenantId, loc.tenantId), eq(party.id, loc.partyId)))
        .where(and(eq(loc.tenantId, tenantId), inArray(loc.id, locationIds)))
        .orderBy(asc(loc.id))
        .for("share")
    : [];
  const documents = header.documentIds.length
    ? await tx
        .select({ id: doc.id, archivedAt: doc.archivedAt })
        .from(doc)
        .where(and(eq(doc.tenantId, tenantId), inArray(doc.id, header.documentIds)))
        .orderBy(asc(doc.id))
        .for("share")
    : [];
  const lotStates = new Map(lots.map((row) => [row.id, row.status === "active"]));
  const locationStates = new Map(
    locations.map((row) => [row.id, !row.archived && !row.partyArchived]),
  );
  const documentStates = new Map(documents.map((row) => [row.id, row.archivedAt === null]));
  const resolution: ReceivingCsvResolution = { rows: [], headerIssues: [] };
  for (const field of ["locationId", "previousSourceLocationId"] as const) {
    const code = referenceIssue(locationStates, header[field]);
    if (code) resolution.headerIssues.push({ field, documentIndex: null, code });
  }
  for (const [documentIndex, id] of header.documentIds.entries()) {
    const code = referenceIssue(documentStates, id);
    if (code) resolution.headerIssues.push({ field: "documentIds", documentIndex, code });
  }
  for (const row of rows) {
    const result: ReceivingCsvResolution["rows"][number] = {
      rowNumber: row.rowNumber,
      productId: null,
      issues: [],
    };
    resolution.rows.push(result);
    if (!row.validation.ok) continue;
    const { productSelector: selector, item } = row.validation;
    const matches = products.filter((product) =>
      selector.kind === "id" ? product.id === selector.value : product.gtin === selector.value,
    );
    const active = matches.filter((product) => !product.archived);
    if (active.length > 1) throw csvPreviewUnavailable();
    const product = active[0];
    if (product) result.productId = product.id;
    else
      result.issues.push({
        column: selector.kind === "id" ? "product_id" : "product_gtin",
        code: matches.length ? "inactive" : "not_found",
      });
    const lotIssue = referenceIssue(lotStates, item.lotId);
    if (lotIssue) result.issues.push({ column: "lot_id", code: lotIssue });
    if (item.source) {
      const physical = item.source.kind === "location";
      const code = referenceIssue(
        locationStates,
        item.source.kind === "location" ? item.source.locationId : item.source.resolvedLocationId,
      );
      if (code)
        result.issues.push({
          column: physical ? "source_location_id" : "source_resolved_location_id",
          code,
        });
    }
  }
  return resolution;
}
