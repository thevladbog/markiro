import { sql } from "drizzle-orm";
import type { Db } from "@markiro/db";
import { platformUuidSchema } from "@markiro/platform-contracts";

type WorkflowLockExecutor = Pick<Db, "execute">;

export type BillingIdempotencyLockKind = "platform_mutation" | "tenant_offer_decision";

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

const IDEMPOTENCY_LOCK_NAMESPACES: Record<BillingIdempotencyLockKind, number> = {
  platform_mutation: 0x42494c50,
  tenant_offer_decision: 0x42494c54,
};

export function canonicalBillingUuid(value: string): string {
  return platformUuidSchema.parse(value);
}

export function canonicalBillingResourceId(value: string): string {
  const uuid = platformUuidSchema.safeParse(value);
  return uuid.success ? uuid.data : value;
}

/**
 * Acquire this before any billing workflow resource locks. PostgreSQL keeps
 * two-int advisory locks in a key space disjoint from bigint advisory locks,
 * so an injected 64-bit workflow hash collision cannot invert this order.
 */
export async function acquireBillingIdempotencyLock(
  tx: WorkflowLockExecutor,
  kind: BillingIdempotencyLockKind,
  resource: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${IDEMPOTENCY_LOCK_NAMESPACES[kind]}::integer, hashtext(${resource}))`,
  );
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

export function postgresUniqueConstraint(error: unknown): string | null {
  let current: unknown = error;
  const visited = new Set<object>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "23505" && typeof record.constraint === "string") {
      return record.constraint;
    }
    current = record.cause;
  }
  return null;
}
