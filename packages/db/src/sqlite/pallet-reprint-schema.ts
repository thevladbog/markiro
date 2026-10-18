import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  check,
} from "drizzle-orm/sqlite-core";
export const warehousePalletSettings = sqliteTable(
  "warehouse_pallet_settings",
  {
    owner: text("owner").primaryKey(),
    reason: text("reason").notNull(),
    sessionId: text("session_id"),
    sessionStatus: text("session_status").notNull().default("finished"),
    sentCount: integer("sent_count").notNull().default(0),
    templateChoicesJson: text("template_choices_json").notNull().default("{}"),
  },
  (t) => [
    check("warehouse_pallet_reason_check", sql`${t.reason} IN ('not_printed','damaged','lost')`),
  ],
);
export const warehousePalletClosures = sqliteTable(
  "warehouse_pallet_closures",
  {
    sscc: text("sscc").primaryKey(),
    palletId: text("pallet_id").notNull(),
    shiftId: text("shift_id").notNull(),
    terminalId: text("terminal_id"),
    closedAt: text("closed_at").notNull(),
    contextJson: text("context_json").notNull(),
  },
  (t) => [check("warehouse_pallet_closure_json_check", sql`json_valid(${t.contextJson})`)],
);
export const warehousePalletSources = sqliteTable(
  "warehouse_pallet_sources",
  {
    owner: text("owner").notNull(),
    sscc: text("sscc").notNull(),
    revision: text("revision").notNull(),
    valueJson: text("value_json").notNull(),
    productionDeliveryJson: text("production_delivery_json"),
    productionDeliveryAckedSequence: integer("production_delivery_acked_sequence")
      .notNull()
      .default(0),
    receiveStatus: text("receive_status").notNull().default("pending"),
    lastTriedAt: text("last_tried_at").notNull().default(""),
    lookupKeysJson: text("lookup_keys_json").notNull().default("[]"),
    eligibilityDenied: integer("eligibility_denied").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.sscc] }),
    check("warehouse_pallet_source_json_check", sql`json_valid(${t.valueJson})`),
    check(
      "warehouse_pallet_source_status_check",
      sql`${t.receiveStatus} IN ('pending','accepted','conflict')`,
    ),
    check("warehouse_pallet_source_denied_check", sql`${t.eligibilityDenied} IN (0,1)`),
  ],
);
export const warehousePalletJobs = sqliteTable(
  "warehouse_pallet_jobs",
  {
    owner: text("owner").notNull(),
    jobId: text("job_id").notNull(),
    sscc: text("sscc").notNull(),
    sourceRevision: text("source_revision").notNull(),
    sourceJson: text("source_json").notNull(),
    profileJson: text("profile_json").notNull(),
    bytesBase64: text("bytes_base64").notNull(),
    bytesDigest: text("bytes_digest").notNull(),
    renderSnapshotJson: text("render_snapshot_json"),
    claimId: text("claim_id"),
    renderingJson: text("rendering_json"),
    renderingRevision: text("rendering_revision"),
    protocol: text("protocol"),
    sessionId: text("session_id"),
    state: text("state").notNull(),
    eventJson: text("event_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.jobId] }),
    uniqueIndex("warehouse_pallet_one_unresolved")
      .on(t.owner)
      .where(sql`${t.state} IN ('prepared','sending','failed_before_send','delivery_unknown')`),
    check(
      "warehouse_pallet_job_json_check",
      sql`json_valid(${t.sourceJson}) AND json_valid(${t.profileJson}) AND json_valid(${t.eventJson})`,
    ),
    check(
      "warehouse_pallet_job_state_check",
      sql`${t.state} IN ('prepared','sending','sent','failed_before_send','delivery_unknown','verified','skipped')`,
    ),
  ],
);
export const warehousePalletEvents = sqliteTable(
  "warehouse_pallet_events",
  {
    owner: text("owner").notNull(),
    eventId: text("event_id").notNull(),
    valueJson: text("value_json").notNull(),
    receiveStatus: text("receive_status").notNull().default("pending"),
    lastTriedAt: text("last_tried_at").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.eventId] }),
    check("warehouse_pallet_event_json_check", sql`json_valid(${t.valueJson})`),
    check(
      "warehouse_pallet_event_status_check",
      sql`${t.receiveStatus} IN ('pending','accepted','conflict')`,
    ),
  ],
);

export const warehousePalletRenderings = sqliteTable(
  "warehouse_pallet_renderings",
  {
    owner: text("owner").notNull(),
    jobId: text("job_id").notNull(),
    revision: text("revision").notNull(),
    valueJson: text("value_json").notNull(),
    receiveStatus: text("receive_status").notNull().default("pending"),
    lastTriedAt: text("last_tried_at").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.owner, t.jobId] })],
);
export const warehousePalletProductionResolutions = sqliteTable(
  "warehouse_pallet_production_resolutions",
  {
    owner: text("owner").notNull(),
    eventId: text("event_id").notNull(),
    sscc: text("sscc").notNull(),
    sourceRevision: text("source_revision").notNull(),
    attemptId: text("attempt_id").notNull(),
    valueJson: text("value_json").notNull(),
    digest: text("digest").notNull(),
    receiveStatus: text("receive_status").notNull().default("pending"),
    lastTriedAt: text("last_tried_at").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.eventId] }),
    uniqueIndex("warehouse_pallet_resolution_attempt_idx").on(
      t.owner,
      t.sscc,
      t.sourceRevision,
      t.attemptId,
    ),
  ],
);
export const warehousePalletSessionSends = sqliteTable(
  "warehouse_pallet_session_sends",
  {
    owner: text("owner").notNull(),
    sessionId: text("session_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    jobId: text("job_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.sessionId, t.attemptId] })],
);
