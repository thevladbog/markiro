import { z } from "zod";
import { NotFoundException } from "@nestjs/common";
import { and, eq, gt } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  formatShiftNumber,
  validationReprocessingDetailsSchema,
  type ValidationReprocessingDetailsQuery,
} from "@markiro/domain";

export async function loadValidationReprocessingDetails(
  db: Db,
  tenantId: string,
  shiftId: string,
  query: ValidationReprocessingDetailsQuery,
) {
  if (!z.uuid().safeParse(shiftId).success) throw new NotFoundException();
  return db.transaction(
    async (tx) => {
      const [target] = await tx
        .select({ id: schema.shifts.id })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
      if (!target) throw new NotFoundException();
      const rows = await tx
        .select({
          repeat: schema.validationCodeReprocessings,
          source: schema.shifts,
          productName: schema.products.name,
        })
        .from(schema.validationCodeReprocessings)
        .innerJoin(
          schema.shifts,
          and(
            eq(schema.shifts.tenantId, schema.validationCodeReprocessings.tenantId),
            eq(schema.shifts.id, schema.validationCodeReprocessings.sourceShiftId),
          ),
        )
        .innerJoin(
          schema.products,
          and(
            eq(schema.products.tenantId, schema.shifts.tenantId),
            eq(schema.products.id, schema.shifts.productId),
          ),
        )
        .where(
          and(
            eq(schema.validationCodeReprocessings.tenantId, tenantId),
            eq(schema.validationCodeReprocessings.shiftId, shiftId),
            query.cursor
              ? gt(schema.validationCodeReprocessings.codeHash, query.cursor)
              : undefined,
          ),
        )
        .orderBy(schema.validationCodeReprocessings.codeHash)
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return validationReprocessingDetailsSchema.parse({
        items: page.map(({ repeat, source, productName }) => ({
          codeHash: repeat.codeHash,
          canonicalRaw: repeat.canonicalRaw,
          sourceShift: {
            id: source.id,
            number: formatShiftNumber({
              monthKey: source.numberMonthKey,
              seq: source.numberSeq,
              createdFrom: source.createdFrom,
            }),
            productName,
            date: source.productionDate ?? source.plannedDate,
          },
          occurrence: {
            shiftId,
            deviceId: repeat.terminalId,
            operatorId: repeat.operatorId,
            scannedAt: repeat.scannedAt.toISOString(),
          },
        })),
        nextCursor: rows.length > query.limit ? page.at(-1)?.repeat.codeHash : null,
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
