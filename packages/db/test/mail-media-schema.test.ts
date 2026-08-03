import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("mail and media schema", () => {
  it("requires every delivery to have exactly one tenant or user scope", () => {
    expect(getTableName(schema.emailDeliveries)).toBe("email_deliveries");
    expect(Object.keys(schema.emailDeliveries)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "userId",
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
});
