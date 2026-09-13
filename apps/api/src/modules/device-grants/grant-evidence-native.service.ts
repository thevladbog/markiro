import { matchesPreparedEvidenceScope } from "./evidence-label-scope";
import { inventoryEvidenceKinds } from "./inventory-evidence-kinds";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";
import { createOrderSchema, type CreateOrderResultDto } from "../pickup-orders/dto";
import { kioskOrderPayloadDigest } from "../pickup-orders/kiosk-admission-proof";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import { BadRequestException, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { productLabelValueDigest, isShiftCloseReasonCode } from "@markiro/domain";
import type { GrantEvidenceEnvelope } from "@markiro/platform-contracts";
import { z } from "zod";
import { StationInventorySyncService } from "../inventories/station-inventory-sync.service";
import {
  leaveStationInventorySchema,
  stationInventoryEventBatchSchema,
  type StationInventoryEventBatchResponseDto,
  type LeaveStationInventoryResponseDto,
} from "../inventories/station-inventory.dto";
import { StationScansService } from "../station-scans/station-scans.service";
import { syncBatchSchema, type SyncBatchResponseDto } from "../station-scans/dto";
import { StationShiftCloseService } from "../station-shift-close/station-shift-close.service";
import {
  stationShiftCloseSchema,
  type StationShiftCloseResponseDto,
  type StationShiftCloseDto,
} from "../station-shift-close/dto";
import { GrantEvidenceService, type EvidenceFact } from "./grant-evidence.service";
import type { GrantCredentialIdentity } from "./credential-epoch";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: "EVIDENCE_NATIVE_PAYLOAD_INVALID" });
  return parsed.data;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
@Injectable()
export class GrantEvidenceNativeService {
  constructor(
    private readonly evidence: GrantEvidenceService,
    private readonly inventories: StationInventorySyncService,
    private readonly scans: StationScansService,
    private readonly shifts: StationShiftCloseService,
    private readonly pickup: PickupOrdersService,
  ) {}
  inventoryEvents(
    identity: GrantCredentialIdentity,
    inventoryId: string,
    envelope: GrantEvidenceEnvelope,
    raw?: Buffer,
  ) {
    const input = parse(stationInventoryEventBatchSchema, envelope.payload);
    return this.evidence.ingest<StationInventoryEventBatchResponseDto>(
      identity,
      `inventories/${inventoryId}/event-batches`,
      envelope,
      raw,
      (hook) =>
        this.inventories.ingest(identity.tenantId, identity.deviceId, inventoryId, input, hook),
      async (tx, result) => {
        const facts: EvidenceFact[] = [];
        for (const [index, event] of input.events.entries()) {
          const outcome = result.outcomes.find((row) => row.eventId === event.eventId);
          if (!outcome || !["applied", "replay"].includes(outcome.status)) continue;
          const base = {
            pointer: `/events/${index}`,
            taskKind: "inventory" as const,
            taskId: inventoryId,
            identity: event.eventId,
            payload: event,
            matchesScope: (scope: Record<string, unknown>) => scope.snapshotId === input.snapshotId,
          };
          const kinds = inventoryEvidenceKinds(event);
          if (event.repack) {
            if (kinds.includes("inventory.repack.v1")) {
              const items = await tx
                .select({ id: schema.inventoryRepackItems.id })
                .from(schema.inventoryRepackItems)
                .where(
                  and(
                    eq(schema.inventoryRepackItems.tenantId, identity.tenantId),
                    eq(schema.inventoryRepackItems.inventoryId, inventoryId),
                    eq(schema.inventoryRepackItems.sourceEventId, event.eventId),
                  ),
                );
              if (items.length)
                facts.push({ ...base, eventType: "inventory.repack.v1", units: items.length });
            }
            if (kinds.includes("inventory.box.close.v1")) {
              const [closed] = await tx
                .select({ id: schema.inventoryRepackBoxes.id })
                .from(schema.inventoryRepackBoxes)
                .where(
                  and(
                    eq(schema.inventoryRepackBoxes.tenantId, identity.tenantId),
                    eq(schema.inventoryRepackBoxes.inventoryId, inventoryId),
                    eq(schema.inventoryRepackBoxes.ownerDeviceId, identity.deviceId),
                    eq(schema.inventoryRepackBoxes.closedEventId, event.eventId),
                  ),
                )
                .limit(1);
              if (closed)
                facts.push({ ...base, eventType: "inventory.box.close.v1", containers: 1 });
            }
          } else if (outcome.claimedCount > 0)
            facts.push({ ...base, eventType: "inventory.scan.v1", units: outcome.claimedCount });
        }
        return facts;
      },
      (result) =>
        result.outcomes.every((row) => row.status === "rejected" || row.status === "quarantined")
          ? "rejected"
          : "applied",
    );
  }
  inventoryLeave(
    identity: GrantCredentialIdentity,
    inventoryId: string,
    envelope: GrantEvidenceEnvelope,
    raw?: Buffer,
  ) {
    const input = parse(leaveStationInventorySchema, envelope.payload);
    return this.evidence.ingest<LeaveStationInventoryResponseDto>(
      identity,
      `inventories/${inventoryId}/leave`,
      envelope,
      raw,
      (hook) =>
        this.inventories.leave(identity.tenantId, identity.deviceId, inventoryId, input, hook),
      async (tx) => {
        const [participant] = await tx
          .select()
          .from(schema.inventoryDeviceParticipants)
          .where(
            and(
              eq(schema.inventoryDeviceParticipants.tenantId, identity.tenantId),
              eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
              eq(schema.inventoryDeviceParticipants.deviceId, identity.deviceId),
            ),
          );
        const [inventory] = await tx
          .select()
          .from(schema.inventories)
          .where(
            and(
              eq(schema.inventories.tenantId, identity.tenantId),
              eq(schema.inventories.id, inventoryId),
            ),
          );
        if (!participant || !inventory || !participant.leftAt) return [];
        return [
          {
            pointer: "/",
            eventType: "inventory.close.v1",
            taskKind: "inventory",
            taskId: inventoryId,
            identity: participant.joinedAt.toISOString(),
            payload: { inventoryId, joinedAt: participant.joinedAt.toISOString(), ...input },
            matchesScope: (scope) => scope.snapshotId === inventory.activeSnapshotId,
          },
        ];
      },
    );
  }
  shiftClose(identity: GrantCredentialIdentity, envelope: GrantEvidenceEnvelope, raw?: Buffer) {
    const parsed = parse(stationShiftCloseSchema, envelope.payload);
    const input: StationShiftCloseDto = {
      ...parsed,
      reasonCode:
        parsed.reasonCode && isShiftCloseReasonCode(parsed.reasonCode) ? parsed.reasonCode : null,
    };
    return this.evidence.ingest<StationShiftCloseResponseDto>(
      identity,
      "shift-closures",
      envelope,
      raw,
      (hook) => this.shifts.closeStationShift(identity.tenantId, identity.deviceId, input, hook),
      (_tx, result) =>
        Promise.resolve(
          result.outcome === "conflict"
            ? []
            : [
                {
                  pointer: "/",
                  eventType: "shift.close.v1",
                  taskKind: "shift",
                  taskId: input.shiftId,
                  identity: input.eventId,
                  payload: envelope.payload,
                  matchesScope: (scope) => object(scope.shift)?.id === input.shiftId,
                },
              ],
        ),
      (result) => (result.outcome === "conflict" ? "rejected" : "applied"),
    );
  }
  scanBatch(
    identity: GrantCredentialIdentity,
    envelope: GrantEvidenceEnvelope,
    raw?: Buffer,
    capabilities?: string,
  ) {
    const input = parse(syncBatchSchema, envelope.payload);
    return this.evidence.ingest<SyncBatchResponseDto>(
      identity,
      "scans",
      envelope,
      raw,
      (hook) =>
        this.scans.applyBatch(identity.tenantId, input, identity.deviceId, capabilities, hook),
      async (tx, result) => {
        const facts: EvidenceFact[] = [];
        const denied = (kind: string, index: number) =>
          result.denied?.some((row) => row.recordKind === kind && row.recordIndex === index);
        for (const [index, item] of input.items.entries()) {
          if (!item.code || item.verdict !== "ok" || denied("item", index)) continue;
          const occurrence = result.validationOccurrences?.find(
            (row) =>
              row.shiftId === item.shiftId &&
              row.codeHash === item.code?.codeHash &&
              Date.parse(row.scannedAt) === Date.parse(item.scannedAt),
          );
          let accepted = false;
          if (occurrence?.outcome === "reprocessed") {
            const [saved] = await tx
              .select({ codeHash: schema.validationCodeReprocessings.codeHash })
              .from(schema.validationCodeReprocessings)
              .where(
                and(
                  eq(schema.validationCodeReprocessings.tenantId, identity.tenantId),
                  eq(schema.validationCodeReprocessings.shiftId, item.shiftId),
                  eq(schema.validationCodeReprocessings.codeHash, item.code.codeHash),
                  eq(schema.validationCodeReprocessings.terminalId, identity.deviceId),
                  eq(schema.validationCodeReprocessings.scannedAt, new Date(item.scannedAt)),
                ),
              )
              .limit(1);
            accepted = saved !== undefined;
          } else if (occurrence?.outcome === "first_accepted") {
            const [saved] = await tx
              .select({ codeHash: schema.validationCodeAcceptances.codeHash })
              .from(schema.validationCodeAcceptances)
              .where(
                and(
                  eq(schema.validationCodeAcceptances.tenantId, identity.tenantId),
                  eq(schema.validationCodeAcceptances.shiftId, item.shiftId),
                  eq(schema.validationCodeAcceptances.codeHash, item.code.codeHash),
                  eq(schema.validationCodeAcceptances.terminalId, identity.deviceId),
                  eq(schema.validationCodeAcceptances.scannedAt, new Date(item.scannedAt)),
                ),
              )
              .limit(1);
            accepted = saved !== undefined;
          } else if (!occurrence) {
            const [saved] = await tx
              .select({ codeHash: schema.codes.codeHash })
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
                  eq(schema.codes.tenantId, identity.tenantId),
                  eq(schema.codes.shiftId, item.shiftId),
                  eq(schema.codes.codeHash, item.code.codeHash),
                  eq(schema.codeRegistry.terminalId, identity.deviceId),
                  eq(schema.codes.scannedAt, new Date(item.scannedAt)),
                ),
              )
              .limit(1);
            accepted = saved !== undefined;
          }
          if (accepted)
            facts.push({
              pointer: `/items/${index}`,
              eventType: "shift.scan.v1",
              taskKind: "shift",
              taskId: item.shiftId,
              identity: productLabelValueDigest([item.code.codeHash, item.scannedAt]),
              payload: {
                raw: item.raw,
                code: {
                  codeHash: item.code.codeHash,
                  gtin14: item.code.gtin14,
                  serial: item.code.serial,
                },
                scannedAt: item.scannedAt,
                operatorId: item.operatorId,
                boxId: item.boxId,
              },
              units: 1,
              matchesScope: (scope) => {
                const shift = object(scope.shift);
                return (
                  object(scope.product)?.gtin14 === item.code?.gtin14 &&
                  shift?.id === item.shiftId &&
                  (occurrence?.outcome !== "reprocessed" ||
                    (shift.mode === "validation" &&
                      shift.validationPrintMode === "duplicate_dm" &&
                      shift.allowPreviouslyAcceptedCodes === true))
                );
              },
            });
        }
        for (const [index, box] of input.boxes.entries()) {
          if (denied("box", index)) continue;
          const [closed] = await tx
            .select()
            .from(schema.boxes)
            .where(
              and(
                eq(schema.boxes.tenantId, identity.tenantId),
                eq(schema.boxes.shiftId, box.shiftId),
                eq(schema.boxes.terminalId, identity.deviceId),
                eq(schema.boxes.deviceBoxId, box.boxId),
              ),
            )
            .limit(1);
          if (!closed?.closedAt || closed.sscc !== box.sscc) continue;
          facts.push({
            pointer: `/boxes/${index}`,
            eventType: "shift.box.close.v1",
            taskKind: "shift",
            taskId: box.shiftId,
            identity: box.boxId,
            payload: {
              boxId: box.boxId,
              sscc: box.sscc,
              closedAt: box.closedAt,
              operatorId: box.operatorId,
            },
            containers: 1,
            matchesScope: (scope) => object(scope.shift)?.id === box.shiftId,
          });
        }
        for (const [index, pallet] of input.pallets.entries()) {
          if (denied("pallet", index)) continue;
          const [closed] = await tx
            .select()
            .from(schema.pallets)
            .where(
              and(
                eq(schema.pallets.tenantId, identity.tenantId),
                eq(schema.pallets.shiftId, pallet.shiftId),
                eq(schema.pallets.terminalId, identity.deviceId),
                eq(schema.pallets.devicePalletId, pallet.palletId),
              ),
            )
            .limit(1);
          if (!closed?.closedAt || closed.sscc !== pallet.sscc) continue;
          facts.push({
            pointer: `/pallets/${index}`,
            eventType: "shift.pallet.close.v1",
            taskKind: "shift",
            taskId: pallet.shiftId,
            identity: pallet.palletId,
            payload: {
              palletId: pallet.palletId,
              sscc: pallet.sscc,
              closedAt: pallet.closedAt,
              operatorId: pallet.operatorId,
            },
            containers: 1,
            matchesScope: (scope) => object(scope.shift)?.id === pallet.shiftId,
          });
        }
        for (const [index, event] of input.productLabelEvents.entries()) {
          if (
            event.kind !== "prepared" ||
            event.attemptNo !== 1 ||
            event.reason !== null ||
            !result.productLabelReceipt?.acceptedEventIds.includes(event.eventId)
          )
            continue;
          facts.push({
            pointer: `/productLabelEvents/${index}`,
            eventType: "shift.label.prepare.v1",
            taskKind: "shift",
            taskId: event.shiftId,
            identity: event.eventId,
            payload: event,
            units: 1,
            matchesScope: (scope) => matchesPreparedEvidenceScope(scope, event),
          });
        }
        return facts;
      },
    );
  }
  kioskOrder(identity: GrantCredentialIdentity, envelope: GrantEvidenceEnvelope, raw?: Buffer) {
    const input = parse(createOrderSchema, envelope.payload);
    return this.evidence.ingest<CreateOrderResultDto>(
      identity,
      "orders",
      envelope,
      raw,
      (hook) => this.pickup.createFromKiosk(identity.tenantId, identity.deviceId, input, hook),
      async (tx) => {
        // The native owner consumes the admission before this callback. Recover
        // its frozen identity through this owner's persisted issuance, including
        // retries after the original reservation has already been consumed.
        const grantId = envelope.eventGrants["/#pickup.complete.v1"];
        const [source] = grantId
          ? await tx
              .select({ taskId: schema.deviceGrantTaskSources.taskId })
              .from(schema.deviceGrantIssuances)
              .innerJoin(
                schema.deviceGrantTaskSources,
                and(
                  eq(schema.deviceGrantTaskSources.tenantId, identity.tenantId),
                  eq(schema.deviceGrantTaskSources.id, schema.deviceGrantIssuances.taskSourceId),
                  eq(schema.deviceGrantTaskSources.kioskId, identity.deviceId),
                  eq(schema.deviceGrantTaskSources.taskKind, "pickup"),
                ),
              )
              .where(
                and(
                  eq(schema.deviceGrantIssuances.tenantId, identity.tenantId),
                  eq(schema.deviceGrantIssuances.kioskId, identity.deviceId),
                  eq(schema.deviceGrantIssuances.grantId, grantId),
                ),
              )
          : [];
        const [order] = await tx
          .select()
          .from(schema.pickupOrders)
          .where(
            and(
              eq(schema.pickupOrders.tenantId, identity.tenantId),
              eq(schema.pickupOrders.kioskId, identity.deviceId),
              eq(schema.pickupOrders.deviceSeq, input.deviceSeq),
            ),
          );
        if (!order) return [];
        const boxes = await tx
          .select({ id: schema.pickupOrderBoxes.id })
          .from(schema.pickupOrderBoxes)
          .where(
            and(
              eq(schema.pickupOrderBoxes.tenantId, identity.tenantId),
              eq(schema.pickupOrderBoxes.orderId, order.id),
            ),
          );
        return [
          {
            pointer: "/",
            eventType: "pickup.complete.v1",
            taskKind: "pickup",
            taskId: source?.taskId ?? order.id,
            identity: String(input.deviceSeq),
            payload: { payloadDigest: kioskOrderPayloadDigest(input), deviceSeq: input.deviceSeq },
            units: order.itemCount,
            containers: boxes.length,
            matchesScope: (scope) =>
              scope.deviceSeq === input.deviceSeq &&
              scope.payloadDigest === kioskOrderPayloadDigest(input) &&
              scope.badgeIdentityDigest ===
                entitlementDigest({
                  badgeDigest: input.badgeDigest ?? null,
                  badgeCode: input.badgeCode ?? null,
                }),
          },
        ];
      },
    );
  }
}
