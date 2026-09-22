import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { EntitlementsExecutor } from "../../subscriptions/entitlements.types";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  assertReservationOpen,
  transitionWorkingAssignment,
  workingAssignment,
  type WorkingDeviceActor,
} from "../../subscriptions/working-device-assignments";
import {
  stationDeviceLifecycle,
  type CreateStationDeviceDto,
  type ListStationDevicesResponseDto,
  type StationDeviceDto,
  type StationDeviceKind,
  type UpdateStationDeviceDto,
} from "./dto";

type StationDeviceRow = typeof schema.stationDevices.$inferSelect;
type StationDeviceWithLine = { device: StationDeviceRow; lineName: string | null };

@Injectable()
export class StationDevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(tenantId: string): Promise<ListStationDevicesResponseDto> {
    const rows = await this.deviceQuery()
      .where(eq(schema.stationDevices.tenantId, tenantId))
      .orderBy(desc(schema.stationDevices.enrolledAt));
    return { items: rows.map((row) => this.toDto(row)) };
  }

  async create(
    tenantId: string,
    dto: CreateStationDeviceDto,
    actor?: WorkingDeviceActor,
  ): Promise<StationDeviceDto> {
    const lineName = await this.lineName(tenantId, dto.lineId);
    const row = await this.db.transaction((tx) =>
      this.entitlements.withQuotaSlot(tx, tenantId, "stations", async () => {
        const [created] = await tx
          .insert(schema.stationDevices)
          .values({
            tenantId,
            name: dto.name,
            lineId: dto.lineId,
            kind: dto.kind ?? "station",
            apiKeyId: null,
          })
          .returning();
        if (created) await transitionWorkingAssignment(tx, created, actor);
        return created;
      }),
    );
    if (!row) throw new NotFoundException("Station device was not created");
    return this.toDto({ device: row, lineName });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateStationDeviceDto,
    actor?: WorkingDeviceActor,
  ): Promise<StationDeviceDto> {
    return this.db.transaction((tx) =>
      this.entitlements.withQuotaLock(tx, tenantId, "stations", async () => {
        const [current] = await tx
          .select()
          .from(schema.stationDevices)
          .where(
            and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
          )
          .for("update");
        if (!current) throw new NotFoundException();
        const [execution] = await tx
          .select({ id: schema.workingDeviceReplacementExecutions.id })
          .from(schema.workingDeviceReplacementExecutions)
          .where(
            and(
              eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
              eq(schema.workingDeviceReplacementExecutions.deviceId, id),
              eq(schema.workingDeviceReplacementExecutions.state, "executing"),
            ),
          );
        if (execution) throw new ConflictException({ code: "device_replacement_source_frozen" });
        assertReservationOpen(await workingAssignment(tx, tenantId, id));
        const lineName = await this.lineName(
          tenantId,
          dto.lineId === undefined ? current.lineId : dto.lineId,
          tx,
        );
        const set: { name?: string; lineId?: string | null; kind?: StationDeviceKind } = {};
        if (dto.name !== undefined) set.name = dto.name;
        if (dto.lineId !== undefined) set.lineId = dto.lineId;
        if (dto.kind !== undefined && dto.kind !== current.kind) {
          // Recheck after the same lock used by the pairing claim.
          if (current.apiKeyId !== null || current.pairedAt !== null) {
            throw new ConflictException("Device kind is fixed after pairing");
          }
          set.kind = dto.kind;
        }
        if (Object.keys(set).length === 0) return this.toDto({ device: current, lineName });
        const [row] = await tx
          .update(schema.stationDevices)
          .set(set)
          .where(
            and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
          )
          .returning();
        if (!row) throw new NotFoundException();
        await transitionWorkingAssignment(tx, row, actor, "observed");
        return this.toDto({ device: row, lineName });
      }),
    );
  }

  /**
   * Invalidates the credential before mutating the durable station record.
   * The api-key statement is deliberately auto-committed: a transaction error
   * must never resurrect a still-authenticating device key.
   */
  async revoke(tenantId: string, id: string, actor?: WorkingDeviceActor): Promise<void> {
    const current = await this.find(tenantId, id);
    if (!current) throw new NotFoundException();

    if (current.device.apiKeyId !== null) {
      await this.db.delete(schema.apikey).where(eq(schema.apikey.id, current.device.apiKeyId));
    }

    const deletedKeys = new Set(current.device.apiKeyId === null ? [] : [current.device.apiKeyId]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const nextKey = await this.db.transaction((tx) =>
        this.entitlements.withQuotaLock(tx, tenantId, "stations", async () => {
          const [locked] = await tx
            .select()
            .from(schema.stationDevices)
            .where(
              and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
            )
            .for("update");
          if (!locked) throw new NotFoundException();
          // Release this transaction before auto-committing a newly discovered
          // key deletion. Acquiring a second pooled connection while holding the
          // quota lock could starve the pool behind concurrent waiting revokes.
          if (locked.apiKeyId !== null && !deletedKeys.has(locked.apiKeyId)) return locked.apiKeyId;
          // Replacement leaves revokedAt set, but recovery issuance may have added
          // a code/key since then. Retire those capabilities under the same source
          // lock as issuance/redemption without rewriting the historical revoke.
          // Every explicit replacement-source revoke advances authority, even
          // without a visible key/code: issuance may already be waiting on this
          // lock with the preceding execution revision.
          if (locked.revokedAt !== null) {
            const now = new Date();
            const retired = await tx
              .update(schema.stationPairingCodes)
              .set({ usedAt: now })
              .where(
                and(
                  eq(schema.stationPairingCodes.tenantId, tenantId),
                  eq(schema.stationPairingCodes.stationDeviceId, id),
                  isNull(schema.stationPairingCodes.usedAt),
                ),
              )
              .returning({ id: schema.stationPairingCodes.id });
            const [replacement] = await tx
              .select({ id: schema.workingDeviceReplacementExecutions.id })
              .from(schema.workingDeviceReplacementExecutions)
              .where(
                and(
                  eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
                  eq(schema.workingDeviceReplacementExecutions.deviceId, id),
                  eq(schema.workingDeviceReplacementExecutions.state, "completed"),
                ),
              );
            // Ordinary duplicate revoke remains an idempotent no-op. Unlike a
            // replacement source it cannot have a queued recovery issuance.
            if (!replacement && locked.apiKeyId === null && retired.length === 0) return null;
            const [revoked] = await tx
              .update(schema.stationDevices)
              .set({
                apiKeyId: null,
                securityRevocationRevision: locked.securityRevocationRevision + 1,
              })
              .where(
                and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
              )
              .returning();
            if (!revoked) throw new NotFoundException();
            await tx
              .update(schema.workingDeviceReplacementReadinessIntents)
              .set({ state: "superseded", closedAt: now })
              .where(
                and(
                  eq(schema.workingDeviceReplacementReadinessIntents.tenantId, tenantId),
                  eq(schema.workingDeviceReplacementReadinessIntents.deviceId, id),
                  eq(schema.workingDeviceReplacementReadinessIntents.state, "active"),
                ),
              );
            await tx
              .update(schema.workingDeviceReplacementExecutions)
              .set({
                revision: sql`${schema.workingDeviceReplacementExecutions.revision} + 1`,
              })
              .where(
                and(
                  eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
                  eq(schema.workingDeviceReplacementExecutions.deviceId, id),
                  eq(schema.workingDeviceReplacementExecutions.state, "completed"),
                ),
              );
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: tenantId,
              actorUserId: actor?.domain === "cabinet" ? actor.id : null,
              action: "device.replacement.recovery_security_revoked",
              outcome: "success",
              targetType: "station_device",
              targetId: id,
              before: { credentialEpoch: locked.credentialEpoch },
              after: {
                actorDomain: actor?.domain ?? "system",
                actorId: actor?.id ?? null,
                deviceId: id,
                credentialEpoch: revoked.credentialEpoch,
                securityRevocationRevision: revoked.securityRevocationRevision,
                retiredPairingCodeIds: retired.map((code) => code.id),
                revokedAt: locked.revokedAt.toISOString(),
              },
            });
            return null;
          }
          // Execution owns the durable source transition once its intent commits.
          // Security revocation above is still immediate; repair completes its journal.
          const [execution] = await tx
            .select({ id: schema.workingDeviceReplacementExecutions.id })
            .from(schema.workingDeviceReplacementExecutions)
            .where(
              and(
                eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
                eq(schema.workingDeviceReplacementExecutions.deviceId, id),
                eq(schema.workingDeviceReplacementExecutions.state, "executing"),
              ),
            );
          if (execution) return null;
          assertReservationOpen(await workingAssignment(tx, tenantId, id));
          const revokedAt = new Date();
          const [revoked] = await tx
            .update(schema.stationDevices)
            .set({
              apiKeyId: null,
              revokedAt,
              securityRevocationRevision: locked.securityRevocationRevision + 1,
            })
            .where(
              and(
                eq(schema.stationDevices.tenantId, tenantId),
                eq(schema.stationDevices.id, id),
                isNull(schema.stationDevices.revokedAt),
              ),
            )
            .returning();
          if (!revoked) return null;
          await transitionWorkingAssignment(tx, revoked, actor);
          await tx
            .update(schema.stationPairingCodes)
            .set({ usedAt: revokedAt })
            .where(
              and(
                eq(schema.stationPairingCodes.tenantId, tenantId),
                eq(schema.stationPairingCodes.stationDeviceId, id),
                isNull(schema.stationPairingCodes.usedAt),
              ),
            );
          return null;
        }),
      );
      if (nextKey === null) return;
      await this.db.delete(schema.apikey).where(eq(schema.apikey.id, nextKey));
      deletedKeys.add(nextKey);
    }
    throw new ConflictException({ code: "station_credential_changed" });
  }

  private deviceQuery() {
    return this.db
      .select({ device: schema.stationDevices, lineName: schema.lines.name })
      .from(schema.stationDevices)
      .leftJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.stationDevices.tenantId),
          eq(schema.lines.id, schema.stationDevices.lineId),
        ),
      );
  }

  private async find(tenantId: string, id: string): Promise<StationDeviceWithLine | undefined> {
    const [row] = await this.deviceQuery().where(
      and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)),
    );
    return row;
  }

  private async lineName(
    tenantId: string,
    lineId: string | null,
    executor: EntitlementsExecutor = this.db,
  ): Promise<string | null> {
    if (lineId === null) return null;
    const [line] = await executor
      .select({ id: schema.lines.id, name: schema.lines.name })
      .from(schema.lines)
      .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, lineId)));
    if (!line) throw new BadRequestException("Unknown line for this organization");
    return line.name;
  }

  private toDto(row: StationDeviceWithLine): StationDeviceDto {
    const { device, lineName } = row;
    return {
      id: device.id,
      name: device.name,
      kind: device.kind as StationDeviceKind,
      lineId: device.lineId,
      lineName,
      lifecycle: stationDeviceLifecycle(device),
      pairedAt: device.pairedAt,
      revokedAt: device.revokedAt,
      lastSeenAt: device.lastSeenAt,
      createdAt: device.enrolledAt,
    };
  }
}
