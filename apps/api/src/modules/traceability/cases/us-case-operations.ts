import { createHash } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { caseLinkResultSchema, caseUnlinkResultSchema } from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";

export type CaseCommand = "case.link" | "case.unlink";
export const caseUnavailable = () =>
  new ServiceUnavailableException({ code: "us_database_unavailable" });
export function caseCommandDigest(
  command: CaseCommand,
  lotId: string,
  input: { ssccs: readonly string[] } | { linkId: string; reason: string },
) {
  const canonical =
    "ssccs" in input
      ? { ssccs: [...input.ssccs].sort() }
      : { linkId: input.linkId, reason: input.reason };
  return createHash("sha256")
    .update(JSON.stringify({ commandVersion: 1, command, lotId, input: canonical }))
    .digest("hex");
}
export async function lockCaseOperation(
  tx: UsMasterDataTransaction,
  tenantId: string,
  command: CaseCommand,
  operationKey: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["us-case", tenantId, command, operationKey])},0))`,
  );
  const t = schema.traceLotBoxOperations;
  const [stored] = await tx
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.command, command), eq(t.operationKey, operationKey)));
  return stored;
}
type StoredOperation = typeof schema.traceLotBoxOperations.$inferSelect;
function checkDigest(stored: StoredOperation, digest: string) {
  if (stored.inputDigest !== digest)
    throw new ConflictException({ code: "case_operation_conflict" });
}
export function replayCaseLink(stored: StoredOperation, digest: string, lotId: string) {
  checkDigest(stored, digest);
  const result = caseLinkResultSchema.safeParse(stored.result);
  if (
    !result.success ||
    stored.targetId !== lotId ||
    result.data.lotId !== lotId ||
    [...result.data.created, ...result.data.unchanged].some((row) => row.lotId !== lotId)
  )
    throw caseUnavailable();
  return result.data;
}
export function replayCaseUnlink(
  stored: StoredOperation,
  digest: string,
  lotId: string,
  linkId: string,
) {
  checkDigest(stored, digest);
  const result = caseUnlinkResultSchema.safeParse(stored.result);
  if (
    !result.success ||
    stored.targetId !== linkId ||
    result.data.linkId !== linkId ||
    result.data.lotId !== lotId
  )
    throw caseUnavailable();
  return result.data;
}
function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error.code === "40001" || error.code === "40P01")) return true;
  if (
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    (error.constraint === "trace_lot_box_operations_tenant_id_command_operation_key_pk" ||
      error.constraint === "trace_lot_boxes_one_active_box_uq")
  )
    return true;
  return "cause" in error && retryable(error.cause);
}
/** Reauthorize and reacquire all locks on a fresh snapshot after a concurrent winner. */
export async function caseTransaction<T>(
  db: Db,
  run: (tx: UsMasterDataTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(run, { isolationLevel: "repeatable read" });
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt === 2) throw caseUnavailable();
    }
  }
  throw caseUnavailable();
}
