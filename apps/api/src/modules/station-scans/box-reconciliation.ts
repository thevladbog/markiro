import { BadRequestException } from "@nestjs/common";
import { boxMembershipDigestV1 } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { StationBoxReconciliationDto, StationBoxReconciliationResponseDto } from "./dto";
import { advanceBoxRegistryVersion } from "../boxes/box-registry-version";

const boxKey = (shiftId: string, boxId: string) => `${shiftId}|${boxId}`;
const palletKey = (shiftId: string, palletId: string) => `${shiftId}|${palletId}`;

/** Compare only the authenticated station's aggregation facts. */
export async function reconcileStationBoxes(
  db: Db,
  tenantId: string,
  deviceId: string,
  body: StationBoxReconciliationDto,
): Promise<StationBoxReconciliationResponseDto> {
  return db.transaction(async (tx) => {
    const shiftIds = [...new Set(body.boxes.map((box) => box.shiftId))];
    const ownedShifts = await tx
      .select({ id: schema.shifts.id })
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), inArray(schema.shifts.id, shiftIds)));
    if (ownedShifts.length !== shiftIds.length) throw new BadRequestException("Unknown shift");

    // Ingest takes these same advisory locks before changing a box. Locking in
    // sorted order also keeps a concurrent 200-box audit from deadlocking.
    const lockKeys = body.boxes
      .map((box) => `${tenantId}|${box.shiftId}|${deviceId}|${box.boxId}`)
      .sort();
    for (const key of lockKeys) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }

    const boxRows = await tx
      .select({
        id: schema.boxes.id,
        shiftId: schema.boxes.shiftId,
        deviceBoxId: schema.boxes.deviceBoxId,
        sscc: schema.boxes.sscc,
        closedAt: schema.boxes.closedAt,
        palletId: schema.boxes.palletId,
      })
      .from(schema.boxes)
      .where(
        and(
          eq(schema.boxes.tenantId, tenantId),
          eq(schema.boxes.terminalId, deviceId),
          inArray(schema.boxes.shiftId, shiftIds),
          inArray(
            schema.boxes.deviceBoxId,
            body.boxes.map((box) => box.boxId),
          ),
        ),
      );
    const boxesByKey = new Map(boxRows.map((box) => [boxKey(box.shiftId, box.deviceBoxId), box]));
    const ssccRows = await tx
      .select({ sscc: schema.boxes.sscc, id: schema.boxes.id })
      .from(schema.boxes)
      .where(
        and(
          eq(schema.boxes.tenantId, tenantId),
          inArray(
            schema.boxes.sscc,
            body.boxes.map((box) => box.sscc),
          ),
        ),
      );
    const boxBySscc = new Map(ssccRows.map((box) => [box.sscc, box.id]));
    const palletIds = [
      ...new Set(
        body.boxes.flatMap((box) => (box.devicePalletId === null ? [] : [box.devicePalletId])),
      ),
    ];
    const palletRows =
      palletIds.length === 0
        ? []
        : await tx
            .select({
              id: schema.pallets.id,
              shiftId: schema.pallets.shiftId,
              devicePalletId: schema.pallets.devicePalletId,
            })
            .from(schema.pallets)
            .where(
              and(
                eq(schema.pallets.tenantId, tenantId),
                eq(schema.pallets.terminalId, deviceId),
                eq(schema.pallets.kind, "production"),
                inArray(schema.pallets.shiftId, shiftIds),
                inArray(schema.pallets.devicePalletId, palletIds),
              ),
            );
    const palletsByKey = new Map(
      palletRows.flatMap((pallet) =>
        pallet.shiftId === null
          ? []
          : ([[palletKey(pallet.shiftId, pallet.devicePalletId), pallet]] as const),
      ),
    );
    const itemRows =
      boxRows.length === 0
        ? []
        : await tx
            .select({ boxId: schema.boxItems.boxId, codeHash: schema.boxItems.codeHash })
            .from(schema.boxItems)
            .where(
              and(
                eq(schema.boxItems.tenantId, tenantId),
                inArray(
                  schema.boxItems.boxId,
                  boxRows.map((box) => box.id),
                ),
                isNull(schema.boxItems.displacedAt),
                isNull(schema.boxItems.removedAt),
              ),
            );
    const hashesByBox = new Map<string, string[]>();
    for (const item of itemRows) {
      const hashes = hashesByBox.get(item.boxId) ?? [];
      hashes.push(item.codeHash);
      hashesByBox.set(item.boxId, hashes);
    }

    const results: StationBoxReconciliationResponseDto["results"] = [];
    for (const requested of body.boxes) {
      const found = boxesByKey.get(boxKey(requested.shiftId, requested.boxId));
      const result = (
        status: StationBoxReconciliationResponseDto["results"][number]["status"],
        reasonCode: StationBoxReconciliationResponseDto["results"][number]["reasonCode"],
        serverItemCount: number | null,
      ) => ({
        boxId: requested.boxId,
        status,
        reasonCode,
        serverItemCount,
      });
      if (!found) {
        results.push(
          result(
            boxBySscc.has(requested.sscc) ? "identity_conflict" : "replay_required",
            boxBySscc.has(requested.sscc) ? "sscc_conflict" : "box_absent",
            null,
          ),
        );
        continue;
      }
      const hashes = hashesByBox.get(found.id) ?? [];
      const count = hashes.length;
      if (
        boxBySscc.get(requested.sscc) !== undefined &&
        boxBySscc.get(requested.sscc) !== found.id
      ) {
        results.push(result("identity_conflict", "sscc_conflict", count));
      } else if (found.sscc !== null && found.sscc !== requested.sscc) {
        results.push(result("identity_conflict", "sscc_conflict", count));
      } else if (
        found.closedAt !== null &&
        found.closedAt.getTime() !== new Date(requested.closedAt).getTime()
      ) {
        results.push(result("identity_conflict", "closure_conflict", count));
      } else if (count !== requested.itemCount) {
        results.push(result("content_mismatch", "count_mismatch", count));
      } else if (boxMembershipDigestV1(hashes) !== requested.membershipDigest) {
        results.push(result("content_mismatch", "digest_mismatch", count));
      } else if (found.closedAt === null || found.sscc === null) {
        results.push(result("replay_required", "closure_absent", count));
      } else if (requested.devicePalletId === null) {
        results.push(
          found.palletId === null
            ? result("confirmed", "matched", count)
            : result("identity_conflict", "pallet_conflict", count),
        );
      } else {
        const pallet = palletsByKey.get(palletKey(requested.shiftId, requested.devicePalletId));
        if (!pallet) {
          results.push(
            found.palletId === null
              ? result("replay_required", "pallet_absent", count)
              : result("identity_conflict", "pallet_conflict", count),
          );
        } else if (found.palletId !== null && found.palletId !== pallet.id) {
          results.push(result("identity_conflict", "pallet_conflict", count));
        } else if (found.palletId === null) {
          const updated = await tx
            .update(schema.boxes)
            .set({ palletId: pallet.id })
            .where(
              and(
                eq(schema.boxes.tenantId, tenantId),
                eq(schema.boxes.id, found.id),
                isNull(schema.boxes.palletId),
              ),
            )
            .returning({ id: schema.boxes.id });
          if (updated.length === 1) await advanceBoxRegistryVersion(tx, tenantId, [found.id]);
          results.push(
            updated.length === 1
              ? result("confirmed", "matched", count)
              : result("identity_conflict", "pallet_conflict", count),
          );
        } else {
          results.push(result("confirmed", "matched", count));
        }
      }
    }
    return { results };
  });
}
