import { randomUUID } from "node:crypto";
import { buildLocationDescriptionSnapshot, buildProductSnapshot } from "@markiro/domain";
import {
  transformationFinalizationSnapshotV1Schema,
  type TransformationDraftRecord,
} from "@markiro/platform-contracts";
import { locationResponse } from "../master-data/us-master-data-support";
import { profileDefaults } from "../products/us-product-profile-support";
import { unavailable } from "./us-transformation-persistence";
import type { readTransformationFinalizationContext } from "./us-transformation-readiness";

/** Consume the locked readiness projection. No second read can alter pinned evidence. */
export function planTransformationSnapshot(
  saved: TransformationDraftRecord,
  facts: Awaited<ReturnType<typeof readTransformationFinalizationContext>>,
  actorUserId: string,
  finalizedAt: string,
  boundOutputLotIds?: readonly string[],
) {
  function product(id: string | null) {
    const row = facts.productRows.find((entry) => entry.product.id === id);
    const resolved = facts.input.products.find((entry) => entry.id === id);
    if (!row || !resolved) throw unavailable();
    const built = buildProductSnapshot(row.product, row.profile ?? profileDefaults(row.product));
    if (!built.ok) throw unavailable();
    const value = built.snapshot;
    return {
      id: row.product.id,
      coverage: resolved.coverage,
      description: [
        value.productName,
        value.brandName,
        value.commodity,
        value.variety,
        value.packagingSize ? `${value.packagingSize.value} ${value.packagingSize.uom}` : null,
        value.packagingStyle,
        value.gtin,
      ]
        .filter((part) => part !== null)
        .join(", "),
    };
  }
  function location(id: string | null) {
    const row = facts.locationRows.find((entry) => entry.id === id);
    if (!row) throw unavailable();
    const built = buildLocationDescriptionSnapshot(locationResponse(row));
    if (!built.ok) throw unavailable();
    const value = built.snapshot;
    return {
      id: row.id,
      description: [
        value.businessName,
        value.address.kind === "street"
          ? value.address.streetAddress
          : `${value.address.latitude}, ${value.address.longitude}`,
        value.city,
        value.stateOrRegion,
        value.zipOrPostalCode,
        value.countryCode,
        value.phoneNumber,
      ].join(", "),
    };
  }
  const processor = location(saved.draft.processorLocationId);
  const parsed = transformationFinalizationSnapshotV1Schema.safeParse({
    snapshotVersion: 1,
    eventId: saved.id,
    eventNumber: saved.eventNumber,
    revision: saved.revision,
    ...(saved.revision > 1 ? { previousRevisionId: saved.lifecycle?.previousRevisionId } : {}),
    eventDate: saved.draft.eventDate,
    timeZone: saved.timeZone,
    processor,
    reason: saved.draft.reason,
    reasonNote: saved.draft.reasonNote,
    notes: saved.draft.notes,
    inputs: saved.draft.inputs.map((line, i) => {
      const common = {
        kind: line.kind,
        lineNo: i + 1,
        quantity: line.quantity,
        unitOfMeasure: line.unitOfMeasure,
      };
      if (line.kind === "non_ftl")
        return {
          ...common,
          product: product(line.productId),
          source: { kind: "location", ...location(line.sourceLocationId) },
          reference: line.reference,
        };
      const lot = facts.lotRows.find((row) => row.id === line.lotId);
      if (!lot) throw unavailable();
      return {
        ...common,
        lotId: lot.id,
        product: product(lot.productId),
        tlc: lot.tlc,
        source:
          lot.sourceLocationId !== null
            ? { kind: "location", ...location(lot.sourceLocationId) }
            : {
                kind: "reference",
                referenceKind: lot.sourceReferenceKind,
                referenceValue: lot.sourceReferenceValue,
                ...location(lot.sourceReferenceLocationId),
              },
      };
    }),
    outputs: saved.draft.outputs.map((line, i) => ({
      lineNo: i + 1,
      lotId: saved.revision === 1 ? randomUUID() : boundOutputLotIds?.[i],
      product: product(line.productId),
      tlc: line.tlc,
      source: { kind: "location", ...processor },
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
    })),
    documents: saved.draft.documentIds.map((id) => {
      const row = facts.documentRows.find((entry) => entry.id === id);
      if (!row) throw unavailable();
      return {
        id: row.id,
        type: row.type === "other" ? row.typeOtherLabel : row.type,
        number: row.number,
      };
    }),
    finalizedBy: actorUserId,
    finalizedAt,
  });
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
