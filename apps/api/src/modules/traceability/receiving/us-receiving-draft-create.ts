import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type {
  ReceivingDraft,
  ReceivingDraftRecord,
  ReceivingLiveRecord,
} from "@markiro/platform-contracts";
import { eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "./us-receiving-history";
import {
  readReceivingDraft,
  receivingHeader,
  replaceReceivingChildren,
  unavailable,
} from "./us-receiving-persistence";
import { assertReceivingReferences } from "./us-receiving-references";
import { createReceivingRoot } from "./us-receiving-roots";

type Format = "legacy" | "versioned";
export function insertReceivingDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  draft: ReceivingDraft,
  requestId: string,
  format: "versioned",
): Promise<ReceivingLiveRecord>;
export function insertReceivingDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  draft: ReceivingDraft,
  requestId: string,
  format: "legacy",
): Promise<ReceivingDraftRecord>;
export function insertReceivingDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  draft: ReceivingDraft,
  requestId: string,
  format: Format,
): Promise<ReceivingDraftRecord | ReceivingLiveRecord>;
/** Caller owns transaction, current authorization/profile locks and operation serialization. */
export async function insertReceivingDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  draft: ReceivingDraft,
  requestId: string,
  format: Format,
): Promise<ReceivingDraftRecord | ReceivingLiveRecord> {
  const events = schema.traceabilityEvents,
    counters = schema.receivingCounters;
  await assertReceivingReferences(tx, tenantId, draft);
  // Authorization holds the organization profile/timezone lock through commit.
  const [profile] = await tx
    .select({ timeZone: schema.orgProfiles.timeZone })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  if (!profile) throw unavailable();
  const now = new Date();
  const year = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: profile.timeZone, year: "numeric" }).format(now),
  );
  const [counter] = await tx
    .insert(counters)
    .values({ tenantId, year, sequence: 1 })
    .onConflictDoUpdate({
      target: [counters.tenantId, counters.year],
      set: { sequence: sql`${counters.sequence} + 1` },
    })
    .returning();
  if (!counter) throw unavailable();
  const eventNumber = `REC-${String(year).slice(-2).padStart(2, "0")}-${String(counter.sequence).padStart(4, "0")}`;
  const eventId = randomUUID();
  await createReceivingRoot(tx, { tenantId, eventId, eventNumber });
  const [header] = await tx
    .insert(events)
    .values({
      ...receivingHeader(draft),
      id: eventId,
      rootEventId: eventId,
      tenantId,
      eventNumber,
      timeZone: profile.timeZone,
      createdBy: actorUserId,
      updatedBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: events.id });
  if (!header) throw unavailable();
  await replaceReceivingChildren(tx, tenantId, eventId, draft);
  const result =
    format === "versioned"
      ? await readReceivingLiveRecord(tx, tenantId, eventId)
      : await readReceivingDraft(tx, tenantId, eventId, "update");
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: tenantId,
    actorUserId,
    action: "traceability.receiving.draft_created",
    outcome: "success",
    targetType: "traceability_event",
    targetId: result.id,
    before: null,
    after: result,
    requestId,
  });
  return result;
}
