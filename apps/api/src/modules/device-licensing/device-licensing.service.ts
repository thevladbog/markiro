import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { CABINET_CAPABILITY, hasCabinetCapabilities, resolveCabinetAccess } from "@markiro/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  cancelDeviceReservationSchema,
  deviceReservationReceiptSchema,
  workingDevicePoolSchema,
  type CancelDeviceReservation,
  type DeviceReservationReceipt,
  type WorkingDevicePool,
  type PlatformPrincipal,
  type PlatformCapability,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { platformCapabilitiesForRole } from "../../platform-auth/platform-access-policy";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import {
  assignmentConsistent,
  assignmentOccupied,
  assignmentSnapshot,
} from "../../subscriptions/working-device-assignments";
import { hasWorkingDeviceEvidence } from "../../subscriptions/working-device-evidence";
import { stationDeviceLifecycle } from "../station-devices/dto";

export type DeviceLicensingActor =
  { domain: "cabinet"; id: string } | { domain: "platform"; principal: PlatformPrincipal };

@Injectable()
export class DeviceLicensingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
  ) {}

  async inspect(tenantId: string, actor: DeviceLicensingActor): Promise<WorkingDevicePool> {
    return this.db.transaction(
      async (tx) => {
        const authority = await this.requireActor(tx, tenantId, actor, false);
        const rows = await this.rows(tx, tenantId);
        const integrity = rows.every(({ device, assignment }) =>
          assignmentConsistent(device, assignment),
        )
          ? "ready"
          : "inconsistent";
        const current = await this.entitlements.resolve(tenantId, tx);
        const canCancelReservations = authority.canCancel && integrity === "ready";
        const devices = await Promise.all(
          rows.map(async ({ device, assignment }) => {
            const consistent = assignmentConsistent(device, assignment);
            const state = consistent && assignment ? assignment.state : "inconsistent";
            const evidence =
              state === "reserved" && (await hasWorkingDeviceEvidence(tx, tenantId, device.id));
            const blockedReason = !consistent
              ? "inconsistent"
              : state === "released"
                ? "released"
                : state === "assigned"
                  ? "already_paired"
                  : evidence
                    ? "production_evidence"
                    : null;
            return {
              deviceId: device.id,
              name: device.name,
              kind: device.kind,
              assignmentId: assignment?.id ?? null,
              revision: assignment?.revision ?? null,
              state,
              releaseReason: assignment?.releaseReason ?? null,
              slotOccupied: assignmentOccupied(device, assignment),
              canCancel: canCancelReservations && state === "reserved" && !evidence,
              blockedReason,
              connectionStatus: stationDeviceLifecycle(device),
              pairedAt: device.pairedAt?.toISOString() ?? null,
              lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
            };
          }),
        );
        return workingDevicePoolSchema.parse({
          tenantId,
          integrity,
          usage: devices.filter((d) => d.slotOccupied).length,
          limit: current.quotas.stations,
          canCancelReservations,
          devices,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async cancel(
    tenantId: string,
    deviceId: string,
    input: CancelDeviceReservation,
    actor: DeviceLicensingActor,
  ): Promise<DeviceReservationReceipt> {
    const parsed = cancelDeviceReservationSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "device_reservation_invalid" });
    const request = parsed.data;
    const requestHash = entitlementDigest({ deviceId, ...request });
    return this.db.transaction((tx) =>
      this.entitlements.withQuotaLock(tx, tenantId, "stations", async () => {
        const authority = await this.requireActor(tx, tenantId, actor, true);
        const [existing] = await tx
          .select()
          .from(schema.workingDeviceEvents)
          .where(
            and(
              eq(schema.workingDeviceEvents.tenantId, tenantId),
              eq(schema.workingDeviceEvents.requestId, request.requestId),
            ),
          );
        if (existing) {
          if (
            existing.actorDomain !== actor.domain ||
            existing.actorId !== authority.id ||
            existing.deviceId !== deviceId ||
            existing.requestHash !== requestHash
          ) {
            throw new ConflictException({ code: "device_reservation_request_conflict" });
          }
          return deviceReservationReceiptSchema.parse(existing.response);
        }
        const [device] = await tx
          .select()
          .from(schema.stationDevices)
          .where(
            and(
              eq(schema.stationDevices.tenantId, tenantId),
              eq(schema.stationDevices.id, deviceId),
            ),
          )
          .for("update");
        if (!device) throw new NotFoundException();
        const rows = await this.rows(tx, tenantId);
        if (!rows.every((row) => assignmentConsistent(row.device, row.assignment))) {
          throw new ConflictException({ code: "device_licensing_inconsistent" });
        }
        const assignment = rows.find((row) => row.device.id === deviceId)?.assignment;
        if (!assignment || assignment.revision !== request.expectedRevision)
          throw new ConflictException({ code: "device_reservation_stale" });
        if (
          assignment.state !== "reserved" ||
          device.pairedAt !== null ||
          device.apiKeyId !== null ||
          device.lastSeenAt !== null ||
          (await hasWorkingDeviceEvidence(tx, tenantId, deviceId))
        ) {
          throw new ConflictException({ code: "device_reservation_not_empty" });
        }
        const now = new Date();
        const next = {
          ...assignment,
          state: "released" as const,
          releaseReason: "reservation_cancelled" as const,
          revision: assignment.revision + 1,
          releasedAt: now,
          updatedAt: now,
          lastEventId: randomUUID(),
        };
        const receipt = deviceReservationReceiptSchema.parse({
          requestId: request.requestId,
          deviceId,
          assignmentId: assignment.id,
          revision: next.revision,
          state: next.state,
          releaseReason: next.releaseReason,
          releasedAt: now.toISOString(),
        });
        const before = assignmentSnapshot(assignment);
        const after = assignmentSnapshot(next);
        await tx.insert(schema.workingDeviceEvents).values({
          id: next.lastEventId,
          tenantId,
          deviceId,
          actorDomain: actor.domain,
          actorId: authority.id,
          action: "reservation_cancelled",
          before,
          after,
          requestId: request.requestId,
          requestHash,
          response: receipt,
        });
        await tx
          .update(schema.stationPairingCodes)
          .set({ usedAt: now })
          .where(
            and(
              eq(schema.stationPairingCodes.tenantId, tenantId),
              eq(schema.stationPairingCodes.stationDeviceId, deviceId),
              isNull(schema.stationPairingCodes.usedAt),
            ),
          );
        if (actor.domain === "platform") {
          await this.audit.record(tx, {
            actorPlatformUserId: authority.id,
            actorRole: authority.role,
            tenantId,
            action: "device.reservation.cancelled",
            outcome: "success",
            targetType: "station_device",
            targetId: deviceId,
            reason: null,
            before,
            after,
            requestId: request.requestId,
          });
        }
        await tx
          .update(schema.workingDeviceAssignments)
          .set(next)
          .where(
            and(
              eq(schema.workingDeviceAssignments.tenantId, tenantId),
              eq(schema.workingDeviceAssignments.id, assignment.id),
            ),
          );
        return receipt;
      }),
    );
  }

  private rows(tx: SubscriptionTransaction, tenantId: string) {
    return tx
      .select({ device: schema.stationDevices, assignment: schema.workingDeviceAssignments })
      .from(schema.stationDevices)
      .leftJoin(
        schema.workingDeviceAssignments,
        and(
          eq(schema.workingDeviceAssignments.tenantId, schema.stationDevices.tenantId),
          eq(schema.workingDeviceAssignments.deviceId, schema.stationDevices.id),
        ),
      )
      .where(eq(schema.stationDevices.tenantId, tenantId))
      .orderBy(asc(schema.stationDevices.name), asc(schema.stationDevices.id));
  }

  private async requireActor(
    tx: SubscriptionTransaction,
    tenantId: string,
    actor: DeviceLicensingActor,
    write: boolean,
  ) {
    if (actor.domain === "cabinet") {
      const query = tx
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, actor.id)))
        .limit(2);
      const memberships = await (write ? query.for("share") : query);
      const membership = memberships[0];
      if (
        memberships.length !== 1 ||
        !membership ||
        !hasCabinetCapabilities(resolveCabinetAccess(membership.role).capabilities, [
          CABINET_CAPABILITY.CREDENTIALS_MANAGE,
        ])
      )
        throw new ForbiddenException();
      return { id: actor.id, role: null, canCancel: true };
    }
    const { principal } = actor;
    if (!principal?.twoFactorReady) throw new ForbiddenException();
    // Platform recovery retires the factor before updating its user. Follow
    // that order so a concurrent security reset cannot deadlock cancellation.
    const factorQuery = tx
      .select({ id: schema.platformTwoFactors.id })
      .from(schema.platformTwoFactors)
      .where(
        and(
          eq(schema.platformTwoFactors.userId, principal.userId),
          eq(schema.platformTwoFactors.verified, true),
        ),
      );
    if (!(await (write ? factorQuery.for("share") : factorQuery))[0])
      throw new ForbiddenException();
    const query = tx
      .select()
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, principal.userId));
    const [user] = await (write ? query.for("share") : query);
    const required: PlatformCapability[] = write
      ? ["tenants.write", "billing.write"]
      : ["tenants.read"];
    if (
      !user ||
      user.status !== "active" ||
      !user.twoFactorEnabled ||
      !required.every((cap) => platformCapabilitiesForRole(user.role).includes(cap))
    )
      throw new ForbiddenException();
    const [tenant] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId));
    if (!tenant) throw new NotFoundException();
    return {
      id: user.id,
      role: user.role,
      canCancel: ["tenants.write", "billing.write"].every((cap) =>
        platformCapabilitiesForRole(user.role).some((value) => value === cap),
      ),
    };
  }
}
