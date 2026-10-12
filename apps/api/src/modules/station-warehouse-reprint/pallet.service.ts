import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  PALLET_REPRINT_PROTOCOL,
  palletCompositionDigest,
  palletLabelSourceSchema,
  resolveWarehouseReprintScan,
  validatePalletBranding,
  productLabelValueDigest,
  palletReprintEventSchema,
  palletProductionDeliverySchema,
  type PalletLabelSourceV1,
} from "@markiro/domain";
import type { z } from "zod";
import { DB } from "../../auth/auth.module";
import {
  assertWarehouseDevice,
  assertWarehouseOperator,
  assertWarehouseHistoricalOperator,
} from "./access";
type Reader = Pick<Db, "select">;
async function membership(db: Reader, tenantId: string, sscc: string) {
  const [pallet] = await db
    .select()
    .from(schema.pallets)
    .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, sscc)));
  if (!pallet) return null;
  const boxes = await db
    .select({ sscc: schema.boxes.sscc, id: schema.boxes.id, closedAt: schema.boxes.closedAt })
    .from(schema.boxes)
    .where(
      and(
        eq(schema.boxes.tenantId, tenantId),
        eq(schema.boxes.palletId, pallet.id),
        isNull(schema.boxes.disassembledAt),
      ),
    );
  const [count] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.boxItems)
    .innerJoin(
      schema.boxes,
      and(
        eq(schema.boxes.tenantId, schema.boxItems.tenantId),
        eq(schema.boxes.id, schema.boxItems.boxId),
      ),
    )
    .where(
      and(
        eq(schema.boxes.tenantId, tenantId),
        eq(schema.boxes.palletId, pallet.id),
        isNull(schema.boxes.disassembledAt),
        isNull(schema.boxItems.displacedAt),
        isNull(schema.boxItems.removedAt),
      ),
    );
  const items = await db
    .select({
      boxSscc: schema.boxes.sscc,
      codeHash: schema.boxItems.codeHash,
      acceptedAt: schema.boxItems.addedAt,
    })
    .from(schema.boxItems)
    .innerJoin(
      schema.boxes,
      and(
        eq(schema.boxes.tenantId, schema.boxItems.tenantId),
        eq(schema.boxes.id, schema.boxItems.boxId),
      ),
    )
    .where(
      and(
        eq(schema.boxes.tenantId, tenantId),
        eq(schema.boxes.palletId, pallet.id),
        isNull(schema.boxes.disassembledAt),
        isNull(schema.boxItems.displacedAt),
        isNull(schema.boxItems.removedAt),
      ),
    );
  const compositionDigest = items.every((i) => i.boxSscc !== null)
    ? palletCompositionDigest(
        items.map((i) => ({
          boxSscc: i.boxSscc ?? "",
          codeHash: i.codeHash,
          acceptedAt: i.acceptedAt.toISOString(),
        })),
      )
    : null;
  return {
    compositionDigest,
    pallet,
    boxes: boxes
      .map((b) => b.sscc)
      .filter((v): v is string => v !== null)
      .sort(),
    boxCount: boxes.length,
    itemCount: Number(count?.n ?? 0),
    complete: boxes.every((b) => b.sscc && b.closedAt),
  };
}
function sameComposition(
  m: NonNullable<Awaited<ReturnType<typeof membership>>>,
  source: PalletLabelSourceV1,
) {
  return (
    m.compositionDigest === source.compositionDigest &&
    m.complete &&
    m.boxCount === source.boxCount &&
    m.itemCount === source.itemCount &&
    JSON.stringify(m.boxes) === JSON.stringify([...source.boxSsccs].sort())
  );
}
@Injectable()
export class WarehousePalletService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async receive(
    tenantId: string,
    deviceId: string,
    entries: PalletLabelSourceV1[],
    productionDelivery?: z.infer<typeof palletProductionDeliverySchema>,
  ) {
    return this.db.transaction(async (tx) => {
      await assertWarehouseDevice(tx, tenantId, deviceId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":pallet-label-source"},0))`,
      );
      const results: Array<{ revision: string; status: "accepted" | "retryable" | "conflict" }> =
        [];
      const receiveDelivery = async (
        source: PalletLabelSourceV1,
      ): Promise<"accepted" | "conflict"> => {
        if (!productionDelivery) return "accepted";
        const deliveryScope = and(
          eq(schema.palletProductionDeliveries.tenantId, tenantId),
          eq(schema.palletProductionDeliveries.sscc, source.sscc),
          eq(schema.palletProductionDeliveries.sequence, productionDelivery.sequence),
        );
        const digest = productLabelValueDigest(productionDelivery);
        const [saved] = await tx
          .select()
          .from(schema.palletProductionDeliveries)
          .where(deliveryScope);
        if (saved)
          return saved.sourceDeviceId === deviceId && saved.digest === digest
            ? "accepted"
            : "conflict";
        await tx.insert(schema.palletProductionDeliveries).values({
          tenantId,
          sscc: source.sscc,
          sourceDeviceId: deviceId,
          sequence: productionDelivery.sequence,
          digest,
          value: { ...productionDelivery },
        });
        return "accepted";
      };
      for (const source of entries) {
        if (
          productionDelivery &&
          (entries.length !== 1 || productionDelivery.sourceRevision !== source.revision)
        ) {
          results.push({ revision: source.revision, status: "conflict" });
          continue;
        }
        const [old] = await tx
          .select()
          .from(schema.palletLabelSources)
          .where(
            and(
              eq(schema.palletLabelSources.tenantId, tenantId),
              eq(schema.palletLabelSources.sscc, source.sscc),
            ),
          );
        if (old) {
          results.push({
            revision: source.revision,
            status:
              old.sourceDeviceId === deviceId && old.revision === source.revision
                ? await receiveDelivery(source)
                : "conflict",
          });
          continue;
        }
        const m = await membership(tx, tenantId, source.sscc);
        if (!m) {
          results.push({ revision: source.revision, status: "retryable" });
          continue;
        }
        const claimedBoxes = await tx
          .select({
            id: schema.boxes.id,
            sscc: schema.boxes.sscc,
            palletId: schema.boxes.palletId,
            disassembledAt: schema.boxes.disassembledAt,
          })
          .from(schema.boxes)
          .where(
            and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.sscc, source.boxSsccs)),
          );
        // Exact active membership wins: old removals may have happened before
        // closure and reached the server much later. Server ingestion timestamps
        // cannot be compared with the device's closure clock.
        const historicalItems = sameComposition(m, source)
          ? []
          : await tx
              .select({
                boxId: schema.boxItems.boxId,
                codeHash: schema.boxItems.codeHash,
                addedAt: schema.boxItems.addedAt,
                removedAt: schema.boxItems.removedAt,
                displacedAt: schema.boxItems.displacedAt,
              })
              .from(schema.boxItems)
              .where(
                and(
                  eq(schema.boxItems.tenantId, tenantId),
                  inArray(
                    schema.boxItems.boxId,
                    claimedBoxes.map((box) => box.id),
                  ),
                ),
              );
        const claimedSsccs = new Map(claimedBoxes.map((box) => [box.id, box.sscc]));
        // A missing active occurrence is a definitive mutation only when durable
        // historical memberships reconstruct this exact uploaded composition.
        // Otherwise fewer active items may still mean incomplete ingestion.
        const historicalDigest = palletCompositionDigest(
          historicalItems.map((item) => ({
            boxSscc: claimedSsccs.get(item.boxId) ?? "",
            codeHash: item.codeHash,
            acceptedAt: item.addedAt.toISOString(),
          })),
        );
        if (
          m.pallet.kind !== "production" ||
          m.pallet.shiftId !== source.shiftId ||
          m.pallet.terminalId !== deviceId ||
          (m.pallet.closedAt !== null && m.pallet.closedAt.toISOString() !== source.closedAt) ||
          m.pallet.disassembledAt ||
          claimedBoxes.some(
            (box) => box.disassembledAt || (box.palletId !== null && box.palletId !== m.pallet.id),
          ) ||
          (!sameComposition(m, source) &&
            historicalItems.some((item) => item.removedAt || item.displacedAt) &&
            historicalDigest === source.compositionDigest &&
            historicalItems.length === source.itemCount)
        ) {
          results.push({ revision: source.revision, status: "conflict" });
          continue;
        }
        if (
          !m.pallet.closedAt ||
          (m.boxCount < source.boxCount &&
            m.boxes.every((sscc) => source.boxSsccs.includes(sscc))) ||
          (m.itemCount < source.itemCount &&
            m.boxes.every((sscc) => source.boxSsccs.includes(sscc)))
        ) {
          results.push({ revision: source.revision, status: "retryable" });
          continue;
        }
        if (
          m.pallet.kind !== "production" ||
          m.pallet.shiftId !== source.shiftId ||
          m.pallet.terminalId !== deviceId ||
          m.pallet.closedAt?.toISOString() !== source.closedAt ||
          m.pallet.disassembledAt ||
          !sameComposition(m, source) ||
          (source.rendering.brandingJson !== null &&
            validatePalletBranding(source.rendering.brandingJson).tenantId !== tenantId)
        ) {
          results.push({ revision: source.revision, status: "conflict" });
          continue;
        }
        await tx.insert(schema.palletLabelSources).values({
          tenantId,
          sscc: source.sscc,
          palletId: m.pallet.id,
          sourceDeviceId: deviceId,
          revision: source.revision,
          value: { ...source },
        });
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: null,
          action: "pallet_label_source.saved",
          outcome: "accepted",
          targetType: "pallet",
          targetId: m.pallet.id,
          after: {
            deviceId,
            sscc: source.sscc,
            sourceRevision: source.revision,
            format: source.rendering.kind,
          },
        });
        results.push({ revision: source.revision, status: await receiveDelivery(source) });
      }
      return { protocol: PALLET_REPRINT_PROTOCOL, results };
    });
  }
  async lookup(tenantId: string, deviceId: string, operatorId: string, raw: string) {
    await assertWarehouseDevice(this.db, tenantId, deviceId);
    await assertWarehouseOperator(this.db, tenantId, operatorId);
    const scan = resolveWarehouseReprintScan(raw);
    if (scan.kind === "invalid") return { status: "not_found" as const };
    const identities: string[] = [];
    if (scan.kind === "box") {
      const direct = await this.db
        .select({ sscc: schema.pallets.sscc })
        .from(schema.pallets)
        .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, scan.sscc)));
      const viaBox = await this.db
        .select({ sscc: schema.pallets.sscc })
        .from(schema.boxes)
        .innerJoin(
          schema.pallets,
          and(
            eq(schema.pallets.tenantId, schema.boxes.tenantId),
            eq(schema.pallets.id, schema.boxes.palletId),
          ),
        )
        .where(
          and(
            eq(schema.boxes.tenantId, tenantId),
            eq(schema.boxes.sscc, scan.sscc),
            isNull(schema.boxes.disassembledAt),
          ),
        );
      identities.push(
        ...[...direct, ...viaBox].map((p) => p.sscc).filter((v): v is string => v !== null),
      );
    } else {
      const viaUnit = await this.db
        .select({ sscc: schema.pallets.sscc })
        .from(schema.codeRegistry)
        .innerJoin(
          schema.boxItems,
          and(
            eq(schema.boxItems.tenantId, schema.codeRegistry.tenantId),
            eq(schema.boxItems.codeHash, schema.codeRegistry.codeHash),
            eq(schema.boxItems.addedAt, schema.codeRegistry.scannedAt),
          ),
        )
        .innerJoin(
          schema.boxes,
          and(
            eq(schema.boxes.tenantId, schema.boxItems.tenantId),
            eq(schema.boxes.id, schema.boxItems.boxId),
            eq(schema.boxes.shiftId, schema.codeRegistry.shiftId),
          ),
        )
        .innerJoin(
          schema.pallets,
          and(
            eq(schema.pallets.tenantId, schema.boxes.tenantId),
            eq(schema.pallets.id, schema.boxes.palletId),
          ),
        )
        .where(
          and(
            eq(schema.codeRegistry.tenantId, tenantId),
            eq(schema.codeRegistry.codeHash, scan.codeHash),
            isNull(schema.boxItems.displacedAt),
            isNull(schema.boxItems.removedAt),
            isNull(schema.boxes.disassembledAt),
          ),
        );
      identities.push(...viaUnit.map((p) => p.sscc).filter((v): v is string => v !== null));
    }
    const unique = [...new Set(identities)];
    if (unique.length > 1) return { status: "unavailable" as const, code: "ambiguous" as const };
    const sscc = unique[0];
    if (!sscc) return { status: "not_found" as const };
    const m = await membership(this.db, tenantId, sscc);
    if (!m) return { status: "not_found" as const };
    if (m.pallet.kind !== "production")
      return { status: "unavailable" as const, code: "not_production" as const };
    if (!m.pallet.closedAt) return { status: "unavailable" as const, code: "not_closed" as const };
    if (m.pallet.disassembledAt || !m.itemCount || !m.boxCount)
      return { status: "unavailable" as const, code: "composition_changed" as const };
    const [saved] = await this.db
      .select()
      .from(schema.palletLabelSources)
      .where(
        and(
          eq(schema.palletLabelSources.tenantId, tenantId),
          eq(schema.palletLabelSources.sscc, sscc),
        ),
      );
    if (!saved)
      return {
        status: "unavailable" as const,
        code:
          m.pallet.printVerifiedAt || m.pallet.printSkippedAt
            ? ("snapshot_missing" as const)
            : ("delivery_unresolved" as const),
      };
    const [latestDelivery] = await this.db
      .select()
      .from(schema.palletProductionDeliveries)
      .where(
        and(
          eq(schema.palletProductionDeliveries.tenantId, tenantId),
          eq(schema.palletProductionDeliveries.sscc, sscc),
          eq(schema.palletProductionDeliveries.sourceDeviceId, saved.sourceDeviceId),
        ),
      )
      .orderBy(desc(schema.palletProductionDeliveries.sequence))
      .limit(1);
    const delivery = latestDelivery
      ? palletProductionDeliverySchema.parse(latestDelivery.value)
      : null;
    // These resolution timestamps and occurredAt are claims from the pallet's
    // originating device. Earlier resolution flags cannot settle a later unknown
    // delivery; a sent receipt remains transport evidence, never scan verification.
    const resolved = [m.pallet.printVerifiedAt, m.pallet.printSkippedAt].some(
      (at) => at !== null && (!delivery || at.getTime() > Date.parse(delivery.occurredAt)),
    );
    if (delivery?.state !== "sent" && !resolved)
      return { status: "unavailable" as const, code: "delivery_unresolved" as const };
    const source = palletLabelSourceSchema.parse(saved.value);
    if (
      source.sscc !== sscc ||
      source.shiftId !== m.pallet.shiftId ||
      saved.revision !== source.revision ||
      !sameComposition(m, source)
    )
      return { status: "unavailable" as const, code: "composition_changed" as const };
    return { status: "found" as const, source };
  }
  async events(
    tenantId: string,
    deviceId: string,
    entries: z.infer<typeof palletReprintEventSchema>[],
  ) {
    return this.db.transaction(async (tx) => {
      await assertWarehouseDevice(tx, tenantId, deviceId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ":" + deviceId + ":pallet-reprints"},0))`,
      );
      const results: Array<{ eventId: string; status: "accepted" | "retryable" | "conflict" }> = [];
      for (const event of entries) {
        const digest = productLabelValueDigest(event),
          scope = and(
            eq(schema.palletReprintEvents.tenantId, tenantId),
            eq(schema.palletReprintEvents.deviceId, deviceId),
          );
        const [old] = await tx
          .select()
          .from(schema.palletReprintEvents)
          .where(and(scope, eq(schema.palletReprintEvents.eventId, event.eventId)));
        if (old) {
          results.push({
            eventId: event.eventId,
            status: old.digest === digest ? old.status : "conflict",
          });
          continue;
        }
        const reject = async () => {
          await tx.insert(schema.palletReprintEvents).values({
            tenantId,
            deviceId,
            eventId: event.eventId,
            jobId: event.jobId,
            digest,
            status: "conflict",
            value: { ...event },
          });
          results.push({ eventId: event.eventId, status: "conflict" });
        };
        try {
          await assertWarehouseHistoricalOperator(tx, tenantId, event.operatorId);
        } catch (error) {
          if (!(error instanceof ForbiddenException)) throw error;
          await reject();
          continue;
        }
        const previous = await tx
          .select()
          .from(schema.palletReprintEvents)
          .where(and(scope, eq(schema.palletReprintEvents.jobId, event.jobId)))
          .orderBy(
            sql`${schema.palletReprintEvents.value}->>'occurredAt'`,
            sql`CASE WHEN ${schema.palletReprintEvents.value}->>'state'='prepared' THEN 0 ELSE 1 END`,
          );
        if (
          previous.some(
            (row) =>
              row.status === "conflict" &&
              row.value.state === "prepared" &&
              row.value.attemptId === event.attemptId,
          )
        ) {
          await reject();
          continue;
        }
        const [source] = await tx
          .select()
          .from(schema.palletLabelSources)
          .where(
            and(
              eq(schema.palletLabelSources.tenantId, tenantId),
              eq(schema.palletLabelSources.sscc, event.sscc),
            ),
          );
        if (!source) {
          results.push({ eventId: event.eventId, status: "retryable" });
          continue;
        }
        if (source.revision !== event.sourceRevision) {
          await reject();
          continue;
        }
        const accepted = previous.filter((row) => row.status === "accepted");
        const history = accepted.map((row) => palletReprintEventSchema.parse(row.value));
        const frozen = palletLabelSourceSchema.parse(source.value);
        if (
          (frozen.rendering.kind === "a4" && event.printFormat !== "mono-raster-v1") ||
          history.some(
            (old) =>
              old.sscc !== event.sscc ||
              old.sourceRevision !== event.sourceRevision ||
              old.reason !== event.reason,
          )
        ) {
          await reject();
          continue;
        }
        const sameAttempt = history.filter((old) => old.attemptId === event.attemptId);
        if (
          (event.state === "prepared" && sameAttempt.length) ||
          sameAttempt.some((old) => ["verified", "skipped"].includes(old.state)) ||
          (["sent", "failed_before_send", "delivery_unknown"].includes(event.state) &&
            sameAttempt.some((old) => old.state !== "prepared"))
        ) {
          await reject();
          continue;
        }
        if (event.state === "prepared") {
          const last = history.at(-1);
          if (
            last &&
            (!["failed_before_send", "delivery_unknown"].includes(last.state) ||
              (last.state === "delivery_unknown" &&
                (last.bytesDigest !== event.bytesDigest || last.printFormat !== event.printFormat)))
          ) {
            await reject();
            continue;
          }
        }
        if (
          event.state === "verified" &&
          !sameAttempt.some((old) => ["sent", "delivery_unknown"].includes(old.state))
        ) {
          await reject();
          continue;
        }
        const attempt = accepted
          .map((row) => row.value)
          .find((value) => value.attemptId === event.attemptId && value.state === "prepared");
        if (event.state !== "prepared" && !attempt) {
          results.push({ eventId: event.eventId, status: "retryable" });
          continue;
        }
        if (
          attempt &&
          (attempt.sscc !== event.sscc ||
            attempt.sourceRevision !== event.sourceRevision ||
            attempt.bytesDigest !== event.bytesDigest ||
            attempt.printFormat !== event.printFormat)
        ) {
          await reject();
          continue;
        }
        await tx.insert(schema.palletReprintEvents).values({
          tenantId,
          deviceId,
          eventId: event.eventId,
          jobId: event.jobId,
          digest,
          value: { ...event },
        });
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: null,
          action: `pallet_label.${event.state}`,
          outcome: "accepted",
          targetType: "pallet",
          targetId: source.palletId,
          after: { deviceId, ...event },
        });
        results.push({ eventId: event.eventId, status: "accepted" });
      }
      return { protocol: PALLET_REPRINT_PROTOCOL, results };
    });
  }
}
