import { canonicalExportDigest } from "@markiro/domain";
import {
  platformUuidSchema,
  referenceDocumentSchema,
  traceabilityLotSchema,
  createTransformationDraftSchema,
  finalizeTransformationSchema,
  transformationDraftRecordSchema,
  transformationFinalizedRecordSchema,
  type ReferenceDocument,
  type TraceabilityLot,
  type CreateTransformationDraftInput,
  type FinalizeTransformationInput,
  type TransformationDraftRecord,
  type TransformationFinalizedRecord,
} from "@markiro/platform-contracts";
import { z } from "zod";
import type { UsSixMonthChain } from "./us-six-month-chains.js";
export const US_DATASET_TRANSFORMATION_METADATA = Object.freeze({
  reason: "commingling_and_repacking" as const,
  reasonNote: null,
  notes: "Synthetic six-month demo transformation.",
});

export type UsDatasetTransformationEvidence = Readonly<{
  input: Readonly<{ chain: UsSixMonthChain }>;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  createInput: CreateTransformationDraftInput;
  finalizeInput: FinalizeTransformationInput;
  created: TransformationDraftRecord;
  finalized: TransformationFinalizedRecord;
  outputLot: TraceabilityLot;
  inputLots: readonly Readonly<{ lineNo: number; lotId: string }>[];
}>;
export const usDatasetTransformationEvidenceFields = {
  documents: z
    .array(z.object({ key: z.string(), record: referenceDocumentSchema }).strict())
    .length(2),
  createInput: createTransformationDraftSchema,
  finalizeInput: finalizeTransformationSchema,
  created: transformationDraftRecordSchema,
  finalized: transformationFinalizedRecordSchema,
  outputLot: traceabilityLotSchema,
  inputLots: z
    .array(z.object({ lineNo: z.number().int(), lotId: platformUuidSchema }).strict())
    .length(2),
};
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_transformation_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportDigest(a) === canonicalExportDigest(b);
}
/** Stored response coherence; actual tenant/catalogue/operation ownership requires the verifier. */
export function checkUsDatasetTransformationEvidence(
  result: UsDatasetTransformationEvidence,
): void {
  const { created: first, finalized: last, outputLot: lot, createInput, finalizeInput } = result;
  const chain = result.input.chain.transformation;
  const draft = first.draft,
    snapshot = last.snapshot;
  valid(equal(createInput.draft, draft));
  valid(createInput.operationKey === finalizeInput.operationKey);
  valid(finalizeInput.expectedDraftVersion === first.draftVersion);
  // Native readiness hashes resolved facts unavailable in this bounded receipt. The verifier
  // checks this retained command against its original operation, never today's mutable facts.
  valid(
    first.id === last.id &&
      first.revision === 1 &&
      last.revision === 1 &&
      first.draftVersion === 1 &&
      last.draftVersion === 1,
  );
  valid(
    first.eventNumber === last.eventNumber &&
      first.timeZone === "America/Los_Angeles" &&
      last.timeZone === first.timeZone,
  );
  valid(first.createdBy === last.createdBy && first.createdAt === last.createdAt);
  valid(first.updatedBy === first.createdBy && first.updatedAt === first.createdAt);
  valid(
    last.finalizedBy === first.createdBy &&
      last.updatedBy === last.finalizedBy &&
      last.updatedAt === last.finalizedAt,
  );
  for (const [record, version, current, pending] of [
    [first, 1, null, first.id],
    [last, 2, last.id, null],
  ] as const) {
    const lifecycle = record.lifecycle;
    valid(lifecycle !== undefined);
    valid(
      lifecycle.rootId === first.id &&
        lifecycle.lifecycleVersion === version &&
        lifecycle.currentEventId === current &&
        lifecycle.pendingDraftId === pending,
    );
    valid(
      lifecycle.previousRevisionId === null &&
        lifecycle.amendmentReason === null &&
        lifecycle.supersededByEventId === null &&
        lifecycle.supersededAt === null &&
        lifecycle.supersededBy === null &&
        lifecycle.voidedAt === null &&
        lifecycle.voidedBy === null &&
        lifecycle.voidReason === null,
    );
  }
  valid(draft.eventDate === chain.eventDate && snapshot.eventDate === draft.eventDate);
  valid(draft.processorLocationId !== null && snapshot.processor.id === draft.processorLocationId);
  for (const key of ["reason", "reasonNote", "notes"] as const)
    valid(draft[key] === US_DATASET_TRANSFORMATION_METADATA[key] && snapshot[key] === draft[key]);
  valid(
    draft.inputs.length === 2 &&
      snapshot.inputs.length === 2 &&
      draft.outputs.length === 1 &&
      snapshot.outputs.length === 1 &&
      draft.documentIds.length === 2 &&
      snapshot.documents.length === 2,
  );
  const ids = [
    ...result.documents.map((d) => d.record.id),
    first.id,
    lot.id,
    ...result.inputLots.map((m) => m.lotId),
  ];
  valid(new Set(ids.map((id) => id.toLowerCase())).size === ids.length);
  let issuer: string | undefined;
  result.documents.forEach(({ key, record }, index) => {
    const definitions = result.input.chain.documents.filter(
      (d) => d.input.number === chain.references[index],
    );
    const definition = definitions[0],
      frozen = snapshot.documents[index];
    valid(definitions.length === 1 && definition !== undefined && frozen !== undefined);
    valid(
      key === definition.key &&
        record.archivedAt === null &&
        record.partyId !== null &&
        record.createdBy === first.createdBy,
    );
    const { id, partyId, archivedAt, createdBy, createdAt, updatedAt, ...fields } = record;
    void archivedAt;
    void createdBy;
    void createdAt;
    void updatedAt;
    valid(equal(fields, definition.input));
    valid(
      draft.documentIds[index] === id &&
        equal(frozen, {
          id,
          type: record.type === "other" ? record.typeOtherLabel : record.type,
          number: record.number,
        }),
    );
    valid(issuer === undefined || issuer === partyId);
    issuer = partyId;
  });
  const products = new Map<string, string>();
  const sources = new Map<string, unknown>();
  result.inputLots.forEach((mapping, index) => {
    const expected = chain.inputs[index],
      saved = draft.inputs[index],
      line = snapshot.inputs[index];
    valid(expected !== undefined && saved !== undefined && line !== undefined);
    valid(mapping.lineNo === index + 1 && saved.kind === "ftl_lot" && line.kind === "ftl_lot");
    valid(
      saved.lotId === mapping.lotId && line.lotId === mapping.lotId && line.lineNo === index + 1,
    );
    valid(
      saved.quantity === expected.quantity &&
        line.quantity === expected.quantity &&
        saved.unitOfMeasure === expected.unitOfMeasure &&
        line.unitOfMeasure === expected.unitOfMeasure &&
        line.tlc === expected.tlc,
    );
    const prior = products.get(expected.productKey);
    valid(prior === undefined || prior === line.product.id);
    products.set(expected.productKey, line.product.id);
    valid(line.source.kind === "location");
    const sourceKey = result.input.chain.receiving.previousSourceLocationKey;
    const priorSource = sources.get(sourceKey);
    valid(priorSource === undefined || equal(priorSource, line.source));
    sources.set(sourceKey, line.source);
    if (sourceKey === chain.locationKey)
      valid(
        line.source.id === snapshot.processor.id &&
          line.source.description === snapshot.processor.description,
      );
    else valid(line.source.id !== snapshot.processor.id);
  });
  const saved = draft.outputs[0],
    output = snapshot.outputs[0],
    expected = chain.output;
  valid(saved !== undefined && output !== undefined);
  valid(
    output.lineNo === 1 &&
      output.lotId === lot.id &&
      saved.productId === lot.productId &&
      output.product.id === lot.productId,
  );
  valid(saved.tlc === expected.tlc && output.tlc === expected.tlc && lot.tlc === expected.tlc);
  valid(
    saved.quantity === expected.quantity &&
      output.quantity === expected.quantity &&
      saved.unitOfMeasure === expected.unitOfMeasure &&
      output.unitOfMeasure === expected.unitOfMeasure,
  );
  valid(equal(output.source, { kind: "location", ...snapshot.processor }));
  valid(equal(lot.source, { kind: "location", locationId: snapshot.processor.id }));
  const prior = products.get(expected.productKey);
  valid(prior === undefined || prior === lot.productId);
  products.set(expected.productKey, lot.productId);
  valid(new Set(products.values()).size === products.size);
  valid(
    lot.assignmentBasis === "transformation" &&
      lot.status === "active" &&
      lot.revision === 1 &&
      lot.createdBy === last.finalizedBy &&
      lot.createdAt === last.finalizedAt &&
      lot.sourceLockedAt === last.finalizedAt,
  );
}

export function usDatasetTransformationEvidenceRecordIds(
  parsed: UsDatasetTransformationEvidence,
): readonly string[] {
  return Object.freeze([
    ...new Set(
      [
        ...parsed.documents.map(({ record }) => record.id),
        parsed.created.lifecycle?.rootId,
        parsed.created.id,
        parsed.finalized.lifecycle?.rootId,
        parsed.finalized.id,
        parsed.outputLot.id,
      ].filter((id): id is string => id !== undefined),
    ),
  ]);
}
