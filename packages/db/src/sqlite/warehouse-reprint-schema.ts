import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const warehouseReprintSessions = sqliteTable(
  "warehouse_reprint_sessions",
  {
    owner: text("owner").notNull(),
    sessionId: text("session_id").notNull(),
    operatorId: text("operator_id").notNull(),
    status: text("status").notNull(),
    sessionJson: text("session_json").notNull(),
    sentCount: integer("sent_count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.sessionId] }),
    check("warehouse_session_json", sql`json_valid(${t.sessionJson})`),
  ],
);
export const warehouseReprintJobs = sqliteTable(
  "warehouse_reprint_jobs",
  {
    owner: text("owner").notNull(),
    jobId: text("job_id").notNull(),
    sessionId: text("session_id").notNull(),
    identity: text("identity").notNull(),
    sourceKind: text("source_kind").notNull(),
    jobJson: text("job_json").notNull(),
    rasterJson: text("raster_json"),
    projectionJson: text("projection_json").notNull(),
    state: text("state").notNull(),
    latestSequence: integer("latest_sequence").notNull(),
    attemptId: text("attempt_id").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.jobId] }),
    check("warehouse_raster_json", sql`${t.rasterJson} IS NULL OR json_valid(${t.rasterJson})`),
    uniqueIndex("warehouse_session_identity").on(t.owner, t.sessionId, t.sourceKind, t.identity),
    index("warehouse_reprint_jobs_source_idx").on(t.owner, t.sourceKind, t.identity),
  ],
);
export const warehouseReprintAttempts = sqliteTable(
  "warehouse_reprint_attempts",
  {
    owner: text("owner").notNull(),
    jobId: text("job_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    state: text("state").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.jobId, t.attemptId] }),
    uniqueIndex("warehouse_attempt_no").on(t.owner, t.jobId, t.attemptNo),
  ],
);
export const warehouseReprintEvents = sqliteTable(
  "warehouse_reprint_events",
  {
    owner: text("owner").notNull(),
    eventId: text("event_id").notNull(),
    jobId: text("job_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventJson: text("event_json").notNull(),
    digest: text("digest").notNull(),
    receiveStatus: text("receive_status").notNull().default("pending"),
    rejectionCode: text("rejection_code"),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.eventId] }),
    uniqueIndex("warehouse_event_sequence").on(t.owner, t.jobId, t.sequence),
  ],
);
export const warehouseReprintCache = sqliteTable(
  "warehouse_reprint_cache",
  {
    owner: text("owner").notNull(),
    kind: text("kind").notNull(),
    identity: text("identity").notNull(),
    valueJson: text("value_json").notNull(),
    cachedAt: text("cached_at").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.owner, t.kind, t.identity] })],
);
export const warehouseReprintHistoryAcknowledgements = sqliteTable(
  "warehouse_reprint_history_acknowledgements",
  {
    owner: text("owner").notNull(),
    eventId: text("event_id").notNull(),
    digest: text("digest").notNull(),
    rejectionCode: text("rejection_code").notNull(),
    operatorId: text("operator_id").notNull(),
    acknowledgedAt: text("acknowledged_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.eventId] }),
    foreignKey({
      columns: [t.owner, t.eventId],
      foreignColumns: [warehouseReprintEvents.owner, warehouseReprintEvents.eventId],
    }).onDelete("cascade"),
  ],
);
export const warehouseReprintCommands = sqliteTable(
  "warehouse_reprint_commands",
  {
    owner: text("owner").notNull(),
    commandId: text("command_id").notNull(),
    jobId: text("job_id").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.commandId] })],
);

/** Original local print fields survive server eligibility changes and lookup-cache eviction. */
export const warehouseReprintLocalBoxes = sqliteTable(
  "warehouse_reprint_local_boxes",
  {
    owner: text("owner").notNull(),
    identity: text("identity").notNull(),
    valueJson: text("value_json").notNull(),
    eligibilityDenied: integer("eligibility_denied", { mode: "boolean" }).notNull().default(false),
    groupOverrideJson: text("group_override_json"),
    cachedAt: text("cached_at").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.identity] }),
    check("warehouse_local_box_json", sql`json_valid(${t.valueJson})`),
    check("warehouse_local_box_denied", sql`${t.eligibilityDenied} IN (0,1)`),
    index("warehouse_reprint_local_boxes_retention_idx").on(t.owner, t.cachedAt),
  ],
);
