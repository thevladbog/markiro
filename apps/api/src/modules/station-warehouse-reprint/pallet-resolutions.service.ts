import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  PALLET_PRODUCTION_RESOLUTION_PROTOCOL,
  palletLabelSourceSchema,
  palletProductionDeliverySchema,
  palletProductionResolutionSchema,
  productLabelValueDigest,
  type PalletProductionResolution,
} from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { assertWarehouseDevice, assertWarehouseOperator } from "./access";
import { palletMembership, samePalletComposition } from "./pallet.service";
@Injectable()
export class WarehousePalletResolutionsService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async receive(tenantId: string, deviceId: string, entries: PalletProductionResolution[]) {
    return this.db.transaction(async (tx) => {
      await assertWarehouseDevice(tx, tenantId, deviceId);
      // Serializes against ingestion of the originating device's production receipts.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":pallet-label-source"},0))`,
      );
      const results: Array<{ eventId: string; status: "accepted" | "retryable" | "conflict" }> = [];
      for (const input of entries) {
        const value = palletProductionResolutionSchema.parse(input),
          digest = productLabelValueDigest(value);
        const [old] = await tx
          .select()
          .from(schema.palletProductionResolutions)
          .where(
            and(
              eq(schema.palletProductionResolutions.tenantId, tenantId),
              eq(schema.palletProductionResolutions.sourceDeviceId, deviceId),
              eq(schema.palletProductionResolutions.eventId, value.eventId),
            ),
          );
        if (old) {
          results.push({
            eventId: value.eventId,
            status: old.digest === digest ? "accepted" : "conflict",
          });
          continue;
        }
        try {
          await assertWarehouseOperator(tx, tenantId, value.operatorId);
        } catch (error) {
          if (!(error instanceof ForbiddenException)) throw error;
          results.push({ eventId: value.eventId, status: "conflict" });
          continue;
        }
        const [source] = await tx
          .select()
          .from(schema.palletLabelSources)
          .where(
            and(
              eq(schema.palletLabelSources.tenantId, tenantId),
              eq(schema.palletLabelSources.sscc, value.sscc),
            ),
          );
        if (!source) {
          results.push({ eventId: value.eventId, status: "retryable" });
          continue;
        }
        if (source.sourceDeviceId !== deviceId || source.revision !== value.sourceRevision) {
          results.push({ eventId: value.eventId, status: "conflict" });
          continue;
        }
        const [latest] = await tx
          .select()
          .from(schema.palletProductionDeliveries)
          .where(
            and(
              eq(schema.palletProductionDeliveries.tenantId, tenantId),
              eq(schema.palletProductionDeliveries.sscc, value.sscc),
              eq(schema.palletProductionDeliveries.sourceDeviceId, deviceId),
            ),
          )
          .orderBy(desc(schema.palletProductionDeliveries.sequence))
          .limit(1);
        if (!latest) {
          results.push({ eventId: value.eventId, status: "retryable" });
          continue;
        }
        const receipt = palletProductionDeliverySchema.parse(latest.value),
          membership = await palletMembership(tx, tenantId, value.sscc);
        const [previous] = await tx
          .select()
          .from(schema.palletProductionResolutions)
          .where(
            and(
              eq(schema.palletProductionResolutions.tenantId, tenantId),
              eq(schema.palletProductionResolutions.sscc, value.sscc),
              eq(schema.palletProductionResolutions.sourceDeviceId, deviceId),
              eq(schema.palletProductionResolutions.sourceRevision, value.sourceRevision),
              eq(schema.palletProductionResolutions.attemptId, value.attemptId),
            ),
          );
        if (
          previous ||
          latest.sequence > value.productionSequence ||
          !membership ||
          membership.pallet.disassembledAt ||
          membership.pallet.kind !== "production" ||
          membership.pallet.terminalId !== deviceId ||
          membership.pallet.closedAt?.toISOString() !==
            palletLabelSourceSchema.parse(source.value).closedAt ||
          !samePalletComposition(membership, palletLabelSourceSchema.parse(source.value))
        ) {
          results.push({ eventId: value.eventId, status: "conflict" });
          continue;
        }
        if (latest.sequence < value.productionSequence) {
          results.push({ eventId: value.eventId, status: "retryable" });
          continue;
        }
        if (
          receipt.attemptId !== value.attemptId ||
          receipt.sourceRevision !== value.sourceRevision ||
          (receipt.state === "failed_before_send" && value.outcome === "confirmed")
        ) {
          results.push({ eventId: value.eventId, status: "conflict" });
          continue;
        }
        await tx.insert(schema.palletProductionResolutions).values({
          tenantId,
          sourceDeviceId: deviceId,
          eventId: value.eventId,
          sscc: value.sscc,
          sourceRevision: value.sourceRevision,
          attemptId: value.attemptId,
          digest,
          value: { ...value },
        });
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: null,
          action: `pallet_production.${value.outcome}`,
          outcome: "accepted",
          targetType: "pallet",
          targetId: source.palletId,
          after: { deviceId, ...value },
        });
        results.push({ eventId: value.eventId, status: "accepted" });
      }
      return { protocol: PALLET_PRODUCTION_RESOLUTION_PROTOCOL, results };
    });
  }
}
