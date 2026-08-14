import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { shiftCloseReasonRequired, isShiftCloseReasonCode } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import type {
  ShiftCloseConflictListDto,
  StationShiftCloseDto,
  StationShiftCloseResponseDto,
} from "./dto";

@Injectable()
export class StationShiftCloseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: SecurityAuditService,
  ) {}

  async closeStationShift(
    tenantId: string,
    deviceId: string,
    input: StationShiftCloseDto,
  ): Promise<StationShiftCloseResponseDto> {
    const normalized = {
      eventId: input.eventId,
      shiftId: input.shiftId,
      operatorId: input.operatorId ?? null,
      plannedQtySnapshot: input.plannedQtySnapshot,
      actualQty: input.actualQty,
      closedBoxCount: input.closedBoxCount,
      reasonCode: input.reasonCode ?? null,
      closedAt: input.closedAt.toISOString(),
    };
    const payloadDigest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

    const result = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ digest: schema.stationShiftCloseEvents.payloadDigest, outcome: schema.stationShiftCloseEvents.outcome })
        .from(schema.stationShiftCloseEvents)
        .where(and(eq(schema.stationShiftCloseEvents.tenantId, tenantId), eq(schema.stationShiftCloseEvents.eventId, input.eventId)))
        .for("update");
      if (existing) {
        if (existing.digest !== payloadDigest) throw new ConflictException("Close event payload changed");
        return existing.outcome === "conflict"
          ? ({ outcome: "conflict", conflictCode: "multiple_devices" } as const)
          : ({ outcome: "already_resolved" } as const);
      }

      const [shift] = await tx
        .select({
          id: schema.shifts.id,
          status: schema.shifts.status,
          plannedQty: schema.shifts.plannedQty,
          stationClosePolicy: schema.shifts.stationClosePolicy,
        })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, input.shiftId)))
        .for("update");
      if (!shift) throw new NotFoundException();
      if (shiftCloseReasonRequired(shift.plannedQty, input.actualQty)) {
        if (!input.reasonCode || !isShiftCloseReasonCode(input.reasonCode)) {
          throw new ConflictException("A valid close reason is required");
        }
      }

      const participants = await tx
        .select({ deviceId: schema.shiftDeviceParticipants.deviceId })
        .from(schema.shiftDeviceParticipants)
        .where(and(eq(schema.shiftDeviceParticipants.tenantId, tenantId), eq(schema.shiftDeviceParticipants.shiftId, input.shiftId)));
      const multipleDevices = shift.stationClosePolicy === "admin_only" || participants.some((p) => p.deviceId !== deviceId);
      const outcome = multipleDevices ? "conflict" : "accepted";
      await tx.insert(schema.stationShiftCloseEvents).values({
        eventId: input.eventId,
        tenantId,
        shiftId: input.shiftId,
        deviceId,
        operatorId: input.operatorId ?? null,
        payloadDigest,
        plannedQtySnapshot: shift.plannedQty,
        actualQty: input.actualQty,
        closedBoxCount: input.closedBoxCount,
        reasonCode: input.reasonCode ?? null,
        closedAt: input.closedAt,
        outcome,
        conflictCode: multipleDevices ? "multiple_devices" : null,
      });
      if (outcome === "accepted" && shift.status === "active") {
        await tx
          .update(schema.shifts)
          .set({ status: "closed", closedAt: input.closedAt, closeReason: input.reasonCode ?? null })
          .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, input.shiftId), eq(schema.shifts.status, "active")));
      }
      return multipleDevices
        ? ({ outcome: "conflict", conflictCode: "multiple_devices" } as const)
        : shift.status === "closed"
          ? ({ outcome: "already_resolved" } as const)
          : ({ outcome: "accepted" } as const);
    });
    this.audit.deviceCredentialMutation({ tenantId, actorType: "unauthenticated_device", actorId: deviceId, action: "station.shift_close", resourceId: input.shiftId, outcome: "succeeded" });
    return result;
  }

  async listConflicts(tenantId: string): Promise<ShiftCloseConflictListDto> {
    const rows = await this.db
      .select({ event: schema.stationShiftCloseEvents, productName: schema.products.name })
      .from(schema.stationShiftCloseEvents)
      .leftJoin(schema.shifts, and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, schema.stationShiftCloseEvents.shiftId)))
      .leftJoin(schema.products, and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, schema.shifts.productId)))
      .where(and(eq(schema.stationShiftCloseEvents.tenantId, tenantId), eq(schema.stationShiftCloseEvents.outcome, "conflict")))
      .orderBy(desc(schema.stationShiftCloseEvents.recordedAt));
    return { items: rows.map(({ event, productName }) => ({ ...event, productName })) };
  }

  async dismissConflict(tenantId: string, eventId: string, userId: string): Promise<void> {
    const [row] = await this.db
      .update(schema.stationShiftCloseEvents)
      .set({ outcome: "dismissed", resolvedAt: new Date(), resolvedBy: userId })
      .where(and(eq(schema.stationShiftCloseEvents.tenantId, tenantId), eq(schema.stationShiftCloseEvents.eventId, eventId), eq(schema.stationShiftCloseEvents.outcome, "conflict")))
      .returning({ eventId: schema.stationShiftCloseEvents.eventId });
    if (!row) throw new NotFoundException();
    this.audit.credentialMutation({ tenantId, userId, action: "station.shift_close_conflict.dismiss", resourceId: eventId, outcome: "succeeded" });
  }
}
