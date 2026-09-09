import { schema } from "@markiro/db";
import { and, asc, eq, ne } from "drizzle-orm";
import type { DbTx, ImportActor } from "./national-catalog-import.types";

/** Caller holds subscription and session locks. Never rewrites accepted evidence. */
export async function cancelAcceptedImportWork(tx: DbTx, actor: ImportActor, sessionId: string) {
  const operations = schema.nationalCatalogImportOperations;
  const receipts = schema.nationalCatalogImportOperationItems;
  const now = new Date();
  const rows = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.tenantId, actor.tenantId),
        eq(operations.sessionId, sessionId),
        ne(operations.state, "cancelled"),
      ),
    )
    .orderBy(asc(operations.id))
    .for("update");
  for (const operation of rows) {
    const items = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, actor.tenantId), eq(receipts.operationId, operation.id)))
      .orderBy(asc(receipts.id))
      .for("update");
    const unfinished = items.filter(
      (item) =>
        item.productResult === "pending" ||
        (item.productResult === "failed" && item.errorCode === "infrastructure_failure") ||
        item.imageRetryEligible,
    );
    if (operation.state === "finished" && !unfinished.length) continue;
    for (const item of unfinished) {
      const core =
        item.productResult === "pending" ||
        (item.productResult === "failed" && item.errorCode === "infrastructure_failure");
      await tx
        .update(receipts)
        .set({
          ...(core
            ? { productResult: "cancelled" as const, errorCode: "import_operation_cancelled" }
            : {}),
          ...(item.imageResult === "pending"
            ? { imageResult: "failed" as const, imageErrorCode: "import_operation_cancelled" }
            : {}),
          imageRetryEligible: false,
          nextAttemptAt: null,
          nextImageAttemptAt: null,
          updatedAt: now,
        })
        .where(and(eq(receipts.tenantId, actor.tenantId), eq(receipts.id, item.id)));
    }
    await tx
      .update(operations)
      .set({
        state: "cancelled",
        cancelledAt: now,
        finishedAt: now,
        enqueuePending: false,
        updatedAt: now,
      })
      .where(and(eq(operations.tenantId, actor.tenantId), eq(operations.id, operation.id)));
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: actor.tenantId,
      actorUserId: actor.userId,
      action: "national_catalog.import.cancelled",
      outcome: "success",
      targetType: "national_catalog_import_operation",
      targetId: operation.id,
      before: { state: operation.state },
      after: {
        sessionId,
        operationId: operation.id,
        state: "cancelled",
        stoppedPreviewIds: unfinished.map((item) => item.previewId),
      },
    });
  }
}
