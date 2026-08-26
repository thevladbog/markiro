import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type {
  EmergencyCloseInventoryDto,
  DiscardInventoryLateEventsDto,
  InventoryCloseBlockerDto,
  InventoryCloseDto,
  InventoryClosePreviewDto,
  InventoryCompleteDto,
  InventoryLateEventReplayDto,
  InventoryLateEventDto,
  InventoryLateEventsDiscardDto,
  InventoryReopenDto,
  ListInventoryLateEventsQueryDto,
  ListInventoryLateEventsResponseDto,
} from "./dto";
import { stationInventoryEventBatchSchema } from "./station-inventory.dto";
import { StationInventorySyncService } from "./station-inventory-sync.service";

type InventoryTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface LockedInventory {
  id: string;
  status: "draft" | "preparing" | "ready" | "running" | "closed" | "completed";
  resultRevision: number;
  closedByUserId: string | null;
  closedAt: Date | string | null;
  emergencyCloseReason: string | null;
  emergencyClosedByUserId: string | null;
  emergencyClosedAt: Date | string | null;
}

interface ParticipantBlockerRow {
  active: number;
  stale: number;
  pending: number;
  reportedOpenBoxes: number;
}

interface BoxBlockerRow {
  open: number;
  invalidated: number;
  unresolvedPrint: number;
}

interface DiscrepancyBlockerRow {
  unknown: number;
  ineligible: number;
  dateMismatch: number;
  voided: number;
}

@Injectable()
export class InventoryCloseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly stationSync: StationInventorySyncService,
  ) {}

  preview(tenantId: string, inventoryId: string): Promise<InventoryClosePreviewDto> {
    return this.db.transaction(
      async (tx) => {
        const [inventory] = await tx
          .select({
            id: schema.inventories.id,
            status: schema.inventories.status,
            resultRevision: schema.inventories.resultRevision,
          })
          .from(schema.inventories)
          .where(
            and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
          )
          .limit(1);
        if (!inventory) throw new NotFoundException();
        if (inventory.status !== "running") {
          throw new ConflictException({ code: "INVENTORY_CLOSE_REQUIRES_RUNNING" });
        }
        return {
          inventoryId,
          status: "running",
          resultRevision: inventory.resultRevision,
          blockers: await this.loadBlockers(tx, tenantId, inventoryId),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

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
        before: {
          status: "closed",
          resultRevision: inventory.resultRevision,
          closedByUserId: inventory.closedByUserId,
          closedAt: requiredIso(inventory.closedAt, "closedAt"),
          emergencyCloseReason: inventory.emergencyCloseReason,
          emergencyClosedByUserId: inventory.emergencyClosedByUserId,
          emergencyClosedAt:
            inventory.emergencyClosedAt === null ? null : toIso(inventory.emergencyClosedAt),
        },
        after: {
          status: "running",
          resultRevision,
          closedByUserId: null,
          closedAt: null,
          emergencyCloseReason: null,
          emergencyClosedByUserId: null,
          emergencyClosedAt: null,
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
      void actorUserId;
      throw new ConflictException({
        code: "INVENTORY_DOCUMENT_ARTIFACTS_UNAVAILABLE",
        requiredTask: 8,
      });
    });
  }

  async replayLateEvent(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    lateEventId: string,
  ): Promise<InventoryLateEventReplayDto> {
    const [inventory] = await this.db
      .select({ status: schema.inventories.status })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .limit(1);
    if (!inventory) throw new NotFoundException();
    const [late] = await this.db
      .select({
        id: schema.inventoryLateEvents.id,
        deviceId: schema.inventoryLateEvents.deviceId,
        payload: schema.inventoryLateEvents.payload,
        resolution: schema.inventoryLateEvents.resolution,
        replayAuthorizedAt: schema.inventoryLateEvents.replayAuthorizedAt,
      })
      .from(schema.inventoryLateEvents)
      .where(
        and(
          eq(schema.inventoryLateEvents.tenantId, tenantId),
          eq(schema.inventoryLateEvents.inventoryId, inventoryId),
          eq(schema.inventoryLateEvents.id, lateEventId),
        ),
      )
      .limit(1);
    if (!late) throw new NotFoundException();
    if (inventory.status !== "running") {
      throw new ConflictException({ code: "INVENTORY_LATE_EVENT_REPLAY_REQUIRES_RUNNING" });
    }
    if (late.resolution !== "pending") {
      throw new ConflictException({ code: "INVENTORY_LATE_EVENT_REPLAY_STALE" });
    }
    if (late.replayAuthorizedAt === null) {
      throw new ConflictException({ code: "INVENTORY_LATE_EVENT_REPLAY_NOT_AUTHORIZED" });
    }
    const parsed = stationInventoryEventBatchSchema.safeParse(late.payload);
    if (!parsed.success) {
      throw new ConflictException({ code: "INVENTORY_LATE_EVENT_PAYLOAD_INVALID" });
    }
    const result = await this.stationSync.replayAuthorizedLateEvent(
      tenantId,
      actorUserId,
      inventoryId,
      late.deviceId,
      late.id,
      parsed.data,
    );
    const [resolved] = await this.db
      .select({ resolution: schema.inventoryLateEvents.resolution })
      .from(schema.inventoryLateEvents)
      .where(
        and(
          eq(schema.inventoryLateEvents.tenantId, tenantId),
          eq(schema.inventoryLateEvents.inventoryId, inventoryId),
          eq(schema.inventoryLateEvents.id, lateEventId),
        ),
      );
    if (resolved?.resolution !== "replayed") {
      throw new ConflictException({ code: "INVENTORY_LATE_EVENT_REPLAY_NOT_AUTHORIZED" });
    }
    return { lateEventId, resolution: "replayed", result };
  }

  async listLateEvents(
    tenantId: string,
    inventoryId: string,
    query: ListInventoryLateEventsQueryDto,
  ): Promise<ListInventoryLateEventsResponseDto> {
    const [inventory] = await this.db
      .select({ id: schema.inventories.id, status: schema.inventories.status })
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
        late.resolved_at as "resolvedAt",
        (late.resolution = 'pending'
          and late.replay_authorized_at is not null
          and ${inventory.status === "running"}) as "replayAvailable"
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
      await tx
        .update(schema.inventoryLateEvents)
        .set({
          replayAuthorizedAt: null,
          replayAuthorizedByUserId: null,
          replayAuthorizedRevision: null,
        })
        .where(
          and(
            eq(schema.inventoryLateEvents.tenantId, tenantId),
            eq(schema.inventoryLateEvents.inventoryId, inventoryId),
            eq(schema.inventoryLateEvents.resolution, "pending"),
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
        closedByUserId: schema.inventories.closedByUserId,
        closedAt: schema.inventories.closedAt,
        emergencyCloseReason: schema.inventories.emergencyCloseReason,
        emergencyClosedByUserId: schema.inventories.emergencyClosedByUserId,
        emergencyClosedAt: schema.inventories.emergencyClosedAt,
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
    const participantResult = await tx.execute(sql<ParticipantBlockerRow>`
      select
        count(*) filter (
          where heartbeat_at >= transaction_timestamp() - interval '45 seconds'
        )::int as active,
        count(*) filter (
          where heartbeat_at < transaction_timestamp() - interval '45 seconds'
        )::int as stale,
        coalesce(sum(pending_event_count), 0)::int as pending,
        coalesce(sum(open_box_count), 0)::int as "reportedOpenBoxes"
      from inventory_device_participants
      where tenant_id = ${tenantId}
        and inventory_id = ${inventoryId}
        and left_at is null
    `);
    const boxResult = await tx.execute(sql<BoxBlockerRow>`
      select
        count(*) filter (where state = 'open')::int as open,
        count(*) filter (where state = 'invalidated')::int as invalidated,
        count(*) filter (where state = 'closed' and print_state <> 'printed')::int
          as "unresolvedPrint"
      from inventory_repack_boxes
      where tenant_id = ${tenantId}
        and inventory_id = ${inventoryId}
    `);
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
    const participant = parseParticipantBlockerRow(participantResult.rows[0]);
    if (participant.active > 0) {
      blockers.push(blocker("ACTIVE_PARTICIPANT", { count: participant.active }));
    }
    if (participant.stale > 0) {
      blockers.push(blocker("STALE_PARTICIPANT", { count: participant.stale }));
    }
    if (participant.pending > 0) {
      blockers.push(blocker("PENDING_OUTBOX", { count: participant.pending }));
    }
    if (participant.reportedOpenBoxes > 0) {
      blockers.push(blocker("PARTICIPANT_OPEN_BOX", { count: participant.reportedOpenBoxes }));
    }
    const boxes = parseBoxBlockerRow(boxResult.rows[0]);
    if (boxes.open > 0) blockers.push(blocker("OPEN_REPACK_BOX", { count: boxes.open }));
    if (boxes.invalidated > 0) {
      blockers.push(blocker("INVALIDATED_REPACK_BOX", { count: boxes.invalidated }));
    }
    if (boxes.unresolvedPrint > 0) {
      blockers.push(blocker("UNRESOLVED_BOX_PRINT", { count: boxes.unresolvedPrint }));
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

function parseAggregateCountRow(value: unknown, fields: readonly string[]): Record<string, number> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Inventory close aggregate row is unavailable");
  }
  return Object.fromEntries(
    fields.map((field) => {
      const count: unknown = Reflect.get(value, field);
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new Error(`Inventory close aggregate ${field} is invalid`);
      }
      return [field, count];
    }),
  );
}

function parseParticipantBlockerRow(value: unknown): ParticipantBlockerRow {
  const row = parseAggregateCountRow(value, ["active", "stale", "pending", "reportedOpenBoxes"]);
  return {
    active: aggregateCount(row, "active"),
    stale: aggregateCount(row, "stale"),
    pending: aggregateCount(row, "pending"),
    reportedOpenBoxes: aggregateCount(row, "reportedOpenBoxes"),
  };
}

function parseBoxBlockerRow(value: unknown): BoxBlockerRow {
  const row = parseAggregateCountRow(value, ["open", "invalidated", "unresolvedPrint"]);
  return {
    open: aggregateCount(row, "open"),
    invalidated: aggregateCount(row, "invalidated"),
    unresolvedPrint: aggregateCount(row, "unresolvedPrint"),
  };
}

function aggregateCount(row: Record<string, number>, field: string): number {
  const value = row[field];
  if (value === undefined) throw new Error(`Inventory close aggregate ${field} is unavailable`);
  return value;
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
  const replayAvailable = read("replayAvailable");
  if (typeof replayAvailable !== "boolean") {
    throw new Error("Inventory late-event replayAvailable is invalid");
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
    replayAvailable,
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

function requiredIso(value: Date | string | null, field: string): string {
  if (value === null) throw new Error(`Inventory lifecycle ${field} is unavailable`);
  return toIso(value);
}
