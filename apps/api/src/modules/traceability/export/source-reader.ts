import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import {
  platformUuidSchema,
  usExportInputV1Schema,
  type EventPin,
  type ExportMode,
  type ExportSourceRecord,
} from "@markiro/platform-contracts";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  authorizeUsMasterData,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "../receiving/us-receiving-history";
import { readShippingRecord, readShippingRevisions } from "../shipping/us-shipping-history";
import { transformationTransaction } from "../transformation/us-transformation-operations";
import { readTransformationRecord } from "../transformation/us-transformation-persistence";

const pinsSchema = z
  .array(
    z
      .object({ eventId: platformUuidSchema, revision: z.number().int().min(1).max(2147483647) })
      .strict(),
  )
  .min(1)
  .max(500)
  .refine(
    (pins) => new Set(pins.map((pin) => `${pin.eventId}:${pin.revision}`)).size === pins.length,
  );
const unavailable = () => new ServiceUnavailableException({ code: "us_database_unavailable" });
const sourceSchema = usExportInputV1Schema.shape.events.element;

/** Internal explicit selection only; authorization and all source reads share one DB snapshot. */
export async function readUsExportSources(
  db: Db,
  tenantId: string,
  actorUserId: string,
  pins: readonly EventPin[],
  mode: ExportMode,
): Promise<readonly ExportSourceRecord[]> {
  const selected = pinsSchema.safeParse(pins);
  const parsedMode = usExportInputV1Schema.shape.mode.safeParse(mode);
  if (!selected.success || !parsedMode.success)
    throw new BadRequestException({ code: "invalid_us_export_sources" });
  const ordered = selected.data.sort(
    (a, b) => a.eventId.localeCompare(b.eventId) || a.revision - b.revision,
  );
  return transformationTransaction(db, async (tx) => {
    const profile = await authorizeUsMasterData(
      tx,
      tenantId,
      actorUserId,
      US_CAPABILITY.EXPORT_READ,
    );
    if (profile !== "US_FSMA204_PROCESSOR")
      throw new ForbiddenException({ code: "traceability_profile_required" });
    return resolvePinnedEvents(tx, tenantId, ordered, parsedMode.data);
  });
}

async function resolvePinnedEvents(
  tx: UsMasterDataTransaction,
  tenantId: string,
  orderedPins: readonly EventPin[],
  mode: ExportMode,
): Promise<readonly ExportSourceRecord[]> {
  const result: ExportSourceRecord[] = [];
  const events = schema.traceabilityEvents;
  for (const pin of orderedPins) {
    const [identity] = await tx
      .select({ id: events.id, revision: events.revision, type: events.type })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.id, pin.eventId),
          eq(events.revision, pin.revision),
        ),
      );
    if (!identity) throw new NotFoundException({ code: "us_export_source_not_found" });
    // Shipping's content reader also serves legacy operation receipts. Reuse its
    // live root-chain validator so those compatibility rules cannot hide corruption.
    if (identity.type === "shipping")
      await readShippingRevisions(tx, tenantId, identity.id, { limit: 1, offset: 0 });
    const record = await (identity.type === "receiving"
      ? readReceivingLiveRecord(tx, tenantId, identity.id)
      : identity.type === "transformation"
        ? readTransformationRecord(tx, tenantId, identity.id)
        : identity.type === "shipping"
          ? readShippingRecord(tx, tenantId, identity.id)
          : Promise.reject(unavailable()));
    // Receiving v1-v3 lack identity inside their frozen payload. Bind through the
    // tenant/revision-selected header and the validated server-owned live record.
    if (record.id !== identity.id || record.revision !== identity.revision || !record.lifecycle)
      throw unavailable();
    const lifecycle =
      record.status === "finalized"
        ? "current_finalized"
        : record.status === "amended"
          ? "historical_finalized"
          : record.status;
    if (
      mode === "export_ready_candidate" &&
      (lifecycle !== "current_finalized" || record.lifecycle.currentEventId !== identity.id)
    )
      throw new ConflictException({ code: "us_export_source_not_current_finalized" });
    const payload =
      "content" in record
        ? record.content.kind === "finalized"
          ? { kind: "frozen", snapshot: record.content.snapshot }
          : { kind: "saved_draft", draft: record.content.draft }
        : "snapshot" in record
          ? { kind: "frozen", snapshot: record.snapshot }
          : { kind: "saved_draft", draft: record.draft };
    const parsed = sourceSchema.safeParse({
      ...pin,
      timeZone: record.timeZone,
      type: identity.type,
      lifecycle,
      payload,
    });
    if (!parsed.success) throw unavailable();
    result.push(parsed.data);
  }
  return result;
}
