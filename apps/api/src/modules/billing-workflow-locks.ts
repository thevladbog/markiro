import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";
import { platformUuidSchema } from "@markiro/platform-contracts";

type WorkflowLockExecutor = Pick<Db, "execute">;

export interface BillingWorkflowResource {
  kind:
    | "act"
    | "act_number"
    | "invoice"
    | "invoice_number"
    | "offer"
    | "offer_family"
    | "offer_number"
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
  offer_number: "25",
  invoice_number: "26",
  invoice: "30",
  act: "40",
  ordered_service: "50",
  payment: "35",
  payment_key: "60",
  request: "90",
};

const GLOBAL_RESOURCE_KINDS = new Set<BillingWorkflowResource["kind"]>([
  "act_number",
  "invoice_number",
  "offer_number",
  "payment_key",
]);

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
  const keys = billingWorkflowResourceKeys(tenantId, resources);
  if (keys.length === 0) return;
  const keyParameters = sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  );
  const hashed = await tx.execute<{ identity: string }>(sql`
    select hashtextextended(resource, 0)::text as identity
    from unnest(array[${keyParameters}]::text[]) as resource
  `);
  const identities = sortAndDedupeBillingLockIdentities(
    hashed.rows.map(({ identity }) => BigInt(identity)),
  );
  for (const identity of identities) {
    await tx.execute(sql`select pg_advisory_xact_lock(${identity.toString()}::bigint)`);
  }
}

export function billingWorkflowResourceKeys(
  tenantId: string,
  resources: readonly BillingWorkflowResource[],
): string[] {
  return [
    ...new Set(
      resources.map(({ kind, id }) => {
        const scope = GLOBAL_RESOURCE_KINDS.has(kind) ? "global" : `tenant:${tenantId}`;
        return `billing-workflow:${RESOURCE_RANK[kind]}:${scope}:${kind}:${canonicalBillingResourceId(id)}`;
      }),
    ),
  ].sort();
}

export function sortAndDedupeBillingLockIdentities(identities: readonly bigint[]): bigint[] {
  return [...new Set(identities)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
