import {
  canonicalExportDigest,
  canonicalExportEqual,
  ownedUsDemoJsonCopy,
} from "./us-demo-canonical.js";
import {
  platformUuidSchema,
  receivingLiveRecordSchema,
  receivingOperationReceiptV2Schema,
  referenceDocumentSchema,
  traceabilityLotSchema,
  type ReceivingLiveRecord,
  type ReceivingOperationReceiptV2,
  type ReferenceDocument,
  type TraceabilityLot,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { parseUsDatasetIntent, type UsDatasetStageRow } from "./us-dataset-contract.js";
import {
  usDatasetReceivingLotIdentity,
  type UsDatasetReferenceIdentity,
} from "./us-dataset-receiving-contract.js";
import { assertBoundedSyntheticJson, parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthDefinition,
  type UsSixMonthSpecialExamples,
} from "./us-six-month-definition.js";
import { makeUsSixMonthCatalogue } from "./us-six-month-references.js";

export type UsDatasetSpecialKind = "correction" | "orphan";
export type UsDatasetSpecialStage = "receiving" | "amend_receiving" | "void_receiving";
export type UsDatasetSpecialStageIdentity = Readonly<{
  datasetId: string;
  unitKey: "correction_0001" | "orphan_0001";
  stage: "receiving";
  revision: 2;
  operationKey: string;
  inputDigest: string;
  resultDigest: string;
}>;
export type UsDatasetSpecialInput = Readonly<{
  codec: "us-dataset-special-receiving-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  kind: UsDatasetSpecialKind;
  stage: UsDatasetSpecialStage;
  references: UsDatasetReferenceIdentity;
  recipe: UsSixMonthSpecialExamples[UsDatasetSpecialKind];
  receiving: UsDatasetSpecialStageIdentity | null;
}>;
export type UsDatasetSpecialReceivingResult = Readonly<{
  stage: "receiving";
  input: UsDatasetSpecialInput;
  documents: readonly Readonly<{ key: string; record: ReferenceDocument }>[];
  created: ReceivingOperationReceiptV2;
  finalized: ReceivingOperationReceiptV2;
  lots: readonly TraceabilityLot[];
}>;
export type UsDatasetSpecialLifecycleResult =
  | Readonly<{
      stage: "amend_receiving";
      input: UsDatasetSpecialInput;
      original: UsDatasetSpecialReceivingResult;
      started: ReceivingOperationReceiptV2;
      saved: ReceivingOperationReceiptV2;
      finalized: ReceivingOperationReceiptV2;
      predecessor: ReceivingLiveRecord;
      lots: readonly TraceabilityLot[];
    }>
  | Readonly<{
      stage: "void_receiving";
      input: UsDatasetSpecialInput;
      original: UsDatasetSpecialReceivingResult;
      voided: ReceivingOperationReceiptV2;
      lots: readonly TraceabilityLot[];
    }>;
export type UsDatasetSpecialResult =
  UsDatasetSpecialReceivingResult | UsDatasetSpecialLifecycleResult;
export type UsDatasetSpecialErrorCode =
  | "us_dataset_special_input_invalid"
  | "us_dataset_special_result_invalid"
  | "us_dataset_special_prerequisite_incomplete"
  | "us_dataset_special_dependency_conflict"
  | "us_dataset_special_conflict"
  | "us_dataset_special_mismatch";

export function datasetSpecialError(
  code: UsDatasetSpecialErrorCode,
  unitKey: string,
  stage: UsDatasetSpecialStage,
  cause?: unknown,
): Error & { unitKey: string; stage: UsDatasetSpecialStage } {
  const safeStage: UsDatasetSpecialStage =
    stage === "amend_receiving" || stage === "void_receiving" ? stage : "receiving";
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), {
    unitKey:
      typeof unitKey === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(unitKey) ? unitKey : "unknown",
    stage: safeStage,
  });
}

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .pipe(platformUuidSchema);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const referenceIdentitySchema = z
  .object({
    datasetId: uuid,
    unitKey: z.literal("references"),
    stage: z.literal("references"),
    revision: z.literal(2),
    operationKey: uuid,
    inputDigest: digest,
    resultDigest: digest,
  })
  .strict();
const receivingIdentitySchema = referenceIdentitySchema
  .extend({
    unitKey: z.enum(["correction_0001", "orphan_0001"]),
    stage: z.literal("receiving"),
  })
  .strict();
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-special-receiving-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    kind: z.enum(["correction", "orphan"]),
    stage: z.enum(["receiving", "amend_receiving", "void_receiving"]),
    references: referenceIdentitySchema,
    recipe: z.custom<UsSixMonthSpecialExamples[UsDatasetSpecialKind]>(),
    receiving: receivingIdentitySchema.nullable(),
  })
  .strict();
const lotsSchema = z.array(traceabilityLotSchema).length(2);
const receivingResultSchema = z
  .object({
    stage: z.literal("receiving"),
    input: inputSchema,
    documents: z
      .array(z.object({ key: z.string(), record: referenceDocumentSchema }).strict())
      .length(2),
    created: receivingOperationReceiptV2Schema,
    finalized: receivingOperationReceiptV2Schema,
    lots: lotsSchema,
  })
  .strict();
const resultSchema = z.discriminatedUnion("stage", [
  receivingResultSchema,
  z
    .object({
      stage: z.literal("amend_receiving"),
      input: inputSchema,
      original: receivingResultSchema,
      started: receivingOperationReceiptV2Schema,
      saved: receivingOperationReceiptV2Schema,
      finalized: receivingOperationReceiptV2Schema,
      predecessor: receivingLiveRecordSchema,
      lots: lotsSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal("void_receiving"),
      input: inputSchema,
      original: receivingResultSchema,
      voided: receivingOperationReceiptV2Schema,
      lots: lotsSchema,
    })
    .strict(),
]);
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_special_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportEqual(a, b);
}
/** Only validated module-owned structured copies enter this helper. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}
function unitKey(kind: UsDatasetSpecialKind): UsDatasetSpecialStageIdentity["unitKey"] {
  return kind === "correction" ? "correction_0001" : "orphan_0001";
}
function safeContext(raw: unknown): { unit: string; stage: UsDatasetSpecialStage } {
  const context = z
    .object({
      kind: z.enum(["correction", "orphan"]).optional(),
      stage: z.enum(["receiving", "amend_receiving", "void_receiving"]).optional(),
    })
    .passthrough()
    .parse(raw);
  return {
    unit: context.kind === undefined ? "unknown" : unitKey(context.kind),
    stage: context.stage ?? "receiving",
  };
}
export function makeUsDatasetSpecialInput(
  kind: UsDatasetSpecialKind,
  stage: UsDatasetSpecialStage,
  references: UsDatasetReferenceIdentity,
  receiving: UsDatasetSpecialStageIdentity | null,
): UsDatasetSpecialInput {
  return parseUsDatasetSpecialInput({
    codec: "us-dataset-special-receiving-v1",
    version: usSixMonthDefinition.version,
    definitionDigest: usSixMonthDefinition.digest,
    kind,
    stage,
    references,
    recipe:
      kind === "correction"
        ? makeUsSixMonthSpecialExamples().correction
        : makeUsSixMonthSpecialExamples().orphan,
    receiving,
  });
}
export function parseUsDatasetSpecialInput(raw: unknown): UsDatasetSpecialInput {
  let context: ReturnType<typeof safeContext> = { unit: "unknown", stage: "receiving" };
  try {
    assertBoundedSyntheticJson(raw);
    context = safeContext(raw);
    const input = inputSchema.parse(raw);
    valid(equal(input.recipe, makeUsSixMonthSpecialExamples()[input.kind]));
    valid(equal(raw, input));
    if (input.stage === "receiving") valid(input.receiving === null);
    else {
      valid(input.stage === (input.kind === "correction" ? "amend_receiving" : "void_receiving"));
      valid(input.receiving !== null);
      valid(input.receiving.datasetId === input.references.datasetId);
      valid(input.receiving.unitKey === unitKey(input.kind));
      valid(input.receiving.operationKey !== input.references.operationKey);
    }
    return ownedUsDemoJsonCopy(input);
  } catch (cause) {
    throw datasetSpecialError(
      "us_dataset_special_input_invalid",
      context.unit,
      context.stage,
      cause,
    );
  }
}
function recipeReceiving(input: UsDatasetSpecialInput) {
  const recipe = input.recipe;
  return "initialReceiving" in recipe ? recipe.initialReceiving : recipe.receiving;
}
function recipeDocuments(input: UsDatasetSpecialInput) {
  const recipe = input.recipe;
  return "correctedChain" in recipe ? recipe.correctedChain.documents : recipe.documents;
}
function finalizedContent(record: ReceivingLiveRecord) {
  valid(record.content.kind === "finalized");
  valid(record.content.snapshot.snapshotVersion === 3);
  return { ...record.content, snapshot: record.content.snapshot };
}
function draftContent(record: ReceivingLiveRecord) {
  valid(record.content.kind === "draft");
  return record.content.draft;
}
function sameRevision(a: ReceivingLiveRecord, b: ReceivingLiveRecord): void {
  valid(a.id === b.id && a.eventNumber === b.eventNumber && a.revision === b.revision);
  valid(a.createdBy === b.createdBy && a.createdAt === b.createdAt && a.timeZone === b.timeZone);
  valid(a.lifecycle.rootId === b.lifecycle.rootId);
}
function checkRecordIdentity(record: ReceivingLiveRecord): void {
  const lifecycle = record.lifecycle;
  valid(
    [
      record.id,
      lifecycle.rootId,
      lifecycle.previousRevisionId,
      lifecycle.supersededByEventId,
      lifecycle.currentEventId,
      lifecycle.pendingDraftId,
    ].every((id) => id === null || uuid.safeParse(id).success),
  );
}
function checkReceiptIdentity(receipt: ReceivingOperationReceiptV2): void {
  checkRecordIdentity(receipt.record);
  valid(uuid.safeParse(receipt.eventId).success && uuid.safeParse(receipt.operationKey).success);
  // Native schemas intentionally compare UUIDs case-insensitively; this codec binds exact bytes.
  valid(receipt.eventId === receipt.record.id);
}
function checkCanonicalIds(result: UsDatasetSpecialResult): string[] {
  const original = result.stage === "receiving" ? result : result.original;
  const ids = [
    ...original.documents.map(({ record }) => record.id),
    original.created.eventId,
    ...original.lots.map(({ id }) => id),
    ...(result.stage === "amend_receiving" ? [result.finalized.eventId] : []),
  ];
  valid(ids.every((id) => uuid.safeParse(id).success));
  valid(new Set(ids).size === ids.length);
  return ids;
}

/** Internal consistency only: the executor verifies catalogue ownership and native rows. */
function checkOriginal(result: UsDatasetSpecialReceivingResult): void {
  valid(result.input.stage === "receiving");
  checkReceiptIdentity(result.created);
  checkReceiptIdentity(result.finalized);
  const expected = recipeReceiving(result.input);
  const first = result.created.record,
    last = result.finalized.record;
  valid(
    result.created.command === "receiving.create" &&
      result.finalized.command === "receiving.finalize",
  );
  valid(result.created.operationKey === result.finalized.operationKey);
  valid(uuid.safeParse(result.created.operationKey).success);
  valid(result.created.operationKey !== result.input.references.operationKey);
  valid(result.created.eventId === result.finalized.eventId && first.id === first.lifecycle.rootId);
  sameRevision(first, last);
  valid(first.revision === 1 && first.draftVersion === 1 && last.draftVersion === 1);
  valid(first.lifecycle.lifecycleVersion === 1 && last.lifecycle.lifecycleVersion === 2);
  valid(first.lifecycle.currentEventId === null && first.lifecycle.pendingDraftId === first.id);
  valid(last.lifecycle.currentEventId === last.id && last.lifecycle.pendingDraftId === null);
  valid(first.timeZone === "America/Los_Angeles");
  valid(first.updatedBy === first.createdBy && first.updatedAt === first.createdAt);
  const draft = draftContent(first);
  const final = finalizedContent(last),
    snapshot = final.snapshot;
  valid(final.finalizedBy === first.createdBy && snapshot.profileCode === "US_FSMA204_PROCESSOR");
  valid(draft.dateReceived === expected.eventDate && snapshot.dateReceived === expected.eventDate);
  valid(
    draft.locationId !== null &&
      draft.previousSourceLocationId !== null &&
      draft.locationId !== draft.previousSourceLocationId,
  );
  valid(
    snapshot.locationId === draft.locationId &&
      snapshot.previousSourceLocationId === draft.previousSourceLocationId,
  );
  valid(snapshot.notes === draft.notes && snapshot.receivedAtNote === draft.receivedAtNote);
  valid(draft.items.length === 2 && snapshot.items.length === 2);
  valid(draft.documentIds.length === 2 && snapshot.documents.length === 2);
  checkCanonicalIds(result);
  const parties = new Map<string, string>(),
    products = new Map<string, string>();
  const sourceDefinition = makeUsSixMonthCatalogue().locations.find(
    ({ key }) => key === expected.previousSourceLocationKey,
  );
  valid(sourceDefinition !== undefined);
  result.documents.forEach(({ key, record }, index) => {
    const matches = recipeDocuments(result.input).filter(
      ({ input }) => input.number === expected.references[index],
    );
    const definition = matches[0],
      frozen = snapshot.documents[index];
    valid(matches.length === 1 && definition !== undefined && frozen !== undefined);
    valid(key === definition.key && record.archivedAt === null && record.partyId !== null);
    valid(record.createdBy === first.createdBy && record.updatedAt === record.createdAt);
    const { id, partyId, archivedAt, createdBy, createdAt, updatedAt, ...fields } = record;
    void archivedAt;
    void createdBy;
    void createdAt;
    void updatedAt;
    valid(equal(fields, definition.input));
    valid(draft.documentIds[index] === id);
    valid(equal(frozen.document, { ...fields, partyId, documentId: id, snapshotVersion: 1 }));
    valid(
      parties.get(definition.partyKey) === undefined ||
        parties.get(definition.partyKey) === partyId,
    );
    parties.set(definition.partyKey, partyId);
    if (definition.partyKey === sourceDefinition.partyKey)
      valid(partyId === snapshot.previousSourceDescription.partyId);
  });
  result.lots.forEach((lot, index) => {
    const line = snapshot.items[index],
      saved = draft.items[index],
      definition = expected.lines[index];
    valid(line !== undefined && saved !== undefined && definition !== undefined);
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
    valid(
      saved.productId === lot.productId &&
        line.productId === lot.productId &&
        uuid.safeParse(lot.productId).success,
    );
    valid(
      products.get(definition.productKey) === undefined ||
        products.get(definition.productKey) === lot.productId,
    );
    products.set(definition.productKey, lot.productId);
    valid(
      saved.tlc === definition.tlc && line.tlc === definition.tlc && lot.tlc === definition.tlc,
    );
    valid(saved.quantity === definition.quantity && line.quantity === definition.quantity);
    valid(
      saved.unitOfMeasure === definition.unitOfMeasure &&
        line.unitOfMeasure === definition.unitOfMeasure,
    );
    valid(saved.supplierLotReference === line.supplierLotReference && saved.notes === line.notes);
    valid(equal(saved.source, lot.source) && equal(line.source, lot.source));
    valid(
      lot.source?.kind === "location" && lot.source.locationId === draft.previousSourceLocationId,
    );
    valid(line.sourceDescription.partyId === snapshot.previousSourceDescription.partyId);
    valid(lot.assignmentBasis === "imported" && lot.status === "active" && lot.revision === 1);
    valid(
      lot.sourceLockedAt === final.finalizedAt &&
        lot.createdBy === final.finalizedBy &&
        lot.createdAt === final.finalizedAt,
    );
    valid(lot.updatedBy === lot.createdBy && lot.updatedAt === lot.createdAt);
  });
}
function checkLifecycle(result: UsDatasetSpecialLifecycleResult): void {
  const { input, original } = result;
  const identity = input.receiving;
  valid(identity !== null);
  valid(equal(input.references, original.input.references) && input.kind === original.input.kind);
  valid(equal(input.recipe, original.input.recipe));
  valid(identity.operationKey === original.created.operationKey);
  valid(identity.inputDigest === canonicalExportDigest(original.input));
  valid(identity.resultDigest === canonicalExportDigest(original));
  valid(
    equal(
      result.lots.map(usDatasetReceivingLotIdentity),
      original.lots.map(usDatasetReceivingLotIdentity),
    ),
  );
  const prior = original.finalized.record;
  const historical = finalizedContent(prior);
  checkCanonicalIds(result);
  if (result.stage === "void_receiving") {
    valid(input.kind === "orphan" && "voidReason" in input.recipe);
    checkReceiptIdentity(result.voided);
    const { voided } = result,
      last = voided.record;
    valid(voided.command === "receiving.void" && voided.eventId === prior.id);
    valid(
      uuid.safeParse(voided.operationKey).success &&
        voided.operationKey !== identity.operationKey &&
        voided.operationKey !== input.references.operationKey,
    );
    sameRevision(prior, last);
    valid(last.draftVersion === 1 && last.lifecycle.lifecycleVersion === 3);
    valid(last.lifecycle.currentEventId === null && last.lifecycle.pendingDraftId === null);
    valid(
      last.lifecycle.voidReason === input.recipe.voidReason &&
        last.lifecycle.voidedBy === prior.createdBy,
    );
    valid(
      equal(last.content, historical) &&
        last.updatedBy === prior.updatedBy &&
        last.updatedAt === prior.updatedAt,
    );
    return;
  }
  valid(input.kind === "correction" && "initialReceiving" in input.recipe);
  const { started, saved, finalized, predecessor } = result;
  for (const receipt of [started, saved, finalized]) checkReceiptIdentity(receipt);
  checkRecordIdentity(predecessor);
  const first = started.record,
    middle = saved.record,
    last = finalized.record;
  valid(
    started.command === "receiving.amend" &&
      saved.command === "receiving.save" &&
      finalized.command === "receiving.finalize",
  );
  valid(
    started.operationKey === saved.operationKey && saved.operationKey === finalized.operationKey,
  );
  valid(
    uuid.safeParse(started.operationKey).success &&
      started.operationKey !== identity.operationKey &&
      started.operationKey !== input.references.operationKey,
  );
  valid(
    started.eventId === saved.eventId &&
      saved.eventId === finalized.eventId &&
      started.eventId !== prior.id,
  );
  sameRevision(first, middle);
  sameRevision(first, last);
  valid(
    first.revision === 2 &&
      first.draftVersion === 1 &&
      middle.draftVersion === 2 &&
      last.draftVersion === 2,
  );
  valid(
    first.createdBy === prior.createdBy &&
      first.eventNumber === prior.eventNumber &&
      first.timeZone === prior.timeZone,
  );
  valid(first.updatedBy === first.createdBy && first.updatedAt === first.createdAt);
  for (const record of [first, middle, last]) {
    valid(record.lifecycle.rootId === prior.id && record.lifecycle.previousRevisionId === prior.id);
    valid(record.lifecycle.amendmentReason === input.recipe.amendmentReason);
  }
  valid(
    first.lifecycle.lifecycleVersion === 3 &&
      middle.lifecycle.lifecycleVersion === 3 &&
      last.lifecycle.lifecycleVersion === 4,
  );
  valid(
    first.lifecycle.currentEventId === prior.id && middle.lifecycle.currentEventId === prior.id,
  );
  valid(
    first.lifecycle.pendingDraftId === first.id && middle.lifecycle.pendingDraftId === middle.id,
  );
  valid(last.lifecycle.currentEventId === last.id && last.lifecycle.pendingDraftId === null);
  const initialDraft = draftContent(first),
    correctedDraft = draftContent(middle);
  const initialOriginal = draftContent(original.created.record);
  valid(
    equal(initialDraft, {
      ...initialOriginal,
      items: initialOriginal.items.map((line, index) => ({
        ...line,
        lotId: original.lots[index]?.id,
        previousLineNo: index + 1,
      })),
    }),
  );
  const correctedRecipe = input.recipe.correctedChain.receiving;
  valid(
    equal(correctedDraft, {
      ...initialDraft,
      items: initialDraft.items.map((line, index) => ({
        ...line,
        quantity: correctedRecipe.lines[index]?.quantity,
      })),
    }),
  );
  const final = finalizedContent(last),
    snapshot = final.snapshot;
  valid(final.finalizedBy === prior.createdBy && middle.updatedBy === prior.createdBy);
  const { items, confirmation, ...header } = snapshot;
  const {
    items: previousItems,
    confirmation: previousConfirmation,
    ...priorHeader
  } = historical.snapshot;
  void previousConfirmation;
  valid(equal(header, priorHeader));
  valid(confirmation.reviewedExemptLines.length === 0 && items.length === 2);
  items.forEach((line, index) => {
    const previous = previousItems[index],
      definition = correctedRecipe.lines[index];
    valid(previous !== undefined && definition !== undefined);
    valid(
      equal(line, {
        ...previous,
        quantity: definition.quantity,
        lotBinding: { kind: "retained", previousEventId: prior.id, previousLineNo: index + 1 },
      }),
    );
  });
  sameRevision(prior, predecessor);
  valid(predecessor.status === "amended" && predecessor.draftVersion === 1);
  valid(equal(predecessor.content, historical));
  valid(predecessor.updatedAt === prior.updatedAt && predecessor.updatedBy === prior.updatedBy);
  valid(
    equal(predecessor.lifecycle, {
      ...prior.lifecycle,
      lifecycleVersion: 4,
      currentEventId: last.id,
      supersededByEventId: last.id,
      supersededAt: final.finalizedAt,
      supersededBy: final.finalizedBy,
    }),
  );
}

// Only detached, deeply frozen outputs of the complete result codec are admitted.
// This provenance certifies JSON consistency, never current database state.
const ownedSpecialResults = new WeakSet<UsDatasetSpecialResult>();

export function parseUsDatasetSpecialResult(raw: unknown): UsDatasetSpecialResult {
  let context: ReturnType<typeof safeContext> = { unit: "unknown", stage: "receiving" };
  try {
    assertBoundedSyntheticJson(raw);
    const envelope = z.object({ input: z.unknown() }).passthrough().parse(raw);
    const input = parseUsDatasetSpecialInput(envelope.input);
    context = { unit: unitKey(input.kind), stage: input.stage };
    const parsed = resultSchema.parse(raw);
    valid(parsed.stage === input.stage);
    const result = { ...parsed, input };
    if (result.stage === "receiving") checkOriginal(result);
    else {
      const originalInput = parseUsDatasetSpecialInput(result.original.input);
      result.original = { ...result.original, input: originalInput };
      checkOriginal(result.original);
      checkLifecycle(result);
    }
    valid(equal(raw, result));
    const owned = ownedUsDemoJsonCopy(result);
    ownedSpecialResults.add(owned);
    return owned;
  } catch (cause) {
    throw datasetSpecialError(
      "us_dataset_special_result_invalid",
      context.unit,
      context.stage,
      cause,
    );
  }
}
export function makeUsDatasetSpecialStageIdentity(
  datasetId: string,
  stage: UsDatasetStageRow,
): UsDatasetSpecialStageIdentity {
  let unit = "unknown";
  try {
    assertBoundedSyntheticJson(stage);
    const row = z
      .object({
        unitKey: z.enum(["correction_0001", "orphan_0001"]),
        stage: z.literal("receiving"),
        revision: z.union([z.literal(1), z.literal(2)]),
        intent: z.unknown(),
        receipt: z.unknown().nullable(),
      })
      .strict()
      .parse(stage);
    unit = row.unitKey;
    uuid.parse(datasetId);
    if (row.revision === 1 || row.receipt === null)
      throw datasetSpecialError("us_dataset_special_prerequisite_incomplete", unit, "receiving");
    const intent = parseUsDatasetIntent(row.intent),
      receipt = parseUsDemoReceipt(row.receipt);
    const result = parseUsDatasetSpecialResult(receipt.result);
    valid(result.stage === "receiving");
    valid(
      unit === unitKey(result.input.kind) &&
        intent.unitKey === unit &&
        intent.stage === "receiving",
    );
    valid(result.input.references.datasetId === datasetId);
    valid(equal(intent.input, result.input) && intent.operationKey === result.created.operationKey);
    valid(equal(receipt.recordIds, checkCanonicalIds(result)));
    return freezeOwned(
      receivingIdentitySchema.parse({
        datasetId,
        unitKey: unit,
        stage: "receiving",
        revision: 2,
        operationKey: intent.operationKey,
        inputDigest: intent.inputDigest,
        resultDigest: receipt.resultDigest,
      }),
    );
  } catch (cause) {
    if (cause instanceof Error && cause.message === "us_dataset_special_prerequisite_incomplete")
      throw cause;
    throw datasetSpecialError("us_dataset_special_dependency_conflict", unit, "receiving", cause);
  }
}
export function usDatasetSpecialRecordIds(result: UsDatasetSpecialResult): readonly string[] {
  return Object.freeze(
    checkCanonicalIds(
      ownedSpecialResults.has(result) ? result : parseUsDatasetSpecialResult(result),
    ),
  );
}
