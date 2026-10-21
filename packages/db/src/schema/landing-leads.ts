import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";

export const LANDING_LEAD_STATUSES = [
  "new",
  "contacted",
  "trial",
  "invoice_sent",
  "won",
  "lost",
] as const;
export type LandingLeadStatus = (typeof LANDING_LEAD_STATUSES)[number];

/**
 * `touch` is the owner's «Написал» without a status change; `anonymized` records the
 * retention job or a manual erasure. Every other kind is the vocabulary of spec §15.2.
 */
export const LANDING_LEAD_EVENT_KINDS = [
  "download",
  "invoice_request",
  "demo_request",
  "status_change",
  "touch",
  "note",
  "linked_tenant",
  "activation_request",
  "anonymized",
] as const;
export type LandingLeadEventKind = (typeof LANDING_LEAD_EVENT_KINDS)[number];

export const LEAD_NOTIFICATION_KINDS = ["new_lead", "invoice_request", "daily_digest"] as const;
export type LeadNotificationKind = (typeof LEAD_NOTIFICATION_KINDS)[number];

export const LEAD_NOTIFICATION_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type LeadNotificationStatus = (typeof LEAD_NOTIFICATION_STATUSES)[number];

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(","));

export interface LandingLeadUtm {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
}

/**
 * Platform-level (not tenant) sales leads from the landing forms (spec 2026-10-20 §15).
 * One row per normalized e-mail; anonymization clears the contacts but keeps the row
 * for statistics, so `email` is nullable and unique only while present.
 */
export const landingLeads = pgTable(
  "landing_leads",
  {
    id: uuid("id").primaryKey(),
    email: text("email"),
    company: text("company").notNull(),
    name: text("name"),
    phone: text("phone"),
    inn: text("inn"),
    productGroup: text("product_group"),
    linesBucket: text("lines_bucket"),
    locale: text("locale").notNull(),
    status: text("status").$type<LandingLeadStatus>().notNull().default("new"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    nextTouchAt: timestamp("next_touch_at", { withTimezone: true }),
    ownerNote: text("owner_note"),
    tenantId: text("tenant_id").references(() => organization.id, { onDelete: "set null" }),
    firstSourcePath: text("first_source_path").notNull(),
    firstUtm: jsonb("first_utm").$type<LandingLeadUtm>(),
    firstReferrer: text("first_referrer"),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("landing_leads_email_uq")
      .on(sql`lower(btrim(${t.email}))`)
      .where(sql`${t.email} is not null`),
    index("landing_leads_status_idx").on(t.status, t.createdAt),
    index("landing_leads_next_touch_idx")
      .on(t.nextTouchAt)
      .where(sql`${t.nextTouchAt} is not null`),
    index("landing_leads_inn_idx")
      .on(t.inn)
      .where(sql`${t.inn} is not null`),
    index("landing_leads_tenant_idx")
      .on(t.tenantId)
      .where(sql`${t.tenantId} is not null`),
    index("landing_leads_updated_idx").on(t.updatedAt),
    check(
      "landing_leads_shape_check",
      sql`${t.status} in (${list(LANDING_LEAD_STATUSES)}) and ${t.locale} in ('ru','en') and (${t.linesBucket} is null or ${t.linesBucket} in ('1','2-3','4+')) and (${t.ownerNote} is null or char_length(${t.ownerNote}) <= 2000) and char_length(${t.company}) between 1 and 300`,
    ),
    // A lead either still carries its e-mail or has been anonymized, never both.
    check(
      "landing_leads_anonymized_check",
      sql`(${t.anonymizedAt} is null and ${t.email} is not null) or (${t.anonymizedAt} is not null and ${t.email} is null and ${t.name} is null and ${t.phone} is null)`,
    ),
  ],
);

/** The lead's journal. `payload` never repeats the e-mail (spec §15.2). */
export const landingLeadEvents = pgTable(
  "landing_lead_events",
  {
    id: uuid("id").primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => landingLeads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<LandingLeadEventKind>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    publicRequestId: uuid("public_request_id"),
    actorPlatformUserId: text("actor_platform_user_id").references(() => platformUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("landing_lead_events_public_request_uq").on(t.publicRequestId),
    index("landing_lead_events_lead_created_idx").on(t.leadId, t.createdAt.desc(), t.id.desc()),
    index("landing_lead_events_kind_created_idx").on(t.kind, t.createdAt),
    check("landing_lead_events_kind_check", sql`${t.kind} in (${list(LANDING_LEAD_EVENT_KINDS)})`),
  ],
);

/**
 * Telegram outbox (spec §15.4): written in the lead's transaction, sent by the
 * platform job with exponential retries. `daily_digest` has no lead and one row per
 * civil day (Europe/Moscow); its `payload` lists the lead ids per digest section.
 */
export const leadNotifications = pgTable(
  "lead_notifications",
  {
    id: uuid("id").primaryKey(),
    leadId: uuid("lead_id").references(() => landingLeads.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => landingLeadEvents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<LeadNotificationKind>().notNull(),
    digestDate: date("digest_date"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<LeadNotificationStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lead_notifications_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex("lead_notifications_digest_date_uq")
      .on(t.digestDate)
      .where(sql`${t.kind} = 'daily_digest'`),
    index("lead_notifications_lead_idx").on(t.leadId),
    check(
      "lead_notifications_shape_check",
      sql`${t.kind} in (${list(LEAD_NOTIFICATION_KINDS)}) and ${t.status} in (${list(LEAD_NOTIFICATION_STATUSES)}) and ${t.attempts} >= 0 and ((${t.kind} = 'daily_digest') = (${t.leadId} is null)) and ((${t.kind} = 'daily_digest') = (${t.digestDate} is not null)) and (${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z0-9_]{1,64}$')`,
    ),
  ],
);
