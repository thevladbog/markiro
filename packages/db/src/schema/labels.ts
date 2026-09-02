import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

/**
 * Tenant-scoped label templates. `spec` is a `LabelTemplateSpec` (see
 * @markiro/domain's `parseLabelTemplate`) stored as-is in jsonb -- the API
 * layer validates it against the domain model before every write, so this
 * table trusts its own contents but never re-derives them.
 *
 * `enabled` and `chz_product_group_codes` are selection metadata, not part of
 * the print model: they decide which pickers offer the template, never how it
 * prints. A shift or inventory keeps its snapshot even if the template is
 * later disabled or scoped away.
 */
export const labelTemplates = pgTable(
  "label_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    spec: jsonb("spec").notNull(),
    /**
     * Admin-controlled visibility. A disabled template is hidden from every
     * template picker in the admin and on the station. It can never be a
     * default: the API refuses to disable a template that the organisation
     * or a category default points at.
     */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Chestny ZNAK product-group codes this template applies to. NULL means
     * every category; a non-empty array restricts the template to products
     * carrying one of these codes. Codes are validated against
     * `chz_product_groups` by the API on every write (arrays cannot carry an
     * FK); the CHECK below forbids the ambiguous empty array.
     */
    chzProductGroupCodes: integer("chz_product_group_codes").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // (tenant_id, id) UNIQUE lets other tenants' tables (products, shifts --
  // see Task 7) target a same-tenant row via a composite FK.
  (t) => [
    unique("label_templates_tenant_id_uq").on(t.tenantId, t.id),
    check(
      "label_templates_product_group_codes_nonempty",
      sql`${t.chzProductGroupCodes} IS NULL OR cardinality(${t.chzProductGroupCodes}) > 0`,
    ),
  ],
);
