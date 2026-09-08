import { ConflictException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "./us-receiving-history";
import { unavailable } from "./us-receiving-persistence";

/** Caller has authorized, checked historical replay and locked this root first. */
export async function assertOriginalReceivingWriteTarget(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
): Promise<void> {
  const events = schema.traceabilityEvents;
  const [locked] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
    .for("update");
  if (!locked) throw unavailable();
  // Validate the real lifecycle before choosing a conflict. Legacy revision-1
  // parsers must neither reinterpret history nor turn valid terminal rows into 503.
  const record = await readReceivingLiveRecord(tx, tenantId, eventId);
  if (record.revision !== 1 || record.status === "amended" || record.status === "void")
    throw new ConflictException({
      code: "receiving_lifecycle_conflict",
      rootId: record.lifecycle.rootId,
      lifecycleVersion: record.lifecycle.lifecycleVersion,
      currentEventId: record.lifecycle.currentEventId,
      pendingDraftId: record.lifecycle.pendingDraftId,
    });
  // Preserve the existing original-command conflict for a current finalized
  // original, including one already written by the internal v3 finalizer.
  if (record.status === "finalized")
    throw new ConflictException({ code: "receiving_already_finalized" });
}
