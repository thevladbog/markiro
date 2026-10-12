import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { LABEL_FACTS_PROTOCOL, type UnitLabelFactsV1 } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { assertWarehouseDevice, assertWarehouseHistoricalOperator } from "./access";
@Injectable()
export class WarehouseLabelFactsService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async receive(
    tenantId: string,
    deviceId: string,
    operatorId: string | null,
    entries: UnitLabelFactsV1[],
  ) {
    return this.db.transaction(async (tx) => {
      await assertWarehouseDevice(tx, tenantId, deviceId);
      if (operatorId !== null) await assertWarehouseHistoricalOperator(tx, tenantId, operatorId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":label-facts"},0))`,
      );
      const results: Array<{ digest: string; status: "accepted" | "retryable" | "conflict" }> = [];
      for (const fact of entries) {
        const scope = and(
          eq(schema.unitLabelFacts.tenantId, tenantId),
          eq(schema.unitLabelFacts.shiftId, fact.shiftId),
          eq(schema.unitLabelFacts.codeHash, fact.codeHash),
          eq(schema.unitLabelFacts.acceptedAt, new Date(fact.acceptedAt)),
        );
        const [saved] = await tx.select().from(schema.unitLabelFacts).where(scope);
        if (saved) {
          results.push({
            digest: fact.digest,
            status:
              saved.digest === fact.digest && saved.sourceDeviceId === deviceId
                ? "accepted"
                : "conflict",
          });
          continue;
        }
        const [code] = await tx
          .select({ gtin14: schema.codes.gtin14, deviceId: schema.codeRegistry.terminalId })
          .from(schema.codes)
          .innerJoin(
            schema.codeRegistry,
            and(
              eq(schema.codeRegistry.tenantId, schema.codes.tenantId),
              eq(schema.codeRegistry.codeHash, schema.codes.codeHash),
              eq(schema.codeRegistry.shiftId, schema.codes.shiftId),
              eq(schema.codeRegistry.scannedAt, schema.codes.scannedAt),
            ),
          )
          .where(
            and(
              eq(schema.codes.tenantId, tenantId),
              eq(schema.codes.codeHash, fact.codeHash),
              eq(schema.codes.shiftId, fact.shiftId),
              eq(schema.codes.scannedAt, new Date(fact.acceptedAt)),
            ),
          );
        if (!code) {
          results.push({ digest: fact.digest, status: "retryable" });
          continue;
        }
        if (code.deviceId !== deviceId || code.gtin14 !== fact.fields["product.gtin"]) {
          results.push({ digest: fact.digest, status: "conflict" });
          continue;
        }
        await tx.insert(schema.unitLabelFacts).values({
          tenantId,
          sourceDeviceId: deviceId,
          shiftId: fact.shiftId,
          codeHash: fact.codeHash,
          acceptedAt: new Date(fact.acceptedAt),
          digest: fact.digest,
          fact: { ...fact },
        });
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: null,
          action: "unit_label_facts.saved",
          outcome: "accepted",
          targetType: "shift",
          targetId: fact.shiftId,
          after: {
            deviceId,
            operatorId,
            codeHash: fact.codeHash,
            acceptedAt: fact.acceptedAt,
            digest: fact.digest,
            dateProvenance: fact.dateProvenance,
          },
        });
        results.push({ digest: fact.digest, status: "accepted" });
      }
      return { protocol: LABEL_FACTS_PROTOCOL, results };
    });
  }
}
