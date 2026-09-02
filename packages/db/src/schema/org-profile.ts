import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { labelTemplates } from "./labels.js";
import { organizationLogoAssets } from "./media.js";
import { chzProductGroups } from "./platform.js";

/**
 * Single-tenant-row table: one org profile per organization, keyed directly
 * on tenant_id. The logo reference includes that tenant key so a profile can
 * never point at another organization's object metadata.
 */
export const orgProfiles = pgTable(
  "org_profiles",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => organization.id),
    gln: text("gln"),
    gs1Prefixes: text("gs1_prefixes").array().notNull().default([]),
    inn: text("inn"),
    timeZone: text("time_zone").notNull().default("Europe/Moscow"),
    logoAssetId: uuid("logo_asset_id"),
    defaultBoxLabelTemplateId: uuid("default_box_label_template_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "org_profiles_logo_tenant_fk",
      columns: [table.tenantId, table.logoAssetId],
      foreignColumns: [organizationLogoAssets.tenantId, organizationLogoAssets.id],
    }),
    foreignKey({
      name: "org_profiles_box_label_template_tenant_fk",
      columns: [table.tenantId, table.defaultBoxLabelTemplateId],
      foreignColumns: [labelTemplates.tenantId, labelTemplates.id],
    }),
  ],
);

/**
 * Per-category box-label defaults: one row per (tenant, ЧЗ product group).
 * Resolution at shift creation is category default → organisation default
 * (`org_profiles.default_box_label_template_id`) → none. The composite FK
 * keeps a default inside its own tenant; its constraint name is part of the
 * label-templates delete-conflict set (label-templates.service.ts).
 */
export const orgBoxLabelTemplateDefaults = pgTable(
  "org_box_label_template_defaults",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    chzProductGroupCode: integer("chz_product_group_code")
      .notNull()
      .references(() => chzProductGroups.code),
    templateId: uuid("template_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.chzProductGroupCode] }),
    foreignKey({
      name: "org_box_label_template_defaults_template_tenant_fk",
      columns: [table.tenantId, table.templateId],
      foreignColumns: [labelTemplates.tenantId, labelTemplates.id],
    }),
  ],
);

export type OrgBoxLabelTemplateDefaultRow = typeof orgBoxLabelTemplateDefaults.$inferSelect;
