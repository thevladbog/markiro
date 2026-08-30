import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import { INVENTORY_CHZ_STATUSES, parseScannedSscc, type InventoryChzStatus } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import type {
  InventoryBoxInvalidationSource,
  InventoryDiscrepancyCategory,
  InventoryDiscrepancyDto,
  InventoryDiscrepancyWinnerDto,
  InventoryLiveBoxDto,
  InventoryParticipantDto,
  InventoryProgressDto,
  InventoryRecentEventDto,
  InventoryVerifiedBoxDto,
  ListInventoryDiscrepanciesQueryDto,
  ListInventoryDiscrepanciesResponseDto,
  ListInventoryEvidenceQueryDto,
  ListInventoryEvidenceResponseDto,
} from "./dto";
import {
  buildInventoryEvidenceRowsSql,
  resolveInventoryEvidenceEvents,
  type InventoryEvidenceAction,
} from "./inventory-evidence-query";
import {
  formatInventoryEventCopyIdentity,
  formatInventoryEventIdentity,
  type InventoryEventKind,
} from "./inventory-event-display";

interface ProgressCountRow {
  expectedCount: number;
  verifiedCount: number;
  missingCount: number;
  protectedCount: number;
  protectedFoundCount: number;
  ineligibleCount: number;
  unknownCount: number;
  dateMismatchCount: number;
  voidedCount: number;
  oldBoxCount: number;
  newBoxCount: number;
  invalidatedBoxCount: number;
}

interface DiscrepancyRow {
  category: InventoryDiscrepancyCategory;
  categoryRank: number;
  displayIdentity: string;
  codeHash: string | null;
  sscc: string | null;
  found: boolean;
  sourceStatus: InventoryChzStatus | null;
  sourceProductionDate: string | null;
  observedProductionDate: string | null;
  terminalId: string | null;
  terminalName: string | null;
  winningScannedAt: Date | string | null;
}

interface ParticipantRow {
  deviceId: string;
  terminalName: string;
  operatorName: string;
  joinedAt: Date | string;
  leftAt: Date | string | null;
  heartbeatAt: Date | string;
  state: "active" | "stale" | "left";
  pendingEventCount: number;
  openBoxCount: number;
}

interface LiveBoxRow {
  id: string;
  sscc: string;
  terminalId: string;
  terminalName: string;
  productionDate: string;
  state: "open" | "closed" | "invalidated";
  invalidationSource: InventoryBoxInvalidationSource | null;
  printState: "not_ready" | "pending" | "printing" | "printed" | "failed";
  itemCount: number;
}

interface RecentEventRow {
  eventId: string;
  codeResultId: string | null;
  kind: InventoryEventKind;
  normalizedIdentity: string;
  rawPayload: string | null;
  authoritativeVerdict: string;
  terminalId: string;
  terminalName: string;
  scannedAt: Date | string;
  classification: "expected" | "protected" | "ineligible" | "unknown" | "voided" | null;
  observedProductionDate: string | null;
}

interface VerifiedBoxRow {
  eventId: string;
  rawSscc: string;
  terminalId: string;
  terminalName: string;
  scannedAt: Date | string;
  affectedCodeCount: number;
  total: number;
}

interface EvidenceAggregateRow {
  total: number;
  affectedCodeCount: number;
  allCanVoid: boolean;
  allCanRestore: boolean;
  allCanChangeDate: boolean;
  allCanRemoveItem: boolean;
}

type ReconciliationTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class InventoryReconciliationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getProgress(tenantId: string, inventoryId: string): Promise<InventoryProgressDto> {
    return this.db.transaction((tx) => this.getProgressFromTransaction(tx, tenantId, inventoryId), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  private async getProgressFromTransaction(
    tx: ReconciliationTransaction,
    tenantId: string,
    inventoryId: string,
  ): Promise<InventoryProgressDto> {
    const inventory = await this.getInventoryProjection(tx, tenantId, inventoryId);
    const result = await tx.execute(sql<ProgressCountRow>`
      select
        count(*) filter (where sc.expected)::int as "expectedCount",
        count(*) filter (
          where sc.expected and r.classification = 'expected'
        )::int as "verifiedCount",
        count(*) filter (
          where sc.expected and r.id is null
        )::int as "missingCount",
        count(*) filter (where sc.protected)::int as "protectedCount",
        count(*) filter (
          where sc.protected and r.classification = 'protected'
        )::int as "protectedFoundCount",
        (
          select count(*)::int
          from inventory_code_results ir
          where ir.tenant_id = ${tenantId}
            and ir.inventory_id = ${inventoryId}
            and ir.classification = 'ineligible'
        ) as "ineligibleCount",
        (
          select count(*)::int
          from inventory_code_results ur
          where ur.tenant_id = ${tenantId}
            and ur.inventory_id = ${inventoryId}
            and ur.classification = 'unknown'
        ) as "unknownCount",
        count(*) filter (
          where r.classification <> 'voided'
            and sc.source_production_date is not null
            and r.observed_production_date is not null
            and sc.source_production_date <> r.observed_production_date
        )::int as "dateMismatchCount",
        (
          select count(*)::int
          from inventory_code_results vr
          where vr.tenant_id = ${tenantId}
            and vr.inventory_id = ${inventoryId}
            and vr.classification = 'voided'
        ) as "voidedCount",
        (
          select count(distinct oe.normalized_identity)::int
          from inventory_scan_events oe
          where oe.tenant_id = ${tenantId}
            and oe.inventory_id = ${inventoryId}
            and oe.kind = 'old_box'
            and oe.authoritative_verdict = 'applied'
        ) as "oldBoxCount",
        (
          select count(*)::int
          from inventory_repack_boxes nb
          where nb.tenant_id = ${tenantId}
            and nb.inventory_id = ${inventoryId}
        ) as "newBoxCount",
        (
          select count(*)::int
          from inventory_repack_boxes ib
          where ib.tenant_id = ${tenantId}
            and ib.inventory_id = ${inventoryId}
            and ib.state = 'invalidated'
        ) as "invalidatedBoxCount"
      from inventory_snapshot_codes sc
      left join inventory_code_results r
        on r.tenant_id = sc.tenant_id
       and r.inventory_id = ${inventoryId}
       and r.snapshot_id = sc.snapshot_id
       and r.code_hash = sc.code_hash
      where sc.tenant_id = ${tenantId}
        and sc.snapshot_id = ${inventory.snapshotId}
    `);
    const counts = parseProgressCountRow(result.rows[0]);
    const participantResult = await tx.execute(sql<ParticipantRow>`
        select
          p.device_id as "deviceId",
          d.name as "terminalName",
          e.full_name as "operatorName",
          p.joined_at as "joinedAt",
          p.left_at as "leftAt",
          p.heartbeat_at as "heartbeatAt",
          case
            when p.left_at is not null then 'left'
            when p.heartbeat_at < transaction_timestamp() - interval '45 seconds' then 'stale'
            else 'active'
          end as state,
          p.pending_event_count as "pendingEventCount",
          p.open_box_count as "openBoxCount"
        from inventory_device_participants p
        join station_devices d
          on d.tenant_id = p.tenant_id
         and d.id = p.device_id
        join employees e
          on e.tenant_id = p.tenant_id
         and e.id = p.operator_id
        where p.tenant_id = ${tenantId}
          and p.inventory_id = ${inventoryId}
        order by
          case when p.left_at is null then 0 else 1 end,
          d.name,
          p.device_id
      `);
    const boxResult = await tx.execute(sql<LiveBoxRow>`
        select
          b.id,
          b.new_sscc as sscc,
          b.owner_device_id as "terminalId",
          d.name as "terminalName",
          b.production_date as "productionDate",
          b.state::text as state,
          b.invalidation_source::text as "invalidationSource",
          b.print_state::text as "printState",
          count(i.id) filter (where i.removed_at is null)::int as "itemCount"
        from inventory_repack_boxes b
        join station_devices d
          on d.tenant_id = b.tenant_id
         and d.id = b.owner_device_id
        left join inventory_repack_items i
          on i.tenant_id = b.tenant_id
         and i.inventory_id = b.inventory_id
         and i.box_id = b.id
        where b.tenant_id = ${tenantId}
          and b.inventory_id = ${inventoryId}
        group by b.id, d.name
        order by
          case b.state when 'open' then 0 when 'invalidated' then 1 else 2 end,
          b.opened_at desc,
          b.id
        limit 101
      `);
    const verifiedBoxResult = await tx.execute(sql<VerifiedBoxRow>`
        with ranked_boxes as (
          select
            e.event_id as "eventId",
            substring(e.normalized_identity from length('known_box:') + 1) as "rawSscc",
            e.device_id as "terminalId",
            d.name as "terminalName",
            e.scanned_at as "scannedAt",
            count(r.id)::int as "affectedCodeCount",
            row_number() over (
              partition by e.normalized_identity
              order by e.scanned_at desc, e.event_id desc
            ) as identity_rank
          from inventory_scan_events e
          join station_devices d
            on d.tenant_id = e.tenant_id
           and d.id = e.device_id
          left join inventory_code_results r
            on r.tenant_id = e.tenant_id
           and r.inventory_id = e.inventory_id
           and r.first_accepted_event_id = e.event_id
          where e.tenant_id = ${tenantId}
            and e.inventory_id = ${inventoryId}
            and e.kind = 'known_box'
            and e.authoritative_verdict = 'applied'
          group by e.event_id, d.name
        )
        select
          "eventId",
          "rawSscc",
          "terminalId",
          "terminalName",
          "scannedAt",
          "affectedCodeCount",
          count(*) over()::int as total
        from ranked_boxes
        where identity_rank = 1
        order by "scannedAt" desc, "eventId" desc
        limit 101
      `);
    const recentEventResult = await tx.execute(sql<RecentEventRow>`
        select
          e.event_id as "eventId",
          r.id as "codeResultId",
          e.kind::text as kind,
          e.normalized_identity as "normalizedIdentity",
          e.raw_payload as "rawPayload",
          e.authoritative_verdict as "authoritativeVerdict",
          e.device_id as "terminalId",
          d.name as "terminalName",
          e.scanned_at as "scannedAt",
          r.classification::text as classification,
          r.observed_production_date as "observedProductionDate"
        from inventory_scan_events e
        join station_devices d
          on d.tenant_id = e.tenant_id
         and d.id = e.device_id
        left join inventory_code_results r
          on r.tenant_id = e.tenant_id
         and r.inventory_id = e.inventory_id
         and r.first_accepted_event_id = e.event_id
        where e.tenant_id = ${tenantId}
          and e.inventory_id = ${inventoryId}
        order by e.scanned_at desc, e.event_id desc, r.id
        limit 50
      `);
    const participants = participantResult.rows.map(parseParticipantRow);
    return {
      inventoryId,
      snapshotId: inventory.snapshotId,
      status: inventory.status,
      resultRevision: inventory.resultRevision,
      ...counts,
      pendingEventCount: participants.reduce((sum, row) => sum + row.pendingEventCount, 0),
      openBoxCount: participants.reduce((sum, row) => sum + row.openBoxCount, 0),
      boxTotal: counts.newBoxCount,
      boxesTruncated: boxResult.rows.length > 100,
      verifiedBoxTotal:
        verifiedBoxResult.rows.length === 0 ? 0 : readInteger(verifiedBoxResult.rows[0], "total"),
      verifiedBoxesTruncated: verifiedBoxResult.rows.length > 100,
      participants,
      boxes: boxResult.rows.slice(0, 100).map(parseLiveBoxRow),
      verifiedBoxes: verifiedBoxResult.rows.slice(0, 100).map(parseVerifiedBoxRow),
      recentEvents: recentEventResult.rows.map(parseRecentEventRow),
    };
  }

  async listEvidence(
    tenantId: string,
    inventoryId: string,
    query: ListInventoryEvidenceQueryDto,
  ): Promise<ListInventoryEvidenceResponseDto> {
    return this.db.transaction(
      (tx) => this.listEvidenceFromTransaction(tx, tenantId, inventoryId, query),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private async listEvidenceFromTransaction(
    tx: ReconciliationTransaction,
    tenantId: string,
    inventoryId: string,
    query: ListInventoryEvidenceQueryDto,
  ): Promise<ListInventoryEvidenceResponseDto> {
    await this.getInventoryProjection(tx, tenantId, inventoryId);
    const filter = {
      scope: query.scope,
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.classification === undefined ? {} : { classification: query.classification }),
      ...(query.discrepancyCategory === undefined
        ? {}
        : { discrepancyCategory: query.discrepancyCategory }),
    };
    const evidenceRows = buildInventoryEvidenceRowsSql({ tenantId, inventoryId, filter });
    const aggregateResult = await tx.execute(sql<EvidenceAggregateRow>`
      select
        count(*)::int as total,
        coalesce(sum(matching."affectedCodeCount"), 0)::int as "affectedCodeCount",
        coalesce(bool_and(matching."canVoid"), false) as "allCanVoid",
        coalesce(bool_and(matching."canRestore"), false) as "allCanRestore",
        coalesce(bool_and(matching."canChangeDate"), false) as "allCanChangeDate",
        coalesce(bool_and(matching."canRemoveItem"), false) as "allCanRemoveItem"
      from (${evidenceRows}) matching
    `);
    const aggregate = parseEvidenceAggregateRow(aggregateResult.rows[0]);
    const offset = (query.page - 1) * query.pageSize;
    const pageRows = await resolveInventoryEvidenceEvents(tx, {
      tenantId,
      inventoryId,
      filter,
      order: "newest",
      limit: query.pageSize,
      offset,
    });
    return {
      page: query.page,
      pageSize: query.pageSize,
      total: aggregate.total,
      hasMore: offset + pageRows.length < aggregate.total,
      allMatchingActions: evidenceAggregateActions(aggregate),
      allMatchingAffectedCodeCount: aggregate.affectedCodeCount,
      items: pageRows.map((event) => ({
        eventId: event.eventId,
        codeResultId: event.codeResultId,
        kind: event.kind,
        displayIdentity: formatInventoryEventIdentity(
          event.kind,
          event.rawPayload,
          event.normalizedIdentity,
        ),
        copyIdentity: formatInventoryEventCopyIdentity(event.kind, event.rawPayload),
        authoritativeVerdict: event.authoritativeVerdict,
        terminalId: event.terminalId,
        terminalName: event.terminalName,
        scannedAt: event.scannedAt.toISOString(),
        classification: event.classification,
        observedProductionDate: event.observedProductionDate,
        affectedCodeCount: event.affectedCodeCount,
        discrepancyCodeCount: event.discrepancyCodeCount,
        classifications: event.classifications,
        discrepancyCategories: event.discrepancyCategories,
        actions: event.actions,
      })),
    };
  }

  async listDiscrepancies(
    tenantId: string,
    inventoryId: string,
    query: ListInventoryDiscrepanciesQueryDto,
  ): Promise<ListInventoryDiscrepanciesResponseDto> {
    return this.db.transaction(
      (tx) => this.listDiscrepanciesFromTransaction(tx, tenantId, inventoryId, query),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private async listDiscrepanciesFromTransaction(
    tx: ReconciliationTransaction,
    tenantId: string,
    inventoryId: string,
    query: ListInventoryDiscrepanciesQueryDto,
  ): Promise<ListInventoryDiscrepanciesResponseDto> {
    const inventory = await this.getInventoryProjection(tx, tenantId, inventoryId);
    const rowsQuery = discrepancyRows(tenantId, inventoryId, inventory.snapshotId);
    const categoryFilter = query.category
      ? sql`where discrepancy.category = ${query.category}`
      : sql``;
    const countResult = await tx.execute(sql<{ total: number }>`
      with discrepancy as (${rowsQuery})
      select count(*)::int as total
      from discrepancy
      ${categoryFilter}
    `);
    const total = readInteger(countResult.rows[0], "total");
    const offset = (query.page - 1) * query.pageSize;
    const pageResult = await tx.execute(sql<DiscrepancyRow>`
      with discrepancy as (${rowsQuery})
      select *
      from discrepancy
      ${categoryFilter}
      order by
        discrepancy."categoryRank",
        coalesce(discrepancy.sscc, ''),
        coalesce(discrepancy."codeHash", ''),
        discrepancy."displayIdentity"
      limit ${query.pageSize}
      offset ${offset}
    `);
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: offset + pageResult.rows.length < total,
      items: pageResult.rows.map(parseDiscrepancyRow).map(toDiscrepancyDto),
    };
  }

  private async getInventoryProjection(
    tx: ReconciliationTransaction,
    tenantId: string,
    inventoryId: string,
  ) {
    const [inventory] = await tx
      .select({
        status: schema.inventories.status,
        snapshotId: schema.inventories.activeSnapshotId,
        resultRevision: schema.inventories.resultRevision,
      })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .limit(1);
    if (!inventory) throw new NotFoundException();
    if (inventory.snapshotId === null) {
      throw new ConflictException({ code: "INVENTORY_RECONCILIATION_UNAVAILABLE" });
    }
    return { ...inventory, snapshotId: inventory.snapshotId };
  }
}

function discrepancyRows(tenantId: string, inventoryId: string, snapshotId: string) {
  return sql`
    select
      'missing'::text as category,
      1::int as "categoryRank",
      concat('01', sc.gtin14, '21', sc.serial) as "displayIdentity",
      sc.code_hash as "codeHash",
      sc.parent_sscc as sscc,
      false as found,
      sc.source_status::text as "sourceStatus",
      sc.source_production_date as "sourceProductionDate",
      null::date as "observedProductionDate",
      null::uuid as "terminalId",
      null::text as "terminalName",
      null::timestamptz as "winningScannedAt"
    from inventory_snapshot_codes sc
    left join inventory_code_results r
      on r.tenant_id = sc.tenant_id
     and r.inventory_id = ${inventoryId}
     and r.snapshot_id = sc.snapshot_id
     and r.code_hash = sc.code_hash
    where sc.tenant_id = ${tenantId}
      and sc.snapshot_id = ${snapshotId}
      and sc.expected
      and r.id is null

    union all

    select
      'protected'::text,
      2::int,
      concat('01', sc.gtin14, '21', sc.serial),
      sc.code_hash,
      sc.parent_sscc,
      coalesce(r.classification = 'protected', false),
      sc.source_status::text,
      sc.source_production_date,
      r.observed_production_date,
      case when r.classification = 'protected' then r.winning_device_id else null end,
      case when r.classification = 'protected' then d.name else null end,
      case when r.classification = 'protected' then r.winning_scanned_at else null end
    from inventory_snapshot_codes sc
    left join inventory_code_results r
      on r.tenant_id = sc.tenant_id
     and r.inventory_id = ${inventoryId}
     and r.snapshot_id = sc.snapshot_id
     and r.code_hash = sc.code_hash
    left join station_devices d
      on d.tenant_id = r.tenant_id
     and d.id = r.winning_device_id
    where sc.tenant_id = ${tenantId}
      and sc.snapshot_id = ${snapshotId}
      and sc.protected

    union all

    select
      'ineligible'::text,
      3::int,
      concat('01', sc.gtin14, '21', sc.serial),
      r.code_hash,
      sc.parent_sscc,
      true,
      sc.source_status::text,
      sc.source_production_date,
      r.observed_production_date,
      r.winning_device_id,
      d.name,
      r.winning_scanned_at
    from inventory_code_results r
    join inventory_snapshot_codes sc
      on sc.tenant_id = r.tenant_id
     and sc.snapshot_id = r.snapshot_id
     and sc.code_hash = r.code_hash
    join station_devices d
      on d.tenant_id = r.tenant_id
     and d.id = r.winning_device_id
    where r.tenant_id = ${tenantId}
      and r.inventory_id = ${inventoryId}
      and r.classification = 'ineligible'

    union all

    select
      'unknown'::text,
      4::int,
      e.normalized_identity,
      r.code_hash,
      null::char(18),
      true,
      null::text,
      null::date,
      r.observed_production_date,
      r.winning_device_id,
      d.name,
      r.winning_scanned_at
    from inventory_code_results r
    join inventory_scan_events e
      on e.tenant_id = r.tenant_id
     and e.inventory_id = r.inventory_id
     and e.event_id = r.first_accepted_event_id
    join station_devices d
      on d.tenant_id = r.tenant_id
     and d.id = r.winning_device_id
    where r.tenant_id = ${tenantId}
      and r.inventory_id = ${inventoryId}
      and r.classification = 'unknown'

    union all

    select
      'date_mismatch'::text,
      5::int,
      concat('01', sc.gtin14, '21', sc.serial),
      r.code_hash,
      sc.parent_sscc,
      true,
      sc.source_status::text,
      sc.source_production_date,
      r.observed_production_date,
      r.winning_device_id,
      d.name,
      r.winning_scanned_at
    from inventory_code_results r
    join inventory_snapshot_codes sc
      on sc.tenant_id = r.tenant_id
     and sc.snapshot_id = r.snapshot_id
     and sc.code_hash = r.code_hash
    join station_devices d
      on d.tenant_id = r.tenant_id
     and d.id = r.winning_device_id
    where r.tenant_id = ${tenantId}
      and r.inventory_id = ${inventoryId}
      and r.classification <> 'voided'
      and sc.source_production_date is not null
      and r.observed_production_date is not null
      and sc.source_production_date <> r.observed_production_date

    union all

    select
      'voided'::text,
      6::int,
      case
        when sc.code_hash is null then e.normalized_identity
        else concat('01', sc.gtin14, '21', sc.serial)
      end,
      r.code_hash,
      sc.parent_sscc,
      false,
      sc.source_status::text,
      sc.source_production_date,
      r.observed_production_date,
      r.winning_device_id,
      d.name,
      r.winning_scanned_at
    from inventory_code_results r
    join inventory_scan_events e
      on e.tenant_id = r.tenant_id
     and e.inventory_id = r.inventory_id
     and e.event_id = r.first_accepted_event_id
    left join inventory_snapshot_codes sc
      on sc.tenant_id = r.tenant_id
     and sc.snapshot_id = r.snapshot_id
     and sc.code_hash = r.code_hash
    join station_devices d
      on d.tenant_id = r.tenant_id
     and d.id = r.winning_device_id
    where r.tenant_id = ${tenantId}
      and r.inventory_id = ${inventoryId}
      and r.classification = 'voided'

    union all

    select
      'invalidated_box'::text,
      7::int,
      concat('new_box:', b.new_sscc),
      null::char(64),
      b.new_sscc,
      false,
      null::text,
      null::date,
      b.production_date,
      null::uuid,
      null::text,
      null::timestamptz
    from inventory_repack_boxes b
    where b.tenant_id = ${tenantId}
      and b.inventory_id = ${inventoryId}
      and b.state = 'invalidated'
  `;
}

function toDiscrepancyDto(row: DiscrepancyRow): InventoryDiscrepancyDto {
  return {
    category: row.category,
    displayIdentity: row.displayIdentity,
    codeHash: row.codeHash,
    sscc: row.sscc,
    found: row.found,
    sourceStatus: row.sourceStatus,
    sourceProductionDate: row.sourceProductionDate,
    observedProductionDate: row.observedProductionDate,
    winner: discrepancyWinner(row),
  };
}

function discrepancyWinner(row: DiscrepancyRow): InventoryDiscrepancyWinnerDto | null {
  if (row.terminalId === null || row.terminalName === null || row.winningScannedAt === null) {
    return null;
  }
  const scannedAt =
    row.winningScannedAt instanceof Date ? row.winningScannedAt : new Date(row.winningScannedAt);
  if (Number.isNaN(scannedAt.getTime())) {
    throw new Error("Inventory discrepancy winner time is invalid");
  }
  return {
    terminalId: row.terminalId,
    terminalName: row.terminalName,
    scannedAt: scannedAt.toISOString(),
  };
}

function parseProgressCountRow(value: unknown): ProgressCountRow {
  return {
    expectedCount: readInteger(value, "expectedCount"),
    verifiedCount: readInteger(value, "verifiedCount"),
    missingCount: readInteger(value, "missingCount"),
    protectedCount: readInteger(value, "protectedCount"),
    protectedFoundCount: readInteger(value, "protectedFoundCount"),
    ineligibleCount: readInteger(value, "ineligibleCount"),
    unknownCount: readInteger(value, "unknownCount"),
    dateMismatchCount: readInteger(value, "dateMismatchCount"),
    voidedCount: readInteger(value, "voidedCount"),
    oldBoxCount: readInteger(value, "oldBoxCount"),
    newBoxCount: readInteger(value, "newBoxCount"),
    invalidatedBoxCount: readInteger(value, "invalidatedBoxCount"),
  };
}

function parseParticipantRow(value: unknown): InventoryParticipantDto {
  const record = asRecord(value, "Inventory participant row is unavailable");
  const state = readString(record, "state");
  if (state !== "active" && state !== "stale" && state !== "left") {
    throw new Error("Inventory participant state is invalid");
  }
  return {
    deviceId: readString(record, "deviceId"),
    terminalName: readString(record, "terminalName"),
    operatorName: readString(record, "operatorName"),
    joinedAt: readDate(record, "joinedAt").toISOString(),
    leftAt: readNullableDateAsIso(record, "leftAt"),
    heartbeatAt: readDate(record, "heartbeatAt").toISOString(),
    state,
    pendingEventCount: readInteger(record, "pendingEventCount"),
    openBoxCount: readInteger(record, "openBoxCount"),
  };
}

function parseLiveBoxRow(value: unknown): InventoryLiveBoxDto {
  const record = asRecord(value, "Inventory box row is unavailable");
  const state = readString(record, "state");
  if (state !== "open" && state !== "closed" && state !== "invalidated") {
    throw new Error("Inventory box state is invalid");
  }
  const printState = readString(record, "printState");
  if (
    printState !== "not_ready" &&
    printState !== "pending" &&
    printState !== "printing" &&
    printState !== "printed" &&
    printState !== "failed"
  ) {
    throw new Error("Inventory box print state is invalid");
  }
  const invalidationSource = readNullableString(record, "invalidationSource");
  if (
    invalidationSource !== null &&
    invalidationSource !== "claim_lost" &&
    invalidationSource !== "admin"
  ) {
    throw new Error("Inventory box invalidation source is invalid");
  }
  return {
    id: readString(record, "id"),
    sscc: readString(record, "sscc"),
    terminalId: readString(record, "terminalId"),
    terminalName: readString(record, "terminalName"),
    productionDate: readString(record, "productionDate"),
    state,
    invalidationSource,
    printState,
    itemCount: readInteger(record, "itemCount"),
  };
}

function parseVerifiedBoxRow(value: unknown): InventoryVerifiedBoxDto {
  const record = asRecord(value, "Inventory verified box row is unavailable");
  const rawSscc = readString(record, "rawSscc");
  const sscc = parseScannedSscc(rawSscc);
  if (sscc === null || sscc !== rawSscc) {
    throw new Error("Inventory verified box SSCC is invalid");
  }
  return {
    eventId: readString(record, "eventId"),
    sscc,
    terminalId: readString(record, "terminalId"),
    terminalName: readString(record, "terminalName"),
    scannedAt: readDate(record, "scannedAt").toISOString(),
    affectedCodeCount: readInteger(record, "affectedCodeCount"),
  };
}

function parseRecentEventRow(value: unknown): InventoryRecentEventDto {
  const record = asRecord(value, "Inventory recent event row is unavailable");
  const kind = readString(record, "kind");
  if (kind !== "item" && kind !== "known_box" && kind !== "old_box") {
    throw new Error("Inventory event kind is invalid");
  }
  const classification = readNullableString(record, "classification");
  if (
    classification !== null &&
    classification !== "expected" &&
    classification !== "protected" &&
    classification !== "ineligible" &&
    classification !== "unknown" &&
    classification !== "voided"
  ) {
    throw new Error("Inventory event classification is invalid");
  }
  return {
    eventId: readString(record, "eventId"),
    codeResultId: readNullableString(record, "codeResultId"),
    kind,
    displayIdentity: formatInventoryEventIdentity(
      kind,
      readNullableString(record, "rawPayload"),
      readString(record, "normalizedIdentity"),
    ),
    authoritativeVerdict: readString(record, "authoritativeVerdict"),
    terminalId: readString(record, "terminalId"),
    terminalName: readString(record, "terminalName"),
    scannedAt: readDate(record, "scannedAt").toISOString(),
    classification,
    observedProductionDate: readNullableString(record, "observedProductionDate"),
  };
}

function parseEvidenceAggregateRow(value: unknown): EvidenceAggregateRow {
  const record = asRecord(value, "Inventory evidence aggregate is unavailable");
  return {
    total: readInteger(record, "total"),
    affectedCodeCount: readInteger(record, "affectedCodeCount"),
    allCanVoid: readBoolean(record, "allCanVoid"),
    allCanRestore: readBoolean(record, "allCanRestore"),
    allCanChangeDate: readBoolean(record, "allCanChangeDate"),
    allCanRemoveItem: readBoolean(record, "allCanRemoveItem"),
  };
}

function evidenceAggregateActions(row: EvidenceAggregateRow): InventoryEvidenceAction[] {
  if (row.total === 0) return [];
  const actions: InventoryEvidenceAction[] = [];
  if (row.allCanVoid) actions.push("void_scan");
  if (row.allCanRestore) actions.push("restore_scan");
  if (row.allCanChangeDate) actions.push("change_date");
  if (row.allCanRemoveItem) actions.push("remove_item");
  return actions;
}

function parseDiscrepancyRow(value: unknown): DiscrepancyRow {
  const record = asRecord(value, "Inventory discrepancy row is unavailable");
  const category = record.category;
  if (
    typeof category !== "string" ||
    !(
      [
        "missing",
        "protected",
        "ineligible",
        "unknown",
        "date_mismatch",
        "voided",
        "invalidated_box",
      ] as const
    ).includes(category as InventoryDiscrepancyCategory)
  ) {
    throw new Error("Inventory discrepancy category is invalid");
  }
  const sourceStatus = record.sourceStatus;
  if (
    sourceStatus !== null &&
    (typeof sourceStatus !== "string" ||
      !INVENTORY_CHZ_STATUSES.includes(sourceStatus as InventoryChzStatus))
  ) {
    throw new Error("Inventory discrepancy source status is invalid");
  }
  return {
    category: category as InventoryDiscrepancyCategory,
    categoryRank: readInteger(record, "categoryRank"),
    displayIdentity: readString(record, "displayIdentity"),
    codeHash: readNullableString(record, "codeHash"),
    sscc: readNullableString(record, "sscc"),
    found: readBoolean(record, "found"),
    sourceStatus: sourceStatus as InventoryChzStatus | null,
    sourceProductionDate: readNullableString(record, "sourceProductionDate"),
    observedProductionDate: readNullableString(record, "observedProductionDate"),
    terminalId: readNullableString(record, "terminalId"),
    terminalName: readNullableString(record, "terminalName"),
    winningScannedAt: readNullableDate(record, "winningScannedAt"),
  };
}

function readInteger(value: unknown, key: string): number {
  const field = Reflect.get(asRecord(value, `Missing ${key}`), key);
  if (typeof field !== "number" || !Number.isInteger(field) || field < 0) {
    throw new Error(`Invalid ${key}`);
  }
  return field;
}

function readString(value: unknown, key: string): string {
  const field = Reflect.get(asRecord(value, `Missing ${key}`), key);
  if (typeof field !== "string") throw new Error(`Invalid ${key}`);
  return field;
}

function readNullableString(value: unknown, key: string): string | null {
  const field = Reflect.get(asRecord(value, `Missing ${key}`), key);
  if (field !== null && typeof field !== "string") throw new Error(`Invalid ${key}`);
  return field;
}

function readBoolean(value: unknown, key: string): boolean {
  const field = Reflect.get(asRecord(value, `Missing ${key}`), key);
  if (typeof field !== "boolean") throw new Error(`Invalid ${key}`);
  return field;
}

function readNullableDate(value: unknown, key: string): Date | string | null {
  const field = Reflect.get(asRecord(value, `Missing ${key}`), key);
  if (field !== null && !(field instanceof Date) && typeof field !== "string") {
    throw new Error(`Invalid ${key}`);
  }
  return field;
}

function readDate(value: unknown, key: string): Date {
  const field = Reflect.get(asRecord(value, `Missing ${key}`), key);
  const date = field instanceof Date ? field : typeof field === "string" ? new Date(field) : null;
  if (date === null || Number.isNaN(date.getTime())) throw new Error(`Invalid ${key}`);
  return date;
}

function readNullableDateAsIso(value: unknown, key: string): string | null {
  const field = Reflect.get(asRecord(value, `Missing ${key}`), key);
  if (field === null) return null;
  return readDate({ [key]: field }, key).toISOString();
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
