import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { traceabilityEvents } from "./traceability-receiving.js";

/** Permanent Shipping identity and revision pointers. */
export const shippingEventRoots = pgTable(
  "shipping_event_roots",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    eventNumber: text("event_number").notNull(),
    lifecycleVersion: integer("lifecycle_version").notNull().default(1),
    nextRevision: integer("next_revision").notNull().default(2),
    currentEventId: uuid("current_event_id"),
    pendingDraftId: uuid("pending_draft_id"),
  },
  (t) => [
    unique("shipping_roots_tenant_id_uq").on(t.tenantId, t.id),
    unique("shipping_roots_number_uq").on(t.tenantId, t.eventNumber),
    foreignKey({
      name: "shipping_roots_current_fk",
      columns: [t.tenantId, t.id, t.currentEventId],
      foreignColumns: [
        traceabilityEvents.tenantId,
        traceabilityEvents.rootEventId,
        traceabilityEvents.id,
      ],
    }),
    foreignKey({
      name: "shipping_roots_pending_fk",
      columns: [t.tenantId, t.id, t.pendingDraftId],
      foreignColumns: [
        traceabilityEvents.tenantId,
        traceabilityEvents.rootEventId,
        traceabilityEvents.id,
      ],
    }),
    check(
      "shipping_roots_revision_valid",
      sql`${t.lifecycleVersion} > 0 AND ${t.nextRevision} > 1 AND (${t.currentEventId} IS NULL OR ${t.currentEventId} IS DISTINCT FROM ${t.pendingDraftId})`,
    ),
    check("shipping_roots_number_valid", sql`${t.eventNumber} ~ '^SHP-[0-9]{2}-[0-9]{4,10}$'`),
  ],
);
