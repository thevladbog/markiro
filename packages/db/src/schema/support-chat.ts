import { sql } from "drizzle-orm";
import {
  check,
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
import { platformUsers } from "./platform-auth.js";
import { tenantBillingRequests } from "./tenant-billing.js";

export const supportChatDirection = pgEnum("support_chat_direction", ["customer", "operator"]);
export const supportChatDelivery = pgEnum("support_chat_delivery", [
  "pending",
  "sent",
  "uncertain",
  "failed",
]);
export const supportChatProposalState = pgEnum("support_chat_proposal_state", [
  "pending",
  "accepted",
  "declined",
]);
export const supportChatJobState = pgEnum("support_chat_job_state", [
  "pending",
  "leased",
  "completed",
  "failed",
]);
export const supportChatJobKind = pgEnum("support_chat_job_kind", ["send", "reconcile", "import"]);

export const supportChatOwners = pgTable(
  "support_chat_owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    remoteContactId: text("remote_contact_id"),
    remoteContactSourceId: text("remote_contact_source_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("support_chat_owners_tenant_id_uq").on(table.tenantId, table.id),
    unique("support_chat_owners_tenant_user_uq").on(table.tenantId, table.userId),
    check(
      "support_chat_owners_remote_contact_shape",
      sql`(${table.remoteContactId} is null) = (${table.remoteContactSourceId} is null)`,
    ),
  ],
);

export const supportChatEpisodes = pgTable(
  "support_chat_episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    ownerId: uuid("owner_id").notNull(),
    creationKey: uuid("creation_key").notNull(),
    remoteAccountId: integer("remote_account_id"),
    remoteInboxId: integer("remote_inbox_id"),
    remoteConversationId: integer("remote_conversation_id"),
    requestId: uuid("request_id"),
    transcriptState: text("transcript_state").notNull().default("pending"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("support_chat_episodes_tenant_id_uq").on(table.tenantId, table.id),
    unique("support_chat_episodes_owner_creation_uq").on(
      table.tenantId,
      table.ownerId,
      table.creationKey,
    ),
    unique("support_chat_episodes_request_uq").on(table.requestId),
    unique("support_chat_episodes_remote_uq").on(
      table.remoteAccountId,
      table.remoteInboxId,
      table.remoteConversationId,
    ),
    unique("support_chat_episodes_remote_message_scope_uq").on(
      table.tenantId,
      table.id,
      table.remoteAccountId,
      table.remoteInboxId,
      table.remoteConversationId,
    ),
    index("support_chat_episodes_owner_created_idx").on(
      table.tenantId,
      table.ownerId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "support_chat_episodes_tenant_owner_fk",
      columns: [table.tenantId, table.ownerId],
      foreignColumns: [supportChatOwners.tenantId, supportChatOwners.id],
    }),
    foreignKey({
      name: "support_chat_episodes_tenant_request_fk",
      columns: [table.tenantId, table.requestId],
      foreignColumns: [tenantBillingRequests.tenantId, tenantBillingRequests.id],
    }),
    check(
      "support_chat_episodes_remote_shape",
      sql`(${table.remoteAccountId} is null and ${table.remoteInboxId} is null and ${table.remoteConversationId} is null) or (${table.remoteAccountId} is not null and ${table.remoteInboxId} is not null and ${table.remoteConversationId} is not null)`,
    ),
    check(
      "support_chat_episodes_remote_positive",
      sql`(${table.remoteAccountId} is null or ${table.remoteAccountId} > 0) and (${table.remoteInboxId} is null or ${table.remoteInboxId} > 0) and (${table.remoteConversationId} is null or ${table.remoteConversationId} > 0)`,
    ),
    check(
      "support_chat_episodes_transcript_state",
      sql`${table.transcriptState} in ('pending', 'healthy', 'error')`,
    ),
  ],
);

export const supportChatMessages = pgTable(
  "support_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    episodeId: uuid("episode_id").notNull(),
    direction: supportChatDirection("direction").notNull(),
    text: text("text").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    delivery: supportChatDelivery("delivery").notNull(),
    idempotencyKey: uuid("idempotency_key"),
    remoteAccountId: integer("remote_account_id"),
    remoteInboxId: integer("remote_inbox_id"),
    remoteConversationId: integer("remote_conversation_id"),
    remoteMessageId: integer("remote_message_id"),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("support_chat_messages_tenant_id_uq").on(table.tenantId, table.id),
    unique("support_chat_messages_tenant_episode_id_uq").on(
      table.tenantId,
      table.episodeId,
      table.id,
    ),
    unique("support_chat_messages_tenant_episode_key_uq").on(
      table.tenantId,
      table.episodeId,
      table.idempotencyKey,
    ),
    unique("support_chat_messages_remote_uq").on(
      table.remoteAccountId,
      table.remoteInboxId,
      table.remoteConversationId,
      table.remoteMessageId,
    ),
    index("support_chat_messages_episode_occurred_idx").on(
      table.tenantId,
      table.episodeId,
      table.occurredAt,
      table.id,
    ),
    foreignKey({
      name: "support_chat_messages_tenant_episode_fk",
      columns: [table.tenantId, table.episodeId],
      foreignColumns: [supportChatEpisodes.tenantId, supportChatEpisodes.id],
    }),
    foreignKey({
      name: "support_chat_messages_remote_episode_fk",
      columns: [
        table.tenantId,
        table.episodeId,
        table.remoteAccountId,
        table.remoteInboxId,
        table.remoteConversationId,
      ],
      foreignColumns: [
        supportChatEpisodes.tenantId,
        supportChatEpisodes.id,
        supportChatEpisodes.remoteAccountId,
        supportChatEpisodes.remoteInboxId,
        supportChatEpisodes.remoteConversationId,
      ],
    }),
    check("support_chat_messages_text_nonempty", sql`char_length(${table.text}) > 0`),
    check(
      "support_chat_messages_remote_shape",
      sql`(${table.remoteAccountId} is null and ${table.remoteInboxId} is null and ${table.remoteConversationId} is null and ${table.remoteMessageId} is null) or (${table.remoteAccountId} is not null and ${table.remoteInboxId} is not null and ${table.remoteConversationId} is not null and ${table.remoteMessageId} is not null)`,
    ),
    check(
      "support_chat_messages_sent_remote",
      sql`${table.delivery} <> 'sent' or ${table.remoteMessageId} is not null`,
    ),
  ],
);

export const supportChatProposals = pgTable(
  "support_chat_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    episodeId: uuid("episode_id").notNull(),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    noticeVersion: text("notice_version").notNull().default("support-transcript-v1"),
    state: supportChatProposalState("state").notNull().default("pending"),
    operatorId: text("operator_id")
      .notNull()
      .references(() => platformUsers.id),
    operatorAccessAuditIds: jsonb("operator_access_audit_ids").$type<string[]>(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("support_chat_proposals_tenant_id_uq").on(table.tenantId, table.id),
    unique("support_chat_proposals_episode_revision_uq").on(
      table.tenantId,
      table.episodeId,
      table.revision,
    ),
    unique("support_chat_proposals_tenant_episode_revision_id_uq").on(
      table.tenantId,
      table.episodeId,
      table.revision,
      table.id,
    ),
    unique("support_chat_proposals_episode_key_uq").on(
      table.tenantId,
      table.episodeId,
      table.idempotencyKey,
    ),
    uniqueIndex("support_chat_proposals_one_pending_uq")
      .on(table.tenantId, table.episodeId)
      .where(sql`${table.state} = 'pending'`),
    foreignKey({
      name: "support_chat_proposals_tenant_episode_fk",
      columns: [table.tenantId, table.episodeId],
      foreignColumns: [supportChatEpisodes.tenantId, supportChatEpisodes.id],
    }),
    check("support_chat_proposals_revision_positive", sql`${table.revision} > 0`),
    check(
      "support_chat_proposals_title_length",
      sql`char_length(${table.title}) between 1 and 200`,
    ),
    check(
      "support_chat_proposals_summary_length",
      sql`char_length(${table.summary}) between 1 and 4000`,
    ),
    check(
      "support_chat_proposals_notice_version",
      sql`${table.noticeVersion} = 'support-transcript-v1'`,
    ),
  ],
);

export const supportChatConsents = pgTable(
  "support_chat_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    episodeId: uuid("episode_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    revision: integer("revision").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    decision: text("decision").notNull(),
    noticeVersion: text("notice_version").notNull(),
    noticeLocale: text("notice_locale"),
    noticeText: text("notice_text"),
    acceptedTitle: text("accepted_title").notNull(),
    acceptedSummary: text("accepted_summary").notNull(),
    operatorId: text("operator_id")
      .notNull()
      .references(() => platformUsers.id),
    idempotencyKey: uuid("idempotency_key").notNull(),
    snapshotThrough: timestamp("snapshot_through", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("support_chat_consents_tenant_id_uq").on(table.tenantId, table.id),
    unique("support_chat_consents_proposal_revision_uq").on(table.proposalId, table.revision),
    unique("support_chat_consents_episode_key_uq").on(
      table.tenantId,
      table.episodeId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "support_chat_consents_tenant_episode_fk",
      columns: [table.tenantId, table.episodeId],
      foreignColumns: [supportChatEpisodes.tenantId, supportChatEpisodes.id],
    }),
    foreignKey({
      name: "support_chat_consents_tenant_proposal_fk",
      columns: [table.tenantId, table.episodeId, table.revision, table.proposalId],
      foreignColumns: [
        supportChatProposals.tenantId,
        supportChatProposals.episodeId,
        supportChatProposals.revision,
        supportChatProposals.id,
      ],
    }),
    check("support_chat_consents_decision", sql`${table.decision} in ('accept', 'decline')`),
    check(
      "support_chat_consents_notice_version",
      sql`${table.noticeVersion} = 'support-transcript-v1'`,
    ),
  ],
);

export const supportChatJobs = pgTable(
  "support_chat_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    episodeId: uuid("episode_id").notNull(),
    kind: supportChatJobKind("kind").notNull(),
    state: supportChatJobState("state").notNull().default("pending"),
    messageId: uuid("message_id"),
    attemptToken: uuid("attempt_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    checkpoint: jsonb("checkpoint"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("support_chat_jobs_tenant_id_uq").on(table.tenantId, table.id),
    index("support_chat_jobs_due_idx").on(table.state, table.nextAttemptAt),
    foreignKey({
      name: "support_chat_jobs_tenant_episode_fk",
      columns: [table.tenantId, table.episodeId],
      foreignColumns: [supportChatEpisodes.tenantId, supportChatEpisodes.id],
    }),
    foreignKey({
      name: "support_chat_jobs_tenant_message_fk",
      columns: [table.tenantId, table.episodeId, table.messageId],
      foreignColumns: [
        supportChatMessages.tenantId,
        supportChatMessages.episodeId,
        supportChatMessages.id,
      ],
    }),
    check("support_chat_jobs_retry_nonnegative", sql`${table.retryCount} >= 0`),
    check(
      "support_chat_jobs_lease_shape",
      sql`(${table.state} = 'leased' and ${table.attemptToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'leased' and ${table.leaseExpiresAt} is null)`,
    ),
  ],
);
