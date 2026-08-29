import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { inventories, inventoryChzStatusEnum, inventoryImports } from "./inventory.js";

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const CHZ_SIGNER_AGENT_STATUSES = ["active", "revoked"] as const;
export type ChzSignerAgentStatus = (typeof CHZ_SIGNER_AGENT_STATUSES)[number];

export const CHZ_SIGNER_TASK_TYPES = ["true_api_auth"] as const;
export type ChzSignerTaskType = (typeof CHZ_SIGNER_TASK_TYPES)[number];

export const CHZ_SIGNER_TASK_STATUSES = [
  "pending",
  "claimed",
  "completed",
  "failed",
  "expired",
] as const;
export type ChzSignerTaskStatus = (typeof CHZ_SIGNER_TASK_STATUSES)[number];

/**
 * Агент-подписант КЭП на машине клиента. Секрет — 192-битный токен, здесь
 * хранится только его sha256 (модель киоска: kiosks.device_token_hash).
 */
export const chzSignerAgents = pgTable(
  "chz_signer_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    appVersion: text("app_version"),
    secretHash: text("secret_hash").notNull(),
    status: text("status").notNull().default("active"),
    certThumbprint: text("cert_thumbprint"),
    certSubject: text("cert_subject"),
    certInn: text("cert_inn"),
    certNotAfter: timestamp("cert_not_after", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("chz_signer_agents_tenant_id_uq").on(t.tenantId, t.id),
    uniqueIndex("chz_signer_agents_secret_uq").on(t.secretHash),
    index("chz_signer_agents_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Коды привязки — калька station_pairing_codes (platform.ts:581-608), но код
 * тенант-скоуповый: агент создаётся в момент redeem, а не заранее. Частичные
 * unique-индексы держат инварианты «один живой код на тенанта» и «один живой
 * код на hash» на стороне БД (retire-then-insert — два стейтмента).
 */
export const chzSignerPairingCodes = pgTable(
  "chz_signer_pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    issuedByUserId: text("issued_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chz_signer_pairing_codes_hash_idx").on(t.codeHash),
    uniqueIndex("chz_signer_pairing_codes_one_live_uq")
      .on(t.tenantId)
      .where(sql`used_at is null`),
    uniqueIndex("chz_signer_pairing_codes_code_hash_live_uq")
      .on(t.codeHash)
      .where(sql`used_at is null`),
  ],
);

export const chzSignerTasks = pgTable(
  "chz_signer_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: uuid("agent_id"),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    resultSummary: jsonb("result_summary").$type<Record<string, unknown>>(),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "chz_signer_tasks_tenant_agent_fk",
      columns: [t.tenantId, t.agentId],
      foreignColumns: [chzSignerAgents.tenantId, chzSignerAgents.id],
    }),
    index("chz_signer_tasks_tenant_status_idx").on(t.tenantId, t.status),
    index("chz_signer_tasks_status_created_idx").on(t.status, t.createdAt),
    // Инвариант: не более одной открытой задачи на тенант+тип. Claim держит
    // строку в предикате (status остаётся 'claimed'), терминальные статусы
    // (completed/failed/expired) его покидают — DB-бэкстоп на случай гонки
    // между перекрывающимися прогонами scheduler.run() (два реплика API,
    // старт процесса против тика cron).
    uniqueIndex("chz_signer_tasks_open_uq")
      .on(t.tenantId, t.type)
      .where(sql`status in ('pending', 'claimed')`),
  ],
);

/**
 * Один действующий токен True API на тенанта. Значение шифруется AES-256-GCM
 * на уровне приложения (три bytea-колонки — паттерн mail.ts:45-47); expires_at
 * хранится открыто, чтобы cron и админка читали срок без расшифровки.
 */
export const chzApiTokens = pgTable(
  "chz_api_tokens",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => organization.id),
    encryptedToken: bytea("encrypted_token").notNull(),
    tokenNonce: bytea("token_nonce").notNull(),
    tokenTag: bytea("token_tag").notNull(),
    tokenType: text("token_type").notNull().default("jwt"),
    obtainedAt: timestamp("obtained_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    agentId: uuid("agent_id"),
    certThumbprint: text("cert_thumbprint"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "chz_api_tokens_tenant_agent_fk",
      columns: [t.tenantId, t.agentId],
      foreignColumns: [chzSignerAgents.tenantId, chzSignerAgents.id],
    }),
  ],
);

export const chzExportRunStateEnum = pgEnum("chz_export_run_state", [
  "queued",
  "ordered",
  "ready",
  "imported",
  "failed",
]);

/**
 * One row per (inventory, ChZ status) — six per order. A retry reuses the row
 * rather than accumulating history, so the table stays one row per thing the
 * operator can see; `attempts` is what records how much quota a status has
 * already cost.
 */
export const chzExportRuns = pgTable(
  "chz_export_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    status: inventoryChzStatusEnum("status").notNull(),
    state: chzExportRunStateEnum("state").notNull().default("queued"),
    dispenserTaskId: text("dispenser_task_id"),
    resultId: text("result_id"),
    orderedByUserId: text("ordered_by_user_id")
      .notNull()
      .references(() => user.id),
    importId: uuid("import_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("chz_export_runs_tenant_inventory_status_uq").on(
      table.tenantId,
      table.inventoryId,
      table.status,
    ),
    foreignKey({
      name: "chz_export_runs_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "chz_export_runs_tenant_import_fk",
      columns: [table.tenantId, table.importId],
      foreignColumns: [inventoryImports.tenantId, inventoryImports.id],
    }),
    index("chz_export_runs_unfinished_idx")
      .on(table.tenantId, table.inventoryId)
      .where(sql`${table.state} in ('queued', 'ordered', 'ready')`),
    check("chz_export_runs_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
    // Every state, not just the terminal ones: a row must never sit in
    // `ordered` with no task to poll, which is the state that would strand a
    // run silently. Modelled on `inventory_document_runs_status_consistency_check`.
    check(
      "chz_export_runs_state_consistency_check",
      sql`(${table.state} = 'queued' and ${table.dispenserTaskId} is null and ${table.resultId} is null and ${table.importId} is null and ${table.errorCode} is null)
        or (${table.state} = 'ordered' and ${table.dispenserTaskId} is not null and ${table.resultId} is null and ${table.importId} is null and ${table.errorCode} is null)
        or (${table.state} = 'ready' and ${table.dispenserTaskId} is not null and ${table.resultId} is not null and ${table.importId} is null and ${table.errorCode} is null)
        or (${table.state} = 'imported' and ${table.importId} is not null and ${table.errorCode} is null and ${table.completedAt} is not null)
        or (${table.state} = 'failed' and ${table.errorCode} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);

export type ChzSignerAgentRow = typeof chzSignerAgents.$inferSelect;
export type ChzSignerTaskRow = typeof chzSignerTasks.$inferSelect;
export type ChzApiTokenRow = typeof chzApiTokens.$inferSelect;
export type ChzExportRunRow = typeof chzExportRuns.$inferSelect;
