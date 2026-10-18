import { ForbiddenException, Inject, Injectable, PayloadTooLargeException } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  PALLET_REPRINT_V2_PROTOCOL,
  assertPalletRenderingMatchesSource,
  createPalletSheetSnapshot,
  labelTemplateSpecSchema,
  parsePalletSheetSpec,
  palletLabelSourceSchema,
  palletRenderingV2Schema,
  palletTemplateChoiceSchema,
  palletTemplateCatalogV2Schema,
  palletLookupV2ResultSchema,
  palletProductionDeliverySchema,
  productLabelValueDigest,
  type PalletRenderingV2,
} from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { assertWarehouseDevice, assertWarehouseHistoricalOperator } from "./access";
import {
  WarehousePalletService,
  tryStoredPalletData,
  palletLookupIdentities,
} from "./pallet.service";
@Injectable()
export class WarehousePalletRenderingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pallets: WarehousePalletService,
  ) {}
  async templates(tenantId: string, deviceId: string) {
    await assertWarehouseDevice(this.db, tenantId, deviceId);
    const rows = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(
        and(
          eq(schema.labelTemplates.tenantId, tenantId),
          eq(schema.labelTemplates.purpose, "pallet"),
          eq(schema.labelTemplates.enabled, true),
        ),
      )
      .orderBy(asc(schema.labelTemplates.name), asc(schema.labelTemplates.id))
      .limit(1001);
    if (rows.length > 1000)
      throw new PayloadTooLargeException({ code: "WAREHOUSE_TEMPLATE_CATALOG_TOO_LARGE" });
    const templates = rows.map((row) => {
      if (row.format === "pallet_sheet_v2") {
        const snapshot = createPalletSheetSnapshot({
          id: row.id,
          name: row.name,
          revision: row.revision,
          spec: parsePalletSheetSpec(row.spec),
        });
        return palletTemplateChoiceSchema.parse({
          kind: "a4",
          id: row.id,
          name: row.name,
          snapshot,
          snapshotDigest: productLabelValueDigest(snapshot),
        });
      }
      const snapshot = labelTemplateSpecSchema.parse(row.spec);
      return palletTemplateChoiceSchema.parse({
        kind: "thermal",
        id: row.id,
        name: row.name,
        snapshot,
        snapshotDigest: productLabelValueDigest(snapshot),
      });
    });
    return palletTemplateCatalogV2Schema.parse({ protocol: PALLET_REPRINT_V2_PROTOCOL, templates });
  }
  async lookup(tenantId: string, deviceId: string, operatorId: string, raw: string) {
    const result = await this.pallets.lookup(tenantId, deviceId, operatorId, raw);
    if (result.status !== "unavailable") return palletLookupV2ResultSchema.parse(result);
    const identities = await palletLookupIdentities(this.db, tenantId, raw),
      sscc = identities.length === 1 ? identities[0] : undefined;
    if (!sscc) return palletLookupV2ResultSchema.parse({ ...result, diagnostic: null });
    const [source] = await this.db
      .select()
      .from(schema.palletLabelSources)
      .where(
        and(
          eq(schema.palletLabelSources.tenantId, tenantId),
          eq(schema.palletLabelSources.sscc, sscc),
        ),
      );
    const [latest] = source
      ? await this.db
          .select()
          .from(schema.palletProductionDeliveries)
          .where(
            and(
              eq(schema.palletProductionDeliveries.tenantId, tenantId),
              eq(schema.palletProductionDeliveries.sscc, sscc),
              eq(schema.palletProductionDeliveries.sourceDeviceId, source.sourceDeviceId),
            ),
          )
          .orderBy(desc(schema.palletProductionDeliveries.sequence))
          .limit(1)
      : [];
    const receipt = latest ? palletProductionDeliverySchema.parse(latest.value) : null;
    const kind =
      result.code === "composition_changed"
        ? "composition_changed"
        : result.code === "snapshot_missing"
          ? "snapshot_missing"
          : !receipt
            ? "sync_pending"
            : receipt?.state === "failed_before_send"
              ? "failed_before_send"
              : "delivery_unknown";
    return palletLookupV2ResultSchema.parse({
      ...result,
      diagnostic: {
        sscc,
        kind,
        attemptId: receipt?.attemptId ?? null,
        productionSequence: latest?.sequence ?? null,
        sourceRevision: source?.revision ?? null,
        originDeviceId: source?.sourceDeviceId ?? null,
        shiftId: source
          ? (tryStoredPalletData(source.value, source.revision)?.shiftId ?? null)
          : null,
      },
    });
  }
  async receive(
    tenantId: string,
    deviceId: string,
    entries: Array<{ jobId: string; operatorId: string; rendering: PalletRenderingV2 }>,
  ) {
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
      for (const entry of entries) {
        const rendering = palletRenderingV2Schema.parse(entry.rendering),
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
        const [legacyJob] = await tx
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
        if (legacyJob) {
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
        if (source.revision !== rendering.sourceRevision) {
          results.push({ ...reply, status: "conflict" });
          continue;
        }
        try {
          assertPalletRenderingMatchesSource(
            palletLabelSourceSchema.parse(source.value),
            rendering,
          );
        } catch {
          results.push({ ...reply, status: "conflict" });
          continue;
        }
        if (rendering.templateId !== null) {
          const [template] = await tx
            .select({ id: schema.labelTemplates.id, format: schema.labelTemplates.format })
            .from(schema.labelTemplates)
            .where(
              and(
                eq(schema.labelTemplates.tenantId, tenantId),
                eq(schema.labelTemplates.id, rendering.templateId),
                eq(schema.labelTemplates.purpose, "pallet"),
              ),
            );
          if (
            !template ||
            (template.format === "pallet_sheet_v2") !== (rendering.rendering.kind === "a4")
          ) {
            results.push({ ...reply, status: "conflict" });
            continue;
          }
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
      return { protocol: PALLET_REPRINT_V2_PROTOCOL, results };
    });
  }
}
