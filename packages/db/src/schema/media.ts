import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";

export const mediaAssetStatus = pgEnum("media_asset_status", ["staging", "active", "deleting"]);

/**
 * Durable metadata for objects stored in an S3-compatible service. Keeping a
 * staging row before upload lets the cleanup job remove abandoned objects.
 */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "cascade" }),
    ownerTenantId: text("owner_tenant_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksum: text("checksum").notNull(),
    width: integer("width"),
    height: integer("height"),
    status: mediaAssetStatus("status").notNull().default("staging"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("media_assets_object_key_uq").on(table.objectKey),
    unique("media_assets_owner_id_uq").on(table.ownerUserId, table.id),
    unique("media_assets_owner_tenant_id_uq").on(table.ownerTenantId, table.id),
    check(
      "media_assets_owner_xor",
      sql`num_nonnulls(${table.ownerUserId}, ${table.ownerTenantId}) = 1`,
    ),
  ],
);

/** Durable, tenant-owned metadata for normalized company logo objects. */
export const organizationLogoAssets = pgTable(
  "organization_logo_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksum: text("checksum").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    status: mediaAssetStatus("status").notNull().default("staging"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("organization_logo_assets_object_key_uq").on(table.objectKey),
    unique("organization_logo_assets_tenant_id_uq").on(table.tenantId, table.id),
  ],
);

/** Global person data shared by all of a user's tenant memberships. */
export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    middleName: text("middle_name"),
    avatarAssetOwnerUserId: text("avatar_asset_owner_user_id"),
    avatarAssetId: uuid("avatar_asset_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "user_profiles_avatar_owner_matches_user",
      sql`(${table.avatarAssetId} is null and ${table.avatarAssetOwnerUserId} is null) or (${table.avatarAssetId} is not null and ${table.avatarAssetOwnerUserId} = ${table.userId})`,
    ),
    foreignKey({
      name: "user_profiles_avatar_owner_fk",
      columns: [table.avatarAssetOwnerUserId, table.avatarAssetId],
      foreignColumns: [mediaAssets.ownerUserId, mediaAssets.id],
    }).onDelete("set null"),
  ],
);
