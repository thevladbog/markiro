import { ServiceUnavailableException } from "@nestjs/common";
import type { schema } from "@markiro/db";
import { validateCoverageReview } from "@markiro/domain";
import {
  productTraceabilityProfileSchema,
  type ProductTraceabilityProfile,
  type UpsertProductTraceabilityProfile,
} from "@markiro/platform-contracts";

export function editableProfile(
  value: UpsertProductTraceabilityProfile,
): UpsertProductTraceabilityProfile {
  return {
    productName: value.productName,
    brandName: value.brandName,
    commodity: value.commodity,
    variety: value.variety,
    packagingSizeValue: value.packagingSizeValue,
    packagingSizeUom: value.packagingSizeUom,
    packagingStyle: value.packagingStyle,
    defaultQuantityUom: value.defaultQuantityUom,
    ...coverageFields(value),
  };
}

export function coverageFields(value: UpsertProductTraceabilityProfile) {
  return {
    coverageStatus: value.coverageStatus,
    coverageRationale: value.coverageRationale,
    ftlCategory: value.ftlCategory,
    ftlSourceUrl: value.ftlSourceUrl,
    ftlSourceVersion: value.ftlSourceVersion,
  };
}

/** Input was already validated as positive numeric(12,3); pad without floating-point conversion. */
export function canonicalPackageSize(value: string | null): string | null {
  if (value === null) return null;
  const [integer, fractional = ""] = value.split(".");
  return `${integer}.${fractional.padEnd(3, "0")}`;
}

export function profileDefaults(product: { id: string; name: string }): ProductTraceabilityProfile {
  return validateProfileResponse(
    {
      productId: product.id,
      productName: product.name,
      revision: 0,
      brandName: null,
      commodity: null,
      variety: null,
      packagingSizeValue: null,
      packagingSizeUom: null,
      packagingStyle: null,
      defaultQuantityUom: null,
      coverageStatus: "unknown",
      coverageRationale: null,
      ftlCategory: null,
      ftlSourceUrl: null,
      ftlSourceVersion: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: null,
      updatedAt: null,
    },
    "US_FSMA204_PROCESSOR",
  );
}

export function storedProfileResponse(
  row: typeof schema.productTraceabilityProfiles.$inferSelect,
  profileCode: string,
): ProductTraceabilityProfile {
  // Parse raw DB fields at the boundary; never cast a stored UOM string into the vocabulary.
  return validateProfileResponse(
    {
      productId: row.productId,
      revision: row.revision,
      productName: row.productName,
      brandName: row.brandName,
      commodity: row.commodity,
      variety: row.variety,
      packagingSizeValue: row.packagingSizeValue,
      packagingSizeUom: row.packagingSizeUom,
      packagingStyle: row.packagingStyle,
      defaultQuantityUom: row.defaultQuantityUom,
      coverageStatus: row.coverageStatus,
      coverageRationale: row.coverageRationale,
      ftlCategory: row.ftlCategory,
      ftlSourceUrl: row.ftlSourceUrl,
      ftlSourceVersion: row.ftlSourceVersion,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    profileCode,
  );
}

function validateProfileResponse(value: unknown, profileCode: string): ProductTraceabilityProfile {
  const parsed = productTraceabilityProfileSchema.safeParse(value);
  if (
    !parsed.success ||
    validateCoverageReview(parsed.data, profileCode).length > 0 ||
    // A generic tenant has no FTL assessment, including historical review stamps.
    (profileCode === "US_GENERIC_LOT_TRACEABILITY" &&
      (parsed.data.reviewedBy !== null || parsed.data.reviewedAt !== null))
  )
    throw new ServiceUnavailableException({ code: "us_database_unavailable" });
  return parsed.data;
}
