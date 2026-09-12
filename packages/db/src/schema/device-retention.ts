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
import { organization } from "./auth.js";
import { stationDevices } from "./platform.js";

export type WorkingDeviceRetentionActorDomain = "cabinet" | "platform";
export const workingDeviceRetentionPreviews = pgTable(
  "working_device_retention_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    actorDomain: text("actor_domain").$type<WorkingDeviceRetentionActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    requestId: uuid("request_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    factsFingerprint: text("facts_fingerprint").notNull(),
    observation: jsonb("observation").$type<Record<string, unknown>>().notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    selectedDeviceIds: jsonb("selected_device_ids").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    resultSelectionId: uuid("result_selection_id"),
    response: jsonb("response").$type<unknown>(),
  },
  (t) => [
    unique("working_device_retention_previews_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_retention_previews_tenant_request_uq").on(t.tenantId, t.requestId),
    check(
      "working_device_retention_previews_actor_check",
      sql`${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256`,
    ),
    check(
      "working_device_retention_previews_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and jsonb_typeof(${t.observation}) = 'object' and ${t.payloadHash} ~ '^[0-9a-f]{64}$' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$' and ${t.expectedRevision} >= 0 and jsonb_typeof(${t.selectedDeviceIds}) = 'array'`,
    ),
    check(
      "working_device_retention_previews_interval_check",
      sql`isfinite(${t.createdAt}) and isfinite(${t.expiresAt}) and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`,
    ),
    check(
      "working_device_retention_previews_result_check",
      sql`((${t.confirmedAt} is null and ${t.resultSelectionId} is null and ${t.response} is null) or (${t.confirmedAt} is not null and ${t.resultSelectionId} is not null and ${t.response} is not null and isfinite(${t.confirmedAt}) and ${t.confirmedAt} >= ${t.createdAt} and ${t.confirmedAt} < ${t.expiresAt} and jsonb_typeof(${t.response}) = 'object' and ${t.response}->>'requestId' = ${t.requestId}::text and ${t.response}#>>'{selection,id}' = ${t.resultSelectionId}::text and jsonb_typeof(${t.response}#>'{selection,revision}') = 'number' and ${t.response}#>>'{selection,revision}' ~ '^[1-9][0-9]*$')) is true`,
    ),
  ],
);
export const workingDeviceRetentionSelections = pgTable(
  "working_device_retention_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    previewId: uuid("preview_id").notNull(),
    revision: integer("revision").notNull().default(1),
    actorDomain: text("actor_domain").$type<WorkingDeviceRetentionActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    observation: jsonb("observation").$type<Record<string, unknown>>().notNull(),
    factsFingerprint: text("facts_fingerprint").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("working_device_retention_selections_tenant_id_uq").on(t.tenantId, t.id),
    unique("working_device_retention_selections_tenant_boundary_uq").on(t.tenantId, t.effectiveAt),
    foreignKey({
      name: "working_device_retention_selections_tenant_preview_fk",
      columns: [t.tenantId, t.previewId],
      foreignColumns: [workingDeviceRetentionPreviews.tenantId, workingDeviceRetentionPreviews.id],
    }),
    check(
      "working_device_retention_selections_identity_check",
      sql`${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256 and ${t.revision} >= 1 and jsonb_typeof(${t.observation}) = 'object' and ${t.factsFingerprint} ~ '^[0-9a-f]{64}$' and isfinite(${t.preparedAt}) and isfinite(${t.effectiveAt}) and ${t.preparedAt} < ${t.effectiveAt}`,
    ),
  ],
);
export const workingDeviceRetentionMembers = pgTable(
  "working_device_retention_members",
  {
    tenantId: text("tenant_id").notNull(),
    selectionId: uuid("selection_id").notNull(),
    deviceId: uuid("device_id").notNull(),
  },
  (t) => [
    unique("working_device_retention_members_selection_device_uq").on(t.selectionId, t.deviceId),
    foreignKey({
      name: "working_device_retention_members_tenant_selection_fk",
      columns: [t.tenantId, t.selectionId],
      foreignColumns: [
        workingDeviceRetentionSelections.tenantId,
        workingDeviceRetentionSelections.id,
      ],
    }),
    foreignKey({
      name: "working_device_retention_members_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
  ],
);
export const workingDeviceRetentionEvents = pgTable(
  "working_device_retention_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    selectionId: uuid("selection_id").notNull(),
    requestId: uuid("request_id").notNull(),
    actorDomain: text("actor_domain").$type<WorkingDeviceRetentionActorDomain>().notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").$type<"selection_confirmed">().notNull(),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("working_device_retention_events_tenant_request_uq").on(t.tenantId, t.requestId),
    foreignKey({
      name: "working_device_retention_events_tenant_selection_fk",
      columns: [t.tenantId, t.selectionId],
      foreignColumns: [
        workingDeviceRetentionSelections.tenantId,
        workingDeviceRetentionSelections.id,
      ],
    }),
    check(
      "working_device_retention_events_actor_check",
      sql`${t.actorDomain} in ('cabinet','platform') and length(btrim(${t.actorId})) between 1 and 256 and ${t.action} = 'selection_confirmed' and isfinite(${t.createdAt})`,
    ),
    check(
      "working_device_retention_events_result_check",
      sql`(jsonb_typeof(${t.after}) = 'object' and (${t.before} is null or jsonb_typeof(${t.before}) = 'object') and ${t.after}->>'id' = ${t.selectionId}::text and jsonb_typeof(${t.after}->'revision') = 'number' and ${t.after}->>'revision' ~ '^[1-9][0-9]*$' and jsonb_typeof(${t.result}) = 'object' and ${t.result}->>'requestId' = ${t.requestId}::text and ${t.result}->'selection' = ${t.after} and ((${t.before} is null and ${t.after}->>'revision' = '1') or (jsonb_typeof(${t.before}) = 'object' and ${t.before}->>'id' = ${t.selectionId}::text and jsonb_typeof(${t.before}->'revision') = 'number' and ${t.before}->>'revision' ~ '^[1-9][0-9]*$' and (${t.after}->>'revision')::numeric = (${t.before}->>'revision')::numeric + 1))) is true`,
    ),
  ],
);
