import { createHash } from "node:crypto";
import {
  assessReceivingReadiness,
  assessReceivingExemptionLine,
  RECEIVING_READINESS_RULE_VERSION,
  type ReceivingReadinessInput,
  type ReceivingRetainedBinding,
} from "@markiro/domain";
import { schema } from "@markiro/db";
import {
  receivingReadinessSchema,
  usLocationSchema,
  usPartySchema,
  type ReceivingDraftRecord,
  type ReceivingDraft,
  type TraceabilityLotSource,
} from "@markiro/platform-contracts";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { referenceDocumentResponse } from "../documents/us-reference-document-support";
import { lotResponse, sourceIdentityPredicate } from "../lots/us-lot-support";
import {
  locationResponse,
  partyResponse,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { profileDefaults, storedProfileResponse } from "../products/us-product-profile-support";
import { unavailable } from "./us-receiving-persistence";

const ruleVersion = RECEIVING_READINESS_RULE_VERSION;
// Pin readiness v3 to its original inputs. The internal support token is for
// lifecycle readiness v4; it must not silently change the existing digest.
function readinessV3Lot({
  receivingBasisVersion: _version,
  ...original
}: typeof schema.traceabilityLots.$inferSelect) {
  return original;
}
const ids = (values: (string | null)[]) =>
  [...new Set(values.filter((value): value is string => value !== null))].sort();
const locationId = (source: TraceabilityLotSource) =>
  source?.kind === "location" ? source.locationId : (source?.resolvedLocationId ?? null);
function identity(tlc: string | null, source: TraceabilityLotSource) {
  return JSON.stringify([
    tlc,
    ...(source?.kind === "location"
      ? ["location", source.locationId]
      : source?.kind === "reference"
        ? ["reference", source.referenceKind, source.referenceValue]
        : ["missing"]),
  ]);
}

/** Caller owns one repeatable-read transaction, including current membership/profile checks. */
export async function readReceivingReferenceFacts(
  tx: UsMasterDataTransaction,
  tenantId: string,
  draft: ReceivingDraft,
  profileCode: ReceivingReadinessInput["profileCode"],
  lockReferences = false,
  revision?: {
    retainedBindings: readonly ReceivingRetainedBinding[];
    additionalLotIds: readonly string[];
  },
) {
  const products = schema.products,
    profiles = schema.productTraceabilityProfiles,
    lots = schema.traceabilityLots,
    locations = schema.traceabilityLocations,
    parties = schema.traceabilityParties,
    documents = schema.referenceDocuments;
  const productIds = ids(draft.items.map((line) => line.productId));
  const lotIds = ids([
    ...draft.items.map((line) => line.lotId),
    ...(revision?.additionalLotIds ?? []),
  ]);
  const lotQuery = tx
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), inArray(lots.id, lotIds)))
    .orderBy(asc(lots.id));
  const lotRows = lotIds.length ? await (lockReferences ? lotQuery.for("update") : lotQuery) : [];
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
  const linkedLots = lotRows.map(lotResponse);
  const locationIds = ids([
    draft.locationId,
    draft.previousSourceLocationId,
    ...draft.items.map((line) => locationId(line.source)),
    ...linkedLots.map((lot) => locationId(lot.source)),
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
  for (const row of partyRows)
    if (!usPartySchema.safeParse(partyResponse(row)).success) throw unavailable();
  const partyById = new Map(partyRows.map((row) => [row.id, row]));

  // Each source/TLC identity has a unique tenant index, so <=100 draft lines yield <=100 rows.
  const retained = new Map(
    revision?.retainedBindings.map((binding) => [binding.lineNo, binding.lotId]),
  );
  const assessedLines = draft.items.map((line, index) => {
    const retainedLotId = retained.get(index + 1);
    return {
      line,
      retained: retainedLotId !== undefined,
      effectiveTlc: assessReceivingExemptionLine(
        line,
        draft.locationId,
        retainedLotId === undefined ? undefined : { retainedLotId },
      ).effectiveTlc,
    };
  });
  const createLines = assessedLines.filter(
    ({ line, effectiveTlc, retained: bound }) =>
      !bound && line.lotLinkMode === "create_on_finalize" && effectiveTlc !== null,
  );
  const conflicts = createLines.length
    ? await tx
        .select()
        .from(lots)
        .where(
          and(
            eq(lots.tenantId, tenantId),
            or(
              ...createLines.map(({ line, effectiveTlc }) =>
                and(eq(lots.tlc, effectiveTlc ?? ""), sourceIdentityPredicate(line.source)),
              ),
            ),
          ),
        )
        .orderBy(asc(lots.id))
        .limit(101)
    : [];
  if (conflicts.length > 100) throw unavailable();
  const conflictIdentities = new Set(
    conflicts.map((row) => {
      const lot = lotResponse(row);
      return identity(lot.tlc, lot.source);
    }),
  );
  const [profile] = await tx
    .select()
    .from(schema.traceabilityProfiles)
    .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
  const [organizationProfile] = await tx
    .select({ timeZone: schema.orgProfiles.timeZone })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  if (!profile || !organizationProfile) throw unavailable();
  const input: ReceivingReadinessInput = {
    profileCode,
    draft,
    products: productRows.map(({ product, profile: productProfile }) => {
      const current = productProfile
        ? storedProfileResponse(productProfile, profileCode)
        : profileDefaults(product);
      return {
        id: product.id,
        archived: product.archived,
        gtin14: product.gtin14,
        description: current,
        coverage: current,
      };
    }),
    locations: locationRows.map((row) => {
      const current = usLocationSchema.safeParse(locationResponse(row));
      if (!current.success) throw unavailable();
      return {
        id: row.id,
        archived: row.archived,
        partyArchived: partyById.get(row.partyId)?.archived ?? true,
        roles: current.data.roles,
        description: current.data,
      };
    }),
    lots: linkedLots,
    documents: documentRows.map((row) => {
      const current = referenceDocumentResponse(row);
      const issuerInactive = row.partyId !== null && (partyById.get(row.partyId)?.archived ?? true);
      return {
        id: row.id,
        archived: row.archivedAt !== null || issuerInactive,
        type: current.type,
        number: current.number,
      };
    }),
    conflictingCreateLines: assessedLines.flatMap(
      ({ line, effectiveTlc, retained: bound }, index) =>
        !bound &&
        line.lotLinkMode === "create_on_finalize" &&
        conflictIdentities.has(identity(effectiveTlc, line.source))
          ? [index + 1]
          : [],
    ),
  };
  return {
    input,
    profile,
    organizationProfile,
    productRows,
    locationRows,
    partyRows,
    lotRows,
    documentRows,
    conflicts,
  };
}

/** Legacy v3 projection, including its original digest field order and omitted lot token. */
export async function readReceivingReferenceContext(
  tx: UsMasterDataTransaction,
  tenantId: string,
  saved: ReceivingDraftRecord,
  profileCode: ReceivingReadinessInput["profileCode"],
  lockReferences = false,
) {
  const {
    input,
    profile,
    organizationProfile,
    productRows,
    locationRows,
    partyRows,
    lotRows,
    documentRows,
    conflicts,
  } = await readReceivingReferenceFacts(tx, tenantId, saved.draft, profileCode, lockReferences);
  const inputDigest = createHash("sha256")
    .update(
      JSON.stringify({
        ruleVersion,
        saved,
        profile,
        organizationProfile,
        productRows,
        locationRows,
        partyRows,
        lotRows: lotRows.map(readinessV3Lot),
        documentRows,
        conflicts: conflicts.map(readinessV3Lot),
        input,
      }),
    )
    .digest("hex");
  const result = receivingReadinessSchema.safeParse({
    eventId: saved.id,
    draftVersion: saved.draftVersion,
    checkedAt: new Date().toISOString(),
    inputDigest,
    ruleVersion,
    profileCode,
    ...assessReceivingReadiness(input),
  });
  if (!result.success) throw unavailable();
  return {
    readiness: result.data,
    input,
    profile,
    productRows,
    locationRows,
    partyRows,
    lotRows,
    documentRows,
  };
}
