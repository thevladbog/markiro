import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import {
  canonicalizeKm,
  INVENTORY_EVENT_BATCH_CLAIM_OUTCOME_SIZE,
  INVENTORY_EVENT_CLAIM_OUTCOME_SIZE,
  inventoryEventBatchResponseSchema,
  kmHash,
  parseInventoryEventBatchResponse,
  parseScannedSscc,
  parseSscc,
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

interface ProgressStreamRow {
  id: string;
  resultRevision: number;
  kind: "claim" | "correction" | "remove_item" | "invalidate_box" | "reprint";
  codeHash: string | null;
  classification: "expected" | "protected" | "ineligible" | "unknown" | "voided" | null;
  observedProductionDate: string | null;
  winningEventId: string | null;
  winningDeviceId: string | null;
  winningScannedAt: Date | string | null;
  resultId: string | null;
  boxId: string | null;
  ownerDeviceId: string | null;
  effectAt: Date | string;
  changedAt: Date | string;
}

function readProgressDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Inventory progress timestamp is invalid");
  return date.toISOString();
}

function parseProgressStreamRow(value: unknown): ProgressStreamRow {
  if (typeof value !== "object" || value === null) {
    throw new Error("Inventory progress row is unavailable");
  }
  const read = (key: string): unknown => Reflect.get(value, key);
  const requiredString = (key: string): string => {
    const field = read(key);
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(`Inventory progress ${key} is invalid`);
    }
    return field;
  };
  const nullableString = (key: string): string | null => {
    const field = read(key);
    if (field === null) return null;
    if (typeof field !== "string") throw new Error(`Inventory progress ${key} is invalid`);
    return field;
  };
  const kind = requiredString("kind");
  if (
    kind !== "claim" &&
    kind !== "correction" &&
    kind !== "remove_item" &&
    kind !== "invalidate_box" &&
    kind !== "reprint"
  ) {
    throw new Error("Inventory progress kind is invalid");
  }
  const classification = nullableString("classification");
  if (
    classification !== null &&
    classification !== "expected" &&
    classification !== "protected" &&
    classification !== "ineligible" &&
    classification !== "unknown" &&
    classification !== "voided"
  ) {
    throw new Error("Inventory progress classification is invalid");
  }
  const revision = read("resultRevision");
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new Error("Inventory progress revision is invalid");
  }
  const changedAt = read("changedAt");
  if (!(changedAt instanceof Date) && typeof changedAt !== "string") {
    throw new Error("Inventory progress changedAt is invalid");
  }
  const effectAt = read("effectAt");
  if (!(effectAt instanceof Date) && typeof effectAt !== "string") {
    throw new Error("Inventory progress effectAt is invalid");
  }
  const winningScannedAt = read("winningScannedAt");
  if (
    winningScannedAt !== null &&
    !(winningScannedAt instanceof Date) &&
    typeof winningScannedAt !== "string"
  ) {
    throw new Error("Inventory progress winningScannedAt is invalid");
  }
  return {
    id: requiredString("id"),
    resultRevision: revision,
    kind,
    codeHash: nullableString("codeHash"),
    classification,
    observedProductionDate: nullableString("observedProductionDate"),
    winningEventId: nullableString("winningEventId"),
    winningDeviceId: nullableString("winningDeviceId"),
    winningScannedAt,
    resultId: nullableString("resultId"),
    boxId: nullableString("boxId"),
    ownerDeviceId: nullableString("ownerDeviceId"),
    effectAt,
    changedAt,
  };
}

interface RepackInventoryFacts {
  mode: "check" | "repack";
  capacity: number | null;
}

function repackInventoryFacts(mode: "check" | "repack", manifest: unknown): RepackInventoryFacts {
  if (typeof manifest !== "object" || manifest === null || !("boxCapacity" in manifest)) {
    return { mode, capacity: null };
  }
  const capacity = Reflect.get(manifest, "boxCapacity");
  return {
    mode,
    capacity: Number.isSafeInteger(capacity) && Number(capacity) > 0 ? Number(capacity) : null,
  };
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

function conflictCode(error: ConflictException): string | null {
  const response = error.getResponse();
  return typeof response === "object" && response !== null && "code" in response
    ? String(response.code)
    : null;
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
      let replayAuthorization: { lateEventId: string; actorUserId: string } | null = null;
      const [inventory] = await tx
        .select({
          id: schema.inventories.id,
          status: schema.inventories.status,
          activeSnapshotId: schema.inventories.activeSnapshotId,
          resultRevision: schema.inventories.resultRevision,
          gtin14: schema.inventories.gtin14Snapshot,
          productionDateFrom: schema.inventories.productionDateFrom,
          productionDateTo: schema.inventories.productionDateTo,
          mode: schema.inventories.mode,
          stationManifest: schema.inventories.stationManifest,
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
          outcome: schema.inventoryScanBatches.outcome,
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
        if (sameBatch.outcome === "quarantined" && inventory.status === "running") {
          const [lateEvent] = await tx
            .select({
              id: schema.inventoryLateEvents.id,
              replayAuthorizedByUserId: schema.inventoryLateEvents.replayAuthorizedByUserId,
            })
            .from(schema.inventoryLateEvents)
            .where(
              and(
                eq(schema.inventoryLateEvents.tenantId, tenantId),
                eq(schema.inventoryLateEvents.inventoryId, inventoryId),
                eq(schema.inventoryLateEvents.deviceId, deviceId),
                eq(schema.inventoryLateEvents.batchId, input.batchId),
                eq(schema.inventoryLateEvents.payloadDigest, input.payloadDigest),
                eq(schema.inventoryLateEvents.resolution, "pending"),
              ),
            )
            .for("update");
          if (lateEvent?.replayAuthorizedByUserId) {
            replayAuthorization = {
              lateEventId: lateEvent.id,
              actorUserId: lateEvent.replayAuthorizedByUserId,
            };
            await tx
              .delete(schema.inventoryScanBatches)
              .where(
                and(
                  eq(schema.inventoryScanBatches.tenantId, tenantId),
                  eq(schema.inventoryScanBatches.inventoryId, inventoryId),
                  eq(schema.inventoryScanBatches.deviceId, deviceId),
                  eq(schema.inventoryScanBatches.batchId, input.batchId),
                  eq(schema.inventoryScanBatches.outcome, "quarantined"),
                ),
              );
          }
        }
        if (replayAuthorization === null) {
          return this.normalizeStoredResponse(
            tx,
            tenantId,
            deviceId,
            inventoryId,
            input,
            sameBatch.result,
            inventory.resultRevision,
          );
        }
      }
      const [sameDigest] = await tx
        .select({
          batchId: schema.inventoryScanBatches.batchId,
          outcome: schema.inventoryScanBatches.outcome,
          result: schema.inventoryScanBatches.result,
        })
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
        const prior = await this.normalizeStoredResponse(
          tx,
          tenantId,
          deviceId,
          inventoryId,
          { ...input, batchId: sameDigest.batchId },
          sameDigest.result,
          inventory.resultRevision,
        );
        const replay = {
          ...prior,
          batchId: input.batchId,
          outcomes: prior.outcomes.map((outcome) =>
            outcome.status === "rejected" || outcome.status === "quarantined"
              ? outcome
              : {
                  ...outcome,
                  status: "replay" as const,
                  reasonCode: "BATCH_REPLAY" as const,
                },
          ),
        };
        await tx.insert(schema.inventoryScanBatches).values({
          tenantId,
          inventoryId,
          deviceId,
          batchId: input.batchId,
          payloadDigest: input.payloadDigest,
          sequenceCeiling: BigInt(input.sequenceCeiling),
          outcome: sameDigest.outcome,
          result: replay,
        });
        return replay;
      }

      if (inventory.activeSnapshotId !== input.snapshotId || input.snapshotRevision !== 1) {
        throw new ConflictException({ code: "INVENTORY_SNAPSHOT_MISMATCH" });
      }
      if (input.events.some((event) => event.operatorId !== participant.operatorId)) {
        throw new ConflictException({ code: "INVENTORY_PARTICIPANT_OPERATOR_MISMATCH" });
      }

      const repackFacts = repackInventoryFacts(inventory.mode, inventory.stationManifest);
      const targets = new Map<string, ClaimTarget[]>();
      const rejectedEvents = new Set<string>();
      const rejectionErrors = new Map<string, ConflictException>();
      let expandedClaimCount = 0;
      for (const event of input.events) {
        let expanded: ClaimTarget[];
        try {
          expanded = await this.validateAndExpand(
            tx,
            tenantId,
            inventoryId,
            input.snapshotId,
            inventory.gtin14,
            inventory.productionDateFrom,
            inventory.productionDateTo,
            repackFacts,
            event,
          );
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          rejectedEvents.add(event.eventId);
          rejectionErrors.set(event.eventId, error);
          targets.set(event.eventId, []);
          continue;
        }
        if (expanded.length > INVENTORY_EVENT_CLAIM_OUTCOME_SIZE) {
          throw new ConflictException({ code: "INVENTORY_EVENT_CLAIM_LIMIT_EXCEEDED" });
        }
        if (expandedClaimCount + expanded.length > INVENTORY_EVENT_BATCH_CLAIM_OUTCOME_SIZE) {
          throw new ConflictException({ code: "INVENTORY_BATCH_CLAIM_LIMIT_EXCEEDED" });
        }
        expandedClaimCount += expanded.length;
        targets.set(event.eventId, expanded);
      }

      if (inventory.status !== "running") {
        const invalidLateEvent = input.events.find((event) => rejectionErrors.has(event.eventId));
        if (invalidLateEvent) {
          const rejection = rejectionErrors.get(invalidLateEvent.eventId);
          if (rejection && conflictCode(rejection) !== "INVENTORY_EVENT_MODE_MISMATCH") {
            throw rejection;
          }
        }
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
            claimedCount: 0,
            conflictCount: 0,
            claims: [],
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
        return response;
      }
      if (participant.leftAt !== null) {
        throw new ConflictException({ code: "INVENTORY_PARTICIPANT_LEFT" });
      }

      const [acceptedHighWater] = await tx
        .select({ sequenceCeiling: schema.inventoryScanBatches.sequenceCeiling })
        .from(schema.inventoryScanBatches)
        .where(
          and(
            eq(schema.inventoryScanBatches.tenantId, tenantId),
            eq(schema.inventoryScanBatches.inventoryId, inventoryId),
            eq(schema.inventoryScanBatches.deviceId, deviceId),
            inArray(schema.inventoryScanBatches.outcome, ["applied", "rejected"]),
          ),
        )
        .orderBy(desc(schema.inventoryScanBatches.sequenceCeiling))
        .limit(1);
      if (
        acceptedHighWater &&
        BigInt(input.events[0]?.deviceSequence ?? 0) <= acceptedHighWater.sequenceCeiling
      ) {
        throw new ConflictException({ code: "INVENTORY_EVENT_SEQUENCE_BELOW_HIGH_WATER" });
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
        outcome: rejectedEvents.size === input.events.length ? "rejected" : "applied",
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
          authoritativeVerdict: rejectedEvents.has(event.eventId) ? "rejected" : "pending",
        })),
      );

      const changed = new Map<string, ClaimTarget & { winner: InventoryClaimWinner }>();
      const displacedEvents = new Set<string>();
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
              displacedEvents.add(current.eventId);
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
                .update(schema.inventoryEventClaimOutcomes)
                .set({
                  status: "duplicate",
                  winningEventId: event.eventId,
                  winningDeviceId: deviceId,
                  winningScannedAt: new Date(event.scannedAt),
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
                    eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
                    eq(schema.inventoryEventClaimOutcomes.sourceEventId, current.eventId),
                    eq(schema.inventoryEventClaimOutcomes.codeHash, target.codeHash),
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
        if (rejectedEvents.has(event.eventId)) {
          outcomes.push({
            eventId: event.eventId,
            status: "rejected",
            reasonCode: "INVENTORY_EVENT_REJECTED",
            claimedCount: 0,
            conflictCount: 0,
            claims: [],
          });
          continue;
        }
        const eventTargets = targets.get(event.eventId) ?? [];
        const claims = eventTargets.map((target) => {
          const winner = finalWinners.get(target.codeHash);
          if (!winner) throw new Error("inventory claim winner missing");
          return {
            codeHash: target.codeHash,
            status:
              winner.eventId === event.eventId ? ("claimed" as const) : ("duplicate" as const),
            winner,
          };
        });
        const applied = claims.filter((claim) => claim.status === "claimed").length;
        const lost = claims.length - applied;
        const status =
          applied > 0 || event.kind === "old_box" || event.kind === "repack_action"
            ? "applied"
            : "duplicate";
        if (claims.length > 0) {
          await tx.insert(schema.inventoryEventClaimOutcomes).values(
            claims.map((claim) => ({
              tenantId,
              inventoryId,
              sourceEventId: event.eventId,
              codeHash: claim.codeHash,
              status: claim.status,
              winningEventId: claim.winner.eventId,
              winningDeviceId: claim.winner.deviceId,
              winningScannedAt: new Date(claim.winner.scannedAt),
            })),
          );
        }
        await tx
          .update(schema.inventoryScanEvents)
          .set({
            authoritativeVerdict: status,
            firstWinningEventId: null,
          })
          .where(eq(schema.inventoryScanEvents.eventId, event.eventId));
        outcomes.push({
          eventId: event.eventId,
          status,
          reasonCode: status === "applied" ? "CLAIM_APPLIED" : "CLAIM_LOST",
          claimedCount: applied,
          conflictCount: lost,
          claims,
        });
      }

      for (const [index, event] of input.events.entries()) {
        if (!event.repack || rejectedEvents.has(event.eventId)) continue;
        await this.applyRepackMutation(
          tx,
          tenantId,
          deviceId,
          inventoryId,
          input.snapshotId,
          repackFacts,
          event,
          outcomes[index]!,
        );
      }

      for (const displacedEventId of displacedEvents) {
        const evidence = await tx
          .select({ status: schema.inventoryEventClaimOutcomes.status })
          .from(schema.inventoryEventClaimOutcomes)
          .where(
            and(
              eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
              eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
              eq(schema.inventoryEventClaimOutcomes.sourceEventId, displacedEventId),
            ),
          );
        await tx
          .update(schema.inventoryScanEvents)
          .set({
            authoritativeVerdict: evidence.some((claim) => claim.status === "claimed")
              ? "applied"
              : "duplicate",
            firstWinningEventId: null,
          })
          .where(
            and(
              eq(schema.inventoryScanEvents.tenantId, tenantId),
              eq(schema.inventoryScanEvents.inventoryId, inventoryId),
              eq(schema.inventoryScanEvents.eventId, displacedEventId),
            ),
          );
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
          rejectedEventCount: rejectedEvents.size,
          rejectedEventIds: [...rejectedEvents],
          resultRevision: nextRevision,
          pendingEventCount: input.pendingEventCount,
          openBoxCount: input.openBoxCount,
          replayedLateEventId: replayAuthorization?.lateEventId ?? null,
        },
      });
      if (replayAuthorization) {
        await tx
          .update(schema.inventoryLateEvents)
          .set({
            resolution: "replayed",
            resolvedAt: new Date(),
            resolvedByUserId: replayAuthorization.actorUserId,
          })
          .where(
            and(
              eq(schema.inventoryLateEvents.tenantId, tenantId),
              eq(schema.inventoryLateEvents.inventoryId, inventoryId),
              eq(schema.inventoryLateEvents.id, replayAuthorization.lateEventId),
              eq(schema.inventoryLateEvents.resolution, "pending"),
            ),
          );
      }
      return response;
    });
  }

  async progress(
    tenantId: string,
    deviceId: string,
    inventoryId: string,
    query: StationInventoryProgressQueryDto,
  ): Promise<StationInventoryProgressDto> {
    await this.activeParticipant(tenantId, deviceId, inventoryId);
    return this.db.transaction(
      async (tx) => {
        const [inventory] = await tx
          .select({
            snapshotId: schema.inventories.activeSnapshotId,
            resultRevision: schema.inventories.resultRevision,
          })
          .from(schema.inventories)
          .where(
            and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
          );
        if (!inventory?.snapshotId) throw new NotFoundException();
        const [revisionText, id] = query.cursor?.split(":") ?? [];
        const revision = revisionText ? Number(revisionText) : null;
        const cursorCondition =
          revision === null || id === undefined
            ? sql`true`
            : sql`(stream."resultRevision" > ${revision}
          or (stream."resultRevision" = ${revision} and stream.id > ${id}))`;
        const rowsResult = await tx.execute(sql<ProgressStreamRow>`
      select *
      from (
        select
          change.id,
          change.result_revision as "resultRevision",
          change.kind::text as kind,
          change.code_hash as "codeHash",
          change.classification::text as classification,
          change.observed_production_date as "observedProductionDate",
          change.winning_event_id as "winningEventId",
          change.winning_device_id as "winningDeviceId",
          change.winning_scanned_at as "winningScannedAt",
          null::uuid as "resultId",
          null::uuid as "boxId",
          null::uuid as "ownerDeviceId",
          change.changed_at as "effectAt",
          change.changed_at as "changedAt"
        from inventory_progress_changes change
        where change.tenant_id = ${tenantId}
          and change.inventory_id = ${inventoryId}

        union all

        select
          correction.id,
          correction.result_revision,
          correction.action::text,
          result.code_hash,
          null::text,
          null::date,
          null::uuid,
          null::uuid,
          null::timestamptz,
          correction.target_code_result_id,
          correction.target_repack_box_id,
          box.owner_device_id,
          correction.effect_at,
          correction.created_at
        from inventory_corrections correction
        left join inventory_code_results result
          on result.tenant_id = correction.tenant_id
         and result.inventory_id = correction.inventory_id
         and result.id = correction.target_code_result_id
        left join inventory_repack_boxes box
          on box.tenant_id = correction.tenant_id
         and box.inventory_id = correction.inventory_id
         and box.id = correction.target_repack_box_id
        where correction.tenant_id = ${tenantId}
          and correction.inventory_id = ${inventoryId}
          and correction.action in ('remove_item', 'invalidate_box', 'reprint')
      ) stream
      where ${cursorCondition}
      order by stream."resultRevision", stream.id
      limit ${query.limit}
    `);
        const items: StationInventoryProgressDto["items"] = rowsResult.rows
          .map(parseProgressStreamRow)
          .map((row) => {
            const correctedAt = readProgressDate(row.changedAt);
            if (row.kind === "claim" || row.kind === "correction") {
              if (!row.codeHash || !row.classification) {
                throw new Error("Inventory progress code projection is incomplete");
              }
              return {
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
                        scannedAt: readProgressDate(row.winningScannedAt),
                      }
                    : null,
                correctedAt,
              };
            }
            if (!row.boxId || !row.ownerDeviceId) {
              throw new Error("Inventory progress box correction is incomplete");
            }
            if (row.kind === "remove_item") {
              if (!row.resultId || !row.codeHash) {
                throw new Error("Inventory progress membership correction is incomplete");
              }
              return {
                id: row.id,
                revision: row.resultRevision,
                kind: row.kind,
                boxId: row.boxId,
                resultId: row.resultId,
                codeHash: row.codeHash,
                ownerDeviceId: row.ownerDeviceId,
                removedAt: readProgressDate(row.effectAt),
                correctedAt,
              };
            }
            return {
              id: row.id,
              revision: row.resultRevision,
              kind: row.kind,
              boxId: row.boxId,
              ownerDeviceId: row.ownerDeviceId,
              correctedAt,
            };
          });
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
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
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
        participant.pendingEventCount !== 0 ||
        input.openBoxCount !== participant.openBoxCount
      ) {
        throw new ConflictException({ code: "INVENTORY_LEAVE_PENDING_WORK" });
      }
      const [ownedOpen] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.inventoryRepackBoxes)
        .where(
          and(
            eq(schema.inventoryRepackBoxes.tenantId, tenantId),
            eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
            eq(schema.inventoryRepackBoxes.ownerDeviceId, deviceId),
            eq(schema.inventoryRepackBoxes.state, "open"),
          ),
        );
      if ((ownedOpen?.count ?? 0) !== input.openBoxCount) {
        throw new ConflictException({ code: "INVENTORY_LEAVE_PENDING_WORK" });
      }
      if (participant.leftAt === null) {
        await tx
          .update(schema.inventoryDeviceParticipants)
          .set({
            leftAt: sql`GREATEST(now(), ${schema.inventoryDeviceParticipants.joinedAt})`,
            heartbeatAt: sql`GREATEST(now(), ${schema.inventoryDeviceParticipants.joinedAt})`,
          })
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
            openBoxCount: input.openBoxCount,
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
    inventory: RepackInventoryFacts,
    event: InventoryEvent,
  ): Promise<ClaimTarget[]> {
    if (inventory.mode === "check" && (event.kind === "old_box" || event.repack !== undefined)) {
      throw new ConflictException({ code: "INVENTORY_EVENT_MODE_MISMATCH" });
    }
    if (inventory.mode === "repack" && event.kind === "known_box") {
      throw new ConflictException({ code: "INVENTORY_EVENT_MODE_MISMATCH" });
    }
    if (
      inventory.mode === "repack" &&
      (inventory.capacity === null ||
        (event.kind === "old_box" && event.repack?.action !== "open-box"))
    ) {
      throw new ConflictException({ code: "INVENTORY_REPACK_CONFIGURATION_INVALID" });
    }
    if (event.kind === "repack_action") {
      if (
        event.activeProductionDate === null ||
        event.activeProductionDate < productionDateFrom ||
        event.activeProductionDate > productionDateTo
      ) {
        throw new ConflictException({ code: "INVENTORY_EVENT_PRODUCTION_DATE_MISMATCH" });
      }
      if (
        event.repack?.action === "change-date" &&
        (event.repack.productionDate !== event.activeProductionDate ||
          event.repack.productionDate < productionDateFrom ||
          event.repack.productionDate > productionDateTo)
      ) {
        throw new ConflictException({ code: "INVENTORY_EVENT_PRODUCTION_DATE_MISMATCH" });
      }
      return [];
    }
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
      const eligible = row?.expected === true && row.protected !== true;
      if (
        inventory.mode === "repack" &&
        ((eligible && event.repack?.action !== "add-item") ||
          (!eligible && event.repack?.action === "add-item"))
      ) {
        throw new ConflictException({ code: "INVENTORY_EVENT_MODE_MISMATCH" });
      }
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
    if (event.repack?.action === "open-box") {
      if (
        event.repack.productionDate !== event.activeProductionDate ||
        event.repack.productionDate < productionDateFrom ||
        event.repack.productionDate > productionDateTo
      ) {
        throw new ConflictException({ code: "INVENTORY_EVENT_PRODUCTION_DATE_MISMATCH" });
      }
      return [];
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
      .orderBy(asc(schema.inventorySnapshotCodes.codeHash))
      .limit(INVENTORY_EVENT_CLAIM_OUTCOME_SIZE + 1);
    if ((event.kind === "known_box") !== rows.length > 0) {
      throw new ConflictException({ code: "INVENTORY_EVENT_KIND_MISMATCH" });
    }
    return rows.map((row) => ({
      codeHash: row.codeHash,
      snapshotId,
      classification: row.protected ? "protected" : row.expected ? "expected" : "ineligible",
    }));
  }

  private async applyRepackMutation(
    tx: Transaction,
    tenantId: string,
    deviceId: string,
    inventoryId: string,
    snapshotId: string,
    inventory: RepackInventoryFacts,
    event: InventoryEvent,
    outcome: InventoryEventBatchResponse["outcomes"][number],
  ): Promise<void> {
    const mutation = event.repack;
    if (!mutation) return;
    if (inventory.mode !== "repack" || inventory.capacity === null) {
      throw new ConflictException({ code: "INVENTORY_REPACK_CONFIGURATION_INVALID" });
    }

    if (mutation.action === "open-box") {
      if (
        event.canonicalRaw !== mutation.oldSscc ||
        event.normalizedIdentity !== `old_box:${mutation.oldSscc}`
      ) {
        throw new ConflictException({ code: "INVENTORY_EVENT_IDENTITY_INVALID" });
      }
      if (
        mutation.capacity !== inventory.capacity ||
        mutation.productionDate !== event.activeProductionDate
      ) {
        throw new ConflictException({ code: "INVENTORY_REPACK_FROZEN_FACT_MISMATCH" });
      }
      const parsed = parseSscc(mutation.newSscc, 9);
      if (!parsed || parsed.extensionDigit !== 0) {
        throw new ConflictException({ code: "INVENTORY_REPACK_SSCC_NOT_RESERVED" });
      }
      const [block] = await tx
        .select({
          id: schema.ssccBlocks.id,
          consumedThroughSerial: schema.ssccBlocks.consumedThroughSerial,
        })
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, tenantId),
            eq(schema.ssccBlocks.deviceId, deviceId),
            eq(schema.ssccBlocks.issuerPrefix, parsed.gs1Prefix),
            eq(schema.ssccBlocks.extensionDigit, parsed.extensionDigit),
            lte(schema.ssccBlocks.fromSerial, parsed.serial),
            gte(schema.ssccBlocks.toSerial, parsed.serial),
          ),
        )
        .for("update");
      if (!block) {
        throw new ConflictException({ code: "INVENTORY_REPACK_SSCC_NOT_RESERVED" });
      }
      if (block.consumedThroughSerial !== null && parsed.serial <= block.consumedThroughSerial) {
        throw new ConflictException({ code: "INVENTORY_REPACK_SSCC_NOT_RESERVED" });
      }
      const existingOpen = await tx
        .select({ id: schema.inventoryRepackBoxes.id })
        .from(schema.inventoryRepackBoxes)
        .where(
          and(
            eq(schema.inventoryRepackBoxes.tenantId, tenantId),
            eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
            eq(schema.inventoryRepackBoxes.ownerDeviceId, deviceId),
            eq(schema.inventoryRepackBoxes.state, "open"),
          ),
        )
        .for("update");
      if (existingOpen.length > 0) {
        throw new ConflictException({ code: "INVENTORY_REPACK_OPEN_BOX_EXISTS" });
      }
      await tx.insert(schema.inventoryRepackBoxes).values({
        id: mutation.boxId,
        tenantId,
        inventoryId,
        oldSsccContext: mutation.oldSscc,
        newSscc: mutation.newSscc,
        ownerDeviceId: deviceId,
        openedEventId: event.eventId,
        capacity: inventory.capacity,
        productionDate: mutation.productionDate,
        openedAt: new Date(event.scannedAt),
      });
      await tx
        .update(schema.ssccBlocks)
        .set({
          consumedThroughSerial: sql`GREATEST(COALESCE(${schema.ssccBlocks.consumedThroughSerial}, -1), ${parsed.serial})`,
        })
        .where(eq(schema.ssccBlocks.id, block.id));
      return;
    }

    const [box] = await tx
      .select({
        id: schema.inventoryRepackBoxes.id,
        ownerDeviceId: schema.inventoryRepackBoxes.ownerDeviceId,
        state: schema.inventoryRepackBoxes.state,
        capacity: schema.inventoryRepackBoxes.capacity,
        productionDate: schema.inventoryRepackBoxes.productionDate,
        oldSsccContext: schema.inventoryRepackBoxes.oldSsccContext,
        newSscc: schema.inventoryRepackBoxes.newSscc,
        printState: schema.inventoryRepackBoxes.printState,
        printAttemptCount: schema.inventoryRepackBoxes.printAttemptCount,
        printErrorCode: schema.inventoryRepackBoxes.printErrorCode,
        printedAt: schema.inventoryRepackBoxes.printedAt,
      })
      .from(schema.inventoryRepackBoxes)
      .where(
        and(
          eq(schema.inventoryRepackBoxes.tenantId, tenantId),
          eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
          eq(schema.inventoryRepackBoxes.id, mutation.boxId),
        ),
      )
      .for("update");
    if (!box || box.ownerDeviceId !== deviceId) {
      throw new ConflictException({ code: "INVENTORY_REPACK_BOX_NOT_OWNED" });
    }

    if (mutation.action === "resolve-conflict") {
      const [adminInvalidation] = await tx
        .select({ id: schema.inventoryCorrections.id })
        .from(schema.inventoryCorrections)
        .where(
          and(
            eq(schema.inventoryCorrections.tenantId, tenantId),
            eq(schema.inventoryCorrections.inventoryId, inventoryId),
            eq(schema.inventoryCorrections.targetRepackBoxId, box.id),
            eq(schema.inventoryCorrections.action, "invalidate_box"),
          ),
        )
        .limit(1);
      if (
        box.state !== "invalidated" ||
        box.printAttemptCount !== 0 ||
        box.printedAt !== null ||
        mutation.reason !== "claim-lost" ||
        adminInvalidation !== undefined
      ) {
        throw new ConflictException({ code: "INVENTORY_REPACK_CONFLICT_RESOLUTION_INVALID" });
      }
      const resolvedAt = new Date(mutation.changedAt);
      const activeItems = await tx
        .select({ id: schema.inventoryRepackItems.id })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.boxId, box.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        )
        .for("update");
      if (activeItems.length > 0) {
        await tx
          .update(schema.inventoryRepackItems)
          .set({ removedAt: resolvedAt, activeObservedProductionDate: null })
          .where(
            inArray(
              schema.inventoryRepackItems.id,
              activeItems.map((item) => item.id),
            ),
          );
      }
      await tx
        .update(schema.inventoryRepackBoxes)
        .set({
          state: "open",
          printState: "not_ready",
          printAttemptCount: 0,
          printErrorCode: null,
          closedEventId: null,
          closedAt: null,
          invalidatedAt: null,
          printedAt: null,
          updatedAt: resolvedAt,
        })
        .where(
          and(
            eq(schema.inventoryRepackBoxes.tenantId, tenantId),
            eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
            eq(schema.inventoryRepackBoxes.id, box.id),
            eq(schema.inventoryRepackBoxes.ownerDeviceId, deviceId),
            eq(schema.inventoryRepackBoxes.state, "invalidated"),
          ),
        );
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: null,
        action: "inventory.station.repack_conflict_resolved",
        outcome: "success",
        targetType: "inventory_repack_box",
        targetId: box.id,
        before: {
          state: box.state,
          activeItemCount: activeItems.length,
          printState: box.printState,
          printAttemptCount: box.printAttemptCount,
        },
        after: {
          tenantId,
          inventoryId,
          deviceId,
          operatorId: event.operatorId,
          boxId: box.id,
          reason: mutation.reason,
          state: "open",
          activeItemCount: 0,
          sourceEventId: event.eventId,
          resolvedAt: mutation.changedAt,
        },
      });
      return;
    }

    if (mutation.action === "print-outcome" || mutation.action === "reprint-outcome") {
      if (box.state !== "closed") {
        throw new ConflictException({ code: "INVENTORY_REPACK_BOX_NOT_CLOSED" });
      }
      if (
        box.capacity !== inventory.capacity ||
        box.productionDate !== event.activeProductionDate
      ) {
        throw new ConflictException({ code: "INVENTORY_REPACK_FROZEN_FACT_MISMATCH" });
      }
      if (mutation.sscc !== box.newSscc) {
        throw new ConflictException({ code: "INVENTORY_REPACK_PRINT_SSCC_MISMATCH" });
      }
      if (Date.parse(mutation.completedAt) < Date.parse(mutation.attemptedAt)) {
        throw new ConflictException({ code: "INVENTORY_REPACK_PRINT_TIME_INVALID" });
      }
      if (mutation.attemptNumber !== box.printAttemptCount + 1) {
        throw new ConflictException({ code: "INVENTORY_REPACK_PRINT_ATTEMPT_SEQUENCE_INVALID" });
      }
      if (
        (mutation.action === "print-outcome" &&
          box.printState !== "pending" &&
          box.printState !== "failed") ||
        (mutation.action === "reprint-outcome" && box.printState !== "printed")
      ) {
        throw new ConflictException({ code: "INVENTORY_REPACK_PRINT_STATE_INVALID" });
      }
      const [composition] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          minimumDate: sql<string | null>`min(${schema.inventoryRepackItems.productionDate})`,
          maximumDate: sql<string | null>`max(${schema.inventoryRepackItems.productionDate})`,
        })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.boxId, box.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        );
      if (
        !composition ||
        composition.count === 0 ||
        composition.count > box.capacity ||
        composition.minimumDate !== box.productionDate ||
        composition.maximumDate !== box.productionDate
      ) {
        throw new ConflictException({ code: "INVENTORY_REPACK_PRINT_COMPOSITION_INVALID" });
      }
      const [reusedAttempt] = await tx
        .select({ id: schema.inventoryRepackPrintAttempts.id })
        .from(schema.inventoryRepackPrintAttempts)
        .where(eq(schema.inventoryRepackPrintAttempts.id, mutation.attemptId));
      if (reusedAttempt) {
        throw new ConflictException({ code: "INVENTORY_REPACK_PRINT_ATTEMPT_REUSED" });
      }
      await tx.insert(schema.inventoryRepackPrintAttempts).values({
        id: mutation.attemptId,
        tenantId,
        inventoryId,
        boxId: box.id,
        sourceEventId: event.eventId,
        kind: mutation.action === "print-outcome" ? "initial" : "reprint",
        attemptNumber: mutation.attemptNumber,
        result: mutation.result,
        errorCode: mutation.errorCode,
        attemptedAt: new Date(mutation.attemptedAt),
        completedAt: new Date(mutation.completedAt),
      });
      const isInitial = mutation.action === "print-outcome";
      await tx
        .update(schema.inventoryRepackBoxes)
        .set({
          printState: isInitial ? mutation.result : "printed",
          printAttemptCount: mutation.attemptNumber,
          printErrorCode: mutation.result === "failed" ? mutation.errorCode?.toUpperCase() : null,
          printedAt:
            isInitial && mutation.result === "printed"
              ? new Date(mutation.completedAt)
              : box.printedAt,
          updatedAt: new Date(mutation.completedAt),
        })
        .where(eq(schema.inventoryRepackBoxes.id, box.id));
      return;
    }

    if (box.state !== "open") {
      throw new ConflictException({ code: "INVENTORY_REPACK_BOX_NOT_OPEN" });
    }
    if (
      box.capacity !== inventory.capacity ||
      (mutation.action !== "change-date" && box.productionDate !== event.activeProductionDate)
    ) {
      throw new ConflictException({ code: "INVENTORY_REPACK_FROZEN_FACT_MISMATCH" });
    }

    if (mutation.action === "add-item") {
      if (!event.codeHash) {
        throw new ConflictException({ code: "INVENTORY_REPACK_ITEM_INVALID" });
      }
      const ownedReattach =
        outcome.status === "duplicate" &&
        outcome.claims.length === 1 &&
        outcome.claims[0]?.codeHash === event.codeHash &&
        outcome.claims[0].winner.deviceId === deviceId;
      if (outcome.status !== "applied" && !ownedReattach) {
        await tx
          .update(schema.inventoryRepackBoxes)
          .set({ state: "invalidated", invalidatedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.inventoryRepackBoxes.id, box.id));
        return;
      }
      const [result] = await tx
        .select({ id: schema.inventoryCodeResults.id })
        .from(schema.inventoryCodeResults)
        .where(
          and(
            eq(schema.inventoryCodeResults.tenantId, tenantId),
            eq(schema.inventoryCodeResults.inventoryId, inventoryId),
            eq(schema.inventoryCodeResults.codeHash, event.codeHash),
            eq(schema.inventoryCodeResults.classification, "expected"),
            ownedReattach
              ? eq(schema.inventoryCodeResults.winningDeviceId, deviceId)
              : eq(schema.inventoryCodeResults.firstAcceptedEventId, event.eventId),
          ),
        )
        .for("update");
      if (!result) {
        throw new ConflictException({ code: "INVENTORY_REPACK_ITEM_INELIGIBLE" });
      }
      const displaced = await tx
        .select({ id: schema.inventoryRepackItems.id, boxId: schema.inventoryRepackItems.boxId })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.resultId, result.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        )
        .for("update");
      if (ownedReattach && displaced.length > 0) {
        throw new ConflictException({ code: "INVENTORY_REPACK_ITEM_ALREADY_MEMBER" });
      }
      if (displaced.length > 0) {
        await tx
          .update(schema.inventoryRepackItems)
          .set({ removedAt: new Date(), activeObservedProductionDate: null })
          .where(
            inArray(
              schema.inventoryRepackItems.id,
              displaced.map((row) => row.id),
            ),
          );
        await tx
          .update(schema.inventoryRepackBoxes)
          .set({ state: "invalidated", invalidatedAt: new Date(), updatedAt: new Date() })
          .where(
            inArray(
              schema.inventoryRepackBoxes.id,
              displaced.map((row) => row.boxId),
            ),
          );
      }
      const [activeCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.boxId, box.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        );
      const position = (activeCount?.count ?? 0) + 1;
      const shouldClose = position === box.capacity;
      if (
        position > box.capacity ||
        mutation.position !== position ||
        mutation.closeBox !== shouldClose
      ) {
        throw new ConflictException({ code: "INVENTORY_REPACK_CAPACITY_MISMATCH" });
      }
      const [snapshotCode] = await tx
        .select({ parentSscc: schema.inventorySnapshotCodes.parentSscc })
        .from(schema.inventorySnapshotCodes)
        .where(
          and(
            eq(schema.inventorySnapshotCodes.tenantId, tenantId),
            eq(schema.inventorySnapshotCodes.snapshotId, snapshotId),
            eq(schema.inventorySnapshotCodes.codeHash, event.codeHash),
          ),
        );
      await tx.insert(schema.inventoryRepackItems).values({
        id: mutation.itemId,
        tenantId,
        inventoryId,
        boxId: box.id,
        resultId: result.id,
        sourceEventId: event.eventId,
        position,
        sourceParentMismatch: snapshotCode?.parentSscc !== box.oldSsccContext,
        productionDate: box.productionDate,
        activeObservedProductionDate: box.productionDate,
        addedAt: new Date(event.scannedAt),
      });
      if (shouldClose) {
        await tx
          .update(schema.inventoryRepackBoxes)
          .set({
            state: "closed",
            printState: "pending",
            closedEventId: event.eventId,
            closedAt: new Date(event.scannedAt),
            updatedAt: new Date(),
          })
          .where(eq(schema.inventoryRepackBoxes.id, box.id));
      }
      return;
    }

    if (mutation.action === "remove-last") {
      const [last] = await tx
        .select({ id: schema.inventoryRepackItems.id })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.boxId, box.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        )
        .orderBy(desc(schema.inventoryRepackItems.position))
        .limit(1)
        .for("update");
      if (!last || last.id !== mutation.itemId) {
        throw new ConflictException({ code: "INVENTORY_REPACK_LAST_ITEM_MISMATCH" });
      }
      await tx
        .update(schema.inventoryRepackItems)
        .set({ removedAt: new Date(mutation.changedAt), activeObservedProductionDate: null })
        .where(eq(schema.inventoryRepackItems.id, last.id));
      return;
    }

    if (mutation.action === "clear-box") {
      await tx
        .update(schema.inventoryRepackItems)
        .set({ removedAt: new Date(mutation.changedAt), activeObservedProductionDate: null })
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.boxId, box.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        );
      return;
    }

    if (mutation.action === "change-date") {
      const [activeCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.tenantId, tenantId),
            eq(schema.inventoryRepackItems.inventoryId, inventoryId),
            eq(schema.inventoryRepackItems.boxId, box.id),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        );
      if ((activeCount?.count ?? 0) !== 0) {
        throw new ConflictException({ code: "INVENTORY_REPACK_DATE_FROZEN" });
      }
      await tx
        .update(schema.inventoryRepackBoxes)
        .set({ productionDate: mutation.productionDate, updatedAt: new Date(mutation.changedAt) })
        .where(eq(schema.inventoryRepackBoxes.id, box.id));
      return;
    }

    const [activeCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.inventoryRepackItems)
      .where(
        and(
          eq(schema.inventoryRepackItems.tenantId, tenantId),
          eq(schema.inventoryRepackItems.inventoryId, inventoryId),
          eq(schema.inventoryRepackItems.boxId, box.id),
          isNull(schema.inventoryRepackItems.removedAt),
        ),
      );
    if ((activeCount?.count ?? 0) === 0 || (activeCount?.count ?? 0) >= box.capacity) {
      throw new ConflictException({ code: "INVENTORY_REPACK_INCOMPLETE_CLOSE_INVALID" });
    }
    await tx
      .update(schema.inventoryRepackBoxes)
      .set({
        state: "closed",
        printState: "pending",
        closedEventId: event.eventId,
        closedAt: new Date(mutation.changedAt),
        updatedAt: new Date(),
      })
      .where(eq(schema.inventoryRepackBoxes.id, box.id));
  }

  private async normalizeStoredResponse(
    tx: Transaction,
    tenantId: string,
    deviceId: string,
    inventoryId: string,
    input: StationInventoryEventBatchDto,
    stored: unknown,
    resultRevision: number,
  ): Promise<StationInventoryEventBatchResponseDto> {
    if (inventoryEventBatchResponseSchema.safeParse(stored).success) {
      try {
        return parseInventoryEventBatchResponse(stored, input, inventoryId, deviceId);
      } catch {
        // A pre-hardening stored result can be structurally valid but not bound to this ledger row.
      }
    }

    const outcomes: InventoryEventBatchResponse["outcomes"] = [];
    for (const event of input.events) {
      let evidence = await tx
        .select({
          codeHash: schema.inventoryEventClaimOutcomes.codeHash,
          status: schema.inventoryEventClaimOutcomes.status,
          winningEventId: schema.inventoryEventClaimOutcomes.winningEventId,
          winningDeviceId: schema.inventoryEventClaimOutcomes.winningDeviceId,
          winningScannedAt: schema.inventoryEventClaimOutcomes.winningScannedAt,
        })
        .from(schema.inventoryEventClaimOutcomes)
        .where(
          and(
            eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
            eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
            eq(schema.inventoryEventClaimOutcomes.sourceEventId, event.eventId),
          ),
        )
        .orderBy(asc(schema.inventoryEventClaimOutcomes.codeHash));

      if (evidence.length === 0 && event.kind !== "old_box") {
        let codeHashes: string[] = [];
        if (event.kind === "item" && event.codeHash) {
          codeHashes = [event.codeHash];
        } else if (event.kind === "known_box") {
          const sscc = event.normalizedIdentity.slice("known_box:".length);
          const rows = await tx
            .select({ codeHash: schema.inventorySnapshotCodes.codeHash })
            .from(schema.inventorySnapshotCodes)
            .where(
              and(
                eq(schema.inventorySnapshotCodes.tenantId, tenantId),
                eq(schema.inventorySnapshotCodes.snapshotId, input.snapshotId),
                eq(schema.inventorySnapshotCodes.parentSscc, sscc),
              ),
            )
            .orderBy(asc(schema.inventorySnapshotCodes.codeHash))
            .limit(INVENTORY_EVENT_CLAIM_OUTCOME_SIZE + 1);
          codeHashes = rows.map((row) => row.codeHash);
        }
        if (codeHashes.length > 0) {
          const winners = await tx
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
                inArray(schema.inventoryCodeResults.codeHash, codeHashes),
              ),
            );
          if (winners.length !== codeHashes.length) {
            throw new Error("inventory legacy claim winner missing");
          }
          await tx
            .insert(schema.inventoryEventClaimOutcomes)
            .values(
              winners.map((winner) => ({
                tenantId,
                inventoryId,
                sourceEventId: event.eventId,
                codeHash: winner.codeHash,
                status: winner.eventId === event.eventId ? "claimed" : "duplicate",
                winningEventId: winner.eventId,
                winningDeviceId: winner.deviceId,
                winningScannedAt: winner.scannedAt,
              })),
            )
            .onConflictDoNothing();
          evidence = await tx
            .select({
              codeHash: schema.inventoryEventClaimOutcomes.codeHash,
              status: schema.inventoryEventClaimOutcomes.status,
              winningEventId: schema.inventoryEventClaimOutcomes.winningEventId,
              winningDeviceId: schema.inventoryEventClaimOutcomes.winningDeviceId,
              winningScannedAt: schema.inventoryEventClaimOutcomes.winningScannedAt,
            })
            .from(schema.inventoryEventClaimOutcomes)
            .where(
              and(
                eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
                eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
                eq(schema.inventoryEventClaimOutcomes.sourceEventId, event.eventId),
              ),
            )
            .orderBy(asc(schema.inventoryEventClaimOutcomes.codeHash));
        }
      }
      const claims = evidence.map((claim) => ({
        codeHash: claim.codeHash,
        status: claim.status === "claimed" ? ("claimed" as const) : ("duplicate" as const),
        winner: {
          codeHash: claim.codeHash,
          eventId: claim.winningEventId,
          deviceId: claim.winningDeviceId,
          scannedAt: claim.winningScannedAt.toISOString(),
        },
      }));
      const claimedCount = claims.filter((claim) => claim.status === "claimed").length;
      const conflictCount = claims.length - claimedCount;
      const status = claimedCount > 0 || event.kind === "old_box" ? "applied" : "duplicate";
      outcomes.push({
        eventId: event.eventId,
        status,
        reasonCode: status === "applied" ? "CLAIM_APPLIED" : "CLAIM_LOST",
        claimedCount,
        conflictCount,
        claims,
      });
    }
    const normalized = this.response(inventoryId, input, resultRevision, outcomes);
    await tx
      .update(schema.inventoryScanBatches)
      .set({ result: normalized })
      .where(
        and(
          eq(schema.inventoryScanBatches.tenantId, tenantId),
          eq(schema.inventoryScanBatches.inventoryId, inventoryId),
          eq(schema.inventoryScanBatches.deviceId, deviceId),
          eq(schema.inventoryScanBatches.batchId, input.batchId),
        ),
      );
    return normalized;
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
