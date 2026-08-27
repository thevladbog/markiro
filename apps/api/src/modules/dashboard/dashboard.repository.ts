import { Inject, Injectable } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { formatShiftNumber } from "@markiro/domain";
import { sql } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import type {
  DashboardActiveShiftDto,
  DashboardBucketDto,
  DashboardMode,
  DashboardPeriod,
  DashboardWindowDto,
} from "./dto";

export interface DashboardOverviewFacts {
  generatedAt: Date;
  timeZone: string;
  setup: {
    productCount: number;
    shiftCount: number;
    hasRunShift: boolean;
    activeShiftCount: number;
  };
  today: {
    validationAcceptedUnits: number;
    aggregationClosedBoxes: number;
    aggregationContainedUnits: number;
    activeShiftCount: number;
    includedClosedShiftCount: number;
  };
  currentWindow: DashboardWindowDto;
  comparisonWindow: DashboardWindowDto;
  buckets: DashboardBucketDto[];
  activeShifts: DashboardActiveShiftDto[];
  unreviewedConflictCount: number;
  lateDataShiftCount: number;
  missingDurationModes: DashboardMode[];
}

export interface DashboardRepository {
  load(tenantId: string, period: DashboardPeriod, now: Date): Promise<DashboardOverviewFacts>;
}

type DashboardTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DatabaseNumber = number | string;
type DatabaseRow = Record<string, unknown>;

interface ProfileRow {
  timeZone: string;
  boundGeneratedAt: Date | string;
}

interface SummaryRow {
  productCount: DatabaseNumber;
  shiftCount: DatabaseNumber;
  hasRunShift: boolean;
  activeShiftCount: DatabaseNumber;
  validationAcceptedUnits: DatabaseNumber;
  aggregationClosedBoxes: DatabaseNumber;
  aggregationContainedUnits: DatabaseNumber;
  includedClosedShiftCount: DatabaseNumber;
  unreviewedConflictCount: DatabaseNumber;
  lateDataShiftCount: DatabaseNumber;
}

interface WindowRow {
  kind: "current" | "comparison" | "bucket";
  bucketIndex: number | null;
  startAt: Date | string;
  endAt: Date | string;
  label: string | null;
  validationAcceptedUnits: DatabaseNumber;
  validationShiftHours: DatabaseNumber;
  aggregationClosedBoxes: DatabaseNumber;
  aggregationContainedUnits: DatabaseNumber;
  aggregationShiftHours: DatabaseNumber;
}

interface ActiveShiftRow {
  id: string;
  numberMonthKey: string;
  numberSeq: DatabaseNumber;
  createdFrom: "admin" | "station";
  mode: DashboardMode;
  productName: string | null;
  lineName: string | null;
  openedAt: Date | string;
  lateDataAt: Date | string | null;
  validationAcceptedUnits: DatabaseNumber;
  aggregationClosedBoxes: DatabaseNumber;
  aggregationContainedUnits: DatabaseNumber;
}

@Injectable()
export class DrizzleDashboardRepository implements DashboardRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  load(tenantId: string, period: DashboardPeriod, now: Date): Promise<DashboardOverviewFacts> {
    return this.db.transaction((tx) => this.loadFromTransaction(tx, tenantId, period, now), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  private async loadFromTransaction(
    tx: DashboardTransaction,
    tenantId: string,
    period: DashboardPeriod,
    generatedAt: Date,
  ): Promise<DashboardOverviewFacts> {
    const timeZone = await this.loadTimeZone(tx, tenantId, generatedAt);
    const summary = await this.loadSummary(tx, tenantId, timeZone, generatedAt);
    const windowRows = await this.loadWindows(tx, tenantId, period, timeZone, generatedAt);
    const activeShifts = await this.loadActiveShifts(tx, tenantId, generatedAt);

    const currentRow = windowRows.find((row) => row.kind === "current");
    const comparisonRow = windowRows.find((row) => row.kind === "comparison");
    if (!currentRow || !comparisonRow) {
      throw new Error("Dashboard metric windows are unavailable");
    }
    const currentWindow = mapWindow(currentRow);
    const comparisonWindow = mapWindow(comparisonRow);
    const buckets = windowRows
      .filter((row): row is WindowRow & { bucketIndex: number; label: string } => {
        return row.kind === "bucket" && row.bucketIndex !== null && row.label !== null;
      })
      .sort((left, right) => left.bucketIndex - right.bucketIndex)
      .map((row) => ({ ...mapWindow(row), label: row.label }));
    const missingDurationModes: DashboardMode[] = [];
    if (currentWindow.validation.acceptedUnits > 0 && currentWindow.validation.shiftHours === 0) {
      missingDurationModes.push("validation");
    }
    if (
      (currentWindow.aggregation.closedBoxes > 0 || currentWindow.aggregation.containedUnits > 0) &&
      currentWindow.aggregation.shiftHours === 0
    ) {
      missingDurationModes.push("aggregation");
    }

    return {
      generatedAt,
      timeZone,
      setup: {
        productCount: asNumber(summary.productCount, "product count"),
        shiftCount: asNumber(summary.shiftCount, "shift count"),
        hasRunShift: summary.hasRunShift,
        activeShiftCount: asNumber(summary.activeShiftCount, "active shift count"),
      },
      today: {
        validationAcceptedUnits: asNumber(
          summary.validationAcceptedUnits,
          "today validation accepted units",
        ),
        aggregationClosedBoxes: asNumber(
          summary.aggregationClosedBoxes,
          "today aggregation closed boxes",
        ),
        aggregationContainedUnits: asNumber(
          summary.aggregationContainedUnits,
          "today aggregation contained units",
        ),
        activeShiftCount: asNumber(summary.activeShiftCount, "today active shift count"),
        includedClosedShiftCount: asNumber(
          summary.includedClosedShiftCount,
          "today included closed shift count",
        ),
      },
      currentWindow,
      comparisonWindow,
      buckets,
      activeShifts,
      unreviewedConflictCount: asNumber(
        summary.unreviewedConflictCount,
        "unreviewed conflict count",
      ),
      lateDataShiftCount: asNumber(summary.lateDataShiftCount, "late-data shift count"),
      missingDurationModes,
    };
  }

  private async loadTimeZone(
    tx: DashboardTransaction,
    tenantId: string,
    generatedAt: Date,
  ): Promise<string> {
    const result = await tx.execute(sql<ProfileRow>`
      select
        profile.time_zone as "timeZone",
        ${generatedAt}::timestamptz as "boundGeneratedAt"
      from org_profiles profile
      where profile.tenant_id = ${tenantId}
      limit 1
    `);
    const row = result.rows[0];
    const timeZone = readString(row, "timeZone", "timezone");
    asIsoTimestamp(readTimestamp(row, "boundGeneratedAt"), "bound generated-at timestamp");
    assertValidTimeZone(timeZone);
    return timeZone;
  }

  private async loadSummary(
    tx: DashboardTransaction,
    tenantId: string,
    timeZone: string,
    generatedAt: Date,
  ): Promise<SummaryRow> {
    const result = await tx.execute(sql<SummaryRow>`
      with params as (
        select
          ${tenantId}::text as tenant_id,
          ${generatedAt}::timestamptz as generated_at,
          ${timeZone}::text as time_zone
      ),
      local_clock as (
        select
          p.tenant_id,
          p.generated_at,
          p.time_zone,
          p.generated_at at time zone p.time_zone as local_now
        from params p
      ),
      today_bounds as (
        select
          lc.tenant_id,
          lc.generated_at,
          date_trunc('day', lc.local_now) at time zone lc.time_zone as today_start
        from local_clock lc
      ),
      included_shifts as (
        select
          shift.tenant_id,
          shift.id,
          shift.mode,
          shift.status,
          shift.late_data_at
        from shifts shift
        inner join today_bounds bounds
          on bounds.tenant_id = shift.tenant_id
        where shift.tenant_id = ${tenantId}
          and (
            shift.status = 'active'
            or (
              shift.status = 'closed'
              and shift.closed_at >= bounds.today_start
              and shift.closed_at < bounds.generated_at
            )
          )
      )
      select
        (
          select count(*)::int
          from products product
          where product.tenant_id = p.tenant_id
        ) as "productCount",
        (
          select count(*)::int
          from shifts shift
          where shift.tenant_id = p.tenant_id
        ) as "shiftCount",
        exists (
          select 1
          from shifts shift
          where shift.tenant_id = p.tenant_id
            and shift.status in ('active', 'closed')
        ) as "hasRunShift",
        (
          select count(*)::int
          from included_shifts included
          where included.tenant_id = p.tenant_id
            and included.status = 'active'
        ) as "activeShiftCount",
        (
          select count(*)::int
          from code_registry registry
          inner join included_shifts included
            on included.tenant_id = registry.tenant_id
            and included.id = registry.shift_id
          where registry.tenant_id = p.tenant_id
            and included.tenant_id = p.tenant_id
            and included.mode = 'validation'
        ) as "validationAcceptedUnits",
        (
          select count(*)::int
          from boxes box
          inner join included_shifts included
            on included.tenant_id = box.tenant_id
            and included.id = box.shift_id
          where box.tenant_id = p.tenant_id
            and included.tenant_id = p.tenant_id
            and included.mode = 'aggregation'
            and box.closed_at is not null
            and box.disassembled_at is null
        ) as "aggregationClosedBoxes",
        (
          select count(*)::int
          from box_items item
          inner join boxes box
            on box.tenant_id = item.tenant_id
            and box.id = item.box_id
          inner join included_shifts included
            on included.tenant_id = box.tenant_id
            and included.id = box.shift_id
          where item.tenant_id = p.tenant_id
            and box.tenant_id = p.tenant_id
            and included.tenant_id = p.tenant_id
            and included.mode = 'aggregation'
            and box.closed_at is not null
            and box.disassembled_at is null
            and item.displaced_at is null
            and item.removed_at is null
        ) as "aggregationContainedUnits",
        (
          select count(*)::int
          from included_shifts included
          where included.tenant_id = p.tenant_id
            and included.status = 'closed'
        ) as "includedClosedShiftCount",
        (
          select count(distinct conflict.id)::int
          from code_conflicts conflict
          where conflict.tenant_id = p.tenant_id
            and conflict.reviewed_at is null
            and exists (
              select 1
              from included_shifts included
              where included.tenant_id = conflict.tenant_id
                and included.tenant_id = p.tenant_id
                and (
                  included.id = conflict.losing_shift_id
                  or included.id = conflict.winning_shift_id
                )
            )
        ) as "unreviewedConflictCount",
        (
          select count(*)::int
          from included_shifts included
          where included.tenant_id = p.tenant_id
            and included.late_data_at is not null
        ) as "lateDataShiftCount"
      from params p
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Dashboard summary facts are unavailable");
    return parseSummaryRow(row);
  }

  private async loadWindows(
    tx: DashboardTransaction,
    tenantId: string,
    period: DashboardPeriod,
    timeZone: string,
    generatedAt: Date,
  ): Promise<WindowRow[]> {
    const result = await tx.execute(sql<WindowRow>`
      with params as (
        select
          ${tenantId}::text as tenant_id,
          ${generatedAt}::timestamptz as generated_at,
          ${timeZone}::text as time_zone,
          ${period}::text as period
      ),
      local_clock as (
        select
          p.*,
          p.generated_at at time zone p.time_zone as local_now
        from params p
      ),
      window_config as (
        select
          lc.*,
          case lc.period
            when 'today' then date_trunc('day', lc.local_now)
            when '7d' then date_trunc('day', lc.local_now) - interval '6 days'
            when '30d' then date_trunc('day', lc.local_now) - interval '29 days'
            when '12w' then date_trunc('week', lc.local_now) - interval '11 weeks'
          end as current_local_start,
          case lc.period
            when 'today' then interval '1 day'
            when '7d' then interval '7 days'
            when '30d' then interval '30 days'
            when '12w' then interval '12 weeks'
          end as comparison_delta,
          case lc.period
            when 'today' then interval '1 hour'
            when '7d' then interval '1 day'
            when '30d' then interval '1 day'
            when '12w' then interval '1 week'
          end as bucket_step
        from local_clock lc
      ),
      window_intervals as (
        select
          'current'::text as kind,
          null::int as bucket_index,
          wc.current_local_start at time zone wc.time_zone as start_at,
          wc.generated_at as end_at,
          null::text as label
        from window_config wc
        union all
        select
          'comparison'::text as kind,
          null::int as bucket_index,
          (wc.current_local_start - wc.comparison_delta) at time zone wc.time_zone as start_at,
          (wc.local_now - wc.comparison_delta) at time zone wc.time_zone as end_at,
          null::text as label
        from window_config wc
      ),
      local_bucket_edges as (
        select
          row_number() over (order by edge.local_start)::int - 1 as bucket_index,
          edge.local_start,
          least(edge.local_start + wc.bucket_step, wc.local_now) as local_end,
          wc.local_now,
          wc.generated_at,
          wc.time_zone,
          wc.period
        from window_config wc
        cross join lateral generate_series(
          wc.current_local_start,
          wc.local_now,
          wc.bucket_step
        ) as edge(local_start)
        where edge.local_start < wc.local_now
      ),
      bucket_intervals as (
        select
          'bucket'::text as kind,
          edge.bucket_index,
          edge.local_start at time zone edge.time_zone as start_at,
          case
            when edge.local_end = edge.local_now then edge.generated_at
            else edge.local_end at time zone edge.time_zone
          end as end_at,
          case edge.period
            when 'today' then to_char(edge.local_start, 'HH24:MI')
            when '7d' then to_char(edge.local_start, 'YYYY-MM-DD')
            when '30d' then to_char(edge.local_start, 'YYYY-MM-DD')
            when '12w' then to_char(edge.local_start, 'IYYY-"W"IW')
          end as label
        from local_bucket_edges edge
      ),
      intervals as (
        select * from window_intervals
        union all
        select * from bucket_intervals
      )
      select
        interval.kind as "kind",
        interval.bucket_index as "bucketIndex",
        interval.start_at as "startAt",
        interval.end_at as "endAt",
        interval.label as "label",
        (
          select count(*)::int
          from code_registry registry
          inner join shifts shift
            on shift.tenant_id = registry.tenant_id
            and shift.id = registry.shift_id
          where registry.tenant_id = p.tenant_id
            and shift.tenant_id = p.tenant_id
            and shift.mode = 'validation'
            and registry.scanned_at >= interval.start_at
            and registry.scanned_at < interval.end_at
        ) as "validationAcceptedUnits",
        coalesce((
          select sum(
            greatest(
              extract(epoch from (
                least(coalesce(shift.closed_at, p.generated_at), interval.end_at)
                - greatest(shift.opened_at, interval.start_at)
              )),
              0
            ) / 3600
          )
          from shifts shift
          where shift.tenant_id = p.tenant_id
            and shift.mode = 'validation'
            and shift.status in ('active', 'closed')
            and shift.opened_at is not null
            and shift.opened_at < interval.end_at
            and coalesce(shift.closed_at, p.generated_at) > interval.start_at
        ), 0)::numeric as "validationShiftHours",
        (
          select count(*)::int
          from boxes box
          inner join shifts shift
            on shift.tenant_id = box.tenant_id
            and shift.id = box.shift_id
          where box.tenant_id = p.tenant_id
            and shift.tenant_id = p.tenant_id
            and shift.mode = 'aggregation'
            and box.closed_at is not null
            and box.disassembled_at is null
            and box.closed_at >= interval.start_at
            and box.closed_at < interval.end_at
        ) as "aggregationClosedBoxes",
        (
          select count(*)::int
          from box_items item
          inner join boxes box
            on box.tenant_id = item.tenant_id
            and box.id = item.box_id
          inner join shifts shift
            on shift.tenant_id = box.tenant_id
            and shift.id = box.shift_id
          where item.tenant_id = p.tenant_id
            and box.tenant_id = p.tenant_id
            and shift.tenant_id = p.tenant_id
            and shift.mode = 'aggregation'
            and box.closed_at is not null
            and box.disassembled_at is null
            and item.displaced_at is null
            and item.removed_at is null
            and box.closed_at >= interval.start_at
            and box.closed_at < interval.end_at
        ) as "aggregationContainedUnits",
        coalesce((
          select sum(
            greatest(
              extract(epoch from (
                least(coalesce(shift.closed_at, p.generated_at), interval.end_at)
                - greatest(shift.opened_at, interval.start_at)
              )),
              0
            ) / 3600
          )
          from shifts shift
          where shift.tenant_id = p.tenant_id
            and shift.mode = 'aggregation'
            and shift.status in ('active', 'closed')
            and shift.opened_at is not null
            and shift.opened_at < interval.end_at
            and coalesce(shift.closed_at, p.generated_at) > interval.start_at
        ), 0)::numeric as "aggregationShiftHours"
      from intervals interval
      cross join params p
      order by
        case interval.kind when 'current' then 0 when 'comparison' then 1 else 2 end,
        interval.bucket_index nulls first
    `);
    return result.rows.map(parseWindowRow);
  }

  private async loadActiveShifts(
    tx: DashboardTransaction,
    tenantId: string,
    generatedAt: Date,
  ): Promise<DashboardActiveShiftDto[]> {
    const result = await tx.execute(sql<ActiveShiftRow>`
      with params as (
        select
          ${tenantId}::text as tenant_id,
          ${generatedAt}::timestamptz as generated_at
      ),
      selected_active_shifts as (
        select
          shift.tenant_id,
          shift.id,
          shift.number_month_key,
          shift.number_seq,
          shift.created_from,
          shift.mode,
          shift.opened_at,
          shift.late_data_at,
          product.name as product_name,
          line.name as line_name,
          p.generated_at
        from shifts shift
        inner join params p
          on p.tenant_id = shift.tenant_id
        left join products product
          on product.tenant_id = shift.tenant_id
          and product.id = shift.product_id
        left join lines line
          on line.tenant_id = shift.tenant_id
          and line.id = shift.line_id
        where shift.tenant_id = ${tenantId}
          and shift.status = 'active'
          and shift.opened_at is not null
        order by shift.opened_at, shift.id
        limit 5
      )
      select
        active.id as "id",
        active.number_month_key as "numberMonthKey",
        active.number_seq as "numberSeq",
        active.created_from as "createdFrom",
        active.mode as "mode",
        active.product_name as "productName",
        active.line_name as "lineName",
        active.opened_at as "openedAt",
        active.late_data_at as "lateDataAt",
        (
          select count(*)::int
          from code_registry registry
          where registry.tenant_id = active.tenant_id
            and registry.tenant_id = ${tenantId}
            and registry.shift_id = active.id
            and active.mode = 'validation'
        ) as "validationAcceptedUnits",
        (
          select count(*)::int
          from boxes box
          where box.tenant_id = active.tenant_id
            and box.tenant_id = ${tenantId}
            and box.shift_id = active.id
            and active.mode = 'aggregation'
            and box.closed_at is not null
            and box.disassembled_at is null
        ) as "aggregationClosedBoxes",
        (
          select count(*)::int
          from box_items item
          inner join boxes box
            on box.tenant_id = item.tenant_id
            and box.id = item.box_id
          where item.tenant_id = active.tenant_id
            and item.tenant_id = ${tenantId}
            and box.tenant_id = active.tenant_id
            and box.tenant_id = ${tenantId}
            and box.shift_id = active.id
            and active.mode = 'aggregation'
            and box.closed_at is not null
            and box.disassembled_at is null
            and item.displaced_at is null
            and item.removed_at is null
        ) as "aggregationContainedUnits"
      from selected_active_shifts active
      order by active.opened_at, active.id
    `);

    return result.rows.map(parseActiveShiftRow).map((row) => ({
      id: row.id,
      number: formatShiftNumber({
        monthKey: row.numberMonthKey,
        seq: asNumber(row.numberSeq, "active shift number sequence"),
        createdFrom: row.createdFrom,
      }),
      productName: row.productName,
      lineName: row.lineName,
      openedAt: asIsoTimestamp(row.openedAt, "active shift opening timestamp"),
      lateDataAt:
        row.lateDataAt === null
          ? null
          : asIsoTimestamp(row.lateDataAt, "active shift late-data timestamp"),
      output:
        row.mode === "validation"
          ? {
              mode: "validation",
              acceptedUnits: asNumber(
                row.validationAcceptedUnits,
                "active validation accepted units",
              ),
            }
          : {
              mode: "aggregation",
              closedBoxes: asNumber(row.aggregationClosedBoxes, "active aggregation closed boxes"),
              containedUnits: asNumber(
                row.aggregationContainedUnits,
                "active aggregation contained units",
              ),
            },
    }));
  }
}

function mapWindow(row: WindowRow): DashboardWindowDto {
  const validationAcceptedUnits = asNumber(
    row.validationAcceptedUnits,
    "validation accepted units",
  );
  const validationShiftHours = asNumber(row.validationShiftHours, "validation shift hours");
  const aggregationClosedBoxes = asNumber(row.aggregationClosedBoxes, "aggregation closed boxes");
  const aggregationContainedUnits = asNumber(
    row.aggregationContainedUnits,
    "aggregation contained units",
  );
  const aggregationShiftHours = asNumber(row.aggregationShiftHours, "aggregation shift hours");
  return {
    start: asIsoTimestamp(row.startAt, "dashboard window start"),
    end: asIsoTimestamp(row.endAt, "dashboard window end"),
    validation: {
      acceptedUnits: validationAcceptedUnits,
      shiftHours: validationShiftHours,
      unitsPerShiftHour: rate(validationAcceptedUnits, validationShiftHours),
    },
    aggregation: {
      closedBoxes: aggregationClosedBoxes,
      containedUnits: aggregationContainedUnits,
      shiftHours: aggregationShiftHours,
      boxesPerShiftHour: rate(aggregationClosedBoxes, aggregationShiftHours),
      containedUnitsPerShiftHour: rate(aggregationContainedUnits, aggregationShiftHours),
    },
  };
}

function parseSummaryRow(row: DatabaseRow): SummaryRow {
  return {
    productCount: readNumber(row, "productCount"),
    shiftCount: readNumber(row, "shiftCount"),
    hasRunShift: readBoolean(row, "hasRunShift"),
    activeShiftCount: readNumber(row, "activeShiftCount"),
    validationAcceptedUnits: readNumber(row, "validationAcceptedUnits"),
    aggregationClosedBoxes: readNumber(row, "aggregationClosedBoxes"),
    aggregationContainedUnits: readNumber(row, "aggregationContainedUnits"),
    includedClosedShiftCount: readNumber(row, "includedClosedShiftCount"),
    unreviewedConflictCount: readNumber(row, "unreviewedConflictCount"),
    lateDataShiftCount: readNumber(row, "lateDataShiftCount"),
  };
}

function parseWindowRow(row: DatabaseRow): WindowRow {
  const kind = readString(row, "kind", "window kind");
  if (kind !== "current" && kind !== "comparison" && kind !== "bucket") {
    throw new Error("Invalid dashboard window kind");
  }
  const rawBucketIndex = row.bucketIndex;
  const bucketIndex =
    rawBucketIndex === null ? null : asNumberValue(rawBucketIndex, "bucket index");
  const rawLabel = row.label;
  if (rawLabel !== null && typeof rawLabel !== "string") {
    throw new Error("Invalid dashboard bucket label");
  }
  return {
    kind,
    bucketIndex,
    startAt: readTimestamp(row, "startAt"),
    endAt: readTimestamp(row, "endAt"),
    label: rawLabel,
    validationAcceptedUnits: readNumber(row, "validationAcceptedUnits"),
    validationShiftHours: readNumber(row, "validationShiftHours"),
    aggregationClosedBoxes: readNumber(row, "aggregationClosedBoxes"),
    aggregationContainedUnits: readNumber(row, "aggregationContainedUnits"),
    aggregationShiftHours: readNumber(row, "aggregationShiftHours"),
  };
}

function parseActiveShiftRow(row: DatabaseRow): ActiveShiftRow {
  const createdFrom = readString(row, "createdFrom", "active shift origin");
  if (createdFrom !== "admin" && createdFrom !== "station") {
    throw new Error("Invalid dashboard active shift origin");
  }
  const mode = readString(row, "mode", "active shift mode");
  if (mode !== "validation" && mode !== "aggregation") {
    throw new Error("Invalid dashboard active shift mode");
  }
  return {
    id: readString(row, "id", "active shift id"),
    numberMonthKey: readString(row, "numberMonthKey", "active shift month key"),
    numberSeq: readNumber(row, "numberSeq"),
    createdFrom,
    mode,
    productName: readNullableString(row, "productName", "active shift product name"),
    lineName: readNullableString(row, "lineName", "active shift line name"),
    openedAt: readTimestamp(row, "openedAt"),
    lateDataAt: readNullableTimestamp(row, "lateDataAt"),
    validationAcceptedUnits: readNumber(row, "validationAcceptedUnits"),
    aggregationClosedBoxes: readNumber(row, "aggregationClosedBoxes"),
    aggregationContainedUnits: readNumber(row, "aggregationContainedUnits"),
  };
}

function rate(output: number, shiftHours: number): number | null {
  if (shiftHours === 0) return null;
  return Math.round((output / shiftHours) * 10) / 10;
}

function asNumber(value: DatabaseNumber, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid dashboard ${field}`);
  return parsed;
}

function asNumberValue(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`Invalid dashboard ${field}`);
  }
  return asNumber(value, field);
}

function readNumber(row: DatabaseRow, key: string): number {
  return asNumberValue(row[key], key);
}

function readString(row: DatabaseRow | undefined, key: string, field: string): string {
  const value = row?.[key];
  if (typeof value !== "string") throw new Error(`Invalid dashboard ${field}`);
  return value;
}

function readNullableString(row: DatabaseRow, key: string, field: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid dashboard ${field}`);
  return value;
}

function readBoolean(row: DatabaseRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`Invalid dashboard ${key}`);
  return value;
}

function readTimestamp(row: DatabaseRow | undefined, key: string): Date | string {
  const value = row?.[key];
  if (value instanceof Date || typeof value === "string") return value;
  throw new Error(`Invalid dashboard ${key}`);
}

function readNullableTimestamp(row: DatabaseRow, key: string): Date | string | null {
  const value = row[key];
  if (value === null) return null;
  if (value instanceof Date || typeof value === "string") return value;
  throw new Error(`Invalid dashboard ${key}`);
}

function asIsoTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid dashboard ${field}`);
  return parsed.toISOString();
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid dashboard timezone: ${timeZone}`);
  }
}
