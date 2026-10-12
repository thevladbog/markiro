import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";

/** Trusted internal callbacks; use only the journal's guarded transaction. */
export type UsDatasetAtomicStageWork = Readonly<{
  apply(
    tx: UsDemoTransaction,
    context: UsDatasetContext,
    intent: UsDatasetIntent,
  ): Promise<UsDatasetReceipt>;
  verify(
    tx: UsDemoTransaction,
    context: UsDatasetContext,
    intent: UsDatasetIntent,
    receipt: UsDatasetReceipt,
  ): Promise<void>;
}>;
