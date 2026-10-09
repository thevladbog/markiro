import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  resolveWarehouseReprintScan,
  applyWarehouseReprintEvent,
  productLabelValueDigest,
  WAREHOUSE_REPRINT_PROTOCOL,
  type WarehouseReprintEvent,
  type WarehouseReprintProjection,
  type WarehouseReprintReceipt,
  type WarehouseReprintRejection,
} from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { assertWarehouseDevice, assertWarehouseOperator } from "./access";
import { WarehouseLookupService } from "./lookup.service";
import { WarehouseTemplatesService } from "./templates.service";
@Injectable()
export class WarehouseEventsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly lookup: WarehouseLookupService,
    private readonly templates: WarehouseTemplatesService,
  ) {}
  async receive(
    tenantId: string,
    deviceId: string,
    events: WarehouseReprintEvent[],
  ): Promise<WarehouseReprintReceipt> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":" + deviceId},0))`,
      );
      await assertWarehouseDevice(tx, tenantId, deviceId);
      const result: WarehouseReprintReceipt = {
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        acceptedEventIds: [],
        quarantined: [],
      };
      for (const event of events) {
        const digest = productLabelValueDigest(event);
        const receiptScope = and(
          eq(schema.warehouseReprintReceipts.tenantId, tenantId),
          eq(schema.warehouseReprintReceipts.deviceId, deviceId),
          eq(schema.warehouseReprintReceipts.eventId, event.eventId),
        );
        const [receipt] = await tx
          .select()
          .from(schema.warehouseReprintReceipts)
          .where(receiptScope);
        let rejection: WarehouseReprintRejection | null = null;
        if (receipt) {
          if (receipt.payloadDigest !== digest)
            throw new ConflictException({ code: "WAREHOUSE_EVENT_REPLAY_MISMATCH" });
          rejection = receipt.rejectionCode as WarehouseReprintRejection | null;
        } else {
          const jobScope = and(
            eq(schema.warehouseReprintJobs.tenantId, tenantId),
            eq(schema.warehouseReprintJobs.deviceId, deviceId),
            eq(schema.warehouseReprintJobs.jobId, event.jobId),
          );
          const [saved] = await tx.select().from(schema.warehouseReprintJobs).where(jobScope);
          try {
            await assertWarehouseOperator(tx, tenantId, event.operatorId);
          } catch (error) {
            if (!(error instanceof ForbiddenException)) throw error;
            rejection = "invalid_operator";
          }
          let projection: WarehouseReprintProjection | null = saved
            ? (saved.projection as unknown as WarehouseReprintProjection)
            : null;
          if (!rejection && !saved) {
            if (event.kind !== "prepared") rejection = "parent_missing";
            else {
              const raw =
                event.sourceKind === "box"
                  ? `00${event.identity}`
                  : await this.unitRaw(tx, tenantId, event.identity);
              const found =
                resolveWarehouseReprintScan(raw).kind === "invalid"
                  ? { status: "not_found" as const }
                  : await this.lookup.lookup(tenantId, deviceId, {
                      protocol: WAREHOUSE_REPRINT_PROTOCOL,
                      operatorId: event.operatorId,
                      raw,
                    });
              if (
                found.status !== "found" ||
                !(await this.sourceMatches(
                  tx,
                  tenantId,
                  found.source.sourceId,
                  event.sourceId,
                  event.identity,
                  event.sourceKind,
                )) ||
                found.source.kind !== event.sourceKind ||
                found.source.identity !== event.identity ||
                found.source.payloadDigest !== event.payloadDigest ||
                found.source.sourceShiftId !== event.sourceShiftId
              )
                rejection = "source_not_printable";
              else {
                const catalog = await this.templates.templates(tenantId, deviceId);
                const t = catalog.templates.find((t) => t.id === event.templateId);
                if (
                  !t ||
                  t.purpose !== (event.sourceKind === "box" ? "box" : "product_duplicate") ||
                  t.digest !== event.templateDigest ||
                  t.revision !== event.templateRevision ||
                  (t.chzProductGroupCodes !== null &&
                    (found.source.chzProductGroupCode === null ||
                      !t.chzProductGroupCodes.includes(found.source.chzProductGroupCode)))
                )
                  rejection = "template_mismatch";
              }
            }
          }
          if (!rejection) {
            if (event.sequence !== (projection?.latestSequence ?? 0) + 1)
              rejection = "sequence_gap";
            else {
              try {
                projection = applyWarehouseReprintEvent(projection, event);
              } catch {
                rejection = "invalid_transition";
              }
            }
          }
          if (!rejection && projection) {
            const prepared = saved?.prepared ?? event;
            if (saved)
              await tx
                .update(schema.warehouseReprintJobs)
                .set({
                  projection: { ...projection },
                  latestSequence: projection.latestSequence,
                  updatedAt: new Date(),
                })
                .where(jobScope);
            else
              await tx.insert(schema.warehouseReprintJobs).values({
                tenantId,
                deviceId,
                jobId: event.jobId,
                prepared: { ...event },
                projection: { ...projection },
                latestSequence: projection.latestSequence,
              });
            await tx.insert(schema.warehouseReprintEvents).values({
              tenantId,
              deviceId,
              eventId: event.eventId,
              jobId: event.jobId,
              sequence: event.sequence,
              operatorId: event.operatorId,
              event: { ...event },
              payloadDigest: digest,
            });
            const initial = prepared as Extract<WarehouseReprintEvent, { kind: "prepared" }>;
            const [attemptStart] =
              event.kind === "prepared" || event.kind === "reprint_prepared"
                ? []
                : await tx
                    .select({ event: schema.warehouseReprintEvents.event })
                    .from(schema.warehouseReprintEvents)
                    .where(
                      and(
                        eq(schema.warehouseReprintEvents.tenantId, tenantId),
                        eq(schema.warehouseReprintEvents.deviceId, deviceId),
                        eq(schema.warehouseReprintEvents.jobId, event.jobId),
                        sql`${schema.warehouseReprintEvents.event}->>'attemptId' = ${event.attemptId}`,
                        sql`${schema.warehouseReprintEvents.event}->>'kind' IN ('prepared','reprint_prepared')`,
                      ),
                    )
                    .limit(1);
            const reason =
              event.kind === "prepared" || event.kind === "reprint_prepared"
                ? event.reason
                : attemptStart?.event.reason;
            if (!reason) throw new Error("WAREHOUSE_ATTEMPT_REASON_MISSING");
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId: null,
              action: `warehouse_label.${event.kind}`,
              outcome: "accepted",
              targetType: "warehouse_label_job",
              targetId: event.jobId,
              after: {
                deviceId,
                operatorId: event.operatorId,
                eventId: event.eventId,
                sequence: event.sequence,
                sourceKind: initial.sourceKind,
                sourceId: initial.sourceId,
                identity: initial.identity,
                sourceRevision: initial.sourceRevision,
                templateId: initial.templateId,
                templateDigest: initial.templateDigest,
                payloadDigest: initial.payloadDigest,
                bytesDigest: initial.bytesDigest,
                repair: initial.repair,
                scanDigest: initial.scanDigest,
                reason,
                attemptId: event.attemptId,
                attemptNo: projection.attemptNo,
              },
            });
          }
          await tx.insert(schema.warehouseReprintReceipts).values({
            tenantId,
            deviceId,
            eventId: event.eventId,
            payloadDigest: digest,
            rejectionCode: rejection,
          });
        }
        if (rejection) result.quarantined.push({ eventId: event.eventId, code: rejection });
        else result.acceptedEventIds.push(event.eventId);
      }
      return result;
    });
  }
  private async sourceMatches(
    tx: Pick<Db, "select">,
    tenantId: string,
    serverId: string,
    sourceId: string,
    identity: string,
    kind: "unit" | "box",
  ): Promise<boolean> {
    if (serverId === sourceId) return true;
    if (kind !== "box") return false;
    const [box] = await tx
      .select({ id: schema.boxes.id })
      .from(schema.boxes)
      .where(
        and(
          eq(schema.boxes.tenantId, tenantId),
          eq(schema.boxes.id, serverId),
          eq(schema.boxes.deviceBoxId, sourceId),
          eq(schema.boxes.sscc, identity),
        ),
      );
    return Boolean(box);
  }
  private async unitRaw(
    tx: Pick<Db, "select">,
    tenantId: string,
    identity: string,
  ): Promise<string> {
    const [code] = await tx
      .select({ raw: schema.codes.canonicalRaw })
      .from(schema.codes)
      .where(and(eq(schema.codes.tenantId, tenantId), eq(schema.codes.codeHash, identity)))
      .limit(1);
    return code?.raw ?? "";
  }
}
