import { schema } from "@markiro/db";
import { canonicalExportDigest, US_CAPABILITY } from "@markiro/domain";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { lockCaseOperation } from "../cases/us-case-operations.js";
import { lockShippingOperation } from "../shipping/us-shipping-draft.js";
import { readCurrentShippingBalance } from "../shipping/us-shipping-balance.js";
import { lockTransformationOperation } from "../transformation/us-transformation-operations.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetIntent,
  type UsDatasetReceipt,
} from "./us-dataset-contract.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import {
  makeUsDatasetCorrectedShippingInput,
  parseUsDatasetCorrectedShippingInput,
  makeUsDatasetCorrectedShippingPlan,
} from "./us-dataset-corrected-shipping-contract.js";
import {
  datasetCorrectedShippingError,
  parseUsDatasetCorrectedShippingResult,
} from "./us-dataset-corrected-shipping-result.js";
import { parseUsDatasetCorrectedTransformationResult } from "./us-dataset-corrected-transformation-result.js";
import { verifyUsDatasetCorrectedCasesCore } from "./us-dataset-corrected-cases-verify.js";
import { lockUsDatasetCorrectedShipping } from "./us-dataset-corrected-shipping-locks.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { usDatasetShippingOperationKey } from "./us-dataset-shipping-contract.js";
import type { UsDatasetShippingStores } from "./us-dataset-shipping-prepare.js";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { parseUsDatasetSpecialResult } from "./us-dataset-special-contract.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetCorrectedTerminalDependencies } from "./us-dataset-terminal-read-contract.js";

export function freshUsDatasetCorrectedTerminalDependencies(
  stores: UsDatasetShippingStores,
): UsDatasetCorrectedTerminalDependencies {
  const fresh = freshUsDatasetTerminalDependencies(stores);
  return {
    ...fresh,
    locks: {
      ...fresh.locks,
      correctedShipping: lockUsDatasetCorrectedShipping,
      correctedReferences: lockUsDatasetCorrectedReferences,
      correctedDocuments: lockUsDatasetCorrectedDocuments,
    },
  };
}

export async function authorizeUsDatasetCorrectedShipping(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  stores: UsDatasetShippingStores,
) {
  return authorizeUsDatasetCorrectedShippingCore(
    tx,
    context,
    freshUsDatasetCorrectedTerminalDependencies(stores),
  );
}

export async function authorizeUsDatasetCorrectedShippingCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  stores: UsDatasetCorrectedTerminalDependencies,
) {
  const header = await stores.journal.readHeaderInTransaction(tx, context);
  await stores.authorize(tx, context.tenantId, context.actorUserId, US_CAPABILITY.SHIPPING_WRITE);
  if (!header)
    throw datasetCorrectedShippingError("us_dataset_corrected_shipping_prerequisite_incomplete");
  return header.id;
}

export async function readUsDatasetCorrectedShippingInput(
  journal: UsDatasetJournalStore,
  context: UsDatasetContext,
  datasetId: string,
) {
  const references = await journal.readStage(context, datasetId, "references", "references");
  const amendment = await journal.readStage(
    context,
    datasetId,
    "correction_0001",
    "amend_receiving",
  );
  const transformation = await journal.readStage(
    context,
    datasetId,
    "correction_0001",
    "transformation",
  );
  const cases = await journal.readStage(context, datasetId, "correction_0001", "cases");
  if (!references?.receipt || !amendment?.receipt || !transformation?.receipt || !cases?.receipt)
    throw datasetCorrectedShippingError("us_dataset_corrected_shipping_prerequisite_incomplete");
  return makeUsDatasetCorrectedShippingInput(
    makeUsDatasetReferenceIdentity(datasetId, references),
    amendment,
    transformation,
    cases,
  );
}

export async function prepareUsDatasetCorrectedShipping(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  phase: Readonly<{ mode: "application" | "fresh" | "replay"; receipt?: UsDatasetReceipt }>,
  stores: UsDatasetShippingStores,
) {
  return prepareUsDatasetCorrectedShippingCore(
    tx,
    context,
    rawIntent,
    phase,
    freshUsDatasetCorrectedTerminalDependencies(stores),
  );
}

export async function prepareUsDatasetCorrectedShippingCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  rawIntent: UsDatasetIntent,
  phase: Readonly<{ mode: "application" | "fresh" | "replay"; receipt?: UsDatasetReceipt }>,
  stores: UsDatasetCorrectedTerminalDependencies,
) {
  const datasetId = await authorizeUsDatasetCorrectedShippingCore(tx, context, stores);
  const fail = () => datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
  const equal = (a: unknown, b: unknown) => {
    if (canonicalExportDigest(a) !== canonicalExportDigest(b)) throw fail();
  };
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":us-processor-demo-v1"}, 0))`,
  );
  const h = schema.traceabilityDemoDatasets,
    s = schema.traceabilityDemoDatasetStages;
  await tx
    .select({ id: h.id })
    .from(h)
    .where(and(eq(h.tenantId, context.tenantId), eq(h.id, datasetId)))
    .for("update");
  await tx
    .select({ id: s.unitKey })
    .from(s)
    .where(
      and(
        eq(s.tenantId, context.tenantId),
        eq(s.datasetId, datasetId),
        eq(s.unitKey, "correction_0001"),
      ),
    )
    .orderBy(asc(s.stage))
    .for("update");
  const [references, original, amendment, transformation, cases, shipping] =
    await stores.journal.readStagesInTransaction(tx, context, datasetId, [
      { unitKey: "references", stage: "references" },
      { unitKey: "correction_0001", stage: "receiving" },
      { unitKey: "correction_0001", stage: "amend_receiving" },
      { unitKey: "correction_0001", stage: "transformation" },
      { unitKey: "correction_0001", stage: "cases" },
      { unitKey: "correction_0001", stage: "shipping" },
    ]);
  if (
    !references?.receipt ||
    !original?.receipt ||
    !amendment?.receipt ||
    !transformation?.receipt ||
    !cases?.receipt ||
    !shipping
  )
    throw datasetCorrectedShippingError("us_dataset_corrected_shipping_prerequisite_incomplete");
  const intent = parseUsDatasetIntent(rawIntent),
    input = parseUsDatasetCorrectedShippingInput(intent.input);
  equal(intent, shipping.intent);
  equal(intent.unitKey, "correction_0001");
  equal(intent.stage, "shipping");
  equal(intent.inputDigest, canonicalExportDigest(input));
  equal(
    input,
    makeUsDatasetCorrectedShippingInput(
      makeUsDatasetReferenceIdentity(datasetId, references),
      amendment,
      transformation,
      cases,
    ),
  );
  const origin = parseUsDatasetCorrectedTransformationResult(transformation.receipt.result);
  await lockCaseOperation(tx, context.tenantId, "case.link", cases.intent.operationKey);
  for (const command of ["transformation.create", "transformation.finalize"] as const)
    await lockTransformationOperation(
      tx,
      context.tenantId,
      command,
      transformation.intent.operationKey,
    );
  for (const row of makeUsDatasetCorrectedShippingPlan(input)) {
    const key = usDatasetShippingOperationKey(intent.operationKey, row.shipmentNo);
    for (const command of ["shipping.create", "shipping.finalize"] as const) {
      const operation = await lockShippingOperation(tx, context.tenantId, command, key);
      if (phase.mode === "application" && operation) throw fail();
    }
  }
  let receipt = shipping.receipt;
  if (phase.mode === "fresh") {
    if (shipping.receipt || shipping.revision !== 1 || !phase.receipt) throw fail();
    receipt = parseUsDemoReceipt(phase.receipt);
  } else if (phase.mode === "replay") {
    if (!shipping.receipt || !phase.receipt) throw fail();
    equal(phase.receipt, shipping.receipt);
  } else if (shipping.receipt) throw fail();
  const known = receipt ? parseUsDatasetCorrectedShippingResult(receipt.result) : null;
  if (known) equal(known.input, input);
  await stores.locks.correctedShipping(tx, context, origin, known);
  const bindings = parseUsDatasetReferenceResult(references.receipt.result).bindings;
  await stores.locks.correctedReferences(tx, context.tenantId, bindings);
  const numbers = makeUsDatasetCorrectedShippingPlan(input).flatMap(({ references }) => references);
  const definitions = input.chain.documents
    .filter(({ input }) => numbers.includes(input.number))
    .map((row) => {
      const partyId = bindings.parties.find(({ key }) => key === row.partyKey)?.id;
      if (!partyId) throw fail();
      return { type: row.input.type, number: row.input.number, partyId };
    });
  const lifecycle = parseUsDatasetSpecialResult(amendment.receipt.result);
  if (lifecycle.stage !== "amend_receiving") throw fail();
  const originalResult = parseUsDatasetSpecialResult(original.receipt.result);
  if (originalResult.stage !== "receiving") throw fail();
  const ids = [
    ...originalResult.documents.map(({ record }) => record.id),
    ...origin.documents.map(({ record }) => record.id),
    ...(known?.shipments.flatMap(({ documents }) => documents.map(({ record }) => record.id)) ??
      []),
  ];
  const existing = await stores.locks.correctedDocuments(tx, context.tenantId, ids, definitions);
  await verifyUsDatasetCorrectedCasesCore(
    tx,
    context,
    cases.intent,
    cases.receipt,
    "replay",
    stores,
  );
  if (phase.mode === "application") {
    if (
      existing.some((doc) =>
        definitions.some(
          (row) =>
            doc.type === row.type && doc.number === row.number && doc.partyId === row.partyId,
        ),
      )
    )
      throw fail();
    equal(await readCurrentShippingBalance(tx, context.tenantId, input.casesInput.outputLotId), {
      state: "known",
      unitOfMeasure: "case",
      supply: "60",
      used: "0",
      remaining: "60",
    });
  }
  return { input, intent, shipping, references, origin, bindings };
}

/** Original corrected reference SHARE plan, including its exact cardinality checks. */
export async function lockUsDatasetCorrectedReferences(
  tx: UsDemoTransaction,
  tenantId: string,
  bindings: ReturnType<typeof parseUsDatasetReferenceResult>["bindings"],
) {
  const fail = () => datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
  const parties: { id: string }[] = [];
  for (const [table, owned] of [
    [schema.traceabilityParties, bindings.parties],
    [schema.traceabilityLocations, bindings.locations],
    [schema.products, bindings.products],
  ] as const) {
    const shares = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.tenantId, tenantId),
          inArray(
            table.id,
            owned.map(({ id }) => id),
          ),
        ),
      )
      .orderBy(asc(table.id))
      .for("share");
    if (shares.length !== owned.length) throw fail();
    if (table === schema.traceabilityParties) parties.push(...shares);
  }
  const profiles = schema.productTraceabilityProfiles;
  const shares = await tx
    .select({ id: profiles.productId })
    .from(profiles)
    .where(
      and(
        eq(profiles.tenantId, tenantId),
        inArray(
          profiles.productId,
          bindings.products.map(({ id }) => id),
        ),
      ),
    )
    .orderBy(asc(profiles.productId))
    .for("share");
  if (shares.length !== bindings.products.length) throw fail();
  return { parties };
}

/** Partial selected rows are lock evidence only, never full document values. */
export async function lockUsDatasetCorrectedDocuments(
  tx: UsDemoTransaction,
  tenantId: string,
  ids: readonly string[],
  definitions: readonly {
    type: (typeof schema.referenceDocuments.$inferSelect)["type"];
    number: string;
    partyId: string;
  }[],
) {
  const docs = schema.referenceDocuments;
  return tx
    .select({ id: docs.id, type: docs.type, number: docs.number, partyId: docs.partyId })
    .from(docs)
    .where(
      and(
        eq(docs.tenantId, tenantId),
        or(
          inArray(docs.id, ids),
          ...definitions.map((row) =>
            and(
              eq(docs.type, row.type),
              eq(docs.number, row.number),
              eq(docs.partyId, row.partyId),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(docs.id))
    .for("share");
}
