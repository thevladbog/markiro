import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/** Historical actor identity, intentionally independent of the deletable apikey secret row. */
export const publicApiKeyIdentities = pgTable(
  "public_api_key_identities",
  {
    keyId: text("key_id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("public_api_key_identity_tenant_key_uq").on(t.tenantId, t.keyId)],
);

export const publicApiRequestReceipts = pgTable(
  "public_api_request_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    keyId: text("key_id").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    effectId: uuid("effect_id").notNull().defaultRandom(),
    state: text("state").$type<"pending" | "completed">().notNull().default("pending"),
    response: jsonb("response").$type<unknown>(),
    admission: jsonb("admission").$type<Record<string, unknown>>(),
    stagedObjectKey: text("staged_object_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("public_api_request_identity_uq").on(t.tenantId, t.keyId, t.operation, t.idempotencyKey),
    foreignKey({
      name: "public_api_request_tenant_key_fk",
      columns: [t.tenantId, t.keyId],
      foreignColumns: [publicApiKeyIdentities.tenantId, publicApiKeyIdentities.keyId],
    }),
    check("public_api_request_digest_check", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    check("public_api_request_key_check", sql`length(${t.idempotencyKey}) between 1 and 200`),
    check(
      "public_api_request_state_check",
      sql`(${t.state} = 'pending' and ${t.response} is null and ${t.completedAt} is null) or (${t.state} = 'completed' and ${t.response} is not null and ${t.completedAt} is not null and ${t.admission} is not null)`,
    ),
  ],
);
