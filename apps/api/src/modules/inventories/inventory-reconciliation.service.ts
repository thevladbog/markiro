import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import { INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import type {
  InventoryDiscrepancyCategory,
  InventoryDiscrepancyDto,
  InventoryDiscrepancyWinnerDto,
  InventoryProgressDto,
  ListInventoryDiscrepanciesQueryDto,
  ListInventoryDiscrepanciesResponseDto,
} from "./dto";

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
    return {
      inventoryId,
      snapshotId: inventory.snapshotId,
      status: inventory.status,
      resultRevision: inventory.resultRevision,
      ...counts,
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

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
