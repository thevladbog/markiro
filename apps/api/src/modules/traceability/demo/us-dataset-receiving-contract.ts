import { canonicalExportDigest } from "./us-demo-canonical.js";
import {
  platformUuidSchema,
  receivingOperationReceiptV2Schema,
  referenceDocumentSchema,
  traceabilityLotSchema,
  type ReceivingOperationReceiptV2,
  type ReferenceDocument,
  type TraceabilityLot,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { parseUsDatasetIntent, type UsDatasetStageRow } from "./us-dataset-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { assertBoundedSyntheticJson, parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import { makeUsSixMonthRegularChain, type UsSixMonthChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { makeUsSixMonthCatalogue } from "./us-six-month-references.js";

export type UsDatasetReferenceIdentity = Readonly<{
  datasetId: string;
  unitKey: "references";
  stage: "references";
  revision: 2;
  operationKey: string;
  inputDigest: string;
  resultDigest: string;
}>;
export type UsDatasetReceivingInput = Readonly<{
  codec: "us-dataset-receiving-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  references: UsDatasetReferenceIdentity;
  chain: UsSixMonthChain;
}>;
export type UsDatasetReceivingResult = Readonly<{
  input: UsDatasetReceivingInput;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  created: ReceivingOperationReceiptV2;
  finalized: ReceivingOperationReceiptV2;
  lots: readonly TraceabilityLot[];
}>;
export type UsDatasetReceivingErrorCode =
  | "us_dataset_receiving_input_invalid"
  | "us_dataset_receiving_result_invalid"
  | "us_dataset_receiving_prerequisite_incomplete"
  | "us_dataset_receiving_dependency_conflict"
  | "us_dataset_receiving_conflict"
  | "us_dataset_receiving_mismatch";

export function datasetReceivingError(
  code: UsDatasetReceivingErrorCode,
  unitKey: string,
  cause?: unknown,
): Error & { unitKey: string; stage: "receiving" } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey,
    stage: "receiving" as const,
  });
}

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identitySchema = z
  .object({
    datasetId: platformUuidSchema,
    unitKey: z.literal("references"),
    stage: z.literal("references"),
    revision: z.literal(2),
    operationKey: platformUuidSchema,
    inputDigest: digest,
    resultDigest: digest,
  })
  .strict();
// Safe JSON is checked before this custom boundary; complete descriptor equality follows.
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-receiving-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    references: identitySchema,
    chain: z.custom<UsSixMonthChain>(),
  })
  .strict();
const resultSchema = z
  .object({
    input: inputSchema,
    documents: z
      .array(z.object({ key: z.string(), record: referenceDocumentSchema }).strict())
      .length(2),
    created: receivingOperationReceiptV2Schema,
    finalized: receivingOperationReceiptV2Schema,
    lots: z.array(traceabilityLotSchema).length(2),
  })
  .strict();

function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}
const expectedCatalogue = makeUsSixMonthCatalogue();
const expectedReferenceInputDigest = canonicalExportDigest(
  freezeOwned({
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    catalogue: expectedCatalogue,
  }),
);

function equal(a: unknown, b: unknown): boolean {
  return canonicalExportDigest(a) === canonicalExportDigest(b);
}
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_receiving_evidence_invalid");
}

export function makeUsDatasetReferenceIdentity(
  datasetId: string,
  stage: UsDatasetStageRow,
): UsDatasetReferenceIdentity {
  try {
    assertBoundedSyntheticJson(stage);
    if (stage.revision === 1 || stage.receipt === null)
      throw datasetReceivingError("us_dataset_receiving_prerequisite_incomplete", "references");
    const intent = parseUsDatasetIntent(stage.intent);
    const receipt = parseUsDemoReceipt(stage.receipt);
    const result = parseUsDatasetReferenceResult(receipt.result);
    valid(stage.unitKey === "references" && stage.stage === "references" && stage.revision === 2);
    valid(intent.unitKey === "references" && intent.stage === "references");
    valid(canonicalExportDigest(intent.input) === expectedReferenceInputDigest);
    valid(
      equal(
        receipt.recordIds,
        [...result.bindings.parties, ...result.bindings.locations, ...result.bindings.products].map(
          ({ id }) => id,
        ),
      ),
    );
    const identity = identitySchema.parse({
      datasetId,
      unitKey: "references",
      stage: "references",
      revision: 2,
      operationKey: intent.operationKey,
      inputDigest: intent.inputDigest,
      resultDigest: receipt.resultDigest,
    });
    valid(identity.datasetId === datasetId);
    return freezeOwned(identity);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "us_dataset_receiving_prerequisite_incomplete")
      throw cause;
    throw datasetReceivingError("us_dataset_receiving_dependency_conflict", "references", cause);
  }
}

export function makeUsDatasetReceivingInput(
  index: number,
  references: UsDatasetReferenceIdentity,
): UsDatasetReceivingInput {
  let unitKey = "unknown";
  try {
    const chain = makeUsSixMonthRegularChain(index);
    unitKey = chain.unitKey;
    return parseUsDatasetReceivingInput({
      codec: "us-dataset-receiving-v1",
      version: usSixMonthDefinition.version,
      definitionDigest: usSixMonthDefinition.digest,
      references,
      chain,
    });
  } catch (cause) {
    throw datasetReceivingError("us_dataset_receiving_input_invalid", unitKey, cause);
  }
}

export function parseUsDatasetReceivingInput(raw: unknown): UsDatasetReceivingInput {
  let unitKey = "unknown";
  try {
    assertBoundedSyntheticJson(raw);
    // Diagnostic context only, after raw safety; the full strict schema remains authoritative.
    const context = z
      .object({
        chain: z.object({ unitKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }).passthrough(),
      })
      .passthrough()
      .safeParse(raw);
    if (context.success) unitKey = context.data.chain.unitKey;
    const parsed = inputSchema.parse(raw);
    const match = /^chain_(\d{4})$/.exec(parsed.chain.unitKey);
    valid(match !== null && match[1] !== undefined);
    unitKey = parsed.chain.unitKey;
    valid(equal(parsed.chain, makeUsSixMonthRegularChain(Number(match[1]))));
    valid(equal(raw, parsed));
    return freezeOwned(structuredClone(parsed));
  } catch (cause) {
    throw datasetReceivingError("us_dataset_receiving_input_invalid", unitKey, cause);
  }
}

/** Compare business evidence internally; catalogue UUID ownership is verified by the executor. */
function checkResult(result: UsDatasetReceivingResult): void {
  const chain = result.input.chain;
  const { created, finalized } = result;
  const first = created.record;
  const last = finalized.record;
  valid(created.command === "receiving.create" && finalized.command === "receiving.finalize");
  valid(created.operationKey === finalized.operationKey && created.eventId === finalized.eventId);
  valid(first.lifecycle.rootId === last.lifecycle.rootId && first.id === last.id);
  valid(
    first.revision === 1 &&
      last.revision === 1 &&
      first.draftVersion === 1 &&
      last.draftVersion === 1,
  );
  valid(first.lifecycle.lifecycleVersion === 1 && last.lifecycle.lifecycleVersion === 2);
  valid(last.lifecycle.pendingDraftId === null);
  valid(first.timeZone === "America/Los_Angeles" && last.timeZone === first.timeZone);
  valid(
    first.eventNumber === last.eventNumber &&
      first.createdBy === last.createdBy &&
      first.createdAt === last.createdAt,
  );
  valid(first.updatedBy === first.createdBy && first.updatedAt === first.createdAt);
  valid(first.content.kind === "draft" && last.content.kind === "finalized");
  const draft = first.content.draft;
  const finalContent = last.content;
  const snapshot = finalContent.snapshot;
  valid(finalContent.finalizedBy === first.createdBy);
  valid(snapshot.snapshotVersion === 3 && snapshot.profileCode === "US_FSMA204_PROCESSOR");
  valid(
    draft.dateReceived === chain.receiving.eventDate &&
      snapshot.dateReceived === draft.dateReceived,
  );
  valid(draft.locationId !== null && snapshot.locationId === draft.locationId);
  valid(
    draft.previousSourceLocationId !== null &&
      snapshot.previousSourceLocationId === draft.previousSourceLocationId,
  );
  valid(draft.locationId !== draft.previousSourceLocationId);
  valid(snapshot.receivedAtNote === draft.receivedAtNote && snapshot.notes === draft.notes);
  valid(draft.items.length === 2 && snapshot.items.length === 2);
  valid(draft.documentIds.length === 2 && snapshot.documents.length === 2);
  const ids = [
    ...result.documents.map(({ record }) => record.id),
    first.id,
    ...result.lots.map(({ id }) => id),
  ];
  valid(new Set(ids.map((id) => id.toLowerCase())).size === 5);
  const symbolicProducts = new Map<string, string>();
  const symbolicParties = new Map<string, string>();
  result.documents.forEach(({ key, record }, index) => {
    const number = chain.receiving.references[index];
    const definitions = chain.documents.filter(({ input }) => input.number === number);
    const definition = definitions[0];
    const frozen = snapshot.documents[index];
    valid(definitions.length === 1 && definition !== undefined && frozen !== undefined);
    valid(key === definition.key && record.archivedAt === null && record.partyId !== null);
    valid(record.createdBy === first.createdBy);
    const { id, partyId, archivedAt, createdBy, createdAt, updatedAt, ...fields } = record;
    void archivedAt;
    void createdBy;
    void createdAt;
    void updatedAt;
    valid(equal(fields, definition.input));
    valid(draft.documentIds[index] === id);
    valid(equal(frozen.document, { ...fields, partyId, documentId: id, snapshotVersion: 1 }));
    const prior = symbolicParties.get(definition.partyKey);
    valid(prior === undefined || prior === partyId);
    symbolicParties.set(definition.partyKey, partyId);
    const location = expectedCatalogue.locations.find(
      ({ key }) => key === chain.receiving.previousSourceLocationKey,
    );
    valid(location !== undefined);
    if (definition.partyKey === location.partyKey)
      valid(partyId === snapshot.previousSourceDescription.partyId);
  });
  result.lots.forEach((lot, index) => {
    const expected = chain.receiving.lines[index];
    const saved = draft.items[index];
    const line = snapshot.items[index];
    valid(expected !== undefined && saved !== undefined && line !== undefined);
    valid(line.lineNo === index + 1 && line.lotId === lot.id && saved.lotId === null);
    valid(
      saved.lotLinkMode === "create_on_finalize" &&
        line.lotLinkMode === saved.lotLinkMode &&
        line.lotBinding.kind === "created",
    );
    valid(
      !saved.exemptSupplier &&
        saved.exemptReason === null &&
        (saved.exemptReceipt ?? null) === null &&
        line.receiptBasis.kind === "ordinary",
    );
    valid(saved.productId === lot.productId && line.productId === lot.productId);
    const prior = symbolicProducts.get(expected.productKey);
    valid(prior === undefined || prior === lot.productId);
    symbolicProducts.set(expected.productKey, lot.productId);
    valid(saved.tlc === expected.tlc && line.tlc === expected.tlc && lot.tlc === expected.tlc);
    valid(saved.quantity === expected.quantity && line.quantity === expected.quantity);
    valid(
      saved.unitOfMeasure === expected.unitOfMeasure &&
        line.unitOfMeasure === expected.unitOfMeasure,
    );
    valid(line.supplierLotReference === saved.supplierLotReference && line.notes === saved.notes);
    valid(equal(saved.source, lot.source) && equal(line.source, lot.source));
    valid(
      lot.source?.kind === "location" && lot.source.locationId === draft.previousSourceLocationId,
    );
    valid(line.sourceDescription.partyId === snapshot.previousSourceDescription.partyId);
    valid(lot.assignmentBasis === "imported" && lot.status === "active" && lot.revision === 1);
    valid(
      lot.sourceLockedAt === finalContent.finalizedAt && lot.createdBy === finalContent.finalizedBy,
    );
    valid(lot.createdAt === finalContent.finalizedAt);
  });
}

export function parseUsDatasetReceivingResult(raw: unknown): UsDatasetReceivingResult {
  let unitKey = "unknown";
  try {
    assertBoundedSyntheticJson(raw);
    // Establish safe intent context before a nested receipt/document schema can reject it.
    const envelope = z.object({ input: z.unknown() }).passthrough().parse(raw);
    const input = parseUsDatasetReceivingInput(envelope.input);
    unitKey = input.chain.unitKey;
    const parsed = resultSchema.parse(raw);
    const result = { ...parsed, input };
    valid(equal(raw, result));
    checkResult(result);
    return freezeOwned(structuredClone(result));
  } catch (cause) {
    throw datasetReceivingError("us_dataset_receiving_result_invalid", unitKey, cause);
  }
}

export function usDatasetReceivingRecordIds(result: UsDatasetReceivingResult): readonly string[] {
  const ownedIds = [
    ...result.documents.map(({ record }) => record.id),
    result.created.record.lifecycle.rootId,
    ...result.lots.map(({ id }) => id),
  ];
  if (
    new Set(ownedIds.map((id) => id.toLowerCase())).size !== ownedIds.length ||
    result.created.eventId !== result.created.record.lifecycle.rootId
  )
    throw datasetReceivingError("us_dataset_receiving_result_invalid", result.input.chain.unitKey);
  return Object.freeze([
    ...new Set([
      ...result.documents.map(({ record }) => record.id),
      result.created.record.lifecycle.rootId,
      result.created.eventId,
      ...result.lots.map(({ id }) => id),
    ]),
  ]);
}

export function usDatasetReceivingLotIdentity(
  lot: TraceabilityLot,
): Readonly<Record<string, unknown>> {
  return freezeOwned(
    structuredClone({
      id: lot.id,
      productId: lot.productId,
      tlc: lot.tlc,
      source: lot.source,
      assignmentBasis: lot.assignmentBasis,
      status: lot.status,
      revision: lot.revision,
      sourceLockedAt: lot.sourceLockedAt,
      createdBy: lot.createdBy,
      createdAt: lot.createdAt,
    }),
  );
}
