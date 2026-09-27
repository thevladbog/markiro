import { createHash } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { ConflictException } from "@nestjs/common";
import { transformationDraftRecordSchema } from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "./us-transformation-persistence";

export type TransformationCommand =
  | "transformation.create"
  | "transformation.save"
  | "transformation.finalize"
  | "transformation.amend"
  | "transformation.void";
export function transformationCommandDigest(
  command: TransformationCommand,
  input: unknown,
  eventId?: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        commandVersion: 1,
        command,
        ...(eventId === undefined ? {} : { eventId }),
        input,
      }),
    )
    .digest("hex");
}
export async function lockTransformationOperation(
  tx: UsMasterDataTransaction,
  tenantId: string,
  command: TransformationCommand,
  operationKey: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["us-transformation", tenantId, command, operationKey])},0))`,
  );
  const table = schema.transformationOperations;
  const [stored] = await tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.tenantId, tenantId),
        eq(table.command, command),
        eq(table.operationKey, operationKey),
      ),
    );
  return stored;
}
export function replayTransformationDraft(
  stored: typeof schema.transformationOperations.$inferSelect,
  digest: string,
  eventId?: string,
) {
  if (stored.inputDigest !== digest)
    throw new ConflictException({ code: "transformation_operation_conflict" });
  const result = transformationDraftRecordSchema.safeParse(stored.result);
  if (
    !result.success ||
    result.data.id !== stored.eventId ||
    (eventId !== undefined && result.data.id !== eventId)
  )
    throw unavailable();
  return result.data;
}
function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error.code === "40001" || error.code === "40P01")) return true;
  if (
    "code" in error &&
    error.code === "23505" &&
    "table" in error &&
    error.table === "transformation_operations" &&
    "constraint" in error &&
    error.constraint === "transformation_operations_tenant_id_command_operation_key_pk"
  )
    return true;
  return "cause" in error && retryable(error.cause);
}
/** Restart the whole authorization/command boundary when the snapshot cannot see a winner. */
export async function transformationTransaction<T>(
  db: Db,
  run: (tx: UsMasterDataTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(run, { isolationLevel: "repeatable read" });
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === 2) throw unavailable();
    }
  }
  throw unavailable();
}
