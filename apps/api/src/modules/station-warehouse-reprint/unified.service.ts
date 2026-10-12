import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  UNIFIED_REPRINT_PROTOCOL,
  WAREHOUSE_REPRINT_PROTOCOL,
  resolveWarehouseReprintScan,
  unifiedLookupResultSchema,
  palletDataBatchSchema,
  palletRenderingsV3BatchSchema,
  palletRenderingV3Schema,
  assertPalletRenderingV3MatchesData,
  palletProductionDeliverySchema,
  palletProductionResolutionSchema,
  type UnifiedLookupResult,
} from "@markiro/domain";
import type { z } from "zod";
import { DB } from "../../auth/auth.module";
import {
  assertWarehouseDevice,
  assertWarehouseOperator,
  assertWarehouseHistoricalOperator,
} from "./access";
import { WarehouseLookupService } from "./lookup.service";
import {
  WarehousePalletService,
  palletMembership,
  samePalletComposition,
  storedPalletData,
  tryStoredPalletData,
} from "./pallet.service";

@Injectable()
export class WarehouseUnifiedService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly labels: WarehouseLookupService,
    private readonly pallets: WarehousePalletService,
  ) {}
  async receiveData(
    tenantId: string,
    deviceId: string,
    input: z.infer<typeof palletDataBatchSchema>,
  ) {
    const batch = palletDataBatchSchema.parse(input);
    const result = await this.pallets.receive(
      tenantId,
      deviceId,
      batch.entries,
      batch.productionDelivery,
    );
    return { ...result, protocol: UNIFIED_REPRINT_PROTOCOL };
  }
  async lookup(
    tenantId: string,
    deviceId: string,
    operatorId: string,
    raw: string,
  ): Promise<UnifiedLookupResult> {
    await assertWarehouseDevice(this.db, tenantId, deviceId);
    await assertWarehouseOperator(this.db, tenantId, operatorId);
    const scan = resolveWarehouseReprintScan(raw);
    if (scan.kind === "invalid") throw new BadRequestException({ code: "WAREHOUSE_SCAN_INVALID" });
    const labelLookup = async (): Promise<UnifiedLookupResult> => {
      const result = await this.labels.lookup(tenantId, deviceId, {
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        operatorId,
        raw,
      });
      return result.status === "found"
        ? unifiedLookupResultSchema.parse({ ...result, kind: result.source.kind })
        : result;
    };
    if (scan.kind === "unit") return labelLookup();
    const membership = await palletMembership(this.db, tenantId, scan.sscc);
    if (!membership) return labelLookup();
    const [box] = await this.db
      .select({ id: schema.boxes.id })
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, scan.sscc)))
      .limit(1);
    const [repack] = await this.db
      .select({ id: schema.inventoryRepackBoxes.id })
      .from(schema.inventoryRepackBoxes)
      .where(
        and(
          eq(schema.inventoryRepackBoxes.tenantId, tenantId),
          eq(schema.inventoryRepackBoxes.newSscc, scan.sscc),
        ),
      )
      .limit(1);
    if (box || repack) return { status: "unavailable", code: "ambiguous" };
    if (membership.pallet.kind !== "production")
      return { status: "unavailable", code: "not_production" };
    if (!membership.pallet.closedAt) return { status: "unavailable", code: "not_closed" };
    if (membership.pallet.disassembledAt || !membership.itemCount || !membership.boxCount)
      return { status: "unavailable", code: "composition_changed" };
    const [saved] = await this.db
      .select()
      .from(schema.palletLabelSources)
      .where(
        and(
          eq(schema.palletLabelSources.tenantId, tenantId),
          eq(schema.palletLabelSources.sscc, scan.sscc),
        ),
      );
    if (!saved) return { status: "unavailable", code: "snapshot_missing" };
    const data = tryStoredPalletData(saved.value, saved.revision);
    if (!data) return { status: "unavailable", code: "snapshot_missing" };
    if (
      data.sscc !== scan.sscc ||
      data.shiftId !== membership.pallet.shiftId ||
      !samePalletComposition(membership, data)
    )
      return { status: "unavailable", code: "composition_changed" };
    const [latest] = await this.db
      .select()
      .from(schema.palletProductionDeliveries)
      .where(
        and(
          eq(schema.palletProductionDeliveries.tenantId, tenantId),
          eq(schema.palletProductionDeliveries.sscc, scan.sscc),
          eq(schema.palletProductionDeliveries.sourceDeviceId, saved.sourceDeviceId),
        ),
      )
      .orderBy(desc(schema.palletProductionDeliveries.sequence))
      .limit(1);
    const delivery = latest ? palletProductionDeliverySchema.parse(latest.value) : null;
    // Only evidence of an actual ambiguous dispatch blocks a new print. Absence of a
    // legacy receipt/template is not evidence of dispatch ambiguity.
    if (delivery?.state === "delivery_unknown") {
      const [decision] = await this.db
        .select()
        .from(schema.palletProductionResolutions)
        .where(
          and(
            eq(schema.palletProductionResolutions.tenantId, tenantId),
            eq(schema.palletProductionResolutions.sscc, scan.sscc),
            eq(schema.palletProductionResolutions.sourceDeviceId, saved.sourceDeviceId),
            eq(schema.palletProductionResolutions.sourceRevision, delivery.sourceRevision),
            eq(schema.palletProductionResolutions.attemptId, delivery.attemptId),
          ),
        );
      const resolution = decision ? palletProductionResolutionSchema.parse(decision.value) : null;
      const resolvedByFlag = [
        membership.pallet.printVerifiedAt,
        membership.pallet.printSkippedAt,
      ].some((at) => at !== null && at.getTime() > Date.parse(delivery.occurredAt));
      if (!resolvedByFlag && resolution?.productionSequence !== latest?.sequence)
        return {
          status: "unavailable",
          code: "delivery_unresolved",
          diagnostic: {
            sscc: scan.sscc,
            sourceRevision: delivery.sourceRevision,
            attemptId: delivery.attemptId,
            productionSequence: delivery.sequence,
            originDeviceId: saved.sourceDeviceId,
            shiftId: data.shiftId,
            kind: "delivery_unknown",
          },
        };
    }
    return unifiedLookupResultSchema.parse({ status: "found", kind: "pallet", data });
  }
  async receiveRenderings(
    tenantId: string,
    deviceId: string,
    input: z.infer<typeof palletRenderingsV3BatchSchema>,
  ) {
    const batch = palletRenderingsV3BatchSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await assertWarehouseDevice(tx, tenantId, deviceId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":" + deviceId + ":pallet-reprints"},0))`,
      );
      const results: Array<{
        jobId: string;
        renderingRevision: string;
        status: "accepted" | "retryable" | "conflict";
      }> = [];
      for (const entry of batch.entries) {
        const rendering = palletRenderingV3Schema.parse(entry.rendering),
          reply = { jobId: entry.jobId, renderingRevision: rendering.renderingRevision };
        const [old] = await tx
          .select()
          .from(schema.palletReprintRenderings)
          .where(
            and(
              eq(schema.palletReprintRenderings.tenantId, tenantId),
              eq(schema.palletReprintRenderings.deviceId, deviceId),
              eq(schema.palletReprintRenderings.jobId, entry.jobId),
            ),
          );
        if (old) {
          results.push({
            ...reply,
            status: old.renderingRevision === rendering.renderingRevision ? "accepted" : "conflict",
          });
          continue;
        }
        const [legacy] = await tx
          .select({ id: schema.palletReprintEvents.eventId })
          .from(schema.palletReprintEvents)
          .where(
            and(
              eq(schema.palletReprintEvents.tenantId, tenantId),
              eq(schema.palletReprintEvents.deviceId, deviceId),
              eq(schema.palletReprintEvents.jobId, entry.jobId),
            ),
          )
          .limit(1);
        if (legacy) {
          results.push({ ...reply, status: "conflict" });
          continue;
        }
        try {
          await assertWarehouseHistoricalOperator(tx, tenantId, entry.operatorId);
        } catch (error) {
          if (!(error instanceof ForbiddenException)) throw error;
          results.push({ ...reply, status: "conflict" });
          continue;
        }
        const [source] = await tx
          .select()
          .from(schema.palletLabelSources)
          .where(
            and(
              eq(schema.palletLabelSources.tenantId, tenantId),
              eq(schema.palletLabelSources.sscc, rendering.sscc),
            ),
          );
        if (!source) {
          results.push({ ...reply, status: "retryable" });
          continue;
        }
        try {
          assertPalletRenderingV3MatchesData(
            storedPalletData(source.value, source.revision),
            rendering,
          );
        } catch {
          results.push({ ...reply, status: "conflict" });
          continue;
        }
        const membership = await palletMembership(tx, tenantId, rendering.sscc);
        if (
          !membership ||
          !membership.pallet.closedAt ||
          membership.pallet.disassembledAt ||
          !samePalletComposition(membership, storedPalletData(source.value, source.revision))
        ) {
          results.push({ ...reply, status: "conflict" });
          continue;
        }
        const [template] = await tx
          .select()
          .from(schema.labelTemplates)
          .where(
            and(
              eq(schema.labelTemplates.tenantId, tenantId),
              eq(
                schema.labelTemplates.id,
                rendering.choice.id ?? "00000000-0000-0000-0000-000000000000",
              ),
              eq(schema.labelTemplates.purpose, "pallet"),
            ),
          );
        if (
          !template ||
          (template.format === "pallet_sheet_v2") !== (rendering.choice.kind === "a4")
        ) {
          results.push({ ...reply, status: "conflict" });
          continue;
        }
        await tx.insert(schema.palletReprintRenderings).values({
          tenantId,
          deviceId,
          jobId: entry.jobId,
          sscc: rendering.sscc,
          sourceRevision: rendering.sourceRevision,
          renderingRevision: rendering.renderingRevision,
          value: { ...rendering },
        });
        results.push({ ...reply, status: "accepted" });
      }
      return { protocol: UNIFIED_REPRINT_PROTOCOL, results };
    });
  }
}
