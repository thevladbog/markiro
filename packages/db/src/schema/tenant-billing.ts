import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { billingPayments, invoices } from "./billing.js";
import { platformUsers } from "./platform-auth.js";
import { commercialOffers, orderedServices, subscriptionEvents } from "./saas.js";

export const BILLING_REQUEST_TYPES = [
  "renewal",
  "capacity_change",
  "additional_service",
  "documents",
  "other",
] as const;
export type BillingRequestType = (typeof BILLING_REQUEST_TYPES)[number];

export const BILLING_REQUEST_STATUSES = [
  "new",
  "under_review",
  "clarification_required",
  "offer_prepared",
  "awaiting_payment",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type BillingRequestStatus = (typeof BILLING_REQUEST_STATUSES)[number];

export const BILLING_REQUEST_EVENT_KINDS = [
  "created",
  "status_changed",
  "tenant_reply",
  "platform_comment",
  "offer_linked",
  "offer_accepted",
  "offer_changes_requested",
  "invoice_linked",
  "payment_confirmed",
  "service_linked",
  "act_linked",
] as const;
export type BillingRequestEventKind = (typeof BILLING_REQUEST_EVENT_KINDS)[number];

export const BILLING_ACTOR_KINDS = ["tenant_user", "platform_user", "system"] as const;
export type BillingActorKind = (typeof BILLING_ACTOR_KINDS)[number];

export const BILLING_RESPONSIBLE_SIDES = ["tenant", "markiro", "none"] as const;
export type BillingResponsibleSide = (typeof BILLING_RESPONSIBLE_SIDES)[number];

export const OFFER_DECISION_KINDS = ["accepted", "changes_requested"] as const;
export type OfferDecisionKind = (typeof OFFER_DECISION_KINDS)[number];

export const BILLING_ATTACHMENT_STATES = [
  "pending",
  "ready",
  "failed",
  "cleanup_required",
] as const;
export type BillingAttachmentState = (typeof BILLING_ATTACHMENT_STATES)[number];

export const BILLING_ACT_STATUSES = ["draft", "issued", "cancelled"] as const;
export type BillingActStatus = (typeof BILLING_ACT_STATUSES)[number];

export const billingRequestType = pgEnum("billing_request_type", BILLING_REQUEST_TYPES);
export const billingRequestStatus = pgEnum("billing_request_status", BILLING_REQUEST_STATUSES);
export const billingRequestEventKind = pgEnum(
  "billing_request_event_kind",
  BILLING_REQUEST_EVENT_KINDS,
);
export const billingActorKind = pgEnum("billing_actor_kind", BILLING_ACTOR_KINDS);
export const billingResponsibleSide = pgEnum("billing_responsible_side", BILLING_RESPONSIBLE_SIDES);
export const offerDecisionKind = pgEnum("offer_decision_kind", OFFER_DECISION_KINDS);
export const billingAttachmentState = pgEnum("billing_attachment_state", BILLING_ATTACHMENT_STATES);
export const billingActStatus = pgEnum("billing_act_status", BILLING_ACT_STATUSES);

export const tenantBillingRequestNumberSequence = pgSequence("tenant_billing_request_number_seq");

export const tenantBillingRequests = pgTable(
  "tenant_billing_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    number: text("number").notNull(),
    type: billingRequestType("type").notNull(),
    status: billingRequestStatus("status").notNull().default("new"),
    description: text("description").notNull(),
    desiredAt: timestamp("desired_at", { withTimezone: true }),
    contextType: text("context_type"),
    contextId: text("context_id"),
    responsibleSide: billingResponsibleSide("responsible_side").notNull().default("markiro"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tenant_billing_requests_number_uq").on(table.number),
    unique("tenant_billing_requests_tenant_id_uq").on(table.tenantId, table.id),
    unique("tenant_billing_requests_tenant_idempotency_uq").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("tenant_billing_requests_tenant_status_updated_idx").on(
      table.tenantId,
      table.status,
      table.updatedAt,
    ),
    check(
      "tenant_billing_requests_context_shape_check",
      sql`(${table.contextType} is null) = (${table.contextId} is null)`,
    ),
    check(
      "tenant_billing_requests_description_nonempty",
      sql`nullif(btrim(${table.description}), '') is not null`,
    ),
  ],
);

export const tenantBillingRequestEvents = pgTable(
  "tenant_billing_request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    requestId: uuid("request_id").notNull(),
    kind: billingRequestEventKind("kind").notNull(),
    fromStatus: billingRequestStatus("from_status"),
    toStatus: billingRequestStatus("to_status"),
    actorKind: billingActorKind("actor_kind").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    actorPlatformUserId: text("actor_platform_user_id").references(() => platformUsers.id),
    message: text("message"),
    metadata: jsonb("metadata"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tenant_billing_request_events_tenant_id_uq").on(table.tenantId, table.id),
    unique("tenant_billing_request_events_tenant_idempotency_uq").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("tenant_billing_request_events_tenant_request_created_idx").on(
      table.tenantId,
      table.requestId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "tenant_billing_request_events_tenant_request_fk",
      columns: [table.tenantId, table.requestId],
      foreignColumns: [tenantBillingRequests.tenantId, tenantBillingRequests.id],
    }),
    check(
      "tenant_billing_request_events_actor_shape_check",
      sql`(${table.actorKind} = 'tenant_user' and ${table.actorUserId} is not null and ${table.actorPlatformUserId} is null)
        or (${table.actorKind} = 'platform_user' and ${table.actorUserId} is null and ${table.actorPlatformUserId} is not null)
        or (${table.actorKind} = 'system' and ${table.actorUserId} is null and ${table.actorPlatformUserId} is null)`,
    ),
    check(
      "tenant_billing_request_events_status_shape_check",
      sql`${table.kind} <> 'status_changed' or (${table.fromStatus} is not null and ${table.toStatus} is not null and ${table.fromStatus} <> ${table.toStatus})`,
    ),
  ],
);

export const tenantBillingRequestAttachments = pgTable(
  "tenant_billing_request_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    requestId: uuid("request_id").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    state: billingAttachmentState("state").notNull().default("pending"),
    uploadedByUserId: text("uploaded_by_user_id")
      .notNull()
      .references(() => user.id),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tenant_billing_request_attachments_tenant_id_uq").on(table.tenantId, table.id),
    unique("tenant_billing_request_attachments_object_key_uq").on(table.objectKey),
    index("tenant_billing_request_attachments_tenant_request_state_idx").on(
      table.tenantId,
      table.requestId,
      table.state,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "tenant_billing_request_attachments_tenant_request_fk",
      columns: [table.tenantId, table.requestId],
      foreignColumns: [tenantBillingRequests.tenantId, tenantBillingRequests.id],
    }),
    check("tenant_billing_request_attachments_byte_size_positive", sql`${table.byteSize} > 0`),
  ],
);

export const commercialOfferDecisions = pgTable(
  "commercial_offer_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    decision: offerDecisionKind("decision").notNull(),
    message: text("message"),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("commercial_offer_decisions_tenant_id_uq").on(table.tenantId, table.id),
    unique("commercial_offer_decisions_tenant_idempotency_uq").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    uniqueIndex("commercial_offer_decisions_accepted_offer_uq")
      .on(table.tenantId, table.offerId)
      .where(sql`${table.decision} = 'accepted'`),
    index("commercial_offer_decisions_tenant_offer_created_idx").on(
      table.tenantId,
      table.offerId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "commercial_offer_decisions_tenant_offer_fk",
      columns: [table.tenantId, table.offerId],
      foreignColumns: [commercialOffers.tenantId, commercialOffers.id],
    }),
    check(
      "commercial_offer_decisions_message_shape_check",
      sql`${table.decision} <> 'changes_requested' or nullif(btrim(${table.message}), '') is not null`,
    ),
  ],
);

export const commercialOfferDecisionIdempotency = pgTable(
  "commercial_offer_decision_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    offerId: uuid("offer_id").notNull(),
    decision: offerDecisionKind("decision").notNull(),
    message: text("message"),
    decisionId: uuid("decision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("commercial_offer_decision_idempotency_tenant_key_uq").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("commercial_offer_decision_idempotency_tenant_decision_idx").on(
      table.tenantId,
      table.decisionId,
    ),
    foreignKey({
      name: "commercial_offer_decision_idempotency_tenant_offer_fk",
      columns: [table.tenantId, table.offerId],
      foreignColumns: [commercialOffers.tenantId, commercialOffers.id],
    }),
    foreignKey({
      name: "commercial_offer_decision_idempotency_tenant_decision_fk",
      columns: [table.tenantId, table.decisionId],
      foreignColumns: [commercialOfferDecisions.tenantId, commercialOfferDecisions.id],
    }),
    check(
      "commercial_offer_decision_idempotency_message_shape_check",
      sql`${table.decision} <> 'changes_requested' or nullif(btrim(${table.message}), '') is not null`,
    ),
  ],
);

export const platformBillingMutationIdempotency = pgTable(
  "platform_billing_mutation_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    targetId: text("target_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state").notNull().default("pending"),
    resultId: uuid("result_id"),
    result: jsonb("result"),
    actorPlatformUserId: text("actor_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("platform_billing_mutation_idempotency_tenant_key_uq").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("platform_billing_mutation_idempotency_tenant_target_idx").on(
      table.tenantId,
      table.operation,
      table.targetId,
    ),
    foreignKey({
      name: "platform_billing_mutation_idempotency_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [organization.id],
    }),
    check(
      "platform_billing_mutation_idempotency_operation_nonempty",
      sql`nullif(btrim(${table.operation}), '') is not null and nullif(btrim(${table.targetId}), '') is not null`,
    ),
    check(
      "platform_billing_mutation_idempotency_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "platform_billing_mutation_idempotency_state_check",
      sql`(${table.state} = 'pending' and ${table.result} is null)
        or (${table.state} = 'committed' and ${table.result} is not null and ${table.resultId} is not null)`,
    ),
  ],
);

export const billingActs = pgTable(
  "billing_acts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organization.id),
    requestId: uuid("request_id"),
    invoiceId: uuid("invoice_id"),
    orderedServiceId: uuid("ordered_service_id"),
    number: text("number").notNull(),
    status: billingActStatus("status").notNull().default("draft"),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    createdByPlatformUserId: text("created_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    issuedByPlatformUserId: text("issued_by_platform_user_id").references(() => platformUsers.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    cancelledByPlatformUserId: text("cancelled_by_platform_user_id").references(
      () => platformUsers.id,
    ),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("billing_acts_number_uq").on(table.number),
    unique("billing_acts_tenant_id_uq").on(table.tenantId, table.id),
    index("billing_acts_tenant_status_created_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    foreignKey({
      name: "billing_acts_tenant_request_fk",
      columns: [table.tenantId, table.requestId],
      foreignColumns: [tenantBillingRequests.tenantId, tenantBillingRequests.id],
    }),
    foreignKey({
      name: "billing_acts_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: "billing_acts_tenant_service_fk",
      columns: [table.tenantId, table.orderedServiceId],
      foreignColumns: [orderedServices.tenantId, orderedServices.id],
    }),
    check("billing_acts_period_order_check", sql`${table.periodEnd} >= ${table.periodStart}`),
    check(
      "billing_acts_issue_shape_check",
      sql`((${table.issuedByPlatformUserId} is null and ${table.issuedAt} is null)
        or (${table.issuedByPlatformUserId} is not null and ${table.issuedAt} is not null))
        and ((${table.status} = 'draft' and ${table.issuedByPlatformUserId} is null and ${table.cancelledByPlatformUserId} is null and ${table.cancelledAt} is null)
          or (${table.status} = 'issued' and ${table.issuedByPlatformUserId} is not null and ${table.cancelledByPlatformUserId} is null and ${table.cancelledAt} is null)
          or (${table.status} = 'cancelled' and ${table.cancelledByPlatformUserId} is not null and ${table.cancelledAt} is not null))`,
    ),
  ],
);

export const billingActDocuments = pgTable(
  "billing_act_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    actId: uuid("act_id").notNull(),
    revision: integer("revision").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    state: billingAttachmentState("state").notNull().default("pending"),
    uploadedByPlatformUserId: text("uploaded_by_platform_user_id")
      .notNull()
      .references(() => platformUsers.id),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("billing_act_documents_tenant_id_uq").on(table.tenantId, table.id),
    unique("billing_act_documents_act_revision_uq").on(table.tenantId, table.actId, table.revision),
    unique("billing_act_documents_object_key_uq").on(table.objectKey),
    index("billing_act_documents_tenant_created_id_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
    index("billing_act_documents_tenant_act_state_idx").on(
      table.tenantId,
      table.actId,
      table.state,
      table.createdAt,
      table.id,
    ),
    uniqueIndex("billing_act_documents_current_act_uq")
      .on(table.tenantId, table.actId)
      .where(sql`${table.isCurrent} = true`),
    foreignKey({
      name: "billing_act_documents_tenant_act_fk",
      columns: [table.tenantId, table.actId],
      foreignColumns: [billingActs.tenantId, billingActs.id],
    }),
    check("billing_act_documents_revision_positive", sql`${table.revision} > 0`),
    check("billing_act_documents_byte_size_positive", sql`${table.byteSize} > 0`),
    check("billing_act_documents_content_type_pdf", sql`${table.contentType} = 'application/pdf'`),
    check(
      "billing_act_documents_ready_shape_check",
      sql`(${table.state} = 'ready' and ${table.readyAt} is not null)
        or (${table.state} <> 'ready' and ${table.readyAt} is null)`,
    ),
  ],
);

export const tenantBillingRequestLinks = pgTable(
  "tenant_billing_request_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    requestId: uuid("request_id").notNull(),
    offerId: uuid("offer_id"),
    invoiceId: uuid("invoice_id"),
    paymentId: uuid("payment_id"),
    actId: uuid("act_id"),
    orderedServiceId: uuid("ordered_service_id"),
    subscriptionEventId: uuid("subscription_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tenant_billing_request_links_tenant_id_uq").on(table.tenantId, table.id),
    uniqueIndex("tenant_billing_request_links_offer_uq")
      .on(table.tenantId, table.offerId)
      .where(sql`${table.offerId} is not null`),
    uniqueIndex("tenant_billing_request_links_invoice_uq")
      .on(table.tenantId, table.invoiceId)
      .where(sql`${table.invoiceId} is not null`),
    uniqueIndex("tenant_billing_request_links_payment_uq")
      .on(table.tenantId, table.requestId, table.paymentId)
      .where(sql`${table.paymentId} is not null`),
    uniqueIndex("tenant_billing_request_links_act_uq")
      .on(table.tenantId, table.actId)
      .where(sql`${table.actId} is not null`),
    uniqueIndex("tenant_billing_request_links_service_uq")
      .on(table.tenantId, table.requestId, table.orderedServiceId)
      .where(sql`${table.orderedServiceId} is not null`),
    uniqueIndex("tenant_billing_request_links_subscription_event_uq")
      .on(table.tenantId, table.requestId, table.subscriptionEventId)
      .where(sql`${table.subscriptionEventId} is not null`),
    foreignKey({
      name: "tenant_billing_request_links_tenant_request_fk",
      columns: [table.tenantId, table.requestId],
      foreignColumns: [tenantBillingRequests.tenantId, tenantBillingRequests.id],
    }),
    foreignKey({
      name: "tenant_billing_request_links_tenant_offer_fk",
      columns: [table.tenantId, table.offerId],
      foreignColumns: [commercialOffers.tenantId, commercialOffers.id],
    }),
    foreignKey({
      name: "tenant_billing_request_links_tenant_invoice_fk",
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: "tenant_billing_request_links_tenant_payment_fk",
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [billingPayments.tenantId, billingPayments.id],
    }),
    foreignKey({
      name: "tenant_billing_request_links_tenant_act_fk",
      columns: [table.tenantId, table.actId],
      foreignColumns: [billingActs.tenantId, billingActs.id],
    }),
    foreignKey({
      name: "tenant_billing_request_links_tenant_service_fk",
      columns: [table.tenantId, table.orderedServiceId],
      foreignColumns: [orderedServices.tenantId, orderedServices.id],
    }),
    foreignKey({
      name: "tenant_billing_request_links_tenant_subscription_event_fk",
      columns: [table.tenantId, table.subscriptionEventId],
      foreignColumns: [subscriptionEvents.tenantId, subscriptionEvents.id],
    }),
    check(
      "tenant_billing_request_links_one_target_check",
      sql`num_nonnulls(${table.offerId}, ${table.invoiceId}, ${table.paymentId}, ${table.actId}, ${table.orderedServiceId}, ${table.subscriptionEventId}) = 1`,
    ),
  ],
);
