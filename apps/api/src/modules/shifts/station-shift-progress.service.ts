import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { StationShiftProgressDto } from "./dto";

/**
 * The station work screen's shift-wide total (design 2026-09-25). One
 * read-only snapshot answers how many units the shift holds across every
 * device -- `code_registry` owners, which already exclude undone, cleared,
 * disassembled and lost codes, plus reprocessed units when the shift allows
 * previously accepted codes -- and how many of them the calling device owns.
 * The station adds its live local count to the difference.
 */
@Injectable()
export class StationShiftProgressService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async progress(
    tenantId: string,
    shiftId: string,
    deviceId: string,
  ): Promise<StationShiftProgressDto> {
    // A malformed id is just another shift this device cannot see.
    if (!z.uuid().safeParse(shiftId).success) throw new NotFoundException();
    return this.db.transaction(
      async (tx) => {
        const result = await tx.execute(sql`
          with target_shift as (
            select shift.tenant_id, shift.id, shift.allow_previously_accepted_codes
            from shifts shift
            where shift.tenant_id = ${tenantId}
              and shift.id = ${shiftId}
          )
          select
            transaction_timestamp() as "asOf",
            (
              select count(*)::int
              from code_registry registry
              where registry.tenant_id = target.tenant_id
                and registry.shift_id = target.id
            ) as "registryUnits",
            (
              select count(*)::int
              from code_registry registry
              where registry.tenant_id = target.tenant_id
                and registry.shift_id = target.id
                and registry.terminal_id = ${deviceId}
            ) as "deviceRegistryUnits",
            (
              select count(*)::int
              from validation_code_reprocessings reprocessing
              where target.allow_previously_accepted_codes
                and reprocessing.tenant_id = target.tenant_id
                and reprocessing.shift_id = target.id
            ) as "reprocessedUnits",
            (
              select count(*)::int
              from validation_code_reprocessings reprocessing
              where target.allow_previously_accepted_codes
                and reprocessing.tenant_id = target.tenant_id
                and reprocessing.shift_id = target.id
                and reprocessing.terminal_id = ${deviceId}
            ) as "deviceReprocessedUnits"
          from target_shift target
        `);
        const row = result.rows[0];
        if (!row) throw new NotFoundException();
        return {
          shiftId,
          acceptedUnits:
            countOf(row.registryUnits, "registry units") +
            countOf(row.reprocessedUnits, "reprocessed units"),
          deviceAcceptedUnits:
            countOf(row.deviceRegistryUnits, "device registry units") +
            countOf(row.deviceReprocessedUnits, "device reprocessed units"),
          asOf: isoOf(row.asOf),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}

function countOf(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

function isoOf(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid progress timestamp");
  return parsed.toISOString();
}
