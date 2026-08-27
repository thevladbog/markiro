import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

type BillingMutationExecutor = Pick<Db, "execute" | "select" | "insert" | "update">;
type BillingMutationRow = typeof schema.platformBillingMutationIdempotency.$inferSelect;

export interface PlatformBillingMutationSpec {
  tenantId: string;
  idempotencyKey: string;
  operation: string;
  targetId: string;
  payload: unknown;
  actorPlatformUserId: string;
}

export type PlatformBillingMutationStart =
  | { kind: "new"; row: BillingMutationRow }
  | { kind: "pending"; row: BillingMutationRow }
  | { kind: "committed"; row: BillingMutationRow; result: unknown };

export async function beginPlatformBillingMutation(
  tx: BillingMutationExecutor,
  spec: PlatformBillingMutationSpec,
): Promise<PlatformBillingMutationStart> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`platform-billing:${spec.tenantId}:${spec.idempotencyKey}`}, 0))`,
  );
  const payloadHash = platformBillingPayloadHash(spec.payload);
  const [existing] = await tx
    .select()
    .from(schema.platformBillingMutationIdempotency)
    .where(
      and(
        eq(schema.platformBillingMutationIdempotency.tenantId, spec.tenantId),
        eq(schema.platformBillingMutationIdempotency.idempotencyKey, spec.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.operation !== spec.operation ||
      existing.targetId !== spec.targetId ||
      existing.payloadHash !== payloadHash
    ) {
      throw new ConflictException({ code: "idempotency_key_reused" });
    }
    return existing.state === "committed"
      ? { kind: "committed", row: existing, result: existing.result }
      : { kind: "pending", row: existing };
  }
  const [created] = await tx
    .insert(schema.platformBillingMutationIdempotency)
    .values({
      tenantId: spec.tenantId,
      idempotencyKey: spec.idempotencyKey,
      operation: spec.operation,
      targetId: spec.targetId,
      payloadHash,
      actorPlatformUserId: spec.actorPlatformUserId,
    })
    .returning();
  if (!created) throw new Error("platform billing mutation intent insert failed");
  return { kind: "new", row: created };
}

export async function commitPlatformBillingMutation(
  tx: Pick<Db, "update">,
  rowId: string,
  resultId: string,
  result: unknown,
): Promise<void> {
  const [committed] = await tx
    .update(schema.platformBillingMutationIdempotency)
    .set({
      state: "committed",
      resultId,
      result,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.platformBillingMutationIdempotency.id, rowId),
        eq(schema.platformBillingMutationIdempotency.state, "pending"),
      ),
    )
    .returning({ id: schema.platformBillingMutationIdempotency.id });
  if (!committed) throw new Error("platform billing mutation commit failed");
}

export function platformBillingPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite billing payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Cannot hash unsupported billing payload");
}
