import { schema } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { lockCaseOperation } from "../cases/us-case-operations.js";
import { lockShippingOperation, type UsShippingStore } from "../shipping/us-shipping-draft.js";
import { readCurrentShippingBalance } from "../shipping/us-shipping-balance.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetStageRow,
} from "./us-dataset-contract.js";
import {
  parseUsDatasetCasesResult,
  makeUsDatasetTransformationIdentity,
} from "./us-dataset-cases-contract.js";
import { verifyUsDatasetCasesOriginCore } from "./us-dataset-cases-verify.js";
import {
  makeUsDatasetReferenceIdentity,
  parseUsDatasetReceivingResult,
} from "./us-dataset-receiving-contract.js";
import {
  makeUsDatasetReceivingIdentity,
  parseUsDatasetTransformationResult,
} from "./us-dataset-transformation-contract.js";
import type { UsDatasetTransformationStores } from "./us-dataset-transformation-verify.js";
import {
  datasetShippingError,
  makeUsDatasetShippingInput,
  makeUsDatasetShippingPlan,
  parseUsDatasetShippingInput,
  parseUsDatasetShippingResult,
  usDatasetShippingOperationKey,
  type UsDatasetShippingInput,
} from "./us-dataset-shipping-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import type { UsDatasetVerifiedOrigin } from "./us-dataset-shipping-projection.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetShippingDependencies } from "./us-dataset-terminal-read-contract.js";

export type UsDatasetShippingStores = UsDatasetTransformationStores &
  Readonly<{ shipping: UsShippingStore }>;
export type UsDatasetShippingPrepared = Readonly<{
  input: UsDatasetShippingInput;
  intent: UsDatasetIntent;
  shipping: UsDatasetStageRow;
  references: UsDatasetStageRow;
  receiving: UsDatasetStageRow;
  transformation: UsDatasetStageRow;
  cases: UsDatasetStageRow;
  verifiedOrigin: UsDatasetVerifiedOrigin;
}>;

export async function prepareUsDatasetShipping(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  datasetId: string,
  unitKey: string,
  phase: "application" | "verification",
  stores: UsDatasetShippingStores,
): Promise<UsDatasetShippingPrepared> {
  return prepareUsDatasetShippingCore(
    tx,
    context,
    datasetId,
    unitKey,
    phase,
    freshUsDatasetTerminalDependencies(stores),
  );
}

export async function prepareUsDatasetShippingCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  datasetId: string,
  unitKey: string,
  phase: "application" | "verification",
  stores: UsDatasetShippingDependencies,
): Promise<UsDatasetShippingPrepared> {
  const header = await stores.journal.readHeaderInTransaction(tx, context);
  const fail = () => datasetShippingError("us_dataset_shipping_conflict", unitKey);
  if (!header || header.id !== datasetId) throw fail();
  await stores.authorize(tx, context.tenantId, context.actorUserId, US_CAPABILITY.SHIPPING_WRITE);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":us-processor-demo-v1"}, 0))`,
  );
  const h = schema.traceabilityDemoDatasets,
    s = schema.traceabilityDemoDatasetStages;
  await tx
    .select({ id: h.id })
    .from(h)
    .where(and(eq(h.tenantId, context.tenantId), eq(h.id, header.id)))
    .for("update");
  await tx
    .select({ id: s.unitKey })
    .from(s)
    .where(
      and(eq(s.tenantId, context.tenantId), eq(s.datasetId, header.id), eq(s.unitKey, unitKey)),
    )
    .orderBy(asc(s.stage))
    .for("update");
  const [references, receiving, transformation, cases, shipping] =
    await stores.journal.readStagesInTransaction(tx, context, header.id, [
      { unitKey: "references", stage: "references" },
      { unitKey: unitKey, stage: "receiving" },
      { unitKey: unitKey, stage: "transformation" },
      { unitKey: unitKey, stage: "cases" },
      { unitKey: unitKey, stage: "shipping" },
    ]);
  if (
    !references?.receipt ||
    !receiving?.receipt ||
    !transformation?.receipt ||
    !cases?.receipt ||
    !shipping
  )
    throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
  const intent = shipping.intent,
    input = parseUsDatasetShippingInput(intent.input);
  const origin = parseUsDatasetTransformationResult(transformation.receipt.result);
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw fail();
  };
  equal(
    input,
    makeUsDatasetShippingInput(
      input.index,
      makeUsDatasetReferenceIdentity(header.id, references),
      makeUsDatasetReceivingIdentity(header.id, receiving),
      makeUsDatasetTransformationIdentity(header.id, transformation),
      origin.outputLot.id,
      origin.outputLot.productId,
    ),
  );
  equal(input.chain.unitKey, unitKey);
  equal(intent.inputDigest, canonicalExportDigest(input));
  const caseResult = parseUsDatasetCasesResult(cases.receipt.result);
  equal(caseResult.input.outputLotId, input.outputLotId);
  // All operation arbitration precedes all business roots and lots.
  await lockCaseOperation(tx, context.tenantId, "case.link", cases.intent.operationKey);
  for (const row of makeUsDatasetShippingPlan(input)) {
    const key = usDatasetShippingOperationKey(intent.operationKey, row.shipmentNo);
    for (const command of ["shipping.create", "shipping.finalize"] as const) {
      const operation = await lockShippingOperation(tx, context.tenantId, command, key);
      if (phase === "application" && operation) throw fail();
    }
  }
  if (phase === "application" && shipping.receipt) throw fail();
  const saved = shipping.receipt ? parseUsDatasetShippingResult(shipping.receipt.result) : null;
  await stores.locks.shipping(
    tx,
    context,
    parseUsDatasetReceivingResult(receiving.receipt.result),
    origin,
    saved,
  );
  // Retain public reference shares and ALL known document shares before final
  // case-support locks. Upstream verification will reacquire already held locks.
  const bindings = parseUsDatasetReferenceResult(references.receipt.result).bindings;
  await stores.locks.shippingReferences(tx, context.tenantId, unitKey, bindings);
  // Cases' upstream verifier still validates every canonical reference fact;
  // this tier only acquires those same shares early, without repeating reads.
  const numbers = makeUsDatasetShippingPlan(input).flatMap((row) => row.references);
  const parties = bindings.parties;
  const definitions = input.chain.documents
    .filter((row) => numbers.includes(row.input.number))
    .map((row) => {
      const partyId = parties.find((party) => party.key === row.partyKey)?.id;
      if (!partyId) throw fail();
      return { type: row.input.type, number: row.input.number, partyId };
    });
  const upstream = parseUsDatasetReceivingResult(receiving.receipt.result);
  const ownedIds = [
    ...upstream.documents.map((row) => row.record.id),
    ...origin.documents.map((row) => row.record.id),
    ...(saved?.shipments.flatMap((row) => row.documents.map((doc) => doc.record.id)) ?? []),
  ];
  const existing = await stores.locks.shippingDocuments(
    tx,
    context.tenantId,
    ownedIds,
    definitions,
  );
  const verifiedOrigin = await verifyUsDatasetCasesOriginCore(
    tx,
    context,
    cases.intent,
    cases.receipt,
    "replay",
    stores,
  );
  // These unit stages are retained FOR UPDATE above. Cases and Transformation
  // independently check their full dependency identities (including revisions,
  // intents and receipts); bind the returned checked values to these exact rows.
  equal(verifiedOrigin.receiving, parseUsDatasetReceivingResult(receiving.receipt.result));
  equal(verifiedOrigin.transformation, origin);
  if (phase === "application") {
    if (
      existing.some((doc) =>
        definitions.some(
          (row) =>
            doc.type === row.type && doc.number === row.number && doc.partyId === row.partyId,
        ),
      )
    )
      throw fail();
    equal(await readCurrentShippingBalance(tx, context.tenantId, input.outputLotId), {
      state: "known",
      unitOfMeasure: "case",
      supply: input.chain.transformation.output.quantity,
      used: "0",
      remaining: input.chain.transformation.output.quantity,
    });
  }
  return { input, intent, shipping, references, receiving, transformation, cases, verifiedOrigin };
}
