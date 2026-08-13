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
    ).toEqual(expect.arrayContaining(["media_assets_object_key_uq", "media_assets_owner_id_uq"]));
    expect(
      getTableConfig(schema.userProfiles).foreignKeys.map((foreignKey) => foreignKey.getName()),
    ).toContain("user_profiles_avatar_owner_fk");
    expect(
      getTableConfig(schema.userProfiles).checks.map((constraint) => constraint.name),
    ).toContain("user_profiles_avatar_owner_matches_user");
  });

  it("keeps organization logos tenant-owned through the profile reference", () => {
    expect(getTableName(schema.organizationLogoAssets)).toBe("organization_logo_assets");
    expect(Object.keys(schema.organizationLogoAssets)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "objectKey",
        "contentType",
        "byteSize",
        "checksum",
        "width",
        "height",
        "status",
      ]),
    );
    expect(
      getTableConfig(schema.organizationLogoAssets).uniqueConstraints.map((item) => item.getName()),
    ).toEqual(
      expect.arrayContaining([
        "organization_logo_assets_object_key_uq",
        "organization_logo_assets_tenant_id_uq",
      ]),
    );
    expect(Object.keys(schema.orgProfiles)).toContain("logoAssetId");
    expect(
      getTableConfig(schema.orgProfiles).foreignKeys.map((foreignKey) => foreignKey.getName()),
    ).toContain("org_profiles_logo_tenant_fk");
  });
});
