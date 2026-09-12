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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stationDevices } from "./platform.js";

export type WorkingDeviceReplacementActorDomain = "cabinet" | "platform";
export type WorkingDeviceReplacementState = "prepared" | "cancelled";

export const workingDeviceReplacementPreviews = pgTable(
  "working_device_replacement_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    actorDomain: text("actor_domain").$type<WorkingDeviceReplacementActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    requestId: uuid("request_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    factsFingerprint: text("facts_fingerprint").notNull(),
    observation: jsonb("observation").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    resultPreparationId: uuid("result_preparation_id"),
    response: jsonb("response").$type<unknown>(),
  },
  (t) => [
    unique("working_device_replacement_previews_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_replacement_previews_tenant_device_id_uq").on(
      t.tenantId,
      t.deviceId,
      t.id,
    ),
    unique("working_device_replacement_previews_tenant_request_uq").on(t.tenantId, t.requestId),
    foreignKey({
      name: "working_device_replacement_previews_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    check(
      "working_device_replacement_previews_actor_check",
      sql`${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256`,
    ),
    check(
      "working_device_replacement_previews_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and jsonb_typeof(${t.observation}) = 'object' and ${t.payloadHash} ~ '^[0-9a-f]{64}$' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "working_device_replacement_previews_interval_check",
      sql`isfinite(${t.createdAt}) and isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`,
    ),
    check(
      "working_device_replacement_previews_result_check",
      sql`(${t.confirmedAt} is null and ${t.resultPreparationId} is null and ${t.response} is null) or (${t.confirmedAt} is not null and ${t.resultPreparationId} is not null and ${t.response} is not null and isfinite(${t.confirmedAt}) and ${t.confirmedAt} >= ${t.createdAt} and ${t.confirmedAt} < ${t.expiresAt})`,
    ),
  ],
);

export const workingDeviceReplacementPreparations = pgTable(
  "working_device_replacement_preparations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    previewId: uuid("preview_id").notNull(),
    revision: integer("revision").notNull().default(1),
    state: text("state").$type<WorkingDeviceReplacementState>().notNull().default("prepared"),
    actorDomain: text("actor_domain").$type<WorkingDeviceReplacementActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    observation: jsonb("observation").$type<Record<string, unknown>>().notNull(),
    factsFingerprint: text("facts_fingerprint").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledActorDomain:
      text("cancelled_actor_domain").$type<WorkingDeviceReplacementActorDomain>(),
    cancelledActorId: text("cancelled_actor_id"),
  },
  (t) => [
    unique("working_device_replacement_preparations_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_replacement_preparations_tenant_device_id_uq").on(
      t.tenantId,
      t.deviceId,
      t.id,
    ),
    unique("working_device_replacement_preparations_tenant_preview_uq").on(
      t.tenantId,
      t.deviceId,
      t.previewId,
    ),
    uniqueIndex("working_device_replacements_one_prepared_uq")
      .on(t.tenantId, t.deviceId)
      .where(sql`${t.state} = 'prepared'`),
    foreignKey({
      name: "working_device_replacement_preparations_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
    foreignKey({
      name: "working_device_replacement_preparations_tenant_device_preview_fk",
      columns: [t.tenantId, t.deviceId, t.previewId],
      foreignColumns: [
        workingDeviceReplacementPreviews.tenantId,
        workingDeviceReplacementPreviews.deviceId,
        workingDeviceReplacementPreviews.id,
      ],
    }),
    check(
      "working_device_replacement_preparations_identity_check",
      sql`${t.state} in ('prepared','cancelled') and ${t.revision} >= 1 and ${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256 and jsonb_typeof(${t.observation}) = 'object' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$' and isfinite(${t.preparedAt})`,
    ),
    check(
      "working_device_replacement_preparations_cancellation_check",
      sql`((${t.state} = 'prepared' and ${t.cancelledAt} is null and ${t.cancelledActorDomain} is null and ${t.cancelledActorId} is null) or (${t.state} = 'cancelled' and ${t.cancelledAt} is not null and isfinite(${t.cancelledAt}) and ${t.cancelledAt} >= ${t.preparedAt} and ${t.cancelledActorDomain} is not null and ${t.cancelledActorDomain} in ('cabinet','platform') and ${t.cancelledActorId} is not null and length(btrim(${t.cancelledActorId})) between 1 and 256)) is true`,
    ),
  ],
);
