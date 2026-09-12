import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  VALIDATION_REPROCESSING_PROTOCOL,
  validationOccurrenceStatusSchema,
  type ValidationOccurrenceStatusQuery,
  type ValidationOccurrenceStatus,
} from "@markiro/domain";

/** Reconcile acknowledged occurrences as well as pending ones: an earlier competing scan can arrive later. */
export async function loadValidationOccurrenceStatus(
  db: Db,
  tenantId: string,
  deviceId: string,
  query: ValidationOccurrenceStatusQuery,
): Promise<ValidationOccurrenceStatus> {
  return db.transaction(
    async (tx) => {
      const ids = [...new Set(query.occurrences.map((item) => item.shiftId))];
      if (ids.length === 0) return { protocol: VALIDATION_REPROCESSING_PROTOCOL, occurrences: [] };
      const shifts = await tx
        .select({ id: schema.shifts.id })
        .from(schema.shifts)
        .innerJoin(
          schema.shiftDeviceParticipants,
          and(
            eq(schema.shiftDeviceParticipants.tenantId, schema.shifts.tenantId),
            eq(schema.shiftDeviceParticipants.shiftId, schema.shifts.id),
            eq(schema.shiftDeviceParticipants.deviceId, deviceId),
          ),
        )
        .where(and(eq(schema.shifts.tenantId, tenantId), inArray(schema.shifts.id, ids)));
      if (shifts.length !== ids.length) throw new BadRequestException("Unknown shift");
      const result = await tx.execute<{
        shiftId: string;
        codeHash: string;
        scannedAt: Date;
        outcome: string;
        ownership: "released" | null;
      }>(sql`
        select input."shiftId", input."codeHash", input."scannedAt",
          case when repeat.terminal_id = ${deviceId}::uuid and repeat.scanned_at = input."scannedAt" then 'reprocessed'
            when owner.shift_id = input."shiftId" and owner.terminal_id = ${deviceId} and owner.scanned_at = input."scannedAt" then 'first_accepted'
            when exists (select 1 from code_conflicts conflict where conflict.tenant_id = ${tenantId}
              and conflict.code_hash = input."codeHash" and conflict.losing_shift_id = input."shiftId"
              and conflict.losing_terminal_id = ${deviceId} and conflict.losing_scanned_at = input."scannedAt") then 'conflict'
            when ordinary.terminal_id = ${deviceId} and ordinary.scanned_at = input."scannedAt" then 'first_accepted'
            else 'pending' end as outcome,
          case when ordinary.terminal_id = ${deviceId} and ordinary.scanned_at = input."scannedAt"
            and not (owner.shift_id IS NOT DISTINCT FROM input."shiftId" and owner.terminal_id IS NOT DISTINCT FROM ${deviceId} and owner.scanned_at IS NOT DISTINCT FROM input."scannedAt")
            and not exists (select 1 from code_conflicts conflict where conflict.tenant_id = ${tenantId}
              and conflict.code_hash = input."codeHash" and conflict.losing_shift_id = input."shiftId"
              and conflict.losing_terminal_id = ${deviceId} and conflict.losing_scanned_at = input."scannedAt")
            then 'released' else null end as ownership
        from jsonb_to_recordset(${JSON.stringify(query.occurrences)}::jsonb) as input("shiftId" uuid, "codeHash" text, "scannedAt" timestamptz)
        left join validation_code_acceptances ordinary on ordinary.tenant_id = ${tenantId} and ordinary.shift_id = input."shiftId" and ordinary.code_hash = input."codeHash"
        left join code_registry owner on owner.tenant_id = ${tenantId} and owner.code_hash = input."codeHash"
        left join validation_code_reprocessings repeat on repeat.tenant_id = ${tenantId} and repeat.shift_id = input."shiftId" and repeat.code_hash = input."codeHash"
      `);
      return validationOccurrenceStatusSchema.parse({
        protocol: VALIDATION_REPROCESSING_PROTOCOL,
        occurrences: result.rows.map(({ ownership, ...row }) => ({
          ...row,
          ...(ownership ? { ownership } : {}),
          scannedAt: new Date(row.scannedAt).toISOString(),
        })),
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
