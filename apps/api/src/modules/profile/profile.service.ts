import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, lt, lte, notExists, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { processAvatar } from "./avatar-processor";
import type { AvatarUrlDto, UpdateProfileDto, UserProfileDto } from "./dto";

@Injectable()
export class ProfileService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  async getProfile(userId: string): Promise<UserProfileDto> {
    const [profile] = await this.db
      .select({
        firstName: schema.userProfiles.firstName,
        lastName: schema.userProfiles.lastName,
        middleName: schema.userProfiles.middleName,
        avatarAssetId: schema.userProfiles.avatarAssetId,
      })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1);
    return toProfileDto(profile);
  }

  async updateProfile(userId: string, input: UpdateProfileDto): Promise<UserProfileDto> {
    const before = await this.getProfile(userId);
    const middleName = input.middleName ?? null;
    const displayName = [input.lastName, input.firstName, middleName].filter(Boolean).join(" ");
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.userProfiles)
        .values({
          userId,
          firstName: input.firstName,
          lastName: input.lastName,
          middleName,
        })
        .onConflictDoUpdate({
          target: schema.userProfiles.userId,
          set: {
            firstName: input.firstName,
            lastName: input.lastName,
            middleName,
            updatedAt: new Date(),
          },
        });
      const updated = await tx
        .update(schema.user)
        .set({ name: displayName, updatedAt: new Date() })
        .where(eq(schema.user.id, userId))
        .returning({ id: schema.user.id });
      if (updated.length !== 1) throw new ConflictException("Profile account no longer exists");
      await this.writeAudit(tx, userId, "profile.updated", before, {
        firstName: input.firstName,
        lastName: input.lastName,
        middleName,
        hasAvatar: before.hasAvatar,
      });
    });
    return this.getProfile(userId);
  }

  async uploadAvatar(userId: string, source: Buffer): Promise<UserProfileDto> {
    const before = await this.getRequiredProfile(userId);
    let avatar: Awaited<ReturnType<typeof processAvatar>>;
    let previousAssetId: string | null = null;
    try {
      avatar = await processAvatar(source);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid avatar");
    }

    const assetId = randomUUID();
    const objectKey = `users/${userId}/avatars/${assetId}.webp`;
    await this.db.insert(schema.mediaAssets).values({
      id: assetId,
      ownerUserId: userId,
      objectKey,
      contentType: avatar.contentType,
      byteSize: avatar.byteSize,
      checksum: avatar.checksum,
      width: avatar.width,
      height: avatar.height,
      status: "staging",
    });

    try {
      await this.storage.put(objectKey, avatar.buffer, avatar.contentType);
    } catch {
      throw new ServiceUnavailableException("Avatar storage is unavailable");
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${schema.userProfiles.userId} from ${schema.userProfiles} where ${schema.userProfiles.userId} = ${userId} for update`,
        );
        const [current] = await tx
          .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
          .from(schema.userProfiles)
          .where(eq(schema.userProfiles.userId, userId))
          .limit(1);
        if (!current) throw new ConflictException("Complete the profile before adding an avatar");
        previousAssetId = current.avatarAssetId;
        const activated = await tx
          .update(schema.mediaAssets)
          .set({ status: "active", updatedAt: new Date() })
          .where(
            and(
              eq(schema.mediaAssets.id, assetId),
              eq(schema.mediaAssets.ownerUserId, userId),
              eq(schema.mediaAssets.status, "staging"),
            ),
          )
          .returning({ id: schema.mediaAssets.id });
        if (activated.length !== 1) throw new ConflictException("Avatar staging state changed");
        await tx
          .update(schema.userProfiles)
          .set({
            avatarAssetOwnerUserId: userId,
            avatarAssetId: assetId,
            updatedAt: new Date(),
          })
          .where(eq(schema.userProfiles.userId, userId));
        if (previousAssetId) {
          await tx
            .update(schema.mediaAssets)
            .set({ status: "deleting", updatedAt: new Date() })
            .where(
              and(
                eq(schema.mediaAssets.id, previousAssetId),
                eq(schema.mediaAssets.ownerUserId, userId),
              ),
            );
        }
        await this.writeAudit(tx, userId, "avatar.uploaded", before, {
          ...before,
          hasAvatar: true,
        });
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException("Could not activate avatar");
    }

    if (previousAssetId) await this.tryDeleteAsset(userId, previousAssetId);
    return this.getProfile(userId);
  }

  async deleteAvatar(userId: string): Promise<void> {
    const before = await this.getRequiredProfile(userId);
    let previousAssetId: string | null = null;
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${schema.userProfiles.userId} from ${schema.userProfiles} where ${schema.userProfiles.userId} = ${userId} for update`,
      );
      const [current] = await tx
        .select({ avatarAssetId: schema.userProfiles.avatarAssetId })
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId))
        .limit(1);
      previousAssetId = current?.avatarAssetId ?? null;
      if (!previousAssetId) return;
      await tx
        .update(schema.userProfiles)
        .set({ avatarAssetOwnerUserId: null, avatarAssetId: null, updatedAt: new Date() })
        .where(eq(schema.userProfiles.userId, userId));
      await tx
        .update(schema.mediaAssets)
        .set({ status: "deleting", updatedAt: new Date() })
        .where(
          and(
            eq(schema.mediaAssets.id, previousAssetId),
            eq(schema.mediaAssets.ownerUserId, userId),
          ),
        );
      await this.writeAudit(tx, userId, "avatar.deleted", before, {
        ...before,
        hasAvatar: false,
      });
    });
    if (previousAssetId) await this.tryDeleteAsset(userId, previousAssetId);
  }

  async getAvatarUrl(userId: string): Promise<AvatarUrlDto> {
    const [asset] = await this.db
      .select({ objectKey: schema.mediaAssets.objectKey })
      .from(schema.userProfiles)
      .innerJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.userProfiles.avatarAssetId),
          eq(schema.mediaAssets.ownerUserId, schema.userProfiles.userId),
          eq(schema.mediaAssets.status, "active"),
        ),
      )
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1);
    if (!asset) return { url: null };
    return { url: await this.storage.presignRead(asset.objectKey, 300) };
  }

  async reconcileAssets(now = new Date(), limit = 50): Promise<number> {
    const staleBefore = new Date(now.getTime() - 15 * 60 * 1_000);
    const candidates = await this.db
      .select({
        id: schema.mediaAssets.id,
        ownerUserId: schema.mediaAssets.ownerUserId,
        objectKey: schema.mediaAssets.objectKey,
        status: schema.mediaAssets.status,
      })
      .from(schema.mediaAssets)
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.avatarAssetId, schema.mediaAssets.id))
      .where(
        and(
          inArray(schema.mediaAssets.status, ["staging", "deleting"]),
          lt(schema.mediaAssets.updatedAt, staleBefore),
          isNull(schema.userProfiles.userId),
        ),
      )
      .limit(limit);

    let reconciled = 0;
    for (const candidate of candidates) {
      if (candidate.status === "staging") {
        const claimed = await this.db
          .update(schema.mediaAssets)
          .set({ status: "deleting", updatedAt: now })
          .where(
            and(
              eq(schema.mediaAssets.id, candidate.id),
              eq(schema.mediaAssets.ownerUserId, candidate.ownerUserId),
              eq(schema.mediaAssets.status, "staging"),
              lte(schema.mediaAssets.updatedAt, staleBefore),
            ),
          )
          .returning({ id: schema.mediaAssets.id });
        if (claimed.length !== 1) continue;
      }

      const [reference] = await this.db
        .select({ userId: schema.userProfiles.userId })
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.avatarAssetId, candidate.id))
        .limit(1);
      if (reference) continue;

      try {
        await this.storage.delete(candidate.objectKey);
      } catch {
        continue;
      }
      const result = await this.db
        .delete(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, candidate.id),
            eq(schema.mediaAssets.ownerUserId, candidate.ownerUserId),
            eq(schema.mediaAssets.status, "deleting"),
            notExists(
              this.db
                .select({ userId: schema.userProfiles.userId })
                .from(schema.userProfiles)
                .where(eq(schema.userProfiles.avatarAssetId, candidate.id)),
            ),
          ),
        );
      reconciled += result.rowCount ?? 0;
    }
    return reconciled;
  }

  private async getRequiredProfile(userId: string): Promise<UserProfileDto> {
    const [profile] = await this.db
      .select({ userId: schema.userProfiles.userId })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1);
    if (!profile) throw new ConflictException("Complete the profile before adding an avatar");
    return this.getProfile(userId);
  }

  private async tryDeleteAsset(userId: string, assetId: string): Promise<void> {
    const [asset] = await this.db
      .select({ objectKey: schema.mediaAssets.objectKey })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.id, assetId),
          eq(schema.mediaAssets.ownerUserId, userId),
          eq(schema.mediaAssets.status, "deleting"),
        ),
      )
      .limit(1);
    if (!asset) return;
    try {
      await this.storage.delete(asset.objectKey);
      await this.db
        .delete(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.id, assetId),
            eq(schema.mediaAssets.ownerUserId, userId),
            eq(schema.mediaAssets.status, "deleting"),
          ),
        );
    } catch {
      // The durable `deleting` row remains for scheduled reconciliation.
    }
  }

  private async writeAudit(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    userId: string,
    action: string,
    before: UserProfileDto,
    after: UserProfileDto,
  ): Promise<void> {
    const memberships = await tx
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, userId));
    if (memberships.length === 0) return;
    await tx.insert(schema.tenantAuditEvents).values(
      memberships.map(({ organizationId }) => ({
        organizationId,
        actorUserId: userId,
        action,
        outcome: "success",
        targetType: "user_profile",
        targetId: userId,
        before,
        after,
      })),
    );
  }
}

function toProfileDto(
  profile:
    | {
        firstName: string;
        lastName: string;
        middleName: string | null;
        avatarAssetId: string | null;
      }
    | undefined,
): UserProfileDto {
  return {
    firstName: profile?.firstName ?? null,
    lastName: profile?.lastName ?? null,
    middleName: profile?.middleName ?? null,
    hasAvatar: Boolean(profile?.avatarAssetId),
  };
}
