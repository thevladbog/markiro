import {
  canonicalExportDigest,
  canonicalExportEqual,
  ownedUsDemoJsonCopy,
} from "./us-demo-canonical.js";
import { platformUuidSchema } from "@markiro/platform-contracts";
import { z } from "zod";
import {
  makeUsDatasetCorrectedCasesInput,
  parseUsDatasetCorrectedCasesInput,
  type UsDatasetCorrectedCasesInput,
} from "./us-dataset-corrected-cases-contract.js";
import {
  parseUsDatasetCorrectedCasesResult,
  usDatasetCorrectedCasesRecordIds,
} from "./us-dataset-corrected-cases-result.js";
import {
  assertUsDatasetCorrectedTransformationJson,
  parseUsDatasetCorrectedTransformationInput,
} from "./us-dataset-corrected-transformation-contract.js";
import {
  parseUsDatasetCorrectedTransformationResult,
  usDatasetCorrectedTransformationRecordIds,
} from "./us-dataset-corrected-transformation-result.js";
import {
  parseUsDatasetSpecialResult,
  parseUsDatasetSpecialInput,
  usDatasetSpecialRecordIds,
} from "./us-dataset-special-contract.js";
import { parseUsDatasetIntent } from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import type { UsDatasetShippingPlanRow } from "./us-dataset-shipping-contract.js";
import type { UsSixMonthChain } from "./us-six-month-chains.js";
import { makeUsSixMonthSpecialExamples, usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetCorrectedShippingInput = Readonly<{
  codec: "us-dataset-corrected-shipping-input-v1";
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  casesInput: UsDatasetCorrectedCasesInput;
  cases: Readonly<{
    datasetId: string;
    unitKey: "correction_0001";
    stage: "cases";
    revision: 2;
    operationKey: string;
    inputDigest: string;
    resultDigest: string;
  }>;
  chain: UsSixMonthChain;
}>;

type ErrorCode =
  | "us_dataset_corrected_shipping_input_invalid"
  | "us_dataset_corrected_shipping_dependency_conflict"
  | "us_dataset_corrected_shipping_prerequisite_incomplete";
function shippingError(code: ErrorCode, cause: unknown): Error {
  return Object.assign(new Error(code, { cause }), {
    unitKey: "correction_0001",
    stage: "shipping",
  });
}
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .pipe(platformUuidSchema);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const casesIdentitySchema = z
  .object({
    datasetId: uuid,
    unitKey: z.literal("correction_0001"),
    stage: z.literal("cases"),
    revision: z.literal(2),
    operationKey: uuid,
    inputDigest: digest,
    resultDigest: digest,
  })
  .strict();
const inputSchema = z
  .object({
    codec: z.literal("us-dataset-corrected-shipping-input-v1"),
    version: z.literal("us-processor-six-month-v1"),
    definitionDigest: z.literal(usSixMonthDefinition.digest),
    casesInput: z.unknown(),
    cases: casesIdentitySchema,
    chain: z.custom<UsSixMonthChain>(),
  })
  .strict();
const stageSchema = z
  .object({
    unitKey: z.literal("correction_0001"),
    stage: z.literal("cases"),
    revision: z.union([z.literal(1), z.literal(2)]),
    intent: z.unknown(),
    receipt: z.unknown().nullable(),
  })
  .strict();
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("us_dataset_corrected_shipping_evidence_invalid");
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalExportEqual(a, b);
}
/** Only traverses owned copies after complete descriptor-safe validation. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}
/** Stored evidence coherence, never current-row ownership or authorization. */
export function parseUsDatasetCorrectedShippingInput(
  raw: unknown,
): UsDatasetCorrectedShippingInput {
  try {
    assertUsDatasetCorrectedTransformationJson(raw);
    const parsed = inputSchema.parse(raw);
    const casesInput = parseUsDatasetCorrectedCasesInput(parsed.casesInput);
    const input = { ...parsed, casesInput };
    valid(equal(raw, input));
    valid(input.cases.datasetId === casesInput.references.datasetId);
    valid(input.cases.inputDigest === canonicalExportDigest(casesInput));
    valid(equal(input.chain, makeUsSixMonthSpecialExamples().correction.correctedChain));
    return ownedUsDemoJsonCopy(input);
  } catch (cause) {
    throw shippingError("us_dataset_corrected_shipping_input_invalid", cause);
  }
}
export function makeUsDatasetCorrectedShippingInput(
  references: unknown,
  amendmentStage: unknown,
  transformationStage: unknown,
  casesStage: unknown,
): UsDatasetCorrectedShippingInput {
  let incomplete = false;
  try {
    assertUsDatasetCorrectedTransformationJson({
      references,
      amendmentStage,
      transformationStage,
      casesStage,
    });
    const row = stageSchema.parse(casesStage);
    valid(equal(row, casesStage));
    const intent = parseUsDatasetIntent(row.intent);
    const casesInput = parseUsDatasetCorrectedCasesInput(intent.input);
    valid(intent.unitKey === row.unitKey && intent.stage === row.stage);
    valid(equal(references, casesInput.references));
    // Validate every supplied prerequisite before an upstream pending row can
    // short-circuit reconstruction. Reuse the accepted codecs, never infer results.
    for (const [name, raw, identity] of [
      ["amend_receiving", amendmentStage, casesInput.amendment],
      ["transformation", transformationStage, casesInput.transformation],
    ] as const) {
      const upstreamRow = stageSchema
        .extend({ stage: z.literal(name) })
        .strict()
        .parse(raw);
      valid(equal(upstreamRow, raw));
      const upstreamIntent = parseUsDatasetIntent(upstreamRow.intent);
      valid(upstreamIntent.unitKey === upstreamRow.unitKey && upstreamIntent.stage === name);
      valid(upstreamIntent.operationKey === identity.operationKey);
      valid(upstreamIntent.inputDigest === identity.inputDigest);
      if (name === "amend_receiving") {
        const amendmentInput = parseUsDatasetSpecialInput(upstreamIntent.input);
        valid(amendmentInput.kind === "correction" && amendmentInput.stage === name);
        valid(equal(amendmentInput.references, casesInput.references));
      } else {
        const transformationInput = parseUsDatasetCorrectedTransformationInput(
          upstreamIntent.input,
        );
        valid(
          equal(transformationInput, {
            codec: "us-dataset-corrected-transformation-input-v1",
            version: casesInput.version,
            definitionDigest: casesInput.definitionDigest,
            references: casesInput.references,
            amendment: casesInput.amendment,
            receivingOrigin: casesInput.receivingOrigin,
            chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
          }),
        );
      }
      const upstreamPending = upstreamRow.revision === 1 && upstreamRow.receipt === null;
      valid(upstreamPending || (upstreamRow.revision === 2 && upstreamRow.receipt !== null));
      if (!upstreamPending) {
        const upstreamReceipt = parseUsDemoReceipt(upstreamRow.receipt);
        valid(upstreamReceipt.resultDigest === identity.resultDigest);
        if (name === "amend_receiving") {
          const result = parseUsDatasetSpecialResult(upstreamReceipt.result);
          valid(result.stage === name && equal(result.input, upstreamIntent.input));
          valid(result.started.operationKey === upstreamIntent.operationKey);
          valid(equal(upstreamReceipt.recordIds, usDatasetSpecialRecordIds(result)));
          const current = result.finalized.record;
          valid(current.content.kind === "finalized");
          valid(
            equal(casesInput.receivingOrigin, {
              rootId: current.lifecycle.rootId,
              eventId: current.id,
              revision: current.revision,
              lifecycleVersion: current.lifecycle.lifecycleVersion,
              inputLots: current.content.snapshot.items.map(({ lineNo, lotId }) => ({
                lineNo,
                lotId,
              })),
            }),
          );
        } else {
          const result = parseUsDatasetCorrectedTransformationResult(upstreamReceipt.result);
          valid(equal(result.input, upstreamIntent.input));
          valid(result.createInput.operationKey === upstreamIntent.operationKey);
          valid(
            equal(upstreamReceipt.recordIds, usDatasetCorrectedTransformationRecordIds(result)),
          );
          const receiptIds = new Set(upstreamReceipt.recordIds);
          valid(
            [casesInput.support.shiftId, ...casesInput.support.boxes.map(({ id }) => id)].every(
              (id) => !receiptIds.has(id),
            ),
          );
          const origin = result.finalized.lifecycle;
          valid(origin !== undefined);
          valid(
            equal(casesInput.transformationOrigin, {
              rootId: origin.rootId,
              eventId: result.finalized.id,
              revision: result.finalized.revision,
              lifecycleVersion: origin.lifecycleVersion,
            }),
          );
          valid(casesInput.outputLotId === result.outputLot.id);
          valid(casesInput.outputProductId === result.outputLot.productId);
        }
      }
    }
    const pending = row.revision === 1 && row.receipt === null;
    valid(pending || (row.revision === 2 && row.receipt !== null));
    // Reject contradictory Cases evidence before any valid pending upstream category.
    const receipt = pending ? null : parseUsDemoReceipt(row.receipt);
    if (receipt) {
      const result = parseUsDatasetCorrectedCasesResult(receipt.result);
      valid(equal(result.input, casesInput));
      valid(result.operationKey === intent.operationKey);
      valid(result.requestId === `dataset-cases:${intent.operationKey}`);
      valid(equal(receipt.recordIds, usDatasetCorrectedCasesRecordIds(result)));
    }
    let reconstructed: UsDatasetCorrectedCasesInput;
    try {
      reconstructed = makeUsDatasetCorrectedCasesInput(
        references,
        amendmentStage,
        transformationStage,
        casesInput.support,
      );
    } catch (cause) {
      incomplete =
        cause instanceof Error &&
        cause.message === "us_dataset_corrected_cases_prerequisite_incomplete";
      throw cause;
    }
    valid(equal(casesInput, reconstructed));
    if (pending) {
      incomplete = true;
      throw new Error("us_dataset_corrected_shipping_pending_cases");
    }
    valid(receipt !== null);
    return parseUsDatasetCorrectedShippingInput({
      codec: "us-dataset-corrected-shipping-input-v1",
      version: casesInput.version,
      definitionDigest: casesInput.definitionDigest,
      casesInput,
      cases: {
        datasetId: casesInput.references.datasetId,
        unitKey: row.unitKey,
        stage: row.stage,
        revision: 2,
        operationKey: intent.operationKey,
        inputDigest: intent.inputDigest,
        resultDigest: receipt.resultDigest,
      },
      chain: makeUsSixMonthSpecialExamples().correction.correctedChain,
    });
  } catch (cause) {
    throw shippingError(
      incomplete
        ? "us_dataset_corrected_shipping_prerequisite_incomplete"
        : "us_dataset_corrected_shipping_dependency_conflict",
      cause,
    );
  }
}
export function makeUsDatasetCorrectedShippingPlan(
  input: UsDatasetCorrectedShippingInput,
): readonly UsDatasetShippingPlanRow[] {
  const parsed = parseUsDatasetCorrectedShippingInput(input);
  const shipment = parsed.chain.shipping[0];
  valid(shipment !== undefined);
  return freezeOwned([
    {
      shipmentNo: 1,
      eventDate: shipment.eventDate,
      quantity: shipment.quantity,
      unitOfMeasure: "case" as const,
      shippingLocationKey: shipment.shippingLocationKey,
      recipientLocationKey: shipment.recipientLocationKey,
      references: [...shipment.references],
      outputLotId: parsed.casesInput.outputLotId,
      outputProductId: parsed.casesInput.outputProductId,
      plannedAvailableBefore: "60",
      plannedRemainingAfter: "10",
    },
  ]);
}
