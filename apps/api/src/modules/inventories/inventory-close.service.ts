import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type {
  EmergencyCloseInventoryDto,
  DiscardInventoryLateEventsDto,
  InventoryCloseBlockerDto,
  InventoryCloseDto,
  InventoryCompleteDto,
  InventoryLateEventDto,
  InventoryLateEventsDiscardDto,
  InventoryReopenDto,
  ListInventoryLateEventsQueryDto,
  ListInventoryLateEventsResponseDto,
} from "./dto";

type InventoryTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface LockedInventory {
  id: string;
  status: "draft" | "preparing" | "ready" | "running" | "closed" | "completed";
  resultRevision: number;
}

interface ParticipantBlockerRow {
  participantId: string;
  deviceId: string;
  heartbeatAt: Date | string;
  stale: boolean;
  pendingEventCount: number;
  openBoxCount: number;
}

interface BoxBlockerRow {
  id: string;
  state: "open" | "closed" | "invalidated";
  printState: "not_ready" | "pending" | "printing" | "printed" | "failed";
}

interface DiscrepancyBlockerRow {
  unknown: number;
  ineligible: number;
  dateMismatch: number;
  voided: number;
}

@Injectable()
export class InventoryCloseService {
  constructor(@Inject(DB) private readonly db: Db) {}

  close(tenantId: string, actorUserId: string, inventoryId: string): Promise<InventoryCloseDto> {
    return this.closeUnderLock(tenantId, actorUserId, inventoryId, null);
  }

  emergencyClose(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: EmergencyCloseInventoryDto,
  ): Promise<InventoryCloseDto> {
    return this.closeUnderLock(tenantId, actorUserId, inventoryId, input.reason);
  }

  reopen(tenantId: string, actorUserId: string, inventoryId: string): Promise<InventoryReopenDto> {
    return this.db.transaction(async (tx) => {
      const inventory = await this.lockInventory(tx, tenantId, inventoryId);
      this.assertNotCompleted(inventory);
      if (inventory.status !== "closed") {
        throw new ConflictException({ code: "INVENTORY_REOPEN_REQUIRES_CLOSED" });
      }
      const reopenedAt = new Date();
      const resultRevision = inventory.resultRevision + 1;
      // Task 8 adds document tables and extends this row-locked transaction with
      // the real invalidation update. Before that schema exists the count is
      // necessarily zero; no placeholder artifact evidence is invented here.
      const invalidatedArtifactCount = 0;
      await tx
        .update(schema.inventories)
        .set({
          status: "running",
          resultRevision,
          closedByUserId: null,
          closedAt: null,
          emergencyCloseReason: null,
          emergencyClosedByUserId: null,
          emergencyClosedAt: null,
          updatedAt: reopenedAt,
        })
        .where(
          and(
            eq(schema.inventories.tenantId, tenantId),
            eq(schema.inventories.id, inventoryId),
            eq(schema.inventories.status, "closed"),
          ),
        );
      const authorizedLateEvents = await tx
        .update(schema.inventoryLateEvents)
        .set({
          replayAuthorizedAt: reopenedAt,
          replayAuthorizedByUserId: actorUserId,
          replayAuthorizedRevision: resultRevision,
        })
        .where(
          and(
            eq(schema.inventoryLateEvents.tenantId, tenantId),
            eq(schema.inventoryLateEvents.inventoryId, inventoryId),
            eq(schema.inventoryLateEvents.resolution, "pending"),
          ),
        )
        .returning({ id: schema.inventoryLateEvents.id });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "inventory.reopened",
        outcome: "success",
        targetType: "inventory",
        targetId: inventoryId,
        before: { status: "closed", resultRevision: inventory.resultRevision },
        after: {
          status: "running",
          resultRevision,
          invalidatedArtifactCount,
          replayAuthorizedLateEventCount: authorizedLateEvents.length,
          reopenedAt: reopenedAt.toISOString(),
        },
      });
      return { inventoryId, status: "running", resultRevision, invalidatedArtifactCount };
    });
  }

  complete(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
  ): Promise<InventoryCompleteDto> {
    return this.db.transaction(async (tx) => {
      const inventory = await this.lockInventory(tx, tenantId, inventoryId);
      this.assertNotCompleted(inventory);
      if (inventory.status !== "closed") {
        throw new ConflictException({ code: "INVENTORY_COMPLETE_REQUIRES_CLOSED" });
      }
      const [pendingLateEvent] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.inventoryLateEvents)
        .where(
          and(
            eq(schema.inventoryLateEvents.tenantId, tenantId),
            eq(schema.inventoryLateEvents.inventoryId, inventoryId),
            eq(schema.inventoryLateEvents.resolution, "pending"),
          ),
        );
      if ((pendingLateEvent?.count ?? 0) > 0) {
        throw new ConflictException({
          code: "INVENTORY_LATE_EVENTS_UNRESOLVED",
          pendingLateEventCount: pendingLateEvent?.count ?? 0,
        });
      }
      // There cannot be a running inventory document job before Task 8 adds
      // that schema. Task 8 extends this same lock boundary with the real check.
      const completedAt = new Date();
      await tx
        .update(schema.inventories)
        .set({
          status: "completed",
          completionAcknowledgedByUserId: actorUserId,
          completionAcknowledgedAt: completedAt,
          completedByUserId: actorUserId,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(schema.inventories.tenantId, tenantId),
            eq(schema.inventories.id, inventoryId),
            eq(schema.inventories.status, "closed"),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "inventory.completed",
        outcome: "success",
        targetType: "inventory",
        targetId: inventoryId,
        before: { status: "closed", resultRevision: inventory.resultRevision },
        after: {
          status: "completed",
          resultRevision: inventory.resultRevision,
          documentsDownloadedAndChecked: true,
          completedAt: completedAt.toISOString(),
        },
      });
      return {
        inventoryId,
        status: "completed",
        resultRevision: inventory.resultRevision,
        completedAt: completedAt.toISOString(),
      };
    });
  }

  async listLateEvents(
    tenantId: string,
    inventoryId: string,
    query: ListInventoryLateEventsQueryDto,
  ): Promise<ListInventoryLateEventsResponseDto> {
    const [inventory] = await this.db
      .select({ id: schema.inventories.id })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .limit(1);
    if (!inventory) throw new NotFoundException();
    const [countRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.inventoryLateEvents)
      .where(
        and(
          eq(schema.inventoryLateEvents.tenantId, tenantId),
          eq(schema.inventoryLateEvents.inventoryId, inventoryId),
        ),
      );
    const total = countRow?.total ?? 0;
    const offset = (query.page - 1) * query.pageSize;
    const result = await this.db.execute(sql`
      select
        late.id,
        late.batch_id as "batchId",
        late.device_id as "deviceId",
        device.name as "terminalName",
        case
          when jsonb_typeof(late.payload -> 'events') = 'array'
          then jsonb_array_length(late.payload -> 'events')
          else 0
        end::int as "eventCount",
        late.received_at as "receivedAt",
        late.closed_revision as "closedRevision",
        late.reason,
        late.resolution::text as resolution,
        late.resolved_at as "resolvedAt"
      from inventory_late_events late
      join station_devices device
        on device.tenant_id = late.tenant_id
       and device.id = late.device_id
      where late.tenant_id = ${tenantId}
        and late.inventory_id = ${inventoryId}
      order by late.received_at desc, late.id desc
      limit ${query.pageSize}
      offset ${offset}
    `);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: offset + result.rows.length < total,
      items: result.rows.map(parseLateEventRow),
    };
  }

  discardLateEvents(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: DiscardInventoryLateEventsDto,
  ): Promise<InventoryLateEventsDiscardDto> {
    return this.db.transaction(async (tx) => {
      const inventory = await this.lockInventory(tx, tenantId, inventoryId);
      this.assertNotCompleted(inventory);
      if (inventory.status !== "closed") {
        throw new ConflictException({ code: "INVENTORY_LATE_EVENT_DECISION_REQUIRES_CLOSED" });
      }
      const pending = await tx
        .select({ id: schema.inventoryLateEvents.id })
        .from(schema.inventoryLateEvents)
        .where(
          and(
            eq(schema.inventoryLateEvents.tenantId, tenantId),
            eq(schema.inventoryLateEvents.inventoryId, inventoryId),
            inArray(schema.inventoryLateEvents.id, input.lateEventIds),
            eq(schema.inventoryLateEvents.resolution, "pending"),
          ),
        )
        .for("update");
      if (pending.length !== input.lateEventIds.length) {
        throw new ConflictException({ code: "INVENTORY_LATE_EVENT_DECISION_STALE" });
      }
      const resolvedAt = new Date();
      const discarded = await tx
        .update(schema.inventoryLateEvents)
        .set({
          resolution: "discarded",
          resolvedAt,
          resolvedByUserId: actorUserId,
        })
        .where(
          and(
            eq(schema.inventoryLateEvents.tenantId, tenantId),
            eq(schema.inventoryLateEvents.inventoryId, inventoryId),
            inArray(schema.inventoryLateEvents.id, input.lateEventIds),
            eq(schema.inventoryLateEvents.resolution, "pending"),
          ),
        )
        .returning({ id: schema.inventoryLateEvents.id });
      if (discarded.length !== input.lateEventIds.length) {
        throw new ConflictException({ code: "INVENTORY_LATE_EVENT_DECISION_STALE" });
      }
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "inventory.late_events_discarded",
        outcome: "success",
        targetType: "inventory",
        targetId: inventoryId,
        before: {
          status: "closed",
          resultRevision: inventory.resultRevision,
          pendingLateEventIds: input.lateEventIds,
        },
        after: {
          status: "closed",
          resultRevision: inventory.resultRevision,
          discardedLateEventIds: input.lateEventIds,
          reason: input.reason,
          resolvedAt: resolvedAt.toISOString(),
        },
      });
      return { discardedCount: discarded.length };
    });
  }

  private closeUnderLock(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    emergencyReason: string | null,
  ): Promise<InventoryCloseDto> {
    return this.db.transaction(async (tx) => {
      const inventory = await this.lockInventory(tx, tenantId, inventoryId);
      this.assertNotCompleted(inventory);
      if (inventory.status !== "running") {
        throw new ConflictException({ code: "INVENTORY_CLOSE_REQUIRES_RUNNING" });
      }
      const blockers = await this.loadBlockers(tx, tenantId, inventoryId);
      if (emergencyReason === null && blockers.length > 0) {
        throw new ConflictException({
          code: "INVENTORY_CLOSE_BLOCKED",
          resultRevision: inventory.resultRevision,
          blockers,
        });
      }
      const closedAt = new Date();
      const emergency = emergencyReason !== null;
      await tx
        .update(schema.inventories)
        .set({
          status: "closed",
          closedByUserId: actorUserId,
          closedAt,
          emergencyCloseReason: emergencyReason,
          emergencyClosedByUserId: emergency ? actorUserId : null,
          emergencyClosedAt: emergency ? closedAt : null,
          updatedAt: closedAt,
        })
        .where(
          and(
            eq(schema.inventories.tenantId, tenantId),
            eq(schema.inventories.id, inventoryId),
            eq(schema.inventories.status, "running"),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: emergency ? "inventory.emergency_closed" : "inventory.closed",
        outcome: "success",
        targetType: "inventory",
        targetId: inventoryId,
        before: { status: "running", resultRevision: inventory.resultRevision },
        after: {
          status: "closed",
          resultRevision: inventory.resultRevision,
          emergency,
          reason: emergencyReason,
          blockers,
          closedAt: closedAt.toISOString(),
        },
      });
      return {
        inventoryId,
        status: "closed",
        resultRevision: inventory.resultRevision,
        closedAt: closedAt.toISOString(),
        emergency,
        blockers,
      };
    });
  }

  private async lockInventory(
    tx: InventoryTransaction,
    tenantId: string,
    inventoryId: string,
  ): Promise<LockedInventory> {
    const [inventory] = await tx
      .select({
        id: schema.inventories.id,
        status: schema.inventories.status,
        resultRevision: schema.inventories.resultRevision,
      })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .for("update");
    if (!inventory) throw new NotFoundException();
    return inventory;
  }

  private assertNotCompleted(inventory: LockedInventory): void {
    if (inventory.status === "completed") {
      throw new ConflictException({ code: "INVENTORY_COMPLETED_IMMUTABLE" });
    }
  }

  private async loadBlockers(
    tx: InventoryTransaction,
    tenantId: string,
    inventoryId: string,
  ): Promise<InventoryCloseBlockerDto[]> {
    const participants = await tx
      .select({
        participantId: schema.inventoryDeviceParticipants.id,
        deviceId: schema.inventoryDeviceParticipants.deviceId,
        heartbeatAt: schema.inventoryDeviceParticipants.heartbeatAt,
        stale: sql<boolean>`${schema.inventoryDeviceParticipants.heartbeatAt} < transaction_timestamp() - interval '45 seconds'`,
        pendingEventCount: schema.inventoryDeviceParticipants.pendingEventCount,
        openBoxCount: schema.inventoryDeviceParticipants.openBoxCount,
      })
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          sql`${schema.inventoryDeviceParticipants.leftAt} is null`,
        ),
      )
      .orderBy(asc(schema.inventoryDeviceParticipants.id));
    const boxes = await tx
      .select({
        id: schema.inventoryRepackBoxes.id,
        state: schema.inventoryRepackBoxes.state,
        printState: schema.inventoryRepackBoxes.printState,
      })
      .from(schema.inventoryRepackBoxes)
      .where(
        and(
          eq(schema.inventoryRepackBoxes.tenantId, tenantId),
          eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
        ),
      )
      .orderBy(asc(schema.inventoryRepackBoxes.id));
    const discrepancyResult = await tx.execute(sql<DiscrepancyBlockerRow>`
      select
        count(*) filter (where result.classification = 'unknown')::int as unknown,
        count(*) filter (where result.classification = 'ineligible')::int as ineligible,
        count(*) filter (
          where result.classification <> 'voided'
            and source.source_production_date is not null
            and result.observed_production_date is not null
            and source.source_production_date <> result.observed_production_date
        )::int as "dateMismatch",
        count(*) filter (where result.classification = 'voided')::int as voided
      from inventory_code_results result
      left join inventory_snapshot_codes source
        on source.tenant_id = result.tenant_id
       and source.snapshot_id = result.snapshot_id
       and source.code_hash = result.code_hash
      where result.tenant_id = ${tenantId}
        and result.inventory_id = ${inventoryId}
    `);
    const blockers: InventoryCloseBlockerDto[] = [];
    for (const participant of participants as ParticipantBlockerRow[]) {
      blockers.push(
        blocker(participant.stale ? "STALE_PARTICIPANT" : "ACTIVE_PARTICIPANT", {
          participantId: participant.participantId,
          deviceId: participant.deviceId,
        }),
      );
      if (participant.pendingEventCount > 0) {
        blockers.push(
          blocker("PENDING_OUTBOX", {
            count: participant.pendingEventCount,
            participantId: participant.participantId,
            deviceId: participant.deviceId,
          }),
        );
      }
      if (participant.openBoxCount > 0) {
        blockers.push(
          blocker("PARTICIPANT_OPEN_BOX", {
            count: participant.openBoxCount,
            participantId: participant.participantId,
            deviceId: participant.deviceId,
          }),
        );
      }
    }
    for (const box of boxes as BoxBlockerRow[]) {
      if (box.state === "open") blockers.push(blocker("OPEN_REPACK_BOX", { boxId: box.id }));
      if (box.state === "invalidated") {
        blockers.push(blocker("INVALIDATED_REPACK_BOX", { boxId: box.id }));
      }
      if (box.state === "closed" && box.printState !== "printed") {
        blockers.push(blocker("UNRESOLVED_BOX_PRINT", { boxId: box.id }));
      }
    }
    const discrepancy = parseDiscrepancyBlockerRow(discrepancyResult.rows[0]);
    if (discrepancy) {
      for (const [category, count] of [
        ["unknown", discrepancy.unknown],
        ["ineligible", discrepancy.ineligible],
        ["date_mismatch", discrepancy.dateMismatch],
        ["voided", discrepancy.voided],
      ] as const) {
        if (count > 0) {
          blockers.push(
            blocker("UNRESOLVED_DISCREPANCY", { count, discrepancyCategory: category }),
          );
        }
      }
    }
    return blockers;
  }
}

function blocker(
  code: InventoryCloseBlockerDto["code"],
  values: Partial<Omit<InventoryCloseBlockerDto, "code">> = {},
): InventoryCloseBlockerDto {
  return {
    code,
    count: values.count ?? 1,
    participantId: values.participantId ?? null,
    deviceId: values.deviceId ?? null,
    boxId: values.boxId ?? null,
    discrepancyCategory: values.discrepancyCategory ?? null,
  };
}

function parseLateEventRow(value: unknown): InventoryLateEventDto {
  if (typeof value !== "object" || value === null) {
    throw new Error("Inventory late-event row is unavailable");
  }
  const read = (key: string): unknown => Reflect.get(value, key);
  const text = (key: string): string => {
    const field = read(key);
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(`Inventory late-event ${key} is invalid`);
    }
    return field;
  };
  const integer = (key: string): number => {
    const field = read(key);
    if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
      throw new Error(`Inventory late-event ${key} is invalid`);
    }
    return field;
  };
  const resolution = text("resolution");
  if (resolution !== "pending" && resolution !== "replayed" && resolution !== "discarded") {
    throw new Error("Inventory late-event resolution is invalid");
  }
  const resolvedAt = read("resolvedAt");
  if (resolvedAt !== null && !(resolvedAt instanceof Date) && typeof resolvedAt !== "string") {
    throw new Error("Inventory late-event resolvedAt is invalid");
  }
  return {
    id: text("id"),
    batchId: text("batchId"),
    deviceId: text("deviceId"),
    terminalName: text("terminalName"),
    eventCount: integer("eventCount"),
    receivedAt: toIso(readTimestamp(read("receivedAt"), "receivedAt")),
    closedRevision: integer("closedRevision"),
    reason: text("reason"),
    resolution,
    resolvedAt: resolvedAt === null ? null : toIso(resolvedAt),
  };
}

function parseDiscrepancyBlockerRow(value: unknown): DiscrepancyBlockerRow | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error("Inventory discrepancy blocker row is unavailable");
  }
  const count = (key: string): number => {
    const field: unknown = Reflect.get(value, key);
    if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
      throw new Error(`Inventory discrepancy ${key} count is invalid`);
    }
    return field;
  };
  return {
    unknown: count("unknown"),
    ineligible: count("ineligible"),
    dateMismatch: count("dateMismatch"),
    voided: count("voided"),
  };
}

function readTimestamp(value: unknown, field: string): Date | string {
  if (value instanceof Date || typeof value === "string") return value;
  throw new Error(`Inventory lifecycle ${field} is invalid`);
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Inventory lifecycle timestamp is invalid");
  return date.toISOString();
}
