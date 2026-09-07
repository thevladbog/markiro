import { createHash } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { ConflictException } from "@nestjs/common";
import {
  receivingOperationReceiptV2Schema,
  type ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { unavailable } from "./us-receiving-persistence";

type Command = ReceivingOperationReceiptV2["command"];
export function receivingLifecycleCommandDigest(command: Command, eventId: string, input: unknown) {
  return createHash("sha256")
    .update(JSON.stringify({ commandVersion: 2, command, eventId, input }))
    .digest("hex");
}

/** Authorization belongs before this lock, including on successful replay. */
export async function lockReceivingOperation(
  tx: UsMasterDataTransaction,
  tenantId: string,
  command: Command,
  operationKey: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["us-receiving", tenantId, command, operationKey])}, 0))`,
  );
  const operations = schema.receivingOperations;
  const [receipt] = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.tenantId, tenantId),
        eq(operations.command, command),
        eq(operations.operationKey, operationKey),
      ),
    );
  return receipt;
}

export function replayReceivingLifecycle(
  stored: typeof schema.receivingOperations.$inferSelect,
  command: "receiving.amend" | "receiving.void" | "receiving.save" | "receiving.finalize",
  eventId: string,
  operationKey: string,
  inputDigest: string,
): ReceivingOperationReceiptV2 {
  if (stored.inputDigest !== inputDigest)
    throw new ConflictException({ code: "receiving_operation_conflict" });
  const parsed = receivingOperationReceiptV2Schema.safeParse(stored.result);
  if (!parsed.success) throw unavailable();
  const receipt = parsed.data;
  if (
    receipt.command !== command ||
    receipt.operationKey !== operationKey ||
    receipt.inputDigest !== inputDigest ||
    receipt.eventId !== stored.eventId ||
    (command === "receiving.amend"
      ? receipt.record.lifecycle.previousRevisionId !== eventId
      : receipt.eventId !== eventId)
  )
    throw unavailable();
  return receipt;
}

function retryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error.code === "40001" || error.code === "40P01")) return true;
  return "cause" in error && retryable(error.cause);
}

/** Same bounded retry policy as the original finalizer; each retry reauthorizes. */
export async function receivingTransaction<T>(
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
