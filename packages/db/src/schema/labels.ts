import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
 */
export const labelTemplates = pgTable(
  "label_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    spec: jsonb("spec").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // (tenant_id, id) UNIQUE lets other tenants' tables (products, shifts --
  // see Task 7) target a same-tenant row via a composite FK.
  (t) => [unique("label_templates_tenant_id_uq").on(t.tenantId, t.id)],
);
