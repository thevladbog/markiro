import { isDeepStrictEqual } from "node:util";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY, validateCoverageReview } from "@markiro/domain";
import {
  platformUuidSchema,
  putProductTraceabilityProfileSchema,
  type ProductTraceabilityProfile,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import {
  canonicalPackageSize,
  coverageFields,
  editableProfile,
  storedProfileResponse,
} from "./us-product-profile-support";
import {
  freshUsProductProfileReaders,
  readCurrentUsProductProfile,
  readUsProductProfileCore,
  readUsProductProfilesCore,
} from "./us-product-profile-read";

export class UsProductProfileStore {
  constructor(private readonly db: Db) {}

  async getProfile(
    tenantId: string,
    actorUserId: string,
    inputId: unknown,
  ): Promise<ProductTraceabilityProfile> {
    const productId = parseMasterDataInput(platformUuidSchema, inputId);
    return this.db.transaction((tx) =>
      this.getProfileInTransaction(tx, tenantId, actorUserId, productId),
    );
  }

  async getProfileInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    inputId: unknown,
  ): Promise<ProductTraceabilityProfile> {
    return readUsProductProfileCore(
      tx,
      tenantId,
      actorUserId,
      inputId,
      freshUsProductProfileReaders,
    );
  }

  async getProfilesInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    inputIds: unknown,
  ): Promise<ProductTraceabilityProfile[]> {
    return readUsProductProfilesCore(
      tx,
      tenantId,
      actorUserId,
      inputIds,
      freshUsProductProfileReaders,
    );
  }

  async putProfile(
    tenantId: string,
    actorUserId: string,
    inputId: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ProductTraceabilityProfile> {
    const command = this.parseProfileCommand(inputId, input);
    return this.db.transaction((tx) =>
      this.persistProfileInTransaction(tx, tenantId, actorUserId, command, requestId),
    );
  }

  async putProfileInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    inputId: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ProductTraceabilityProfile> {
    const command = this.parseProfileCommand(inputId, input);
    return this.persistProfileInTransaction(tx, tenantId, actorUserId, command, requestId);
  }

  private parseProfileCommand(inputId: unknown, input: unknown) {
    const productId = parseMasterDataInput(platformUuidSchema, inputId);
    const parsed = parseMasterDataInput(putProductTraceabilityProfileSchema, input);
    const next = {
      ...editableProfile(parsed),
      packagingSizeValue: canonicalPackageSize(parsed.packagingSizeValue),
    };
    return { productId, parsed, next };
  }

  private async persistProfileInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    command: ReturnType<UsProductProfileStore["parseProfileCommand"]>,
    requestId: string,
  ): Promise<ProductTraceabilityProfile> {
    const { productId, parsed, next } = command;
    const profileCode = await authorizeUsMasterData(
      tx,
      tenantId,
      actorUserId,
      US_CAPABILITY.MASTER_DATA_WRITE,
    );
    // The shared catalog row serializes first inserts too, before a profile row exists.
    const before = await this.currentProfile(tx, tenantId, productId, profileCode, "update");
    const issues = validateCoverageReview(next, profileCode);
    if (issues.length > 0)
      throw new BadRequestException({
        code: "invalid_master_data",
        issues: issues.map((issue) => ({ path: issue.field, message: issue.code })),
      });
    const coverageChanged = !isDeepStrictEqual(coverageFields(before), coverageFields(next));
    if (coverageChanged)
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.QA_MANAGE);

    const unchanged = before.revision > 0 && isDeepStrictEqual(editableProfile(before), next);
    const immediateRetry = parsed.expectedRevision === before.revision - 1;
    if (unchanged && (parsed.expectedRevision === before.revision || immediateRetry)) return before;
    if (parsed.expectedRevision !== before.revision)
      throw new ConflictException({ code: "product_profile_conflict" });

    const now = new Date();
    const values = {
      ...next,
      revision: before.revision + 1,
      updatedAt: now,
      reviewedBy: coverageChanged ? actorUserId : before.reviewedBy,
      reviewedAt: coverageChanged
        ? now
        : before.reviewedAt === null
          ? null
          : new Date(before.reviewedAt),
    };
    const [stored] =
      before.revision === 0
        ? await tx
            .insert(schema.productTraceabilityProfiles)
            .values({ ...values, tenantId, productId, createdAt: now })
            .returning()
        : await tx
            .update(schema.productTraceabilityProfiles)
            .set(values)
            .where(
              and(
                eq(schema.productTraceabilityProfiles.tenantId, tenantId),
                eq(schema.productTraceabilityProfiles.productId, productId),
              ),
            )
            .returning();
    if (!stored) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
    const after = storedProfileResponse(stored, profileCode);
    const actions = ["traceability.product_profile.updated"];
    if (coverageChanged) actions.push("traceability.product_profile.coverage_changed");
    await tx.insert(schema.tenantAuditEvents).values(
      actions.map((action) => ({
        organizationId: tenantId,
        actorUserId,
        action,
        outcome: "success",
        targetType: "traceability_product_profile",
        targetId: productId,
        before,
        after,
        requestId,
      })),
    );
    return after;
  }

  private async currentProfile(
    tx: UsMasterDataTransaction,
    tenantId: string,
    productId: string,
    profileCode: string,
    lock: "share" | "update",
  ): Promise<ProductTraceabilityProfile> {
    return readCurrentUsProductProfile(
      tx,
      tenantId,
      productId,
      profileCode,
      lock,
      freshUsProductProfileReaders,
    );
  }
}
