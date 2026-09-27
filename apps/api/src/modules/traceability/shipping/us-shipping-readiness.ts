import { createHash } from "node:crypto";
import { schema } from "@markiro/db";
import {
  COVERAGE_STATUSES,
  validateProductDescription,
  validateShippingReadiness,
  type ShippingReadinessInput,
} from "@markiro/domain";
import {
  SHIPPING_READINESS_RULE_VERSION,
  shippingReadinessSchema,
  type ShippingDraftRecord,
} from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  locationResponse,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { profileDefaults } from "../products/us-product-profile-support";
import { readCurrentShippingBalance } from "./us-shipping-balance";

const ids = (values: readonly (string | null)[]) =>
  [...new Set(values.filter((value): value is string => value !== null))].sort();

/** Re-resolve saved IDs and current balances; the client provides only the saved version. */
export async function readShippingFinalizationContext(
  tx: UsMasterDataTransaction,
  tenantId: string,
  saved: ShippingDraftRecord,
  profileCode: ShippingReadinessInput["profileCode"],
) {
  const draft = saved.draft;
  const lotIds = ids(draft.items.map((line) => line.lotId));
  const lots = schema.traceabilityLots;
  // Future finalization takes the same lot order before checking balances.
  const lotRows = lotIds.length
    ? await tx
        .select()
        .from(lots)
        .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, lotIds)))
        .orderBy(asc(lots.id))
        .for("update")
    : [];
  const productIds = ids(lotRows.map((lot) => lot.productId));
  const products = schema.products,
    profiles = schema.productTraceabilityProfiles;
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
        .for("share", { of: products })
    : [];
  if (productIds.length) {
    await tx
      .select({ productId: profiles.productId })
      .from(profiles)
      .where(and(eq(profiles.tenantId, tenantId), inArray(profiles.productId, productIds)))
      .orderBy(asc(profiles.productId))
      .for("share");
  }
  const locationIds = ids([
    draft.shipFromLocationId,
    draft.recipientLocationId,
    ...lotRows.map((lot) => lot.sourceLocationId ?? lot.sourceReferenceLocationId),
  ]);
  const locations = schema.traceabilityLocations;
  const locationRows = locationIds.length
    ? await tx
        .select()
        .from(locations)
        .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, locationIds)))
        .orderBy(asc(locations.id))
        .for("share")
    : [];
  const documents = schema.referenceDocuments;
  const documentRows = draft.documentIds.length
    ? await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, draft.documentIds)))
        .orderBy(asc(documents.id))
        .for("share")
    : [];
  const partyIds = ids([
    ...locationRows.map((row) => row.partyId),
    ...documentRows.map((row) => row.partyId),
  ]);
  const parties = schema.traceabilityParties;
  const partyRows = partyIds.length
    ? await tx
        .select()
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), inArray(parties.id, partyIds)))
        .orderBy(asc(parties.id))
        .for("share")
    : [];
  const partyById = new Map(partyRows.map((row) => [row.id, row]));
  const locationFacts = locationRows.map((row) => ({
    id: row.id,
    roles: row.roles,
    archived: row.archived || (partyById.get(row.partyId)?.archived ?? true),
    descriptionReady: locationResponse(row).descriptionStatus.exportReady,
  }));
  const locationById = new Map(locationFacts.map((row) => [row.id, row]));
  const predecessorId = saved.lifecycle?.previousRevisionId ?? null;
  if (saved.revision > 1 && (!predecessorId || saved.lifecycle?.currentEventId !== predecessorId))
    throw new ServiceUnavailableException({ code: "us_database_unavailable" });
  const owned =
    predecessorId && lotIds.length
      ? await tx
          .select({ lotId: schema.shippingLotStatusEffects.lotId })
          .from(schema.shippingLotStatusEffects)
          .where(
            and(
              eq(schema.shippingLotStatusEffects.tenantId, tenantId),
              eq(schema.shippingLotStatusEffects.eventId, predecessorId),
              inArray(schema.shippingLotStatusEffects.lotId, lotIds),
              isNull(schema.shippingLotStatusEffects.compensatedAt),
            ),
          )
      : [];
  const ownedLots = new Set(owned.map((row) => row.lotId));
  const balances = await Promise.all(
    lotRows.map((lot) =>
      readCurrentShippingBalance(tx, tenantId, lot.id, predecessorId ?? undefined),
    ),
  );
  const input: ShippingReadinessInput = {
    profileCode,
    draft: { ...draft, timeZone: saved.timeZone },
    locations: locationFacts,
    documents: documentRows.map((row) => ({
      id: row.id,
      archived:
        row.archivedAt !== null ||
        (row.partyId !== null && (partyById.get(row.partyId)?.archived ?? true)),
      type: row.type,
      number: row.number,
    })),
    products: productRows.map(({ product, profile }) => {
      const current = profile ?? profileDefaults(product);
      const coverage = z.enum(COVERAGE_STATUSES).safeParse(current.coverageStatus);
      if (!coverage.success)
        throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      return {
        id: product.id,
        archived: product.archived,
        descriptionReady: validateProductDescription(current).length === 0,
        coverage: {
          coverageStatus: coverage.data,
          coverageRationale: current.coverageRationale,
          ftlCategory: current.ftlCategory,
          ftlSourceUrl: current.ftlSourceUrl,
          ftlSourceVersion: current.ftlSourceVersion,
          reviewedBy: current.reviewedBy,
          reviewedAt: profile?.reviewedAt?.toISOString() ?? null,
        },
      };
    }),
    lots: lotRows.map((lot, index) => {
      const sourceId = lot.sourceLocationId ?? lot.sourceReferenceLocationId;
      const source = sourceId === null ? undefined : locationById.get(sourceId);
      const balance = balances[index];
      if (!balance) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
      return {
        id: lot.id,
        productId: lot.productId,
        tlc: lot.tlc,
        sourceResolved: Boolean(source && !source.archived && source.descriptionReady),
        status: lot.status,
        balance,
        predecessorShippingStatusOwned: ownedLots.has(lot.id),
      };
    }),
  };
  const issues = validateShippingReadiness(input).map((issue) => ({
    severity: "error" as const,
    path: issue.path,
    code: issue.code,
    line: issue.line ?? null,
  }));
  const inputDigest = createHash("sha256")
    .update(
      JSON.stringify({
        ruleVersion: SHIPPING_READINESS_RULE_VERSION,
        eventId: saved.id,
        draftVersion: saved.draftVersion,
        input,
      }),
    )
    .digest("hex");
  const readiness = shippingReadinessSchema.parse({
    eventId: saved.id,
    expectedDraftVersion: saved.draftVersion,
    ruleVersion: SHIPPING_READINESS_RULE_VERSION,
    inputDigest,
    state: issues.length ? "incomplete" : "complete",
    profileCode,
    issues,
  });
  return { readiness, input, lotRows, productRows, locationRows, documentRows, partyRows };
}

export async function readShippingReadiness(
  tx: UsMasterDataTransaction,
  tenantId: string,
  saved: ShippingDraftRecord,
  profileCode: ShippingReadinessInput["profileCode"],
) {
  return (await readShippingFinalizationContext(tx, tenantId, saved, profileCode)).readiness;
}
