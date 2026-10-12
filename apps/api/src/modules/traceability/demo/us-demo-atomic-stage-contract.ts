import type { Db } from "@markiro/db";
import type {
  UsDemoIntent,
  UsDemoJournalContext,
  UsDemoReceipt,
} from "./us-demo-journal-contract.js";

export type UsDemoTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Trusted internal callbacks; the journal supplies its guarded transaction. */
export type UsDemoAtomicStageWork = Readonly<{
  apply(
    tx: UsDemoTransaction,
    context: UsDemoJournalContext,
    intent: UsDemoIntent,
  ): Promise<UsDemoReceipt>;
  verify(
    tx: UsDemoTransaction,
    context: UsDemoJournalContext,
    intent: UsDemoIntent,
    receipt: UsDemoReceipt,
  ): Promise<void>;
}>;
