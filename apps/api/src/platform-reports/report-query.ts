import type { Db } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql, type SQL } from "drizzle-orm";
import { PlatformReportSourceError, REPORT_MAX_ROWS, type ReportRow } from "./report-definitions";

export type ReportTransaction = Pick<Db, "execute">;
export function inWindow(column: SQL, input: PlatformReportInput): SQL {
  return sql`(${column} >= (${input.fromDate}::date::timestamp AT TIME ZONE ${input.timezone}) AND ${column} < ((${input.toDate}::date + 1)::timestamp AT TIME ZONE ${input.timezone}))`;
}
export function factWindow(column: SQL, input: PlatformReportInput): SQL {
  return input.periodBasis === "production_date"
    ? sql`${column} IS NOT NULL`
    : inWindow(column, input);
}
export function tenantScope(column: SQL, input: PlatformReportInput): SQL {
  return sql`${column} IN (${sql.join(
    input.tenantIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}
export async function reportRows(tx: ReportTransaction, query: SQL): Promise<ReportRow[]> {
  const result = await tx.execute(query);
  if (result.rows.length > REPORT_MAX_ROWS)
    throw new PlatformReportSourceError("REPORT_LIMIT_EXCEEDED");
  return result.rows.map((raw) => {
    const row: ReportRow = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value instanceof Date) row[key] = value.toISOString();
      else if (typeof value === "string" && key.endsWith("_at")) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime()))
          throw new PlatformReportSourceError("REPORT_SOURCE_FAILED");
        row[key] = date.toISOString();
      } else if (
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        row[key] = value;
      else throw new PlatformReportSourceError("REPORT_SOURCE_FAILED");
    }
    return row;
  });
}

export async function validateReportFilters(
  tx: ReportTransaction,
  input: PlatformReportInput,
): Promise<void> {
  for (const [id, table] of [
    [input.lineId, "lines"],
    [input.productId, "products"],
    [input.operatorId, "employees"],
  ] as const) {
    if (!id) continue;
    const result = await tx.execute(
      sql`SELECT id FROM ${sql.identifier(table)} WHERE id = ${id}::uuid AND ${tenantScope(sql`tenant_id`, input)}`,
    );
    if (result.rows.length !== 1) throw new PlatformReportSourceError("REPORT_INVALID_PARAMETERS");
  }
}
