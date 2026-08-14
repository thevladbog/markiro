import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("mail and media schema", () => {
  it("requires every delivery to have exactly one tenant, customer user, or platform user scope", () => {
    expect(getTableName(schema.emailDeliveries)).toBe("email_deliveries");
    expect(Object.keys(schema.emailDeliveries)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "userId",
        "platformUserId",
        "recipient",
        "kind",
        "status",
        "encryptedPayload",
        "payloadNonce",
        "payloadTag",
        "attemptId",
        "attemptDeadline",
      ]),
    );
    expect(
      getTableConfig(schema.emailDeliveries).checks.map((constraint) => constraint.name),
    ).toContain("email_deliveries_scope_xor");
    const platformUserForeignKey = getTableConfig(schema.emailDeliveries).foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() === "email_deliveries_platform_user_id_platform_users_id_fk",
    );
    expect(getTableName(platformUserForeignKey!.reference().foreignTable)).toBe("platform_users");
  });

  it("gives every logical delivery one durable outbox row", () => {
    expect(getTableName(schema.emailOutbox)).toBe("email_outbox");
    expect(
      getTableConfig(schema.emailOutbox).uniqueConstraints.map((item) => item.getName()),
    ).toContain("email_outbox_delivery_uq");
  });

  it("tracks media cleanup durably before and after profile activation", () => {
    expect(getTableName(schema.mediaAssets)).toBe("media_assets");
    expect(Object.keys(schema.mediaAssets)).toEqual(
      expect.arrayContaining([
        "ownerUserId",
        "ownerTenantId",
        "objectKey",
        "status",
        "checksum",
        "width",
        "height",
        "byteSize",
      ]),
    );
    expect(Object.keys(schema.userProfiles)).toContain("avatarAssetId");
    expect(Object.keys(schema.userProfiles)).toContain("avatarAssetOwnerUserId");
    expect(
      getTableConfig(schema.mediaAssets).uniqueConstraints.map((item) => item.getName()),
    ).toEqual(
      expect.arrayContaining([
        "media_assets_object_key_uq",
        "media_assets_owner_id_uq",
        "media_assets_owner_tenant_id_uq",
      ]),
    );
    expect(getTableConfig(schema.mediaAssets).checks.map((one) => one.name)).toContain(
      "media_assets_owner_xor",
    );
    expect(
      getTableConfig(schema.userProfiles).foreignKeys.map((foreignKey) => foreignKey.getName()),
    ).toContain("user_profiles_avatar_owner_fk");
    expect(
      getTableConfig(schema.userProfiles).checks.map((constraint) => constraint.name),
    ).toContain("user_profiles_avatar_owner_matches_user");
  });

  it("assigns each product one tenant-owned media asset", () => {
    expect(getTableName(schema.productImages)).toBe("product_images");
    const productImagesConfig = getTableConfig(schema.productImages);
    expect(
      productImagesConfig.primaryKeys.map((one) => one.columns.map((column) => column.name)),
    ).toContainEqual(["tenant_id", "product_id"]);
    expect(
      productImagesConfig.uniqueConstraints
        .find((one) => one.getName() === "product_images_asset_id_uq")
        ?.columns.map((column) => column.name),
    ).toEqual(["asset_id"]);
    expect(productImagesConfig.foreignKeys.map((one) => one.getName())).toEqual(
      expect.arrayContaining([
        "product_images_tenant_product_fk",
        "product_images_tenant_asset_fk",
      ]),
    );

    const productForeignKey = getTableConfig(schema.productImages).foreignKeys.find(
      (one) => one.getName() === "product_images_tenant_product_fk",
    )!;
    const productReference = productForeignKey.reference();
    expect(productReference.columns.map((one) => one.name)).toEqual(["tenant_id", "product_id"]);
    expect(productReference.foreignColumns.map((one) => one.name)).toEqual(["tenant_id", "id"]);

    const assetForeignKey = getTableConfig(schema.productImages).foreignKeys.find(
      (one) => one.getName() === "product_images_tenant_asset_fk",
    )!;
    const assetReference = assetForeignKey.reference();
    expect(assetReference.columns.map((one) => one.name)).toEqual(["tenant_id", "asset_id"]);
    expect(assetReference.foreignColumns.map((one) => one.name)).toEqual(["owner_tenant_id", "id"]);
  });
});
