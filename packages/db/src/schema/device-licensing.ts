import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { stationDevices } from "./platform.js";

export type WorkingDeviceAssignmentState = "reserved" | "assigned" | "released";
export type WorkingDeviceReleaseReason = "reservation_cancelled" | "security_revoked";

/** Immutable transition journal; actors and receipts are supplied by the owning transaction. */
export const workingDeviceEvents = pgTable(
  "working_device_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    actorDomain: text("actor_domain")
      .$type<"migration" | "system" | "cabinet" | "platform" | "device">()
      .notNull(),
    actorId: text("actor_id"),
    action: text("action")
      .$type<
        | "observed"
        | "reserved"
        | "assigned"
        | "released"
        | "reservation_cancelled"
        | "replacement_prepared"
        | "replacement_cancelled"
      >()
      .notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    outcome: text("outcome").$type<"success">().notNull().default("success"),
    requestId: uuid("request_id"),
    requestHash: text("request_hash"),
    response: jsonb("response").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("working_device_events_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_events_tenant_device_id_uq").on(t.tenantId, t.deviceId, t.id),
    unique("working_device_events_tenant_request_uq").on(t.tenantId, t.requestId),
    foreignKey({
      name: "working_device_events_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }).onDelete("cascade"),
    check(
      "working_device_events_actor_check",
      sql`${t.actorDomain} in ('migration','system','cabinet','platform','device') and (${t.actorDomain} <> 'migration' or ${t.actorId} is null) and (${t.actorDomain} not in ('cabinet','platform','device') or ${t.actorId} is not null)`,
    ),
    check(
      "working_device_events_action_check",
      sql`${t.action} in ('observed','reserved','assigned','released','reservation_cancelled','replacement_prepared','replacement_cancelled') and ${t.outcome} = 'success'`,
    ),
    check(
      "working_device_events_json_check",
      sql`(${t.before} is null or jsonb_typeof(${t.before})='object') and jsonb_typeof(${t.after})='object'`,
    ),
    check(
      "working_device_events_replacement_check",
      sql`${t.action} not in ('replacement_prepared','replacement_cancelled') or ((${t.actorDomain} in ('cabinet','platform') and ${t.actorId} is not null and ${t.requestId} is not null and ${t.requestHash} is not null and ${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.response} is not null and jsonb_typeof(${t.response}) = 'object' and ${t.response}->>'requestId' is not null and ${t.response}->>'requestId' = ${t.requestId}::text and ${t.after}->>'id' is not null and ${t.response}#>>'{preparation,id}' is not null and ${t.response}#>>'{preparation,id}' = ${t.after}->>'id' and ((${t.action} = 'replacement_prepared' and ${t.before} is null and ${t.after}->>'state' = 'prepared' and ${t.response}#>>'{preparation,state}' = 'prepared') or (${t.action} = 'replacement_cancelled' and ${t.before} is not null and ${t.before}->>'state' = 'prepared' and ${t.after}->>'state' = 'cancelled' and ${t.response}#>>'{preparation,state}' = 'cancelled'))) is true)`,
    ),
  ],
);

/** One current assignment per physical device. Security release can be reacquired; cancellation is terminal. */
export const workingDeviceAssignments = pgTable(
  "working_device_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    state: text("state").$type<WorkingDeviceAssignmentState>().notNull(),
    revision: integer("revision").notNull().default(1),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason").$type<WorkingDeviceReleaseReason>(),
    provenance: text("provenance").$type<"migration" | "runtime">().notNull(),
    lastEventId: uuid("last_event_id"),
  },
  (t) => [
    unique("working_device_assignments_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_assignments_tenant_device_uq").on(t.tenantId, t.deviceId),
    foreignKey({
      name: "working_device_assignments_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "working_device_assignments_last_event_fk",
      columns: [t.tenantId, t.deviceId, t.lastEventId],
      foreignColumns: [
        workingDeviceEvents.tenantId,
        workingDeviceEvents.deviceId,
        workingDeviceEvents.id,
      ],
    }),
    check(
      "working_device_assignments_state_check",
      sql`${t.state} in ('reserved','assigned','released') and ${t.revision} >= 1 and ${t.provenance} in ('migration','runtime')`,
    ),
    check(
      "working_device_assignments_release_check",
      sql`(${t.state} <> 'released' and ${t.releasedAt} is null and ${t.releaseReason} is null) or (${t.state} = 'released' and ${t.releasedAt} is not null and ${t.releaseReason} is not null and ${t.releaseReason} in ('reservation_cancelled','security_revoked'))`,
    ),
  ],
);
