import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@markiro/db";
import {
  grantEventBudget,
  inventorySnapshotContentDigest,
  type BudgetLine,
  type GrantEventType,
  type GrantOwner,
} from "@markiro/domain";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import { parseStationInventoryManifest } from "../inventories/station-inventory.dto";
import type { ApprovedGrantPolicy, GrantTaskBounds } from "./grant-policy";

export interface FrozenGrantTask {
  taskKind: "shift" | "inventory" | "pickup";
  taskId: string;
  snapshotDigest: string;
  eventTypes: GrantEventType[];
  budget: BudgetLine[];
}
type Denial = { status: "denied"; reason: "bounds_required" | "task_not_frozen" };
type Ready = { status: "ready"; task: FrozenGrantTask };
/** Pure producer for already trusted owner facts. Not a request DTO boundary. */
export function buildFrozenGrantTask(
  taskKind: FrozenGrantTask["taskKind"],
  taskId: string,
  scope: Record<string, unknown>,
  eventTypes: GrantEventType[],
  bounds: GrantTaskBounds | undefined,
): Denial | Ready {
  if (!bounds || eventTypes.length === 0) return { status: "denied", reason: "bounds_required" };
  const budget: BudgetLine[] = [];
  for (const event of eventTypes) {
    const limits = bounds[event];
    if (!limits) return { status: "denied", reason: "bounds_required" };
    const lines = grantEventBudget(event, limits);
    if (!lines) return { status: "denied", reason: "bounds_required" };
    budget.push(...lines);
  }
  return {
    status: "ready",
    task: {
      taskKind,
      taskId,
      snapshotDigest: entitlementDigest({ taskKind, taskId, scope }),
      eventTypes,
      budget,
    },
  };
}
function serializable(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return z.record(z.string(), z.unknown()).parse(parsed);
}
/**
 * Same transaction as caller admission, after quota/timeline/device/key/policy locks.
 * Never acquires a pool connection. Pickup reads ONLY scope already frozen by
 * attestation, so it never takes registry/allowance locks after the kiosk lock.
 */
export async function freezeGrantTask(
  tx: SubscriptionTransaction,
  owner: GrantOwner,
  reference: { taskKind: FrozenGrantTask["taskKind"]; taskId: string },
  policy: ApprovedGrantPolicy,
): Promise<Denial | (Ready & { sourceId: string })> {
  const missing: Denial = { status: "denied", reason: "task_not_frozen" };
  let scope: Record<string, unknown>;
  let events: GrantEventType[];
  let bounds: GrantTaskBounds | undefined;
  if (owner.kind === "kiosk") {
    if (reference.taskKind !== "pickup") return missing;
    const [device] = await tx
      .select()
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, owner.tenantId), eq(schema.kiosks.id, owner.deviceId)))
      .for("update");
    if (
      !device ||
      device.status !== "active" ||
      !device.deviceTokenHash ||
      device.credentialEpoch !== owner.credentialEpoch
    )
      return missing;
    const [reservation] = await tx
      .select()
      .from(schema.kioskOrderAdmissions)
      .where(
        and(
          eq(schema.kioskOrderAdmissions.tenantId, owner.tenantId),
          eq(schema.kioskOrderAdmissions.kioskId, owner.deviceId),
          eq(schema.kioskOrderAdmissions.id, reference.taskId),
        ),
      )
      .for("update");
    if (!reservation) return missing;
    if (!reservation.frozenScope || reservation.credentialEpoch !== owner.credentialEpoch)
      return { status: "denied", reason: "bounds_required" };
    const frozen = z
      .object({
        version: z.literal(1),
        payloadDigest: z.string(),
        deviceSeq: z.number().int().nonnegative(),
        unitCount: z.number().int().nonnegative(),
        containerCount: z.number().int().nonnegative(),
        items: z.array(
          z
            .object({
              rawKm: z.string().min(1),
              kmKey: z.string().min(1),
              productId: z.string().uuid(),
            })
            .strict(),
        ),
        boxes: z.array(
          z
            .object({
              boxId: z.string().uuid(),
              sscc: z.string().min(1),
              productId: z.string().uuid(),
              members: z.array(
                z.object({ rawKm: z.string().min(1), kmKey: z.string().min(1) }).strict(),
              ),
            })
            .strict(),
        ),
      })
      .passthrough()
      .safeParse(reservation.frozenScope);
    if (
      !frozen.success ||
      frozen.data.payloadDigest !== reservation.payloadDigest ||
      frozen.data.deviceSeq !== reservation.deviceSeq
    )
      return missing;
    const keys = [
      ...frozen.data.items.map((item) => item.kmKey),
      ...frozen.data.boxes.flatMap((box) => box.members.map((member) => member.kmKey)),
    ];
    const unitCount = keys.length,
      containerCount = frozen.data.boxes.length;
    if (
      new Set(keys).size !== unitCount ||
      frozen.data.unitCount !== unitCount ||
      frozen.data.containerCount !== containerCount
    )
      return { status: "denied", reason: "bounds_required" };
    scope = frozen.data;
    events = ["pickup.complete.v1"];
    const configured = policy.taskBounds.pickup?.["pickup.complete.v1"];
    bounds = configured
      ? {
          "pickup.complete.v1": {
            ...configured,
            maxEvents: Math.min(configured.maxEvents, 1),
            ...(configured.maxUnits === undefined
              ? {}
              : { maxUnits: Math.min(configured.maxUnits, unitCount) }),
            ...(configured.maxContainers === undefined
              ? {}
              : { maxContainers: Math.min(configured.maxContainers, containerCount) }),
          },
        }
      : undefined;
  } else {
    if (reference.taskKind === "pickup") return missing;
    const [device] = await tx
      .select()
      .from(schema.stationDevices)
      .where(
        and(
          eq(schema.stationDevices.tenantId, owner.tenantId),
          eq(schema.stationDevices.id, owner.deviceId),
        ),
      )
      .for("update");
    if (
      !device ||
      device.revokedAt ||
      !device.apiKeyId ||
      device.kind !== owner.kind ||
      device.credentialEpoch !== owner.credentialEpoch
    )
      return missing;
    if (reference.taskKind === "inventory") {
      const [inventory] = await tx
        .select()
        .from(schema.inventories)
        .where(
          and(
            eq(schema.inventories.tenantId, owner.tenantId),
            eq(schema.inventories.id, reference.taskId),
          ),
        )
        .for("update");
      if (!inventory || inventory.status !== "running" || !inventory.activeSnapshotId)
        return missing;
      const [participant] = await tx
        .select()
        .from(schema.inventoryDeviceParticipants)
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, owner.tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, inventory.id),
            eq(schema.inventoryDeviceParticipants.deviceId, owner.deviceId),
          ),
        )
        .for("update");
      if (!participant || participant.leftAt) return missing;
      const [snapshot] = await tx
        .select()
        .from(schema.inventorySnapshots)
        .where(
          and(
            eq(schema.inventorySnapshots.tenantId, owner.tenantId),
            eq(schema.inventorySnapshots.id, inventory.activeSnapshotId),
            eq(schema.inventorySnapshots.inventoryId, inventory.id),
          ),
        )
        .for("share");
      if (!snapshot) return missing;
      let manifest;
      try {
        manifest = parseStationInventoryManifest(inventory.stationManifest);
      } catch {
        return missing;
      }
      if (
        manifest.snapshotId !== snapshot.id ||
        manifest.combinedDigest !== snapshot.combinedDigest ||
        manifest.mode !== inventory.mode
      )
        return missing;
      const codes = await tx
        .select()
        .from(schema.inventorySnapshotCodes)
        .where(
          and(
            eq(schema.inventorySnapshotCodes.tenantId, owner.tenantId),
            eq(schema.inventorySnapshotCodes.snapshotId, snapshot.id),
          ),
        )
        .orderBy(asc(schema.inventorySnapshotCodes.codeHash))
        .for("share");
      if (inventorySnapshotContentDigest(codes) !== manifest.contentDigest) return missing;
      scope = serializable({
        manifest,
        snapshotId: snapshot.id,
        combinedDigest: snapshot.combinedDigest,
        contentDigest: manifest.contentDigest,
      });
      events =
        inventory.mode === "check"
          ? ["inventory.scan.v1", "inventory.close.v1"]
          : [
              "inventory.scan.v1",
              "inventory.repack.v1",
              "inventory.box.close.v1",
              "inventory.close.v1",
            ];
      bounds =
        inventory.mode === "check"
          ? policy.taskBounds.inventoryCheck
          : policy.taskBounds.inventoryRepack;
    } else {
      const [shift] = await tx
        .select()
        .from(schema.shifts)
        .where(
          and(eq(schema.shifts.tenantId, owner.tenantId), eq(schema.shifts.id, reference.taskId)),
        )
        .for("update");
      if (!shift || shift.status !== "active") return missing;
      const [participant] = await tx
        .select()
        .from(schema.shiftDeviceParticipants)
        .where(
          and(
            eq(schema.shiftDeviceParticipants.tenantId, owner.tenantId),
            eq(schema.shiftDeviceParticipants.shiftId, shift.id),
            eq(schema.shiftDeviceParticipants.deviceId, owner.deviceId),
          ),
        )
        .for("update");
      if (!participant) return missing;
      const templates = [];
      for (const id of [
        ...new Set(
          [
            shift.labelTemplateId,
            shift.boxLabelTemplateId,
            shift.palletLabelTemplateId,
            shift.validationPrintTemplateId,
          ].filter((id): id is string => id !== null),
        ),
      ].sort()) {
        const [template] = await tx
          .select()
          .from(schema.labelTemplates)
          .where(
            and(
              eq(schema.labelTemplates.tenantId, owner.tenantId),
              eq(schema.labelTemplates.id, id),
            ),
          )
          .for("share");
        if (!template) return missing;
        templates.push({ id: template.id, spec: template.spec });
      }
      const [product] = await tx
        .select()
        .from(schema.products)
        .where(
          and(
            eq(schema.products.tenantId, owner.tenantId),
            eq(schema.products.id, shift.productId),
          ),
        )
        .for("share");
      if (!product) return missing;
      let counterpartyName: string | null = null;
      if (shift.counterpartyId !== null) {
        const [counterparty] = await tx
          .select({ name: schema.counterparties.name })
          .from(schema.counterparties)
          .where(
            and(
              eq(schema.counterparties.tenantId, owner.tenantId),
              eq(schema.counterparties.id, shift.counterpartyId),
            ),
          )
          .for("share");
        if (!counterparty) return missing;
        counterpartyName = counterparty.name;
      }
      // Bind execution and label content explicitly. Receipt/progress timestamps,
      // planned totals and catalog bookkeeping must never renew consumption identity.
      // Every productive maximum still comes only from approved policy bounds.
      scope = serializable({
        shift: {
          id: shift.id,
          productId: shift.productId,
          mode: shift.mode,
          lineId: shift.lineId,
          counterpartyId: shift.counterpartyId,
          counterpartyName,
          ssccIssuerCounterpartyId: shift.ssccIssuerCounterpartyId,
          labelTemplateId: shift.labelTemplateId,
          boxLabelTemplateId: shift.boxLabelTemplateId,
          palletLabelTemplateId: shift.palletLabelTemplateId,
          validationPrintMode: shift.validationPrintMode,
          allowPreviouslyAcceptedCodes: shift.allowPreviouslyAcceptedCodes,
          validationPrintVerification: shift.validationPrintVerification,
          validationPrintTemplateId: shift.validationPrintTemplateId,
          validationPrintSnapshot: shift.validationPrintSnapshot,
          validationPrintPolicyRevision: shift.validationPrintPolicyRevision,
          boxCapacity: shift.boxCapacity,
          palletsEnabled: shift.palletsEnabled,
          palletBoxCapacity: shift.palletsEnabled ? shift.palletBoxCapacity : null,
          stationClosePolicy: shift.stationClosePolicy,
          stationCloseOwnerDeviceId: shift.stationCloseOwnerDeviceId,
          plannedDate: shift.plannedDate,
          productionDate: shift.productionDate,
          // These immutable fields form the printed shift number (including /S).
          numberMonthKey: shift.numberMonthKey,
          numberSeq: shift.numberSeq,
          createdFrom: shift.createdFrom,
        },
        product: {
          id: product.id,
          gtin14: product.gtin14,
          name: product.name,
          printName: product.printName,
          chzProductGroupCode: product.chzProductGroupCode,
          egaisCode: product.egaisCode,
          shelfLifeDays: product.shelfLifeDays,
        },
        templates,
      });
      events = ["shift.scan.v1", "shift.close.v1"];
      if (shift.mode === "aggregation") events.push("shift.box.close.v1");
      if (shift.palletsEnabled) events.push("shift.pallet.close.v1");
      if (shift.validationPrintMode === "duplicate_dm") events.push("shift.label.prepare.v1");
      bounds = policy.taskBounds.shift;
    }
  }
  const built = buildFrozenGrantTask(reference.taskKind, reference.taskId, scope, events, bounds);
  if (built.status === "denied") return built;
  const ownerPredicate =
    owner.kind === "kiosk"
      ? eq(schema.deviceGrantTaskSources.kioskId, owner.deviceId)
      : eq(schema.deviceGrantTaskSources.stationDeviceId, owner.deviceId);
  const [existing] = await tx
    .select()
    .from(schema.deviceGrantTaskSources)
    .where(
      and(
        eq(schema.deviceGrantTaskSources.tenantId, owner.tenantId),
        ownerPredicate,
        eq(schema.deviceGrantTaskSources.credentialEpoch, owner.credentialEpoch),
        eq(schema.deviceGrantTaskSources.taskId, reference.taskId),
        eq(schema.deviceGrantTaskSources.taskKind, reference.taskKind),
        eq(schema.deviceGrantTaskSources.snapshotDigest, built.task.snapshotDigest),
        eq(schema.deviceGrantTaskSources.policyRevision, policy.revision),
      ),
    );
  if (existing) return { ...built, sourceId: existing.id };
  const [saved] = await tx
    .insert(schema.deviceGrantTaskSources)
    .values({
      tenantId: owner.tenantId,
      ownerKind: owner.kind,
      credentialEpoch: owner.credentialEpoch,
      stationDeviceId: owner.kind === "kiosk" ? null : owner.deviceId,
      kioskId: owner.kind === "kiosk" ? owner.deviceId : null,
      ...built.task,
      scope,
      policyId: policy.id,
      policyRevision: policy.revision,
    })
    .returning({ id: schema.deviceGrantTaskSources.id });
  if (!saved) throw new Error("Frozen grant source was not persisted");
  return { ...built, sourceId: saved.id };
}
