import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { platformUsers } from "./platform-auth.js";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const emailDeliveryStatus = pgEnum("email_delivery_status", [
  "queued",
  "sending",
  "retrying",
  "sent",
  "failed",
  "canceled",
]);

/** One logical email and its retry/lease state. Sensitive template data is encrypted. */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    platformUserId: text("platform_user_id").references(() => platformUsers.id),
    publicRequestId: uuid("public_request_id"),
    recipient: text("recipient").notNull(),
    kind: text("kind").notNull(),
    sourceId: text("source_id"),
    encryptedPayload: bytea("encrypted_payload"),
    payloadNonce: bytea("payload_nonce"),
    payloadTag: bytea("payload_tag"),
    status: emailDeliveryStatus("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    attemptId: uuid("attempt_id"),
    attemptDeadline: timestamp("attempt_deadline", { withTimezone: true }),
    errorCategory: text("error_category"),
    errorCode: text("error_code"),
    errorText: text("error_text"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "email_deliveries_scope_xor",
      sql`num_nonnulls(${table.tenantId}, ${table.userId}, ${table.platformUserId}, ${table.publicRequestId}) = 1`,
    ),
    index("email_deliveries_tenant_status_idx").on(table.tenantId, table.status),
    index("email_deliveries_user_status_idx").on(table.userId, table.status),
    index("email_deliveries_platform_user_status_idx").on(table.platformUserId, table.status),
    index("email_deliveries_public_request_status_idx").on(table.publicRequestId, table.status),
    uniqueIndex("email_deliveries_public_request_kind_uq")
      .on(table.publicRequestId, table.kind)
      .where(sql`${table.publicRequestId} is not null`),
  ],
);

/** Transactional outbox row published to the job queue after the DB commit. */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => emailDeliveries.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [unique("email_outbox_delivery_uq").on(table.deliveryId)],
);
