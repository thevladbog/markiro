import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Auth, type Db } from "@markiro/db";
import { AUTH, DB } from "../../auth/auth.module";
import type {
  EnrollStationDeviceResponseDto,
  ListStationDevicesResponseDto,
  StationDeviceDto,
} from "./dto";

@Injectable()
export class StationDevicesService {
  private readonly logger = new Logger(StationDevicesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  /**
   * Enroll a device: mint a Better Auth api-key whose referenceId is the
   * tenantId (so TenantGuard resolves the tenant from the key), then persist
   * a station_devices row pointing at that key. The plaintext key is returned
   * exactly once; it is never stored.
   */
  async enroll(
    tenantId: string,
    ownerUserId: string,
    name: string,
    serverUrl: string,
  ): Promise<EnrollStationDeviceResponseDto> {
    // Organization-owned key: referenceId = tenantId (plan decision #3). The
    // call is server-side with no session headers, so `userId` (the enrolling
    // member, e.g. the org owner) is required; the org config makes the key
    // owned by the tenant, not that user.
    const key = await this.auth.api.createApiKey({
      body: {
        configId: "station",
        organizationId: tenantId,
        userId: ownerUserId,
        name,
        metadata: { kind: "station" },
      },
    });

    // `createApiKey` and the `station_devices` insert are not transactional
    // (the key is minted via Better Auth's own store, not this `db` handle),
    // so if the insert throws — or returns no row — the just-minted key
    // would otherwise be orphaned: live, but unreachable via
    // `/station-devices/:id` (no device row exists to revoke it through).
    // Roll it back here so a failed enroll never leaves a dangling api-key.
    let row: typeof schema.stationDevices.$inferSelect | undefined;
    try {
      [row] = await this.db
        .insert(schema.stationDevices)
        .values({ tenantId, name, apiKeyId: key.id })
        .returning();
    } catch (err) {
      await this.rollbackApiKey(key.id);
      throw err;
    }
    if (!row) {
      await this.rollbackApiKey(key.id);
      throw new InternalServerErrorException("Failed to enroll device");
    }

    return { deviceId: row.id, name: row.name, apiKey: key.key, serverUrl };
  }

  /** Best-effort cleanup of an api-key minted for an enroll that failed to persist. */
  private async rollbackApiKey(apiKeyId: string): Promise<void> {
    try {
      await this.db.delete(schema.apikey).where(eq(schema.apikey.id, apiKeyId));
    } catch (cleanupErr) {
      // Log-only: this must not mask the original enroll failure being
      // thrown by the caller, but an orphaned key is otherwise silent.
      this.logger.error(
        `Failed to roll back orphaned api-key ${apiKeyId} after a failed station-device enroll`,
        cleanupErr instanceof Error ? cleanupErr.stack : String(cleanupErr),
      );
    }
  }

  async list(tenantId: string): Promise<ListStationDevicesResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.tenantId, tenantId))
      .orderBy(desc(schema.stationDevices.enrolledAt));
    return { items: rows.map((r) => this.rowToDto(r)) };
  }

  /**
   * Revoke: delete the device row AND the underlying apikey row atomically,
   * so a transient failure can never leave the api-key live while the device
   * row is gone (which would make a retry 404 without actually revoking).
   */
  async revoke(tenantId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.stationDevices)
        .where(and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)));
      if (!row) throw new NotFoundException();

      await tx
        .delete(schema.stationDevices)
        .where(and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)));
      await tx.delete(schema.apikey).where(eq(schema.apikey.id, row.apiKeyId));
    });
  }

  private rowToDto(row: typeof schema.stationDevices.$inferSelect): StationDeviceDto {
    return { id: row.id, name: row.name, enrolledAt: row.enrolledAt, lastSeenAt: row.lastSeenAt };
  }
}
