import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import {
  canonicalizeKm,
  kmHash,
  parseScannedSscc,
  type InventoryClaimWinner,
  type InventoryEvent,
  type InventoryEventBatchResponse,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import type {
  LeaveStationInventoryDto,
  LeaveStationInventoryResponseDto,
  StationInventoryEventBatchDto,
  StationInventoryEventBatchResponseDto,
  StationInventoryProgressDto,
  StationInventoryProgressQueryDto,
} from "./station-inventory.dto";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface ClaimTarget {
  codeHash: string;
  snapshotId: string | null;
  classification: "expected" | "protected" | "ineligible" | "unknown";
}

function winnerPrecedes(left: InventoryClaimWinner, right: InventoryClaimWinner): boolean {
  const time = Date.parse(left.scannedAt) - Date.parse(right.scannedAt);
  return (
    time < 0 ||
    (time === 0 &&
      (left.deviceId < right.deviceId ||
        (left.deviceId === right.deviceId && left.eventId < right.eventId)))
  );
}

function asWinner(row: {
  codeHash: string;
  eventId: string;
  deviceId: string;
  scannedAt: Date;
}): InventoryClaimWinner {
  return {
    codeHash: row.codeHash,
    eventId: row.eventId,
    deviceId: row.deviceId,
    scannedAt: row.scannedAt.toISOString(),
  };
}

@Injectable()
export class StationInventorySyncService {
  constructor(@Inject(DB) private readonly db: Db) {}

  ingest(
    tenantId: string,
    deviceId: string,
    inventoryId: string,
    input: StationInventoryEventBatchDto,
  ): Promise<StationInventoryEventBatchResponseDto> {
    return this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select({
          id: schema.inventories.id,
          status: schema.inventories.status,
          activeSnapshotId: schema.inventories.activeSnapshotId,
          resultRevision: schema.inventories.resultRevision,
          gtin14: schema.inventories.gtin14Snapshot,
          productionDateFrom: schema.inventories.productionDateFrom,
          productionDateTo: schema.inventories.productionDateTo,
        })
        .from(schema.inventories)
        .where(
          and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
        )
        .for("update");
      if (!inventory) throw new NotFoundException();

      const [participant] = await tx
        .select({
          operatorId: schema.inventoryDeviceParticipants.operatorId,
          leftAt: schema.inventoryDeviceParticipants.leftAt,
        })
        .from(schema.inventoryDeviceParticipants)
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
            eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          ),
        )
        .for("update");
      if (!participant) throw new NotFoundException();

      const [sameBatch] = await tx
        .select({
          payloadDigest: schema.inventoryScanBatches.payloadDigest,
          result: schema.inventoryScanBatches.result,
        })
        .from(schema.inventoryScanBatches)
        .where(
          and(
            eq(schema.inventoryScanBatches.tenantId, tenantId),
            eq(schema.inventoryScanBatches.inventoryId, inventoryId),
            eq(schema.inventoryScanBatches.deviceId, deviceId),
            eq(schema.inventoryScanBatches.batchId, input.batchId),
          ),
        );
      if (sameBatch) {
        if (sameBatch.payloadDigest !== input.payloadDigest) {
          throw new ConflictException({ code: "INVENTORY_BATCH_DIGEST_CONFLICT" });
        }
        return sameBatch.result as unknown as StationInventoryEventBatchResponseDto;
      }
      const [sameDigest] = await tx
        .select({ batchId: schema.inventoryScanBatches.batchId })
        .from(schema.inventoryScanBatches)
        .where(
          and(
            eq(schema.inventoryScanBatches.tenantId, tenantId),
            eq(schema.inventoryScanBatches.inventoryId, inventoryId),
            eq(schema.inventoryScanBatches.deviceId, deviceId),
            eq(schema.inventoryScanBatches.payloadDigest, input.payloadDigest),
          ),
        );
      if (sameDigest) {
        throw new ConflictException({ code: "INVENTORY_BATCH_DIGEST_REUSED" });
      }

      if (inventory.activeSnapshotId !== input.snapshotId || input.snapshotRevision !== 1) {
        throw new ConflictException({ code: "INVENTORY_SNAPSHOT_MISMATCH" });
      }
      if (input.events.some((event) => event.operatorId !== participant.operatorId)) {
        throw new ConflictException({ code: "INVENTORY_PARTICIPANT_OPERATOR_MISMATCH" });
      }

      const targets = new Map<string, ClaimTarget[]>();
      for (const event of input.events) {
        targets.set(
          event.eventId,
          await this.validateAndExpand(
            tx,
            tenantId,
            inventoryId,
            input.snapshotId,
            inventory.gtin14,
            inventory.productionDateFrom,
            inventory.productionDateTo,
            event,
          ),
        );
      }

      if (inventory.status !== "running") {
        if (inventory.status !== "closed" && inventory.status !== "completed") {
          throw new ConflictException({ code: "INVENTORY_NOT_ACCEPTING_EVENTS" });
        }
        const response = this.response(
          inventoryId,
          input,
          inventory.resultRevision,
          input.events.map((event) => ({
            eventId: event.eventId,
            status: "quarantined" as const,
            reasonCode:
              inventory.status === "completed" ? "INVENTORY_COMPLETED" : "INVENTORY_CLOSED",
          })),
        );
        await tx.insert(schema.inventoryScanBatches).values({
          tenantId,
          inventoryId,
          deviceId,
          batchId: input.batchId,
          payloadDigest: input.payloadDigest,
          sequenceCeiling: BigInt(input.sequenceCeiling),
          outcome: "quarantined",
          result: response,
        });
        await tx.insert(schema.inventoryLateEvents).values({
          tenantId,
          inventoryId,
          deviceId,
          batchId: input.batchId,
          payload: input,
          payloadDigest: input.payloadDigest,
          closedRevision: inventory.resultRevision,
          reason: inventory.status === "completed" ? "INVENTORY_COMPLETED" : "INVENTORY_CLOSED",
        });
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: null,
          action: "inventory.station.events_quarantined",
          outcome: "success",
          targetType: "inventory",
          targetId: inventoryId,
          after: {
            tenantId,
            inventoryId,
            deviceId,
            operatorId: participant.operatorId,
            snapshotId: input.snapshotId,
            snapshotRevision: 1,
            batchId: input.batchId,
            payloadDigest: input.payloadDigest,
            sequenceCeiling: input.sequenceCeiling,
            eventCount: input.events.length,
            closedRevision: inventory.resultRevision,
            reason: inventory.status === "completed" ? "INVENTORY_COMPLETED" : "INVENTORY_CLOSED",
          },
        });
        return response;
      }
      if (participant.leftAt !== null) {
        throw new ConflictException({ code: "INVENTORY_PARTICIPANT_LEFT" });
      }

      const eventIds = input.events.map((event) => event.eventId);
      const sequences = input.events.map((event) => BigInt(event.deviceSequence));
      const existingEvents = await tx
        .select({ eventId: schema.inventoryScanEvents.eventId })
        .from(schema.inventoryScanEvents)
        .where(
          or(
            inArray(schema.inventoryScanEvents.eventId, eventIds),
            and(
              eq(schema.inventoryScanEvents.tenantId, tenantId),
              eq(schema.inventoryScanEvents.inventoryId, inventoryId),
              eq(schema.inventoryScanEvents.deviceId, deviceId),
              inArray(schema.inventoryScanEvents.deviceSequence, sequences),
            ),
          ),
        );
      if (existingEvents.length > 0) {
        throw new ConflictException({ code: "INVENTORY_EVENT_ID_OR_SEQUENCE_REUSED" });
      }

      await tx.insert(schema.inventoryScanBatches).values({
        tenantId,
        inventoryId,
        deviceId,
        batchId: input.batchId,
        payloadDigest: input.payloadDigest,
        sequenceCeiling: BigInt(input.sequenceCeiling),
        outcome: "applied",
        result: {},
      });
      await tx.insert(schema.inventoryScanEvents).values(
        input.events.map((event) => ({
          eventId: event.eventId,
          tenantId,
          inventoryId,
          batchId: input.batchId,
          deviceId,
          deviceSequence: BigInt(event.deviceSequence),
          operatorId: event.operatorId,
          scannedAt: new Date(event.scannedAt),
          kind: event.kind,
          normalizedIdentity: event.normalizedIdentity,
          codeHash: event.codeHash,
          rawPayload: event.canonicalRaw,
          activeProductionDate: event.activeProductionDate,
          snapshotRevision: input.snapshotRevision,
          localVerdict: event.localVerdict,
          authoritativeVerdict: "pending",
        })),
      );

      const changed = new Map<string, ClaimTarget & { winner: InventoryClaimWinner }>();
      for (const event of input.events) {
        const eventTargets = targets.get(event.eventId) ?? [];
        for (const target of eventTargets) {
          const candidate: InventoryClaimWinner = {
            codeHash: target.codeHash,
            eventId: event.eventId,
            deviceId,
            scannedAt: event.scannedAt,
          };
          const [current] = await tx
            .select({
              codeHash: schema.inventoryCodeResults.codeHash,
              eventId: schema.inventoryCodeResults.firstAcceptedEventId,
              deviceId: schema.inventoryCodeResults.winningDeviceId,
              scannedAt: schema.inventoryCodeResults.winningScannedAt,
            })
            .from(schema.inventoryCodeResults)
            .where(
              and(
                eq(schema.inventoryCodeResults.tenantId, tenantId),
                eq(schema.inventoryCodeResults.inventoryId, inventoryId),
                eq(schema.inventoryCodeResults.codeHash, target.codeHash),
              ),
            )
            .for("update");
          if (!current) {
            await tx.insert(schema.inventoryCodeResults).values({
              tenantId,
              inventoryId,
              codeHash: target.codeHash,
              snapshotId: target.snapshotId,
              firstAcceptedEventId: event.eventId,
              winningDeviceId: deviceId,
              winningScannedAt: new Date(event.scannedAt),
              observedProductionDate: event.activeProductionDate,
              classification: target.classification,
              originClassification: target.classification,
            });
            changed.set(target.codeHash, { ...target, winner: candidate });
          } else {
            const currentWinner = asWinner(current);
            if (winnerPrecedes(candidate, currentWinner)) {
              await tx
                .update(schema.inventoryCodeResults)
                .set({
                  firstAcceptedEventId: event.eventId,
                  winningDeviceId: deviceId,
                  winningScannedAt: new Date(event.scannedAt),
                  observedProductionDate: event.activeProductionDate,
                  classification: target.classification,
                  originClassification: target.classification,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(schema.inventoryCodeResults.tenantId, tenantId),
                    eq(schema.inventoryCodeResults.inventoryId, inventoryId),
                    eq(schema.inventoryCodeResults.codeHash, target.codeHash),
                  ),
                );
              await tx
                .update(schema.inventoryScanEvents)
                .set({ authoritativeVerdict: "duplicate", firstWinningEventId: event.eventId })
                .where(
                  and(
                    eq(schema.inventoryScanEvents.tenantId, tenantId),
                    eq(schema.inventoryScanEvents.inventoryId, inventoryId),
                    eq(schema.inventoryScanEvents.eventId, current.eventId),
                  ),
                );
              changed.set(target.codeHash, { ...target, winner: candidate });
            }
          }
        }
      }

      const allTargetHashes = [
        ...new Set([...targets.values()].flat().map((target) => target.codeHash)),
      ];
      const finalWinners = new Map<string, InventoryClaimWinner>();
      if (allTargetHashes.length > 0) {
        const rows = await tx
          .select({
            codeHash: schema.inventoryCodeResults.codeHash,
            eventId: schema.inventoryCodeResults.firstAcceptedEventId,
            deviceId: schema.inventoryCodeResults.winningDeviceId,
            scannedAt: schema.inventoryCodeResults.winningScannedAt,
          })
          .from(schema.inventoryCodeResults)
          .where(
            and(
              eq(schema.inventoryCodeResults.tenantId, tenantId),
              eq(schema.inventoryCodeResults.inventoryId, inventoryId),
              inArray(schema.inventoryCodeResults.codeHash, allTargetHashes),
            ),
          );
        for (const row of rows) finalWinners.set(row.codeHash, asWinner(row));
      }

      const outcomes: InventoryEventBatchResponse["outcomes"] = [];
      for (const event of input.events) {
        const eventTargets = targets.get(event.eventId) ?? [];
        const winners = eventTargets
          .map((target) => finalWinners.get(target.codeHash))
          .filter((winner): winner is InventoryClaimWinner => winner !== undefined);
        const applied = winners.filter((winner) => winner.eventId === event.eventId).length;
        const lost = winners.filter((winner) => winner.eventId !== event.eventId);
        const firstLost = lost.sort(
          (a, b) =>
            Date.parse(a.scannedAt) - Date.parse(b.scannedAt) ||
            a.deviceId.localeCompare(b.deviceId) ||
            a.eventId.localeCompare(b.eventId),
        )[0];
        const status = applied > 0 || event.kind === "old_box" ? "applied" : "duplicate";
        await tx
          .update(schema.inventoryScanEvents)
          .set({
            authoritativeVerdict: status,
            firstWinningEventId:
              status === "duplicate" ? (firstLost?.eventId ?? null) : event.eventId,
          })
          .where(eq(schema.inventoryScanEvents.eventId, event.eventId));
        outcomes.push({
          eventId: event.eventId,
          status,
          reasonCode: status === "applied" ? "CLAIM_APPLIED" : "CLAIM_LOST",
          claimedCount: applied,
          conflictCount: lost.length,
          ...(firstLost ? { winner: firstLost } : {}),
        });
      }

      const nextRevision =
        changed.size > 0 ? inventory.resultRevision + 1 : inventory.resultRevision;
      if (changed.size > 0) {
        await tx
          .update(schema.inventories)
          .set({ resultRevision: nextRevision, updatedAt: new Date() })
          .where(
            and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
          );
        await tx.insert(schema.inventoryProgressChanges).values(
          [...changed.values()].map((change) => ({
            tenantId,
            inventoryId,
            snapshotId: input.snapshotId,
            resultRevision: nextRevision,
            kind: "claim" as const,
            codeHash: change.codeHash,
            classification: change.classification,
            observedProductionDate:
              input.events.find((event) => event.eventId === change.winner.eventId)
                ?.activeProductionDate ?? null,
            winningEventId: change.winner.eventId,
            winningDeviceId: change.winner.deviceId,
            winningScannedAt: new Date(change.winner.scannedAt),
          })),
        );
      }
      await tx
        .update(schema.inventoryDeviceParticipants)
        .set({
          heartbeatAt: new Date(),
          pendingEventCount: input.pendingEventCount,
          openBoxCount: input.openBoxCount,
        })
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
            eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          ),
        );
      const response = this.response(inventoryId, input, nextRevision, outcomes);
      await tx
        .update(schema.inventoryScanBatches)
        .set({ result: response })
        .where(
          and(
            eq(schema.inventoryScanBatches.tenantId, tenantId),
            eq(schema.inventoryScanBatches.inventoryId, inventoryId),
            eq(schema.inventoryScanBatches.deviceId, deviceId),
            eq(schema.inventoryScanBatches.batchId, input.batchId),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: null,
        action: "inventory.station.events_synced",
        outcome: "success",
        targetType: "inventory",
        targetId: inventoryId,
        after: {
          tenantId,
          inventoryId,
          deviceId,
          operatorId: participant.operatorId,
          snapshotId: input.snapshotId,
          snapshotRevision: 1,
          batchId: input.batchId,
          payloadDigest: input.payloadDigest,
          sequenceCeiling: input.sequenceCeiling,
          eventCount: input.events.length,
          resultRevision: nextRevision,
          pendingEventCount: input.pendingEventCount,
          openBoxCount: input.openBoxCount,
        },
      });
      return response;
    });
  }

  async progress(
    tenantId: string,
    deviceId: string,
    inventoryId: string,
    query: StationInventoryProgressQueryDto,
  ): Promise<StationInventoryProgressDto> {
    const participant = await this.activeParticipant(tenantId, deviceId, inventoryId);
    const [inventory] = await this.db
      .select({
        snapshotId: schema.inventories.activeSnapshotId,
        resultRevision: schema.inventories.resultRevision,
      })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    if (!inventory?.snapshotId) throw new NotFoundException();
    void participant;
    const [revisionText, id] = query.cursor?.split(":") ?? [];
    const revision = revisionText ? Number(revisionText) : null;
    const whereCursor =
      revision === null || id === undefined
        ? undefined
        : or(
            gt(schema.inventoryProgressChanges.resultRevision, revision),
            and(
              eq(schema.inventoryProgressChanges.resultRevision, revision),
              gt(schema.inventoryProgressChanges.id, id),
            ),
          );
    const rows = await this.db
      .select()
      .from(schema.inventoryProgressChanges)
      .where(
        and(
          eq(schema.inventoryProgressChanges.tenantId, tenantId),
          eq(schema.inventoryProgressChanges.inventoryId, inventoryId),
          whereCursor,
        ),
      )
      .orderBy(
        asc(schema.inventoryProgressChanges.resultRevision),
        asc(schema.inventoryProgressChanges.id),
      )
      .limit(query.limit);
    const items = rows.map((row) => ({
      id: row.id,
      revision: row.resultRevision,
      kind: row.kind,
      codeHash: row.codeHash,
      classification: row.classification,
      observedProductionDate: row.observedProductionDate,
      winner:
        row.winningEventId && row.winningDeviceId && row.winningScannedAt
          ? {
              codeHash: row.codeHash,
              eventId: row.winningEventId,
              deviceId: row.winningDeviceId,
              scannedAt: row.winningScannedAt.toISOString(),
            }
          : null,
      correctedAt: row.changedAt.toISOString(),
    }));
    const last = items.at(-1);
    return {
      inventoryId,
      snapshotId: inventory.snapshotId,
      snapshotRevision: 1,
      cursor: query.cursor ?? null,
      resultRevision: inventory.resultRevision,
      items,
      nextCursor: last ? `${last.revision}:${last.id}` : null,
    };
  }

  leave(
    tenantId: string,
    deviceId: string,
    inventoryId: string,
    input: LeaveStationInventoryDto,
  ): Promise<LeaveStationInventoryResponseDto> {
    return this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select({ id: schema.inventories.id })
        .from(schema.inventories)
        .where(
          and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
        )
        .for("update");
      if (!inventory) throw new NotFoundException();
      const [participant] = await tx
        .select({
          operatorId: schema.inventoryDeviceParticipants.operatorId,
          pendingEventCount: schema.inventoryDeviceParticipants.pendingEventCount,
          openBoxCount: schema.inventoryDeviceParticipants.openBoxCount,
          leftAt: schema.inventoryDeviceParticipants.leftAt,
        })
        .from(schema.inventoryDeviceParticipants)
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
            eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          ),
        )
        .for("update");
      if (!participant) throw new NotFoundException();
      if (
        input.pendingEventCount !== 0 ||
        input.openBoxCount !== 0 ||
        participant.pendingEventCount !== 0 ||
        participant.openBoxCount !== 0
      ) {
        throw new ConflictException({ code: "INVENTORY_LEAVE_PENDING_WORK" });
      }
      if (participant.leftAt === null) {
        await tx
          .update(schema.inventoryDeviceParticipants)
          .set({ leftAt: new Date(), heartbeatAt: new Date() })
          .where(
            and(
              eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
              eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
              eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
            ),
          );
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: null,
          action: "inventory.station.left",
          outcome: "success",
          targetType: "inventory",
          targetId: inventoryId,
          after: {
            tenantId,
            inventoryId,
            deviceId,
            operatorId: participant.operatorId,
            pendingEventCount: 0,
            openBoxCount: 0,
          },
        });
      }
      return { outcome: "left" };
    });
  }

  private async activeParticipant(tenantId: string, deviceId: string, inventoryId: string) {
    const [participant] = await this.db
      .select({ id: schema.inventoryDeviceParticipants.id })
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceId),
          isNull(schema.inventoryDeviceParticipants.leftAt),
        ),
      );
    if (!participant) throw new NotFoundException();
    return participant;
  }

  private async validateAndExpand(
    tx: Transaction,
    tenantId: string,
    inventoryId: string,
    snapshotId: string,
    gtin14: string,
    productionDateFrom: string,
    productionDateTo: string,
    event: InventoryEvent,
  ): Promise<ClaimTarget[]> {
    if (!event.canonicalRaw) {
      throw new ConflictException({ code: "INVENTORY_EVENT_IDENTITY_INVALID" });
    }
    if (
      event.activeProductionDate === null ||
      event.activeProductionDate < productionDateFrom ||
      event.activeProductionDate > productionDateTo
    ) {
      throw new ConflictException({ code: "INVENTORY_EVENT_PRODUCTION_DATE_MISMATCH" });
    }
    if (event.kind === "item") {
      if (!event.codeHash || event.normalizedIdentity !== `item:${event.codeHash}`) {
        throw new ConflictException({ code: "INVENTORY_EVENT_IDENTITY_INVALID" });
      }
      let canonical;
      try {
        canonical = canonicalizeKm(event.canonicalRaw);
      } catch {
        throw new ConflictException({ code: "INVENTORY_EVENT_IDENTITY_INVALID" });
      }
      if (canonical.raw !== event.canonicalRaw || kmHash(canonical) !== event.codeHash) {
        throw new ConflictException({ code: "INVENTORY_EVENT_IDENTITY_INVALID" });
      }
      if (canonical.gtin14 !== gtin14) {
        throw new ConflictException({ code: "INVENTORY_EVENT_GTIN_MISMATCH" });
      }
      const [row] = await tx
        .select({
          expected: schema.inventorySnapshotCodes.expected,
          protected: schema.inventorySnapshotCodes.protected,
        })
        .from(schema.inventorySnapshotCodes)
        .where(
          and(
            eq(schema.inventorySnapshotCodes.tenantId, tenantId),
            eq(schema.inventorySnapshotCodes.snapshotId, snapshotId),
            eq(schema.inventorySnapshotCodes.codeHash, event.codeHash),
          ),
        );
      return [
        {
          codeHash: event.codeHash,
          snapshotId: row ? snapshotId : null,
          classification: !row
            ? "unknown"
            : row.protected
              ? "protected"
              : row.expected
                ? "expected"
                : "ineligible",
        },
      ];
    }
    const sscc = parseScannedSscc(event.canonicalRaw);
    if (!sscc || event.codeHash !== null || event.normalizedIdentity !== `${event.kind}:${sscc}`) {
      throw new ConflictException({ code: "INVENTORY_EVENT_IDENTITY_INVALID" });
    }
    const rows = await tx
      .select({
        codeHash: schema.inventorySnapshotCodes.codeHash,
        expected: schema.inventorySnapshotCodes.expected,
        protected: schema.inventorySnapshotCodes.protected,
      })
      .from(schema.inventorySnapshotCodes)
      .innerJoin(
        schema.inventorySnapshots,
        and(
          eq(schema.inventorySnapshots.tenantId, schema.inventorySnapshotCodes.tenantId),
          eq(schema.inventorySnapshots.id, schema.inventorySnapshotCodes.snapshotId),
        ),
      )
      .where(
        and(
          eq(schema.inventorySnapshotCodes.tenantId, tenantId),
          eq(schema.inventorySnapshotCodes.snapshotId, snapshotId),
          eq(schema.inventorySnapshots.inventoryId, inventoryId),
          eq(schema.inventorySnapshotCodes.parentSscc, sscc),
        ),
      )
      .orderBy(asc(schema.inventorySnapshotCodes.codeHash));
    if ((event.kind === "known_box") !== rows.length > 0) {
      throw new ConflictException({ code: "INVENTORY_EVENT_KIND_MISMATCH" });
    }
    return rows.map((row) => ({
      codeHash: row.codeHash,
      snapshotId,
      classification: row.protected ? "protected" : row.expected ? "expected" : "ineligible",
    }));
  }

  private response(
    inventoryId: string,
    input: StationInventoryEventBatchDto,
    resultRevision: number,
    outcomes: InventoryEventBatchResponse["outcomes"],
  ): InventoryEventBatchResponse {
    return {
      inventoryId,
      snapshotId: input.snapshotId,
      snapshotRevision: 1,
      batchId: input.batchId,
      payloadDigest: input.payloadDigest,
      sequenceCeiling: input.sequenceCeiling,
      resultRevision,
      outcomes,
    };
  }
}
