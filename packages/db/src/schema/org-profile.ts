import { foreignKey, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { labelTemplates } from "./labels.js";
import { organizationLogoAssets } from "./media.js";

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
