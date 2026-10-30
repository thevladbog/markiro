import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { sql } from "drizzle-orm";
import type { MailDeliveryService } from "../mail/mail-delivery.service";
import type { LandingLeadDto } from "./landing-lead.schema";
import {
  insertLeadEvent,
  insertLeadNotification,
  leadRequestSeen,
  leadUrl,
  upsertLead,
} from "./landing-lead-writer";

export interface LandingLeadRepositoryOptions {
  /** The owner's inbox (`LANDING_DEMO_RECIPIENT`). */
  recipient: string;
  /** Contact shown to the visitor (`LANDING_DEMO_REPLY_TO`). */
  replyTo: string;
  /** `LANDING_ORIGIN`: the download e-mail links to `<origin>/skachat/`. */
  landingOrigin: string;
  /** `SAAS_ADMIN_ORIGIN`: lead card links. */
  adminOrigin: string;
}

type MailWriter = Pick<MailDeliveryService, "enqueue">;

/**
 * Accepts one landing form in one transaction (spec §15.3): the lead upsert, its event,
 * both e-mails and the Telegram outbox row commit together or not at all. The event's
 * `public_request_id` makes a retried `requestId` a no-op.
 */
export class LandingLeadRepository {
  constructor(
    private readonly db: Db,
    private readonly mail: MailWriter,
    private readonly options: LandingLeadRepositoryOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async accept(input: LandingLeadDto): Promise<"created" | "existing"> {
    const requestId = input.requestId.toLowerCase();
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`landing-lead-request:${requestId}`}, 0))`,
      );
      if (await leadRequestSeen(tx, requestId)) return "existing";

      const receivedAt = this.now();
      const { leadId, created } = await upsertLead(
        tx,
        {
          email: input.email,
          ...optional("company", input.company),
          locale: input.locale,
          sourcePath: input.sourcePath,
          ...optional("name", input.name),
          ...optional("phone", input.phone),
          ...optional("inn", input.inn),
          ...optional("productGroup", input.productGroup),
          ...optional("linesBucket", input.linesBucket),
          ...optional("utm", input.utm),
          ...optional("referrer", input.referrer),
        },
        receivedAt,
        this.createId,
      );
      const invoice = input.intent === "invoice";
      const eventId = await insertLeadEvent(
        tx,
        {
          leadId,
          kind: invoice ? "invoice_request" : "download",
          publicRequestId: requestId,
          payload: {
            sourcePath: input.sourcePath,
            locale: input.locale,
            ...optional("inn", invoice ? input.inn : undefined),
            ...optional("tariffCode", input.tariffCode),
            ...optional("productGroup", input.productGroup),
            ...optional("linesBucket", input.linesBucket),
            ...optional("utm", input.utm),
            ...optional("referrer", input.referrer),
          },
        },
        receivedAt,
        this.createId,
      );

      const scope = { publicRequestId: requestId };
      if (invoice) {
        if (input.inn === undefined || input.tariffCode === undefined) {
          throw new Error("Invoice lead without INN or tariff passed validation");
        }
        await this.mail.enqueue(tx, {
          scope,
          recipient: input.email,
          sourceId: requestId,
          template: {
            kind: "landing-invoice-request-confirmation",
            locale: input.locale,
            ...optional("company", input.company),
            inn: input.inn,
            tariffCode: input.tariffCode,
            email: input.email,
            contactEmail: this.options.replyTo,
          },
        });
      } else {
        if (input.company === undefined) {
          throw new Error("Download lead without a company passed validation");
        }
        await this.mail.enqueue(tx, {
          scope,
          recipient: input.email,
          sourceId: requestId,
          template: {
            kind: "landing-download-link",
            locale: input.locale,
            company: input.company,
            downloadPageUrl: `${this.options.landingOrigin.replace(/\/$/, "")}/skachat/?installer=1${input.tariffCode === undefined ? "" : `&tariff=${encodeURIComponent(input.tariffCode)}`}`,
            contactEmail: this.options.replyTo,
          },
        });
      }
      await this.mail.enqueue(tx, {
        scope,
        recipient: this.options.recipient,
        sourceId: requestId,
        template: {
          kind: "landing-lead-notification",
          intent: input.intent,
          locale: input.locale,
          requestId,
          receivedAt,
          sourcePath: input.sourcePath,
          consentVersion: input.consentVersion,
          ...optional("company", input.company),
          email: input.email,
          ...optional("name", input.name),
          ...optional("phone", input.phone),
          ...optional("inn", input.inn),
          ...optional("tariffCode", input.tariffCode),
          ...optional("productGroup", input.productGroup),
          ...optional("linesBucket", input.linesBucket),
          ...optional("utm", input.utm),
          ...optional("referrer", input.referrer),
          firstContact: created,
          leadUrl: leadUrl(this.options.adminOrigin, leadId),
        },
      });
      await insertLeadNotification(
        tx,
        { leadId, eventId, kind: invoice ? "invoice_request" : "new_lead", firstContact: created },
        receivedAt,
        this.createId,
      );
      return "created";
    });
  }
}

/** `{ key: value }` when the value is present, `{}` otherwise (`exactOptionalPropertyTypes`). */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}
