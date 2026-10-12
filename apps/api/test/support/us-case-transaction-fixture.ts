import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { TransformationFinalizedRecord } from "@markiro/platform-contracts";
import { UsCaseStore } from "../../src/modules/traceability/cases/us-case-store";
import type { UsMasterDataTransaction } from "../../src/modules/traceability/master-data/us-master-data-support";
import type { UsTransformationStore } from "../../src/modules/traceability/transformation/us-transformation-store";
import type { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";
import { seedFinalizableTransformation } from "./us-transformation-finalization-fixture";

export type CaseTransactionFixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
export type CaseTransactionTarget = Readonly<{
  tenant: string;
  actor: string;
  product: string;
  lotId: string;
  finalized: TransformationFinalizedRecord;
  transformationStore: UsTransformationStore;
  caseStore: UsCaseStore;
}>;

export async function seedCaseTransactionTarget(
  f: CaseTransactionFixture,
): Promise<CaseTransactionTarget> {
  const c = await seedFinalizableTransformation(f);
  const finalized = await c.store.finalize(
    c.tenant,
    c.actor,
    c.saved.id,
    c.command,
    "case-native-origin",
  );
  const output = finalized.snapshot.outputs[0];
  if (finalized.snapshot.outputs.length !== 1 || !output?.lotId)
    throw new Error("Expected exactly one finalized output lot");
  return {
    tenant: c.tenant,
    actor: c.actor,
    product: c.product,
    lotId: output.lotId,
    finalized,
    transformationStore: c.store,
    caseStore: new UsCaseStore(f.db),
  };
}

export async function insertCaseTransactionSupport(
  tx: UsMasterDataTransaction,
  target: CaseTransactionTarget,
  ssccs: readonly string[],
  shiftSequence: number,
): Promise<readonly Readonly<{ id: string; sscc: string }>[]> {
  if (!Number.isSafeInteger(shiftSequence) || shiftSequence < 1)
    throw new Error("Expected a positive unique shift sequence");
  const shiftId = randomUUID();
  await tx.insert(schema.shifts).values({
    id: shiftId,
    tenantId: target.tenant,
    productId: target.product,
    mode: "aggregation",
    numberMonthKey: "SEP26",
    numberSeq: shiftSequence,
  });
  const boxes = ssccs.map((sscc) => ({
    id: randomUUID(),
    tenantId: target.tenant,
    shiftId,
    deviceBoxId: randomUUID(),
    sscc,
    terminalId: null,
    operatorId: null,
  }));
  await tx.insert(schema.boxes).values(boxes);
  await tx.insert(schema.traceabilitySyntheticCaseOrigins).values(
    boxes.map((box) => ({
      tenantId: target.tenant,
      boxId: box.id,
      seedId: "us-case-transaction-fixture",
      seedVersion: 1,
    })),
  );
  return boxes.map(({ id, sscc }) => ({ id, sscc }));
}
