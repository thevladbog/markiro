import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { boxes } from "./platform.js";
import { traceabilityLots } from "./traceability-lots.js";

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

export const traceLotBoxes = pgTable(
  "trace_lot_boxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    boxId: uuid("box_id").notNull(),
    lotId: uuid("lot_id").notNull(),
    ssccAtLink: text("sscc_at_link").notNull(),
    linkSource: text("link_source").notNull(),
    linkedBy: text("linked_by").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
    unlinkedBy: text("unlinked_by"),
    unlinkReason: text("unlink_reason"),
  },
  (t) => [
    foreignKey({
      name: "trace_lot_boxes_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
    foreignKey({
      name: "trace_lot_boxes_lot_fk",
      columns: [t.tenantId, t.lotId],
      foreignColumns: [traceabilityLots.tenantId, traceabilityLots.id],
    }),
    uniqueIndex("trace_lot_boxes_one_active_box_uq")
      .on(t.tenantId, t.boxId)
      .where(sql`${t.unlinkedAt} IS NULL`),
    index("trace_lot_boxes_lot_active_idx")
      .on(t.tenantId, t.lotId, t.linkedAt, t.id)
      .where(sql`${t.unlinkedAt} IS NULL`),
    check("trace_lot_boxes_sscc_shape", sql`${t.ssccAtLink} ~ '^[0-9]{18}$'`),
    check("trace_lot_boxes_link_source_valid", sql`${t.linkSource} IN ('manual','demo_seed')`),
    check(
      "trace_lot_boxes_unlink_all_or_none",
      sql`(${t.unlinkedAt} IS NULL AND ${t.unlinkedBy} IS NULL AND ${t.unlinkReason} IS NULL) OR (${t.unlinkedAt} IS NOT NULL AND ${t.unlinkedBy} IS NOT NULL AND ${t.unlinkReason} IS NOT NULL AND length(btrim(${t.unlinkReason})) BETWEEN 3 AND 2000)`,
    ),
  ],
);

export const traceabilitySyntheticCaseOrigins = pgTable(
  "traceability_synthetic_case_origins",
  {
    tenantId: tenantId(),
    boxId: uuid("box_id").notNull(),
    seedId: text("seed_id").notNull(),
    seedVersion: integer("seed_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.boxId] }),
    foreignKey({
      name: "synthetic_case_origins_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
    check(
      "synthetic_case_origins_seed_valid",
      sql`length(btrim(${t.seedId})) > 0 AND ${t.seedVersion} > 0`,
    ),
  ],
);

export const traceLotBoxOperations = pgTable(
  "trace_lot_box_operations",
  {
    tenantId: tenantId(),
    command: text("command").notNull(),
    operationKey: uuid("operation_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    targetId: uuid("target_id").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.command, t.operationKey] }),
    check(
      "trace_lot_box_operations_command_valid",
      sql`${t.command} IN ('case.link','case.unlink')`,
    ),
    check("trace_lot_box_operations_digest_valid", sql`${t.inputDigest} ~ '^[a-f0-9]{64}$'`),
  ],
);
