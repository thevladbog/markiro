import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";

/** Optional native-owner hook: caller transaction, no second connection. */
export interface EvidenceTransactionHook<T> {
  before(tx: SubscriptionTransaction): Promise<void>;
  after(tx: SubscriptionTransaction, result: T): Promise<void>;
}
export async function withEvidenceTransaction<T>(
  tx: SubscriptionTransaction,
  hook: EvidenceTransactionHook<T> | undefined,
  work: () => Promise<T>,
): Promise<T> {
  await hook?.before(tx);
  const result = await work();
  await hook?.after(tx, result);
  return result;
}
