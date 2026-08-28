import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";
import { platformUuidSchema } from "@markiro/platform-contracts";

type WorkflowLockExecutor = Pick<Db, "execute">;

export interface BillingWorkflowResource {
  kind:
    | "act"
    | "act_number"
    | "invoice"
    | "offer"
    | "offer_family"
    | "ordered_service"
    | "payment"
    | "payment_key"
    | "request";
  id: string;
}

const RESOURCE_RANK: Record<BillingWorkflowResource["kind"], string> = {
  act_number: "05",
  offer_family: "10",
  offer: "20",
  invoice: "30",
  act: "40",
  ordered_service: "50",
  payment: "35",
  payment_key: "60",
  request: "90",
};

export function canonicalBillingUuid(value: string): string {
  return platformUuidSchema.parse(value);
}

export function canonicalBillingResourceId(value: string): string {
  const uuid = platformUuidSchema.safeParse(value);
  return uuid.success ? uuid.data : value;
}

export async function acquireBillingWorkflowLocks(
  tx: WorkflowLockExecutor,
  tenantId: string,
  resources: readonly BillingWorkflowResource[],
): Promise<void> {
  const keys = [
    ...new Set(
      resources.map(
        ({ kind, id }) =>
          `billing-workflow:${tenantId}:${RESOURCE_RANK[kind]}:${kind}:${canonicalBillingResourceId(id)}`,
      ),
    ),
  ].sort();
  for (const key of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
