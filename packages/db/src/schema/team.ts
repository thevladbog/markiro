import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { invitation, member, organization, user } from "./auth.js";
import { employees } from "./pickup.js";

/** Tenant-specific, informational membership fields. `position` is not an access role. */
export const tenantMemberProfiles = pgTable(
  "tenant_member_profiles",
  {
    memberId: text("member_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    position: text("position"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "tenant_member_profiles_organization_member_fk",
      columns: [table.organizationId, table.memberId],
      foreignColumns: [member.organizationId, member.id],
    }).onDelete("cascade"),
  ],
);

/** Tenant-specific fields retained while an invitation has not been accepted. */
export const tenantInvitationProfiles = pgTable(
  "tenant_invitation_profiles",
  {
    invitationId: text("invitation_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    position: text("position"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "tenant_invitation_profiles_organization_invitation_fk",
      columns: [table.organizationId, table.invitationId],
      foreignColumns: [invitation.organizationId, invitation.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Connects a cabinet identity to the same factory employee used by badges and
 * station credentials. The target starts as an invitation and moves to a member.
 */
export const cabinetEmployeeLinks = pgTable(
  "cabinet_employee_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    invitationId: text("invitation_id"),
    memberId: text("member_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "cabinet_employee_links_target_xor",
      sql`(${table.invitationId} is null) <> (${table.memberId} is null)`,
    ),
    unique("cabinet_employee_links_tenant_employee_uq").on(table.organizationId, table.employeeId),
    uniqueIndex("cabinet_employee_links_tenant_member_uq")
      .on(table.organizationId, table.memberId)
      .where(sql`${table.memberId} is not null`),
    uniqueIndex("cabinet_employee_links_tenant_invitation_uq")
      .on(table.organizationId, table.invitationId)
      .where(sql`${table.invitationId} is not null`),
    foreignKey({
      name: "cabinet_employee_links_tenant_employee_fk",
      columns: [table.organizationId, table.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "cabinet_employee_links_tenant_member_fk",
      columns: [table.organizationId, table.memberId],
      foreignColumns: [member.organizationId, member.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "cabinet_employee_links_tenant_invitation_fk",
      columns: [table.organizationId, table.invitationId],
      foreignColumns: [invitation.organizationId, invitation.id],
    }).onDelete("cascade"),
  ],
);

/** Append-only security and lifecycle log. Mail body and recipient are deliberately absent. */
export const tenantAuditEvents = pgTable(
  "tenant_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tenant_audit_events_tenant_created_idx").on(table.organizationId, table.createdAt),
  ],
);
