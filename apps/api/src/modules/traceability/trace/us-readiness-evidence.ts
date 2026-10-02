import { isDeepStrictEqual } from "node:util";
import { schema } from "@markiro/db";
import type {
  LocationDescriptionInput,
  ReadinessEventFact,
  ReadinessLineFact,
  ReadinessRuleInput,
  ReadinessSourceIdentity,
} from "@markiro/domain";
import {
  receivingFinalizationSnapshotV1Schema,
  receivingFinalizationSnapshotV2Schema,
  receivingFinalizationSnapshotV3Schema,
  shippingFinalizationSnapshotV1Schema,
  transformationFinalizationSnapshotV1Schema,
  provisionUsTraceabilityProfileSchema,
  traceabilityCivilDateSchema,
  type UsReadinessDraftRef,
  type UsReadinessScope,
} from "@markiro/platform-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ServiceUnavailableException } from "@nestjs/common";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "../receiving/us-receiving-persistence";
import { validateCurrentTraceEvent } from "./us-trace-evidence";
import { UsReadinessScopeTooLargeException } from "./us-readiness-errors";

export interface UsReadinessEvidence {
  facts: Omit<ReadinessRuleInput, "profileCode">;
  selectedEventCount: number;
  selectedLotCount: number;
  dependencyCount: number;
  draftWork: { total: number; items: UsReadinessDraftRef[]; hasMore: boolean };
}

type Event = typeof schema.traceabilityEvents.$inferSelect;
type Root = typeof schema.receivingEventRoots.$inferSelect;
type Children = Parameters<typeof validateCurrentTraceEvent>[2];
const MAX_RECORDS = 10_000;
const BATCH = 250;
const emptyHeader = {
  receivingLocation: null,
  previousSourceLocation: null,
  processorLocation: null,
  shipFromLocation: null,
  recipientLocation: null,
};
const businessText = z.string().max(4096).nullable();
const quantityFields = { quantity: businessText, unitOfMeasure: businessText };
const receivingShapes = [
  receivingFinalizationSnapshotV1Schema,
  receivingFinalizationSnapshotV2Schema,
  receivingFinalizationSnapshotV3Schema,
] as const;

// The readiness shape keeps version, structural keys and ordered child identity strict.
// Business values may be absent/invalid; only the pure rules decide their severity.
const locationShape = z
  .object({
    ...receivingFinalizationSnapshotV1Schema.shape.locationDescription.shape,
    businessName: z.string().max(4096),
    phoneNumber: businessText,
    address: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("street"), streetAddress: businessText }).strict(),
      z
        .object({ kind: z.literal("coordinates"), latitude: businessText, longitude: businessText })
        .strict(),
    ]),
    city: businessText,
    stateOrRegion: businessText,
    zipOrPostalCode: businessText,
    countryCode: businessText,
    countryDisplay: businessText,
  })
  .strict();
const receivingLine = receivingFinalizationSnapshotV1Schema.shape.items.element.shape;
const coverageShape = z
  .object({ ...receivingLine.coverage.shape })
  .strict()
  .nullable();
const productDescription = z
  .object({
    ...receivingLine.productDescription.shape,
    productName: z.string().max(4096),
    brandName: businessText,
    commodity: businessText,
    variety: businessText,
    packagingSize: z.object({ value: businessText, uom: businessText }).strict().nullable(),
    packagingStyle: businessText,
  })
  .strict();
const receivingBusiness = {
  ...quantityFields,
  tlc: businessText,
  productDescription: productDescription.nullable(),
  coverage: coverageShape,
  sourceDescription: locationShape.nullable(),
};
const receivingDocumentEntry = receivingFinalizationSnapshotV1Schema.shape.documents.element;
const receivingDocuments = z
  .array(
    z
      .object({
        ...receivingDocumentEntry.shape,
        document: z
          .object({
            ...receivingDocumentEntry.shape.document.shape,
            type: businessText,
            number: businessText,
          })
          .strict(),
      })
      .strict(),
  )
  .max(100);
const receivingReadiness = z.discriminatedUnion("snapshotVersion", [
  z
    .object({
      ...receivingFinalizationSnapshotV1Schema.shape,
      documents: receivingDocuments,
      dateReceived: businessText,
      locationDescription: locationShape.nullable(),
      previousSourceDescription: locationShape.nullable(),
      items: z
        .array(z.object({ ...receivingLine, ...receivingBusiness }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      ...receivingFinalizationSnapshotV2Schema.shape,
      documents: receivingDocuments,
      dateReceived: businessText,
      locationDescription: locationShape.nullable(),
      previousSourceDescription: locationShape.nullable(),
      items: z
        .array(
          z
            .object({
              ...receivingFinalizationSnapshotV2Schema.shape.items.element.shape,
              ...receivingBusiness,
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      ...receivingFinalizationSnapshotV3Schema.shape,
      documents: receivingDocuments,
      dateReceived: businessText,
      locationDescription: locationShape.nullable(),
      previousSourceDescription: locationShape.nullable(),
      items: z
        .array(
          z
            .object({
              ...receivingFinalizationSnapshotV3Schema.shape.items.element.shape,
              ...receivingBusiness,
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
]);
const tShape = transformationFinalizationSnapshotV1Schema.shape;
const compactLocation = z.object({ id: z.uuid(), description: businessText }).strict();
const compactSource = z.discriminatedUnion("kind", [
  compactLocation.extend({ kind: z.literal("location") }).strict(),
  compactLocation
    .extend({
      kind: z.literal("reference"),
      referenceKind: z.literal("web_url"),
      referenceValue: z.string().max(1024),
    })
    .strict(),
]);
const compactProduct = z
  .object({ id: z.uuid(), description: businessText, coverage: coverageShape })
  .strict();
const transformBusiness = {
  ...quantityFields,
  product: compactProduct,
  source: compactSource,
  tlc: businessText,
};
const transformationReadiness = z
  .object({
    ...tShape,
    eventDate: businessText,
    processor: compactLocation,
    inputs: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ ...tShape.inputs.element.options[0].shape, ...transformBusiness }).strict(),
          z
            .object({
              ...tShape.inputs.element.options[1].shape,
              ...quantityFields,
              product: compactProduct,
              source: compactSource,
              reference: businessText,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
    outputs: z
      .array(z.object({ ...tShape.outputs.element.shape, ...transformBusiness }).strict())
      .min(1)
      .max(100),
    documents: z
      .array(z.object({ id: z.uuid(), type: businessText, number: businessText }).strict())
      .max(100),
  })
  .strict();
const sShape = shippingFinalizationSnapshotV1Schema.shape;
const shippingSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("location"), location: locationShape }).strict(),
  z
    .object({
      kind: z.literal("reference"),
      referenceKind: z.literal("web_url"),
      referenceValue: z.string().max(1024),
      resolvedLocation: locationShape,
    })
    .strict(),
]);
const shippingReadiness = z
  .object({
    ...sShape,
    eventDate: businessText,
    shipFrom: locationShape,
    recipient: locationShape,
    items: z
      .array(
        z
          .object({
            ...sShape.items.element.shape,
            ...quantityFields,
            tlc: businessText,
            source: shippingSource.nullable(),
            product: z
              .object({
                id: z.uuid(),
                description: productDescription.nullable(),
                coverage: coverageShape,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    documents: z
      .array(
        z
          .object({ ...sShape.documents.element.shape, type: businessText, number: businessText })
          .strict(),
      )
      .max(100),
  })
  .strict();

function parse<T>(shape: z.ZodType<T>, value: unknown): T {
  const result = shape.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}
function location(value: z.infer<typeof locationShape> | null): LocationDescriptionInput | null {
  if (value === null) return null;
  return {
    businessName: value.businessName,
    phoneNumber: value.phoneNumber,
    addressKind: value.address.kind,
    streetAddress: value.address.kind === "street" ? value.address.streetAddress : null,
    latitude: value.address.kind === "coordinates" ? value.address.latitude : null,
    longitude: value.address.kind === "coordinates" ? value.address.longitude : null,
    city: value.city,
    stateOrRegion: value.stateOrRegion,
    zipOrPostalCode: value.zipOrPostalCode,
    countryCode: value.countryCode,
  };
}
function compactIdentity(source: z.infer<typeof compactSource>): ReadinessSourceIdentity {
  return source.kind === "location"
    ? { kind: "location", locationId: source.id }
    : {
        kind: "reference",
        referenceKind: source.referenceKind,
        referenceValue: source.referenceValue,
        resolvedLocationId: source.id,
      };
}
function product(value: z.infer<typeof productDescription> | null) {
  return value === null
    ? null
    : {
        productName: value.productName,
        brandName: value.brandName,
        commodity: value.commodity,
        variety: value.variety,
        packagingSizeValue: value.packagingSize?.value ?? null,
        packagingSizeUom: value.packagingSize?.uom ?? null,
        packagingStyle: value.packagingStyle,
        defaultQuantityUom: null,
      };
}
function lotSource(
  lot: typeof schema.traceabilityLots.$inferSelect,
): ReadinessSourceIdentity | null {
  if (lot.sourceLocationId !== null) return { kind: "location", locationId: lot.sourceLocationId };
  if (lot.sourceReferenceKind !== null && lot.sourceReferenceValue !== null)
    return {
      kind: "reference",
      referenceKind: lot.sourceReferenceKind,
      referenceValue: lot.sourceReferenceValue,
      resolvedLocationId: lot.sourceReferenceLocationId,
    };
  return null;
}
function fact(row: Event, root: Root, children: Children, current = true): ReadinessEventFact {
  if (
    root.tenantId !== row.tenantId ||
    root.id !== row.rootEventId ||
    (current && root.currentEventId !== row.id) ||
    root.eventNumber !== row.eventNumber ||
    row.revision >= root.nextRevision ||
    (current
      ? row.status !== "finalized" || row.supersededByEventId !== null
      : !["finalized", "amended", "void"].includes(row.status)) ||
    row.finalizedAt === null ||
    row.finalizedBy === null ||
    !traceabilityCivilDateSchema.safeParse(row.dateReceived).success ||
    !provisionUsTraceabilityProfileSchema.shape.timeZone.safeParse(row.timeZone).success
  )
    throw unavailable();
  const eventDate = parse(traceabilityCivilDateSchema, row.dateReceived);
  const base = {
    id: row.id,
    rootId: row.rootEventId,
    eventNumber: row.eventNumber,
    revision: row.revision,
    eventDate,
  };
  const child = (
    line: { lineNo: number; lotId?: string; quantity: string | null; unitOfMeasure: string | null },
    rows: Children["items"] | Children["inputs"] | Children["outputs"],
    index: number,
  ) => {
    const c = rows[index];
    if (
      !c ||
      line.lineNo !== index + 1 ||
      c.lineNo !== line.lineNo ||
      c.tenantId !== row.tenantId ||
      c.eventId !== row.id ||
      c.lotId !== (line.lotId ?? null) ||
      c.quantity !== line.quantity ||
      c.unitOfMeasure !== line.unitOfMeasure
    )
      throw unavailable();
    return c;
  };
  const identity = (side: ReadinessLineFact["side"], lineNo: number) =>
    `${row.id}:${side}:${lineNo}`;
  if (row.type === "receiving") {
    const s = parse(receivingReadiness, row.finalizationSnapshot);
    if (
      (s.dateReceived !== null && s.dateReceived !== eventDate) ||
      s.locationId !== row.locationId ||
      s.previousSourceLocationId !== row.previousSourceLocationId ||
      s.items.length !== children.items.length ||
      (s.locationDescription !== null && s.locationDescription.locationId !== s.locationId) ||
      (s.previousSourceDescription !== null &&
        s.previousSourceDescription.locationId !== s.previousSourceLocationId)
    )
      throw unavailable();
    if (
      current &&
      receivingShapes.some((shape) => shape.safeParse(row.finalizationSnapshot).success)
    )
      validateCurrentTraceEvent(row, root, children);
    if (
      new Set(s.documents.map((entry) => entry.document.documentId)).size !== s.documents.length ||
      s.documents.some(({ document, issuer }) =>
        document.partyId === null
          ? issuer !== null
          : issuer === null || issuer.id !== document.partyId,
      )
    )
      throw unavailable();
    // Rebuilding the pinned schemas from .shape intentionally relaxes business KDEs,
    // but drops their superRefine checks. Preserve the structural V2/V3 invariants
    // independently of strict parsing, including for historical evidence.
    if (s.snapshotVersion !== 1) {
      const expected = s.items.flatMap((line) =>
        line.receiptBasis.kind === "ordinary" ? [] : [line.lineNo],
      );
      const reviewed = s.confirmation.reviewedExemptLines;
      if (
        expected.length !== reviewed.length ||
        expected.some((line, index) => line !== reviewed[index])
      )
        throw unavailable();
    }
    const predecessorBindings = new Set<string>();
    const lines = s.items.map((line, index): ReadinessLineFact => {
      const c = child(line, children.items, index);
      if (
        !("lotLinkMode" in c) ||
        c.productId !== line.productId ||
        c.tlc !== line.tlc ||
        c.lotLinkMode !== line.lotLinkMode ||
        (line.source.kind === "location"
          ? c.sourceLocationId !== line.source.locationId
          : c.sourceReferenceKind !== line.source.referenceKind ||
            c.sourceReferenceValue !== line.source.referenceValue ||
            c.sourceReferenceLocationId !== line.source.resolvedLocationId)
      )
        throw unavailable();
      if (
        line.productDescription !== null &&
        line.productDescription.sourceProductId !== line.productId
      )
        throw unavailable();
      const sourceLocation =
        line.source.kind === "location" ? line.source.locationId : line.source.resolvedLocationId;
      if (line.sourceDescription !== null && line.sourceDescription.locationId !== sourceLocation)
        throw unavailable();
      const binding = "lotBinding" in line ? line.lotBinding : undefined;
      if (
        "receiptBasis" in line &&
        line.receiptBasis.kind === "exempt_assigned_tlc" &&
        (line.lotLinkMode !== "create_on_finalize" ||
          line.source.kind !== "location" ||
          (binding?.kind !== "retained" &&
            line.source.locationId.toLowerCase() !== s.locationId.toLowerCase()))
      )
        throw unavailable();
      // These V3 cross-field identities remain structural even when business KDE are missing.
      if (
        (binding?.kind === "created" && line.lotLinkMode !== "create_on_finalize") ||
        (binding?.kind === "linked" && line.lotLinkMode !== "link_existing") ||
        (binding?.kind === "retained") !== (c.previousLineNo !== null) ||
        (binding?.kind === "retained" &&
          (c.previousLineNo !== binding.previousLineNo ||
            row.previousRevisionId !== binding.previousEventId))
      )
        throw unavailable();
      if (binding?.kind === "retained") {
        const key = `${binding.previousEventId.toLowerCase()}:${binding.previousLineNo}`;
        if (predecessorBindings.has(key)) throw unavailable();
        predecessorBindings.add(key);
      }
      return {
        id: identity("items", line.lineNo),
        lineNo: line.lineNo,
        side: "items",
        kind: "lot",
        lotId: line.lotId,
        productId: line.productId,
        tlc: line.tlc,
        source: line.source,
        sourceDescription: location(line.sourceDescription),
        productDescription: product(line.productDescription),
        coverage: line.coverage,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        exemptionReview:
          "receiptBasis" in line && line.receiptBasis.kind !== "ordinary"
            ? "reviewed"
            : "not_applicable",
      };
    });
    return {
      ...base,
      type: "receiving",
      frozenEventDate: s.dateReceived,
      header: {
        ...emptyHeader,
        receivingLocation: location(s.locationDescription),
        previousSourceLocation: location(s.previousSourceDescription),
      },
      documents: s.documents.map(({ document }) => ({
        kind: document.type,
        value: document.number,
      })),
      lines,
    };
  }
  if (row.type === "transformation") {
    const s = parse(transformationReadiness, row.finalizationSnapshot);
    if (
      s.eventId !== row.id ||
      s.eventNumber !== row.eventNumber ||
      s.revision !== row.revision ||
      (s.eventDate !== null && s.eventDate !== eventDate) ||
      s.timeZone !== row.timeZone ||
      (s.previousRevisionId ?? null) !== row.previousRevisionId ||
      s.finalizedBy !== row.finalizedBy ||
      s.finalizedAt !== row.finalizedAt?.toISOString() ||
      s.processor.id !== row.locationId ||
      s.inputs.length !== children.inputs.length ||
      s.outputs.length !== children.outputs.length
    )
      throw unavailable();
    if (
      current &&
      transformationFinalizationSnapshotV1Schema.safeParse(row.finalizationSnapshot).success
    )
      validateCurrentTraceEvent(row, root, children);
    const inputs = s.inputs.map((line, index): ReadinessLineFact => {
      const c = child(line, children.inputs, index);
      if (
        !("kind" in c) ||
        c.kind !== line.kind ||
        (line.kind === "non_ftl" &&
          (c.productId !== line.product.id ||
            c.sourceLocationId !== line.source.id ||
            c.reference !== line.reference))
      )
        throw unavailable();
      const common = {
        id: identity("inputs", line.lineNo),
        lineNo: line.lineNo,
        side: "inputs" as const,
        productId: line.product.id,
        productDescription: line.product.description,
        coverage: line.product.coverage,
        source: compactIdentity(line.source),
        sourceDescription: line.source.description,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        exemptionReview: "not_applicable" as const,
      };
      return line.kind === "ftl_lot"
        ? { ...common, kind: "lot", lotId: line.lotId, tlc: line.tlc }
        : { ...common, kind: "non_ftl", lotId: null, reference: line.reference };
    });
    const outputs = s.outputs.map((line, index): ReadinessLineFact => {
      const c = child(line, children.outputs, index);
      if (
        !("productId" in c) ||
        c.productId !== line.product.id ||
        !("tlc" in c) ||
        c.tlc !== line.tlc
      )
        throw unavailable();
      return {
        id: identity("outputs", line.lineNo),
        lineNo: line.lineNo,
        side: "outputs",
        kind: "lot",
        lotId: line.lotId,
        tlc: line.tlc,
        productId: line.product.id,
        productDescription: line.product.description,
        coverage: line.product.coverage,
        source: compactIdentity(line.source),
        sourceDescription: line.source.description,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
        exemptionReview: "not_applicable",
      };
    });
    return {
      ...base,
      type: "transformation",
      frozenEventDate: s.eventDate,
      header: { ...emptyHeader, processorLocation: s.processor.description },
      documents: s.documents.map((d) => ({ kind: d.type, value: d.number })),
      lines: [...inputs, ...outputs],
    };
  }
  if (row.type !== "shipping") throw unavailable();
  const s = parse(shippingReadiness, row.finalizationSnapshot);
  if (
    s.eventId !== row.id ||
    s.eventNumber !== row.eventNumber ||
    s.revision !== row.revision ||
    (s.eventDate !== null && s.eventDate !== eventDate) ||
    s.timeZone !== row.timeZone ||
    (s.previousRevisionId ?? null) !== row.previousRevisionId ||
    s.finalizedBy !== row.finalizedBy ||
    s.finalizedAt !== row.finalizedAt?.toISOString() ||
    s.shipFrom.locationId !== row.locationId ||
    s.items.length !== children.items.length
  )
    throw unavailable();
  const detail = children.shippingDetail;
  const address =
    s.recipient.address.kind === "street"
      ? s.recipient.address.streetAddress
      : `${s.recipient.address.latitude}, ${s.recipient.address.longitude}`;
  const recipient = {
    id: s.recipient.locationId,
    description: [
      s.recipient.businessName,
      address,
      s.recipient.city,
      s.recipient.stateOrRegion,
      s.recipient.zipOrPostalCode,
      s.recipient.countryDisplay,
      s.recipient.phoneNumber,
    ].join(", "),
    location: s.recipient,
  };
  if (
    !detail ||
    detail.tenantId !== row.tenantId ||
    detail.eventId !== row.id ||
    detail.recipientLocationId !== s.recipient.locationId ||
    !isDeepStrictEqual(detail.recipientSnapshot, recipient)
  )
    throw unavailable();
  if (current && shippingFinalizationSnapshotV1Schema.safeParse(row.finalizationSnapshot).success)
    validateCurrentTraceEvent(row, root, children);
  const lines = s.items.map((line, index): ReadinessLineFact => {
    const c = child(line, children.items, index);
    if (
      !("tlcSnapshot" in c) ||
      c.tlcSnapshot !== line.tlc ||
      !isDeepStrictEqual(c.productSnapshot, line.product) ||
      !isDeepStrictEqual(c.sourceSnapshot, line.source) ||
      (line.product.description !== null &&
        line.product.description.sourceProductId !== line.product.id)
    )
      throw unavailable();
    const source = line.source;
    return {
      id: identity("items", line.lineNo),
      lineNo: line.lineNo,
      side: "items",
      kind: "lot",
      lotId: line.lotId,
      tlc: line.tlc,
      productId: line.product.id,
      productDescription: product(line.product.description),
      coverage: line.product.coverage,
      source:
        source === null
          ? null
          : source.kind === "location"
            ? { kind: "location", locationId: source.location.locationId }
            : {
                kind: "reference",
                referenceKind: source.referenceKind,
                referenceValue: source.referenceValue,
                resolvedLocationId: source.resolvedLocation.locationId,
              },
      sourceDescription: location(
        source === null
          ? null
          : source.kind === "location"
            ? source.location
            : source.resolvedLocation,
      ),
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
      exemptionReview: "not_applicable",
    };
  });
  return {
    ...base,
    type: "shipping",
    frozenEventDate: s.eventDate,
    header: {
      ...emptyHeader,
      shipFromLocation: location(s.shipFrom),
      recipientLocation: location(s.recipient),
    },
    documents: s.documents.map((d) => ({ kind: d.type, value: d.number })),
    lines,
  };
}

/** One bounded set of queries per batch; no graph traversal or per-event query loop. */
async function load(
  tx: UsMasterDataTransaction,
  tenantId: string,
  ids: string[],
  deadline: () => void,
  current = true,
): Promise<ReadinessEventFact[]> {
  const result: ReadinessEventFact[] = [];
  for (let offset = 0; offset < ids.length; offset += BATCH) {
    deadline();
    const batch = ids.slice(offset, offset + BATCH);
    const rows = await tx
      .select()
      .from(schema.traceabilityEvents)
      .where(
        and(
          eq(schema.traceabilityEvents.tenantId, tenantId),
          inArray(schema.traceabilityEvents.id, batch),
        ),
      );
    if (rows.length !== batch.length) throw unavailable();
    const rootIds = rows.map((r) => r.rootEventId);
    const roots = [
      ...(await tx
        .select()
        .from(schema.receivingEventRoots)
        .where(
          and(
            eq(schema.receivingEventRoots.tenantId, tenantId),
            inArray(schema.receivingEventRoots.id, rootIds),
          ),
        )),
      ...(await tx
        .select()
        .from(schema.transformationEventRoots)
        .where(
          and(
            eq(schema.transformationEventRoots.tenantId, tenantId),
            inArray(schema.transformationEventRoots.id, rootIds),
          ),
        )),
      ...(await tx
        .select()
        .from(schema.shippingEventRoots)
        .where(
          and(
            eq(schema.shippingEventRoots.tenantId, tenantId),
            inArray(schema.shippingEventRoots.id, rootIds),
          ),
        )),
    ];
    const receiving = await tx
      .select()
      .from(schema.receivingEventItems)
      .where(
        and(
          eq(schema.receivingEventItems.tenantId, tenantId),
          inArray(schema.receivingEventItems.eventId, batch),
        ),
      )
      .orderBy(schema.receivingEventItems.lineNo);
    const inputs = await tx
      .select()
      .from(schema.transformationEventInputs)
      .where(
        and(
          eq(schema.transformationEventInputs.tenantId, tenantId),
          inArray(schema.transformationEventInputs.eventId, batch),
        ),
      )
      .orderBy(schema.transformationEventInputs.lineNo);
    const outputs = await tx
      .select()
      .from(schema.transformationEventOutputs)
      .where(
        and(
          eq(schema.transformationEventOutputs.tenantId, tenantId),
          inArray(schema.transformationEventOutputs.eventId, batch),
        ),
      )
      .orderBy(schema.transformationEventOutputs.lineNo);
    const shipping = await tx
      .select()
      .from(schema.shippingEventItems)
      .where(
        and(
          eq(schema.shippingEventItems.tenantId, tenantId),
          inArray(schema.shippingEventItems.eventId, batch),
        ),
      )
      .orderBy(schema.shippingEventItems.lineNo);
    const details = await tx
      .select()
      .from(schema.shippingEventDetails)
      .where(
        and(
          eq(schema.shippingEventDetails.tenantId, tenantId),
          inArray(schema.shippingEventDetails.eventId, batch),
        ),
      );
    const byEvent = <T extends { eventId: string }>(values: T[]) => {
      const map = new Map<string, T[]>();
      for (const value of values) {
        const group = map.get(value.eventId) ?? [];
        group.push(value);
        map.set(value.eventId, group);
      }
      return map;
    };
    const rMap = byEvent(receiving),
      iMap = byEvent(inputs),
      oMap = byEvent(outputs),
      sMap = byEvent(shipping);
    const rootMap = new Map(roots.map((r) => [r.id, r]));
    const detailMap = new Map(details.map((d) => [d.eventId, d]));
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    for (const id of batch) {
      const row = rowMap.get(id);
      const root = row && rootMap.get(row.rootEventId);
      if (!row || !root) throw unavailable();
      result.push(
        fact(
          row,
          root,
          {
            items: row.type === "receiving" ? (rMap.get(id) ?? []) : (sMap.get(id) ?? []),
            inputs: iMap.get(id) ?? [],
            outputs: oMap.get(id) ?? [],
            shippingDetail: detailMap.get(id) ?? null,
          },
          current,
        ),
      );
      deadline();
    }
  }
  return result;
}

function relations(tenant: string) {
  return sql`WITH roots AS (
    SELECT tenant_id,id,current_event_id,pending_draft_id,event_number,next_revision,'receiving' AS type FROM receiving_event_roots WHERE tenant_id=${tenant}
    UNION ALL SELECT tenant_id,id,current_event_id,pending_draft_id,event_number,next_revision,'transformation' FROM transformation_event_roots WHERE tenant_id=${tenant}
    UNION ALL SELECT tenant_id,id,current_event_id,pending_draft_id,event_number,next_revision,'shipping' FROM shipping_event_roots WHERE tenant_id=${tenant}
  ), lines AS (
    SELECT tenant_id,event_id,line_no,lot_id,product_id,'receiving' AS type,true AS origin FROM receiving_event_items WHERE tenant_id=${tenant}
    UNION ALL SELECT tenant_id,event_id,line_no,lot_id,product_id,'transformation',false FROM transformation_event_inputs WHERE tenant_id=${tenant}
    UNION ALL SELECT tenant_id,event_id,line_no,lot_id,product_id,'transformation',true FROM transformation_event_outputs WHERE tenant_id=${tenant}
    UNION ALL SELECT tenant_id,event_id,line_no,lot_id,NULL::uuid,'shipping',false FROM shipping_event_items WHERE tenant_id=${tenant}
  )`;
}
function eventFilter(scope: UsReadinessScope) {
  return sql`
    ${scope.lotId === null ? sql`true` : sql`EXISTS (SELECT 1 FROM lines l WHERE l.tenant_id=e.tenant_id AND l.event_id=e.id AND l.lot_id=${scope.lotId})`}
    AND ${
      scope.productId === null
        ? sql`true`
        : sql`(EXISTS (
      SELECT 1 FROM lines l LEFT JOIN traceability_lots lot ON lot.tenant_id=l.tenant_id AND lot.id=l.lot_id
      WHERE l.tenant_id=e.tenant_id AND l.event_id=e.id AND (l.product_id=${scope.productId} OR lot.product_id=${scope.productId})
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(e.finalization_snapshot->'items','[]'::jsonb) || COALESCE(e.finalization_snapshot->'inputs','[]'::jsonb) || COALESCE(e.finalization_snapshot->'outputs','[]'::jsonb)) frozen
      WHERE frozen->>'productId'=${scope.productId} OR frozen->'product'->>'id'=${scope.productId}
    ))`
    }`;
}

/** Shared with controlled EXPLAIN checks so the measured query is the executed selector. */
export function readinessEventSelectionQuery(tenantId: string, scope: UsReadinessScope) {
  // Uncorrelated tuple membership lets PostgreSQL hash each tenant's current
  // root pointers once. Correlated EXISTS under OR can repeatedly scan a whole
  // tenant when bulk inserts have outpaced the planner's statistics.
  return sql`${relations(tenantId)}
    SELECT e.id FROM traceability_events e
    WHERE e.tenant_id=${tenantId} AND e.status='finalized' AND e.superseded_by_event_id IS NULL
      AND (
        (e.type='receiving' AND (e.root_event_id,e.id) IN (SELECT r.id,r.current_event_id FROM receiving_event_roots r WHERE r.tenant_id=${tenantId}))
        OR (e.type='transformation' AND (e.root_event_id,e.id) IN (SELECT r.id,r.current_event_id FROM transformation_event_roots r WHERE r.tenant_id=${tenantId}))
        OR (e.type='shipping' AND (e.root_event_id,e.id) IN (SELECT r.id,r.current_event_id FROM shipping_event_roots r WHERE r.tenant_id=${tenantId}))
      )
      AND e.event_date BETWEEN ${scope.eventDateFrom}::date AND ${scope.eventDateTo}::date AND (${eventFilter(scope)})
    ORDER BY e.event_date,e.id LIMIT ${MAX_RECORDS + 1}`;
}

/** Called in the authorization owner's repeatable-read transaction. No writes or mutable labels. */
export async function readUsReadinessEvidence(
  tx: UsMasterDataTransaction,
  tenantId: string,
  scope: UsReadinessScope,
): Promise<UsReadinessEvidence> {
  const end = performance.now() + 5_000;
  const deadline = () => {
    if (performance.now() >= end) throw unavailable();
  };
  try {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const date = sql`e.event_date BETWEEN ${scope.eventDateFrom}::date AND ${scope.eventDateTo}::date`;
    const filter = eventFilter(scope);
    const selected = await tx.execute<{ id: string }>(
      readinessEventSelectionQuery(tenantId, scope),
    );
    if (selected.rows.length > MAX_RECORDS) throw new UsReadinessScopeTooLargeException();
    const invalid = await tx.execute<{ invalid: boolean }>(sql`${relations(tenantId)}
      SELECT EXISTS (SELECT 1 FROM traceability_events e
        LEFT JOIN roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id AND r.type=e.type
        WHERE e.tenant_id=${tenantId} AND (${date}) AND (${filter}) AND (
          r.id IS NULL OR e.event_number<>r.event_number OR e.revision>=r.next_revision
          OR (e.status='finalized' AND (r.current_event_id IS DISTINCT FROM e.id OR e.superseded_by_event_id IS NOT NULL))
          OR (e.status='draft' AND r.pending_draft_id IS DISTINCT FROM e.id)
          OR (r.current_event_id=e.id AND e.status<>'finalized')
        )) AS invalid`);
    if (invalid.rows[0]?.invalid !== false) throw unavailable();
    const ids = selected.rows.map((r) => r.id);
    const selectedLots = await tx.execute<{
      id: string;
    }>(sql`${relations(tenantId)}, candidates AS (
      SELECT l.lot_id AS id FROM lines l WHERE l.tenant_id=${tenantId} AND l.event_id=ANY(${sql.param(ids)}::uuid[]) AND l.lot_id IS NOT NULL
      UNION SELECT l.lot_id FROM lines l
        JOIN traceability_events e ON e.tenant_id=l.tenant_id AND e.id=l.event_id AND e.type=l.type
        JOIN traceability_lots lot ON lot.tenant_id=l.tenant_id AND lot.id=l.lot_id
        WHERE l.tenant_id=${tenantId} AND l.origin AND e.finalization_snapshot IS NOT NULL AND (${date})
          AND (${scope.lotId}::uuid IS NULL OR lot.id=${scope.lotId}::uuid)
          AND (${scope.productId}::uuid IS NULL OR lot.product_id=${scope.productId}::uuid)
      UNION SELECT lot.id FROM traceability_lots lot WHERE lot.tenant_id=${tenantId} AND lot.id=${scope.lotId}::uuid
        AND (${scope.productId}::uuid IS NULL OR lot.product_id=${scope.productId}::uuid)
        AND NOT EXISTS (SELECT 1 FROM lines l JOIN traceability_events e ON e.tenant_id=l.tenant_id AND e.id=l.event_id AND e.type=l.type
          WHERE l.tenant_id=lot.tenant_id AND l.lot_id=lot.id AND l.origin AND e.finalization_snapshot IS NOT NULL)
    ) SELECT id FROM candidates ORDER BY id LIMIT ${MAX_RECORDS + 1}`);
    if (selectedLots.rows.length > MAX_RECORDS) throw new UsReadinessScopeTooLargeException();
    const lotIds = selectedLots.rows.map((r) => r.id);
    // Also check older/excluded relationships: corruption must not masquerade as an origin gap.
    const integrity = await tx.execute<{ invalid: boolean }>(sql`${relations(tenantId)}
      SELECT EXISTS (
        SELECT 1 FROM lines l
        LEFT JOIN traceability_events e ON e.tenant_id=l.tenant_id AND e.id=l.event_id
        LEFT JOIN roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id AND r.type=l.type
        WHERE l.tenant_id=${tenantId} AND l.lot_id=ANY(${sql.param(lotIds)}::uuid[]) AND (
          e.id IS NULL OR e.type<>l.type OR r.id IS NULL
          OR e.event_number<>r.event_number OR e.revision>=r.next_revision
          OR (e.revision=1 AND (e.id<>r.id OR e.previous_revision_id IS NOT NULL))
          OR (e.revision>1 AND NOT EXISTS (SELECT 1 FROM traceability_events p
            WHERE p.tenant_id=e.tenant_id AND p.id=e.previous_revision_id AND p.root_event_id=r.id
              AND p.type=e.type AND p.revision<e.revision AND p.finalization_snapshot IS NOT NULL))
          OR (e.status='finalized' AND (r.current_event_id IS DISTINCT FROM e.id OR e.superseded_by_event_id IS NOT NULL))
          OR (e.status='draft' AND r.pending_draft_id IS DISTINCT FROM e.id)
          OR (r.current_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM traceability_events c
            WHERE c.tenant_id=r.tenant_id AND c.root_event_id=r.id AND c.id=r.current_event_id
              AND c.type=r.type AND c.status='finalized' AND c.superseded_by_event_id IS NULL))
          OR (e.status='amended' AND NOT EXISTS (SELECT 1 FROM traceability_events s
            WHERE s.tenant_id=e.tenant_id AND s.root_event_id=r.id AND s.id=e.superseded_by_event_id
              AND s.previous_revision_id=e.id AND s.revision>e.revision AND s.type=r.type AND s.finalization_snapshot IS NOT NULL))
          OR (e.finalization_snapshot IS NOT NULL AND (
            jsonb_typeof(e.finalization_snapshot)<>'object'
            OR (e.type='receiving' AND COALESCE(e.finalization_snapshot->>'snapshotVersion','') NOT IN ('1','2','3'))
            OR (e.type<>'receiving' AND COALESCE(e.finalization_snapshot->>'snapshotVersion','')<>'1')))
        )
      ) AS invalid`);
    if (integrity.rows[0]?.invalid !== false) throw unavailable();
    const origins = await tx.execute<{
      lotId: string;
      id: string;
      type: ReadinessEventFact["type"];
      eventNumber: string;
      current: boolean;
      lifecycleAt: Date;
      revision: number;
    }>(sql`${relations(tenantId)}
      SELECT DISTINCT l.lot_id AS "lotId",e.id,e.type,e.event_number AS "eventNumber",(r.current_event_id=e.id AND e.status='finalized' AND e.superseded_by_event_id IS NULL) IS TRUE AS current,
        COALESCE(e.voided_at,e.finalized_at) AS "lifecycleAt", e.revision
      FROM lines l LEFT JOIN traceability_events e ON e.tenant_id=l.tenant_id AND e.id=l.event_id AND e.type=l.type
      LEFT JOIN roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id AND r.type=e.type
      WHERE l.tenant_id=${tenantId} AND l.origin AND l.lot_id=ANY(${sql.param(lotIds)}::uuid[]) AND e.finalization_snapshot IS NOT NULL
      ORDER BY "lifecycleAt",e.revision,e.id`);
    const originsByLot = new Map<string, typeof origins.rows>();
    for (const origin of origins.rows) {
      const group = originsByLot.get(origin.lotId) ?? [];
      group.push(origin);
      originsByLot.set(origin.lotId, group);
    }
    const events = await load(tx, tenantId, ids, deadline);
    const currentOriginIds = [...new Set(origins.rows.filter((o) => o.current).map((o) => o.id))];
    const eventMap = new Map(events.map((e) => [e.id, e]));
    const dependencies = await load(
      tx,
      tenantId,
      currentOriginIds.filter((id) => !eventMap.has(id)),
      deadline,
    );
    for (const event of dependencies) eventMap.set(event.id, event);
    // Historical origins remain excluded evidence, but their saved structure/children must be sound.
    await load(
      tx,
      tenantId,
      [...new Set(origins.rows.filter((origin) => !origin.current).map((origin) => origin.id))],
      deadline,
      false,
    );
    const lots: UsReadinessEvidence["facts"]["lots"][number][] = [];
    for (let offset = 0; offset < lotIds.length; offset += BATCH) {
      deadline();
      const batch = lotIds.slice(offset, offset + BATCH);
      const rows = await tx
        .select()
        .from(schema.traceabilityLots)
        .where(
          and(
            eq(schema.traceabilityLots.tenantId, tenantId),
            inArray(schema.traceabilityLots.id, batch),
          ),
        );
      if (rows.length !== batch.length) throw unavailable();
      for (const lot of rows) {
        const records = originsByLot.get(lot.id) ?? [];
        const related = records.at(-1);
        lots.push({
          id: lot.id,
          productId: lot.productId,
          tlc: lot.tlc,
          source: lotSource(lot),
          currentOrigin: records.some((o) => o.current),
          relatedEventId: related?.id ?? null,
          relatedEvent: related
            ? { type: related.type, eventNumber: related.eventNumber, revision: related.revision }
            : null,
        });
      }
    }
    lots.sort((a, b) => a.id.localeCompare(b.id));
    const dependencyFacts: UsReadinessEvidence["facts"]["dependencies"][number][] = [];
    for (const event of events)
      for (const line of event.lines) {
        if (
          line.kind !== "lot" ||
          (event.type !== "shipping" &&
            !(event.type === "transformation" && line.side === "inputs"))
        )
          continue;
        const records = (originsByLot.get(line.lotId) ?? []).filter((o) => o.current);
        if (!records.length) {
          const related = originsByLot.get(line.lotId)?.at(-1);
          dependencyFacts.push({
            consumingEventId: event.id,
            consumingLineId: line.id,
            lotId: line.lotId,
            currentOrigin: false,
            source: null,
            tlc: null,
            productId: null,
            relatedEventId: related?.id ?? null,
            relatedEvent: related
              ? { type: related.type, eventNumber: related.eventNumber, revision: related.revision }
              : null,
          });
        }
        for (const origin of records) {
          const source = eventMap
            .get(origin.id)
            ?.lines.find((l) => l.kind === "lot" && l.lotId === line.lotId && l.side !== "inputs");
          if (!source || source.kind !== "lot") throw unavailable();
          dependencyFacts.push({
            consumingEventId: event.id,
            consumingLineId: line.id,
            lotId: line.lotId,
            currentOrigin: true,
            source: source.source,
            tlc: source.tlc,
            productId: source.productId,
            relatedEventId: origin.id,
            relatedEvent: {
              type: origin.type,
              eventNumber: origin.eventNumber,
              revision: origin.revision,
            },
          });
        }
      }
    const drafts = await tx.execute<{
      eventId: string;
      rootId: string;
      cte: UsReadinessDraftRef["cte"];
      eventNumber: string;
      revision: number;
      draftVersion: number;
      eventDate: string | null;
      total: string;
    }>(sql`${relations(tenantId)}
      SELECT e.id AS "eventId",e.root_event_id AS "rootId",e.type AS cte,e.event_number AS "eventNumber",e.revision,e.draft_version AS "draftVersion",e.event_date::text AS "eventDate",count(*) OVER()::text AS total
      FROM traceability_events e JOIN roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id AND r.pending_draft_id=e.id AND r.type=e.type
      WHERE e.tenant_id=${tenantId} AND e.status='draft' AND (${date} OR (e.event_date IS NULL AND ${scope.lotId !== null || scope.productId !== null})) AND (${filter})
      ORDER BY e.event_date NULLS LAST,e.id LIMIT 100`);
    const items = drafts.rows.map(({ total: _total, draftVersion, ...draft }) => ({
      ...draft,
      eventHref: `/traceability/${draft.cte}/${draft.eventId}`,
      readinessHref: `/traceability/${draft.cte}/${draft.eventId}/readiness?expectedDraftVersion=${draftVersion}`,
    }));
    const total = Number(drafts.rows[0]?.total ?? "0");
    if (!Number.isSafeInteger(total)) throw unavailable();
    deadline();
    return {
      facts: { events, lots, dependencies: dependencyFacts },
      selectedEventCount: events.length,
      selectedLotCount: lots.length,
      dependencyCount: dependencyFacts.length,
      draftWork: { total, items, hasMore: total > items.length },
    };
  } catch (error) {
    if (error instanceof UsReadinessScopeTooLargeException) throw error;
    if (error instanceof ServiceUnavailableException) {
      const response = error.getResponse();
      if (
        typeof response === "object" &&
        response !== null &&
        "code" in response &&
        response.code === "us_database_unavailable"
      )
        throw error;
    }
    throw unavailable();
  }
}
