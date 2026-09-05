import { isDeepStrictEqual } from "node:util";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
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
  profileDefaults,
  storedProfileResponse,
} from "./us-product-profile-support";

export class UsProductProfileStore {
  constructor(private readonly db: Db) {}

  async getProfile(
    tenantId: string,
    actorUserId: string,
    inputId: unknown,
  ): Promise<ProductTraceabilityProfile> {
    const productId = parseMasterDataInput(platformUuidSchema, inputId);
    return this.db.transaction(async (tx) => {
      const profileCode = await authorizeUsMasterData(
        tx,
        tenantId,
        actorUserId,
        US_CAPABILITY.READ,
      );
      return this.currentProfile(tx, tenantId, productId, profileCode, "share");
    });
  }

  async putProfile(
    tenantId: string,
    actorUserId: string,
    inputId: unknown,
    input: unknown,
    requestId: string,
  ): Promise<ProductTraceabilityProfile> {
    const productId = parseMasterDataInput(platformUuidSchema, inputId);
    const parsed = parseMasterDataInput(putProductTraceabilityProfileSchema, input);
    const next = {
      ...editableProfile(parsed),
      packagingSizeValue: canonicalPackageSize(parsed.packagingSizeValue),
    };
    return this.db.transaction(async (tx) => {
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
      if (unchanged && (parsed.expectedRevision === before.revision || immediateRetry))
        return before;
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
    });
  }

  private async currentProfile(
    tx: UsMasterDataTransaction,
    tenantId: string,
    productId: string,
    profileCode: string,
    lock: "share" | "update",
  ): Promise<ProductTraceabilityProfile> {
    const [product] = await tx
      .select({ id: schema.products.id, name: schema.products.name })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
      .limit(1)
      .for(lock);
    if (!product) throw new NotFoundException({ code: "product_not_found" });
    const [row] = await tx
      .select()
      .from(schema.productTraceabilityProfiles)
      .where(
        and(
          eq(schema.productTraceabilityProfiles.tenantId, tenantId),
          eq(schema.productTraceabilityProfiles.productId, productId),
        ),
      )
      .limit(1);
    return row ? storedProfileResponse(row, profileCode) : profileDefaults(product);
  }
}
