import { Inject, Injectable } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { platformReportInputSchema, type PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { DB } from "../auth/auth.module";
import {
  applyReportPrivacy,
  PlatformReportSourceError,
  REPORT_DEFINITIONS,
  REPORT_MAX_ROWS,
  type PlatformReportSource,
  type ReportRow,
} from "./report-definitions";
import { validateReportFilters } from "./report-query";
import { loadShiftRows, shiftColumns } from "./shift-report-source";
import { INVENTORY_COLUMNS, loadInventoryRows } from "./inventory-report-source";
import { COMMERCEML_COLUMNS, loadCommerceMlRows } from "./commerceml-report-source";

// One source snapshot across all application processes; contention is not a failed generation attempt.
export const REPORT_SOURCE_LOCK_KEY = "7314982016401";
export class PlatformReportSourceBusyError extends Error {
  constructor() {
    super("REPORT_SOURCE_BUSY");
    this.name = "PlatformReportSourceBusyError";
  }
}
export { PlatformReportSourceError } from "./report-definitions";
export type { PlatformReportSource } from "./report-definitions";

@Injectable()
export class PlatformReportSourceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async load(rawInput: PlatformReportInput): Promise<PlatformReportSource> {
    const parsed = platformReportInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PlatformReportSourceError("REPORT_INVALID_PARAMETERS");
    const input = parsed.data;
    return this.db
      .transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
          const lock = await tx.execute(
            sql`SELECT pg_try_advisory_xact_lock(${REPORT_SOURCE_LOCK_KEY}::bigint) AS acquired, transaction_timestamp() AS snapshot_at`,
          );
          if (lock.rows[0]?.acquired !== true) throw new PlatformReportSourceBusyError();
          const timestamp = lock.rows[0]?.snapshot_at;
          const snapshotAt =
            timestamp instanceof Date
              ? timestamp
              : typeof timestamp === "string"
                ? new Date(timestamp)
                : null;
          if (!snapshotAt || Number.isNaN(snapshotAt.getTime()))
            throw new PlatformReportSourceError("REPORT_SOURCE_FAILED");
          await validateReportFilters(tx, input);
          let columns: string[];
          let rows: ReportRow[];
          if (input.reportType === "commerceml") {
            columns = COMMERCEML_COLUMNS;
            rows = await loadCommerceMlRows(tx, input);
          } else if (input.reportType === "inventories") {
            columns = INVENTORY_COLUMNS;
            rows = await loadInventoryRows(tx, input);
          } else if (input.reportType === "summary") {
            columns = ["record_type", ...new Set([...shiftColumns(input), ...INVENTORY_COLUMNS])];
            const shifts = await loadShiftRows(tx, input);
            const inventories = await loadInventoryRows(tx, input);
            rows = [
              ...shifts.map((row) => ({ ...row, record_type: "shift" })),
              ...inventories.map((row) => ({ ...row, record_type: "inventory" })),
            ];
            rows.sort(
              (a, b) =>
                String(a.tenant_id).localeCompare(String(b.tenant_id)) ||
                String(a.record_type).localeCompare(String(b.record_type)) ||
                String(a.shift_id ?? a.inventory_id).localeCompare(
                  String(b.shift_id ?? b.inventory_id),
                ),
            );
          } else {
            columns = shiftColumns(input);
            rows = await loadShiftRows(tx, input);
          }
          if (rows.length > REPORT_MAX_ROWS)
            throw new PlatformReportSourceError("REPORT_LIMIT_EXCEEDED");
          return applyReportPrivacy(input, {
            snapshotAt,
            columns,
            rows,
            definitions: { ...REPORT_DEFINITIONS },
          });
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      )
      .catch((error: unknown) => {
        if (
          error instanceof PlatformReportSourceError ||
          error instanceof PlatformReportSourceBusyError
        )
          throw error;
        const cause = error instanceof Error && "cause" in error ? error.cause : error;
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
        throw new PlatformReportSourceError(
          code === "57014" ? "REPORT_SOURCE_TIMEOUT" : "REPORT_SOURCE_FAILED",
        );
      });
  }
}
