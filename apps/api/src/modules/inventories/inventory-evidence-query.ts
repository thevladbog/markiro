import { sql, type SQL } from "drizzle-orm";

import type { Db } from "@markiro/db";

export const INVENTORY_ACTIONABLE_DISCREPANCY_CATEGORIES = [
  "ineligible",
  "unknown",
  "date_mismatch",
] as const;
export type InventoryActionableDiscrepancyCategory =
  (typeof INVENTORY_ACTIONABLE_DISCREPANCY_CATEGORIES)[number];
export type InventoryEvidenceKind = "item" | "known_box" | "old_box";
export type InventoryEvidenceClassification =
  "expected" | "protected" | "ineligible" | "unknown" | "voided";
export type InventoryEvidenceAction = "void_scan" | "restore_scan" | "change_date" | "remove_item";

export interface InventoryEvidenceFilter {
  scope: "all" | "discrepancies";
  search?: string;
  kind?: InventoryEvidenceKind;
  classification?: InventoryEvidenceClassification;
  discrepancyCategory?: InventoryActionableDiscrepancyCategory;
}

export type InventoryEvidenceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface EvidenceSqlInput {
  tenantId: string;
  inventoryId: string;
  filter: InventoryEvidenceFilter;
  eventIds?: readonly string[];
  excludedEventIds?: readonly string[];
}

export interface ResolveInventoryEvidenceInput extends EvidenceSqlInput {
  order: "newest" | "stable_lock";
  limit?: number;
  offset?: number;
}

export interface InventoryEvidenceSelectionEvent {
  eventId: string;
  kind: InventoryEvidenceKind;
  normalizedIdentity: string;
  rawPayload: string | null;
  authoritativeVerdict: string;
  terminalId: string;
  terminalName: string;
  scannedAt: Date;
  resultIds: string[];
  codeResultId: string | null;
  affectedCodeCount: number;
  discrepancyCodeCount: number;
  classifications: InventoryEvidenceClassification[];
  classification: InventoryEvidenceClassification | null;
  discrepancyCategories: InventoryActionableDiscrepancyCategory[];
  observedProductionDate: string | null;
  actions: InventoryEvidenceAction[];
}

export function buildInventoryEvidenceRowsSql(input: EvidenceSqlInput): SQL {
  const eventFilters: SQL[] = [
    sql`e.tenant_id = ${input.tenantId}`,
    sql`e.inventory_id = ${input.inventoryId}`,
  ];
  if (input.filter.search !== undefined) {
    eventFilters.push(sql`(
      e.normalized_identity ilike ${`%${input.filter.search}%`}
      or coalesce(e.raw_payload, '') ilike ${`%${input.filter.search}%`}
      or d.name ilike ${`%${input.filter.search}%`}
    )`);
  }
  if (input.filter.kind !== undefined) {
    eventFilters.push(sql`e.kind = ${input.filter.kind}`);
  }
  if (input.eventIds !== undefined) {
    eventFilters.push(sql`e.event_id = any(${input.eventIds}::uuid[])`);
  }
  if (input.excludedEventIds !== undefined && input.excludedEventIds.length > 0) {
    eventFilters.push(sql`not (e.event_id = any(${input.excludedEventIds}::uuid[]))`);
  }

  const evidenceFilters: SQL[] = [];
  if (input.filter.scope === "discrepancies") {
    evidenceFilters.push(sql`evidence."discrepancyCodeCount" > 0`);
  }
  if (input.filter.classification !== undefined) {
    evidenceFilters.push(sql`${input.filter.classification} = any(evidence.classifications)`);
  }
  if (input.filter.discrepancyCategory !== undefined) {
    evidenceFilters.push(
      sql`${input.filter.discrepancyCategory} = any(evidence."discrepancyCategories")`,
    );
  }

  const evidenceWhere =
    evidenceFilters.length === 0 ? sql`` : sql`where ${sql.join(evidenceFilters, sql` and `)}`;

  return sql`
    with evidence as (
      select
        e.event_id as "eventId",
        e.kind::text as kind,
        e.normalized_identity as "normalizedIdentity",
        e.raw_payload as "rawPayload",
        e.authoritative_verdict as "authoritativeVerdict",
        e.device_id as "terminalId",
        d.name as "terminalName",
        e.scanned_at as "scannedAt",
        coalesce(a.result_ids, array[]::uuid[]) as "resultIds",
        coalesce(a.affected_code_count, 0)::int as "affectedCodeCount",
        coalesce(a.discrepancy_code_count, 0)::int as "discrepancyCodeCount",
        coalesce(a.classifications, array[]::text[]) as classifications,
        array_remove(array[
          case when coalesce(a.has_ineligible, false) then 'ineligible' end,
          case when coalesce(a.has_unknown, false) then 'unknown' end,
          case when coalesce(a.has_date_mismatch, false) then 'date_mismatch' end
        ], null)::text[] as "discrepancyCategories",
        case
          when coalesce(a.affected_code_count, 0) > 0
            and coalesce(a.observed_date_count, 0) <= 1
          then a.observed_production_date
          else null
        end as "observedProductionDate",
        (coalesce(a.non_voided_count, 0) > 0) as "canVoid",
        (coalesce(a.affected_code_count, 0) > 0
          and coalesce(a.non_voided_count, 0) = 0) as "canRestore",
        (coalesce(a.non_voided_count, 0) = coalesce(a.affected_code_count, 0)
          and coalesce(a.affected_code_count, 0) > 0
          and not coalesce(a.has_active_membership, false)) as "canChangeDate",
        (coalesce(a.non_voided_count, 0) = coalesce(a.affected_code_count, 0)
          and coalesce(a.affected_code_count, 0) > 0
          and coalesce(a.has_open_membership, false)) as "canRemoveItem"
      from inventory_scan_events e
      join station_devices d
        on d.tenant_id = e.tenant_id
       and d.id = e.device_id
      left join lateral (
        select
          array_agg(r.id order by r.id) as result_ids,
          count(r.id)::int as affected_code_count,
          count(r.id) filter (
            where r.classification in ('ineligible', 'unknown')
               or (r.classification <> 'voided'
                 and sc.source_production_date is not null
                 and r.observed_production_date is not null
                 and sc.source_production_date <> r.observed_production_date)
          )::int as discrepancy_code_count,
          array_agg(distinct r.classification::text order by r.classification::text)
            filter (where r.id is not null) as classifications,
          bool_or(r.classification = 'ineligible') as has_ineligible,
          bool_or(r.classification = 'unknown') as has_unknown,
          bool_or(r.classification <> 'voided'
            and sc.source_production_date is not null
            and r.observed_production_date is not null
            and sc.source_production_date <> r.observed_production_date) as has_date_mismatch,
          count(r.id) filter (where r.classification <> 'voided')::int as non_voided_count,
          count(distinct coalesce(r.observed_production_date::text, '<null>'))::int
            as observed_date_count,
          min(r.observed_production_date) as observed_production_date,
          bool_or(i.id is not null) as has_active_membership,
          bool_or(i.id is not null and b.state = 'open') as has_open_membership
        from inventory_code_results r
        left join inventory_snapshot_codes sc
          on sc.tenant_id = r.tenant_id
         and sc.snapshot_id = r.snapshot_id
         and sc.code_hash = r.code_hash
        left join inventory_repack_items i
          on i.tenant_id = r.tenant_id
         and i.inventory_id = r.inventory_id
         and i.result_id = r.id
         and i.removed_at is null
        left join inventory_repack_boxes b
          on b.tenant_id = i.tenant_id
         and b.inventory_id = i.inventory_id
         and b.id = i.box_id
        where r.tenant_id = e.tenant_id
          and r.inventory_id = e.inventory_id
          and r.first_accepted_event_id = e.event_id
      ) a on true
      where ${sql.join(eventFilters, sql` and `)}
    )
    select * from evidence
    ${evidenceWhere}
  `;
}

export async function resolveInventoryEvidenceEvents(
  tx: InventoryEvidenceTransaction,
  input: ResolveInventoryEvidenceInput,
): Promise<InventoryEvidenceSelectionEvent[]> {
  const order =
    input.order === "newest"
      ? sql`order by evidence."scannedAt" desc, evidence."eventId" desc`
      : sql`order by evidence."eventId"`;
  const pagination =
    input.limit === undefined ? sql`` : sql`limit ${input.limit} offset ${input.offset ?? 0}`;
  const result = await tx.execute(
    sql`${buildInventoryEvidenceRowsSql(input)} ${order} ${pagination}`,
  );
  return result.rows.map(parseInventoryEvidenceSqlRow);
}

function parseInventoryEvidenceSqlRow(value: unknown): InventoryEvidenceSelectionEvent {
  const record = asRecord(value, "Inventory evidence row is unavailable");
  const kind = parseKind(readString(record, "kind"));
  const classifications = parseClassifications(record.classifications);
  const discrepancyCategories = parseDiscrepancyCategories(record.discrepancyCategories);
  const scannedAtValue = record.scannedAt;
  if (!(scannedAtValue instanceof Date) && typeof scannedAtValue !== "string") {
    throw new Error("Inventory evidence scan time is invalid");
  }
  const scannedAt = scannedAtValue instanceof Date ? scannedAtValue : new Date(scannedAtValue);
  if (Number.isNaN(scannedAt.getTime())) throw new Error("Inventory evidence scan time is invalid");
  const resultIds = parseStringArray(record.resultIds, "Inventory evidence result IDs are invalid");
  const actions: InventoryEvidenceAction[] = [];
  if (readBoolean(record, "canVoid")) actions.push("void_scan");
  if (readBoolean(record, "canRestore")) actions.push("restore_scan");
  if (readBoolean(record, "canChangeDate")) actions.push("change_date");
  if (readBoolean(record, "canRemoveItem")) actions.push("remove_item");
  return {
    eventId: readString(record, "eventId"),
    kind,
    normalizedIdentity: readString(record, "normalizedIdentity"),
    rawPayload: readNullableString(record, "rawPayload"),
    authoritativeVerdict: readString(record, "authoritativeVerdict"),
    terminalId: readString(record, "terminalId"),
    terminalName: readString(record, "terminalName"),
    scannedAt,
    resultIds,
    codeResultId: resultIds.length === 1 ? resultIds[0]! : null,
    affectedCodeCount: readInteger(record, "affectedCodeCount"),
    discrepancyCodeCount: readInteger(record, "discrepancyCodeCount"),
    classifications,
    classification: classifications.length === 1 ? classifications[0]! : null,
    discrepancyCategories,
    observedProductionDate: readNullableString(record, "observedProductionDate"),
    actions,
  };
}

function parseKind(value: string): InventoryEvidenceKind {
  if (value === "item" || value === "known_box" || value === "old_box") return value;
  throw new Error("Inventory evidence event kind is invalid");
}

function parseClassifications(value: unknown): InventoryEvidenceClassification[] {
  const values = parseStringArray(value, "Inventory evidence classifications are invalid");
  for (const item of values) {
    if (
      item !== "expected" &&
      item !== "protected" &&
      item !== "ineligible" &&
      item !== "unknown" &&
      item !== "voided"
    ) {
      throw new Error("Inventory evidence classification is invalid");
    }
  }
  return values as InventoryEvidenceClassification[];
}

function parseDiscrepancyCategories(value: unknown): InventoryActionableDiscrepancyCategory[] {
  const values = parseStringArray(value, "Inventory evidence discrepancy categories are invalid");
  for (const item of values) {
    if (
      !INVENTORY_ACTIONABLE_DISCREPANCY_CATEGORIES.includes(
        item as InventoryActionableDiscrepancyCategory,
      )
    ) {
      throw new Error("Inventory evidence discrepancy category is invalid");
    }
  }
  return values as InventoryActionableDiscrepancyCategory[];
}

function parseStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(message);
  }
  return value as string[];
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Inventory evidence ${key} is invalid`);
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Inventory evidence ${key} is invalid`);
  return value;
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Inventory evidence ${key} is invalid`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Inventory evidence ${key} is invalid`);
  return value;
}
