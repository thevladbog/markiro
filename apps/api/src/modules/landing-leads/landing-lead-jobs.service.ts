import { createHash, randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { LANDING_LEAD_DIGEST_SECTIONS, type LandingLeadDigestSection } from "@markiro/email";
import type { LandingLeadStatus } from "@markiro/platform-contracts";
import { Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { MailDeliveryService } from "../mail/mail-delivery.service";
import { anonymizeLead } from "./lead-anonymization";
import {
  civilDate,
  digestIsEmpty,
  selectDigestSections,
  type LeadDigestCandidate,
  type LeadDigestSections,
} from "./lead-digest-sections";
import {
  leadAlertText,
  leadDigestText,
  NO_COMPANY,
  type LeadAlertFacts,
} from "./lead-telegram-message";
import { leadUrl } from "./landing-lead-writer";
import {
  TelegramSendError,
  type TelegramSender,
  type TelegramNotificationTarget,
} from "./telegram.client";
import { deliverTelegramNotification } from "./telegram-delivery";

export const DISPATCH_LEAD_NOTIFICATIONS_QUEUE = "dispatch-lead-notifications";
export const SEND_LEAD_DIGEST_QUEUE = "send-lead-digest";
export const ANONYMIZE_LANDING_LEADS_QUEUE = "anonymize-landing-leads";
/** 09:00 Moscow time (spec §15.5). */
export const SEND_LEAD_DIGEST_CRON = "0 6 * * *";
export const ANONYMIZE_LANDING_LEADS_CRON = "40 2 * * *";

/** Up to eight attempts with exponential backoff, like the mail outbox (spec §15.4). */
export const LEAD_NOTIFICATION_MAX_ATTEMPTS = 8;
const BATCH_SIZE = 10;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 3_600;
/** A mistaken «lost» can be undone for a month before the contacts are cleared. */
const LOST_GRACE_DAYS = 30;
const ANONYMIZE_BATCH = 200;
const DIGEST_CANDIDATE_LIMIT = 500;

export interface LandingLeadJobsOptions {
  /** Owner inbox for the digest e-mail; empty disables the e-mail copy. */
  recipient: string;
  adminOrigin: string;
  retentionMonths: number;
}

type DueNotification = {
  id: string;
  kind: "new_lead" | "invoice_request" | "daily_digest";
  attempts: number;
  payload: Record<string, unknown>;
  digestDate: string | null;
  leadId: string | null;
  company: string | null;
  productGroup: string | null;
  linesBucket: string | null;
  eventKind: string | null;
  eventPayload: Record<string, unknown> | null;
};

/** Deterministic public request id of a day's digest e-mail: one per civil day. */
export function digestRequestId(digestDate: string): string {
  const hex = createHash("sha256")
    .update(`markiro-landing-lead-digest:${digestDate}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function retryDelaySeconds(attemptsSoFar: number): number {
  return Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(0, attemptsSoFar - 1), RETRY_MAX_SECONDS);
}

/**
 * Platform jobs of the landing leads (spec §15.4–15.5, §15.2): the Telegram outbox,
 * the daily digest and the retention of personal data.
 */
export class LandingLeadJobsService {
  readonly #logger = new Logger(LandingLeadJobsService.name);
  private readonly telegramTargets: readonly TelegramNotificationTarget[] | null;

  constructor(
    private readonly db: Db,
    private readonly mail: Pick<MailDeliveryService, "enqueue">,
    private readonly audit: Pick<PlatformAuditService, "record">,
    telegram: TelegramSender | readonly TelegramNotificationTarget[] | null,
    private readonly options: LandingLeadJobsOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {
    this.telegramTargets =
      telegram === null
        ? null
        : "sendMessage" in telegram
          ? [{ id: "legacy", sender: telegram }]
          : telegram.length === 0
            ? null
            : [...telegram];
    if (
      this.telegramTargets &&
      (this.telegramTargets.length > 2 ||
        new Set(this.telegramTargets.map((target) => target.id)).size !==
          this.telegramTargets.length)
    )
      throw new Error("Invalid Telegram recipient configuration");
  }

  /** Sends the due outbox rows; with Telegram off they are marked `skipped`, never sent later. */
  async dispatchNotifications(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const due = await tx.execute<DueNotification>(sql`
        SELECT n.id::text AS id, n.kind, n.attempts, n.payload,
          n.digest_date::text AS "digestDate", n.lead_id::text AS "leadId",
          l.company, l.product_group AS "productGroup", l.lines_bucket AS "linesBucket",
          e.kind AS "eventKind", e.payload AS "eventPayload"
        FROM lead_notifications AS n
        LEFT JOIN landing_leads AS l ON l.id = n.lead_id
        LEFT JOIN landing_lead_events AS e ON e.id = n.event_id
        WHERE n.status = 'pending' AND n.next_attempt_at <= ${now}
        ORDER BY n.next_attempt_at, n.id
        LIMIT ${BATCH_SIZE}
        FOR UPDATE OF n SKIP LOCKED
      `);
      let sent = 0;
      for (const row of due.rows) {
        if (this.telegramTargets === null) {
          await tx.execute(sql`
            UPDATE lead_notifications
            SET status = 'skipped', last_error_code = 'telegram_disabled', updated_at = ${now}
            WHERE id = ${row.id}::uuid
          `);
          continue;
        }
        let result: Awaited<ReturnType<typeof deliverTelegramNotification>>;
        try {
          result = await deliverTelegramNotification(
            row.payload,
            this.telegramTargets,
            await this.messageFor(tx, row),
            row.attempts,
            LEAD_NOTIFICATION_MAX_ATTEMPTS,
            (code) => this.#logger.warn(`Lead notification not sent: ${code}`),
          );
        } catch (error) {
          const failure =
            error instanceof TelegramSendError
              ? error
              : new TelegramSendError("telegram_message_build", false);
          const attempts = row.attempts + 1;
          const terminal = !failure.transient || attempts >= LEAD_NOTIFICATION_MAX_ATTEMPTS;
          const nextAttemptAt = new Date(now.getTime() + retryDelaySeconds(attempts) * 1_000);
          await tx.execute(sql`
            UPDATE lead_notifications
            SET attempts = ${attempts}, status = ${terminal ? "failed" : "pending"},
              next_attempt_at = ${nextAttemptAt}, last_error_code = ${failure.code},
              updated_at = ${now}
            WHERE id = ${row.id}::uuid
          `);
          this.#logger.warn(`Lead notification not sent: ${failure.code}`);
          continue;
        }
        await tx.execute(sql`
          UPDATE lead_notifications
          SET status = ${result.status}, attempts = attempts + 1,
            payload = ${JSON.stringify(result.payload)}::jsonb,
            sent_at = ${result.status === "sent" ? now : null},
            next_attempt_at = ${new Date(now.getTime() + retryDelaySeconds(row.attempts + 1) * 1_000)},
            last_error_code = ${result.errorCode}, updated_at = ${now}
          WHERE id = ${row.id}::uuid
        `);
        if (result.status === "sent") sent += 1;
      }
      return sent;
    });
  }

  private async messageFor(tx: Pick<Db, "execute">, row: DueNotification): Promise<string> {
    if (row.kind === "daily_digest") {
      const ids = sectionIds(row.payload);
      const all = [...new Set(LANDING_LEAD_DIGEST_SECTIONS.flatMap((section) => ids[section]))];
      const leads =
        all.length === 0
          ? []
          : (
              await tx.execute<{ id: string; company: string | null }>(sql`
                SELECT id::text AS id, company FROM landing_leads
                WHERE id = ANY(${`{${all.join(",")}}`}::uuid[])
              `)
            ).rows;
      const companies = new Map(leads.map((lead) => [lead.id, lead.company ?? NO_COMPANY]));
      const sections = Object.fromEntries(
        LANDING_LEAD_DIGEST_SECTIONS.map((section) => [
          section,
          ids[section]
            .filter((id) => companies.has(id))
            .map((id) => ({
              company: companies.get(id) ?? NO_COMPANY,
              leadUrl: leadUrl(this.options.adminOrigin, id),
            })),
        ]),
      ) as LeadDigestSections<{ company: string; leadUrl: string }>;
      return leadDigestText(row.digestDate ?? "", sections, `${this.options.adminOrigin}/leads`);
    }
    if (row.leadId === null) throw new Error("Lead notification lost its lead");
    const payload = row.eventPayload ?? {};
    const facts: LeadAlertFacts = {
      kind:
        row.eventKind === "invoice_request" || row.eventKind === "demo_request"
          ? row.eventKind
          : "download",
      firstContact: row.payload.firstContact !== false,
      company: row.company,
      productGroup: row.productGroup,
      linesBucket: row.linesBucket,
      tariffCode: typeof payload.tariffCode === "string" ? payload.tariffCode : null,
      sourcePath: typeof payload.sourcePath === "string" ? payload.sourcePath : null,
      utm:
        payload.utm && typeof payload.utm === "object"
          ? (payload.utm as Record<string, unknown>)
          : null,
      leadUrl: leadUrl(this.options.adminOrigin, row.leadId),
    };
    return leadAlertText(facts);
  }

  /** One digest per Moscow civil day; an empty digest is not sent (spec §15.5). */
  async sendDailyDigest(): Promise<"sent" | "empty" | "exists"> {
    const now = this.now();
    const digestDate = civilDate(now);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`landing-lead-digest:${digestDate}`}, 0))`,
      );
      const existing = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM lead_notifications
        WHERE kind = 'daily_digest' AND digest_date = ${digestDate}::date
      `);
      if (existing.rows.length > 0) return "exists";
      const candidates = await this.digestCandidates(tx, now);
      const sections = selectDigestSections(candidates, now);
      if (digestIsEmpty(sections)) return "empty";

      const payload = {
        sections: Object.fromEntries(
          LANDING_LEAD_DIGEST_SECTIONS.map((section) => [
            section,
            sections[section].map((lead) => lead.id),
          ]),
        ),
      };
      await tx.insert(schema.leadNotifications).values({
        id: this.createId(),
        kind: "daily_digest",
        digestDate,
        payload,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (this.options.recipient !== "") {
        await this.mail.enqueue(tx, {
          scope: { publicRequestId: digestRequestId(digestDate) },
          recipient: this.options.recipient,
          sourceId: `lead-digest:${digestDate}`,
          template: {
            kind: "landing-lead-digest",
            digestDate,
            leadsUrl: `${this.options.adminOrigin}/leads`,
            sections: LANDING_LEAD_DIGEST_SECTIONS.filter(
              (section) => sections[section].length > 0,
            ).map((section) => ({
              section,
              leads: sections[section].map((lead) => ({
                company: lead.company,
                leadUrl: leadUrl(this.options.adminOrigin, lead.id),
              })),
            })),
          },
        });
      }
      return "sent";
    });
  }

  private async digestCandidates(
    tx: Pick<Db, "execute">,
    now: Date,
  ): Promise<LeadDigestCandidate[]> {
    const rows = await tx.execute<{
      id: string;
      company: string | null;
      status: LandingLeadStatus;
      createdAt: Date | string;
      statusChangedAt: Date | string;
      nextTouchAt: Date | string | null;
      firstDownloadAt: Date | string | null;
    }>(sql`
      SELECT l.id::text AS id, l.company, l.status, l.created_at AS "createdAt",
        l.status_changed_at AS "statusChangedAt", l.next_touch_at AS "nextTouchAt",
        (SELECT min(e.created_at) FROM landing_lead_events AS e
         WHERE e.lead_id = l.id AND e.kind = 'download') AS "firstDownloadAt"
      FROM landing_leads AS l
      WHERE l.anonymized_at IS NULL AND l.status NOT IN ('won', 'lost')
        AND (l.status IN ('new', 'invoice_sent') OR l.next_touch_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM landing_lead_events AS recent
                     WHERE recent.lead_id = l.id AND recent.kind = 'download'
                       AND recent.created_at >= ${new Date(now.getTime() - 12 * 86_400_000)}))
      ORDER BY l.created_at, l.id
      LIMIT ${DIGEST_CANDIDATE_LIMIT}
    `);
    return rows.rows.map((row) => ({
      id: row.id,
      company: row.company ?? NO_COMPANY,
      status: row.status,
      createdAt: new Date(row.createdAt),
      statusChangedAt: new Date(row.statusChangedAt),
      nextTouchAt: row.nextTouchAt === null ? null : new Date(row.nextTouchAt),
      firstDownloadAt: row.firstDownloadAt === null ? null : new Date(row.firstDownloadAt),
    }));
  }

  /**
   * Retention (spec §15.2): lost leads after a month's grace, and leads without
   * movement for `LEAD_RETENTION_MONTHS`, lose their personal data.
   */
  async anonymizeStale(): Promise<number> {
    const now = this.now();
    const candidates = await this.db.execute<{ id: string; status: string }>(sql`
      SELECT id::text AS id, status FROM landing_leads
      WHERE anonymized_at IS NULL
        AND ((status = 'lost' AND status_changed_at < ${new Date(now.getTime() - LOST_GRACE_DAYS * 86_400_000)})
          OR updated_at < (${now}::timestamptz - make_interval(months => ${this.options.retentionMonths})))
      ORDER BY updated_at, id
      LIMIT ${ANONYMIZE_BATCH}
    `);
    let anonymized = 0;
    for (const candidate of candidates.rows) {
      const done = await this.db.transaction((tx) =>
        anonymizeLead(tx, this.audit, {
          leadId: candidate.id,
          reason: candidate.status === "lost" ? "lost" : "inactive",
          actor: null,
          now,
          createId: this.createId,
        }),
      );
      if (done) anonymized += 1;
    }
    return anonymized;
  }
}

function sectionIds(payload: Record<string, unknown>): Record<LandingLeadDigestSection, string[]> {
  const sections =
    payload.sections && typeof payload.sections === "object"
      ? (payload.sections as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    LANDING_LEAD_DIGEST_SECTIONS.map((section) => {
      const value = sections[section];
      return [
        section,
        Array.isArray(value)
          ? value.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))
          : [],
      ];
    }),
  ) as Record<LandingLeadDigestSection, string[]>;
}
