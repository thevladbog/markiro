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
   * Revoke: delete the underlying apikey row, then the device row.
   *
   * CodeRabbit PR33 review, Finding 8: this used to delete BOTH rows inside
   * one transaction, device row first, api-key second ("atomically, so a
   * transient failure can never leave the api-key live while the device row
   * is gone"). `sscc_blocks`'s composite FK to `station_devices`
   * (packages/db/src/schema/platform.ts) has no `onDelete`, so it defaults
   * to `NO ACTION`; once a device has fetched even one aggregation bundle (a
   * real `sscc_blocks` row referencing it), deleting `station_devices` FIRST
   * raises an FK violation. Inside one transaction that violation aborts the
   * ENTIRE transaction, undoing the api-key delete too (Postgres has no
   * partial commit without explicit SAVEPOINTs) -- so the admin sees a
   * failed request, but the credential is silently still live until they
   * notice and retry differently.
   *
   * The fix is not just reordering the two statements inside the same
   * transaction -- that alone changes nothing, since ANY error in a
   * transaction still rolls back everything before it, regardless of
   * statement order. The api-key delete must instead commit
   * UNCONDITIONALLY, independent of whatever happens to the device row
   * afterward: it runs as its own auto-committed statement (not inside a
   * `this.db.transaction(...)` with the device-row delete), so a station can
   * no longer authenticate the instant this statement returns, no matter
   * what the device-row delete that follows does. If that second delete
   * then fails (the same FK, for a device with issued blocks, or anything
   * else), the error still propagates to the caller -- an orphaned
   * `station_devices` row with no matching `apikey` is bookkeeping debt an
   * admin can investigate, not a live credential, which is the
   * security-critical property this finding exists to guarantee.
   *
   * Safe to split: nothing else in this method reads `apikey` via a join
   * against `station_devices`, or otherwise depends on `station_devices`
   * still existing at the point `apikey` is deleted -- the SELECT below
   * already captured everything this method needs (`row.apiKeyId`) before
   * either delete runs.
   */
  async revoke(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(schema.stationDevices)
      .where(and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)));
    if (!row) throw new NotFoundException();

    await this.db.delete(schema.apikey).where(eq(schema.apikey.id, row.apiKeyId));
    await this.db
      .delete(schema.stationDevices)
      .where(and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, id)));
  }

  private rowToDto(row: typeof schema.stationDevices.$inferSelect): StationDeviceDto {
    return { id: row.id, name: row.name, enrolledAt: row.enrolledAt, lastSeenAt: row.lastSeenAt };
  }
}
