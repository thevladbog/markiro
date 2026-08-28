import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { renderEmail, type EmailTemplateInput, type RenderedEmail } from "@markiro/email";
import { z } from "zod";
import { MailCryptoService } from "./mail-crypto.service";
import type { MailTransport } from "./mail.types";
import { tenantBillingNotificationPayloadSchema } from "./tenant-billing-notification-payload";

export const SEND_EMAIL_DELIVERY_QUEUE = "send-email-delivery";
const MAX_DELIVERY_ATTEMPTS = 5;
const OUTBOX_BATCH_SIZE = 50;

export interface MailQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface MailPgClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<MailQueryResult<Row>>;
  release(error?: Error | boolean): void;
}

export interface MailPgPool {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<MailQueryResult<Row>>;
  connect(): Promise<MailPgClient>;
}

export interface MailQueue {
  send(
    name: string,
    data: { deliveryId: string },
    options: { id: string; singletonKey: string },
  ): Promise<string | null>;
}

type MailRenderer = (input: EmailTemplateInput) => Promise<RenderedEmail>;
type IdFactory = () => string;
type Clock = () => Date;

interface OutboxRow {
  id: string;
  deliveryId: string;
}

interface DeliveryRow {
  id: string;
  tenantId: string | null;
  userId: string | null;
  recipient: string;
  kind: string;
  sourceId: string | null;
  attemptCount: number;
  encryptedPayload: Buffer | null;
  payloadNonce: Buffer | null;
  payloadTag: Buffer | null;
}

export interface ClassifiedMailFailure {
  category:
    | "authentication"
    | "data_integrity"
    | "message"
    | "network"
    | "smtp_permanent"
    | "smtp_transient"
    | "transport_unknown";
  code: string;
  diagnostic: string;
  transient: boolean;
}

export class MailRetryError extends Error {
  constructor(message = "Email delivery should be retried") {
    super(message);
    this.name = "MailRetryError";
  }
}

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "action URL must use http(s)");

const emailTemplateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("organization-invitation"),
      recipientName: z.string().min(1),
      organizationName: z.string().min(1),
      inviterName: z.string().min(1),
      actionUrl: httpUrl,
      expiresAt: z.coerce.date(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("password-reset"),
      recipientName: z.string().min(1),
      actionUrl: httpUrl,
      expiresInMinutes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tenant-owner-activation"),
      recipientName: z.string().min(1),
      organizationName: z.string().min(1),
      actionUrl: httpUrl,
      expiresInMinutes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("platform-user-activation"),
      recipientName: z.string().min(1),
      actionUrl: httpUrl,
      expiresInMinutes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("email-verification"),
      recipientName: z.string().min(1),
      actionUrl: httpUrl,
      expiresInMinutes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("landing-demo-notification"),
      locale: z.enum(["ru", "en"]),
      requestId: z.uuid(),
      receivedAt: z.coerce.date(),
      sourcePath: z.string().min(1),
      consentVersion: z.string().trim().min(1).max(64),
      recipientName: z.string().min(1),
      company: z.string().min(1),
      email: z.email(),
      phone: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("landing-demo-confirmation"),
      locale: z.enum(["ru", "en"]),
      requestId: z.uuid(),
      recipientName: z.string().min(1),
      company: z.string().min(1),
      email: z.email(),
      phone: z.string().min(1).optional(),
      contactEmail: z.email(),
    })
    .strict(),
  tenantBillingNotificationPayloadSchema,
]);

function toEmailTemplateInput(input: z.output<typeof emailTemplateSchema>): EmailTemplateInput {
  if (input.kind !== "landing-demo-notification" && input.kind !== "landing-demo-confirmation") {
    return input;
  }
  const { phone, ...required } = input;
  return { ...required, ...(phone !== undefined ? { phone } : {}) };
}

@Injectable()
export class MailJobsService {
  readonly #logger = new Logger(MailJobsService.name);

  constructor(
    private readonly pool: MailPgPool,
    private readonly crypto: MailCryptoService,
    private readonly transport: MailTransport,
    private readonly renderer: MailRenderer = renderEmail,
    private readonly createId: IdFactory = randomUUID,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async dispatchOutbox(queue: MailQueue): Promise<number> {
    const client = await this.pool.connect();
    let published = 0;
    try {
      await client.query("BEGIN");
      const result = await client.query<OutboxRow>(
        [
          'SELECT id::text, delivery_id::text AS "deliveryId"',
          "FROM email_outbox",
          "WHERE published_at IS NULL",
          "ORDER BY created_at, id",
          "LIMIT $1",
          "FOR UPDATE SKIP LOCKED",
        ].join("\n"),
        [OUTBOX_BATCH_SIZE],
      );
      for (const row of result.rows) {
        try {
          await enqueueStableDelivery(queue, row.deliveryId);
          await client.query(
            [
              "UPDATE email_outbox",
              "SET published_at = now(), attempts = attempts + 1, last_error = null",
              "WHERE id = $1::uuid",
            ].join("\n"),
            [row.id],
          );
          published += 1;
        } catch {
          await client.query(
            [
              "UPDATE email_outbox",
              "SET attempts = attempts + 1, last_error = 'queue_unavailable'",
              "WHERE id = $1::uuid",
            ].join("\n"),
            [row.id],
          );
          this.#logger.warn("Could not publish an email outbox row; it remains retryable");
        }
      }
      await client.query("COMMIT");
      return published;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async processDelivery(deliveryId: string): Promise<void> {
    if (!z.uuid().safeParse(deliveryId).success) {
      this.#logger.warn("Ignoring malformed email delivery job id");
      return;
    }
    const result = await this.withDeliveryLock(deliveryId, async (client) => {
      const delivery = await this.claimDelivery(client, deliveryId);
      if (!delivery) return;

      if (
        delivery.kind === "organization-invitation" &&
        !(await this.sourceIsValid(client, delivery))
      ) {
        await this.cancelInvalidDelivery(client, delivery.id);
        return;
      }

      let template: EmailTemplateInput;
      let rendered: RenderedEmail;
      if (!delivery.encryptedPayload || !delivery.payloadNonce || !delivery.payloadTag) {
        await this.markPermanentFailure(client, delivery.id, {
          category: "data_integrity",
          code: "PAYLOAD_MISSING",
          diagnostic: "data_integrity:PAYLOAD_MISSING",
          transient: false,
        });
        return;
      }
      try {
        template = toEmailTemplateInput(
          emailTemplateSchema.parse(
            this.crypto.decrypt(delivery.id, {
              encryptedPayload: delivery.encryptedPayload,
              payloadNonce: delivery.payloadNonce,
              payloadTag: delivery.payloadTag,
            }),
          ),
        );
        rendered = await this.renderer(template);
      } catch {
        await this.markPermanentFailure(client, delivery.id, {
          category: "message",
          code: "RENDER",
          diagnostic: "message:RENDER",
          transient: false,
        });
        return;
      }

      if (!(await this.sourceIsValid(client, delivery, template))) {
        await this.cancelInvalidDelivery(client, delivery.id);
        return;
      }

      try {
        await this.transport.send(rendered, delivery.recipient);
      } catch (error) {
        const failure = classifyMailFailure(error);
        if (failure.transient && delivery.attemptCount < MAX_DELIVERY_ATTEMPTS) {
          await this.markRetrying(client, delivery.id, failure);
          throw new MailRetryError();
        }
        await this.markPermanentFailure(client, delivery.id, failure);
        return;
      }

      await client.query(
        [
          "UPDATE email_deliveries",
          "SET status = 'sent',",
          "    encrypted_payload = null, payload_nonce = null, payload_tag = null,",
          "    attempt_id = null, attempt_deadline = null,",
          "    error_category = null, error_code = null, error_text = null,",
          "    sent_at = now(), terminal_at = now(), updated_at = now()",
          "WHERE id = $1::uuid AND status = 'sending'",
        ].join("\n"),
        [delivery.id],
      );
    });
    if (!result.acquired) throw new MailRetryError("Email delivery lock is busy");
  }

  async reconcile(queue: MailQueue): Promise<number> {
    const candidates = await this.pool.query<{ id: string; status: string }>(
      [
        "SELECT id::text, status::text",
        "FROM email_deliveries",
        "WHERE (status IN ('queued', 'retrying') AND updated_at < now() - interval '5 minutes')",
        "   OR (status = 'sending' AND attempt_deadline < now())",
        "ORDER BY updated_at, id",
        "LIMIT 100",
      ].join("\n"),
    );
    let enqueued = 0;
    for (const candidate of candidates.rows) {
      if (candidate.status === "sending") {
        const reclaimed = await this.withDeliveryLock(candidate.id, async (client) => {
          const result = await client.query(
            [
              "UPDATE email_deliveries",
              "SET status = 'retrying', attempt_id = null, attempt_deadline = null, updated_at = now()",
              "WHERE id = $1::uuid AND status = 'sending' AND attempt_deadline < now()",
            ].join("\n"),
            [candidate.id],
          );
          return (result.rowCount ?? 0) > 0;
        });
        if (!reclaimed.acquired || !reclaimed.value) continue;
      }
      await enqueueStableDelivery(queue, candidate.id);
      enqueued += 1;
    }
    return enqueued;
  }

  async withDeliveryLock<T>(
    deliveryId: string,
    callback: (client: MailPgClient) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const client = await this.pool.connect();
    let acquired = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [deliveryId],
      );
      acquired = result.rows[0]?.locked === true;
      if (!acquired) return { acquired: false };
      return { acquired: true, value: await callback(client) };
    } finally {
      if (acquired) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [deliveryId])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  private async claimDelivery(
    client: MailPgClient,
    deliveryId: string,
  ): Promise<DeliveryRow | undefined> {
    const attemptId = this.createId();
    const result = await client.query<DeliveryRow>(
      [
        "UPDATE email_deliveries",
        "SET status = 'sending',",
        "    attempt_count = attempt_count + 1,",
        "    attempt_id = $2::uuid,",
        "    attempt_deadline = now() + interval '45 seconds',",
        "    updated_at = now()",
        "WHERE id = $1::uuid",
        "  AND (status IN ('queued', 'retrying')",
        "       OR (status = 'sending' AND attempt_deadline < now()))",
        'RETURNING id::text, tenant_id AS "tenantId", user_id AS "userId",',
        '          recipient, kind, source_id AS "sourceId", attempt_count AS "attemptCount",',
        '          encrypted_payload AS "encryptedPayload",',
        '          payload_nonce AS "payloadNonce", payload_tag AS "payloadTag"',
      ].join("\n"),
      [deliveryId, attemptId],
    );
    return result.rows[0];
  }

  private async sourceIsValid(
    client: MailPgClient,
    delivery: DeliveryRow,
    template?: EmailTemplateInput,
  ): Promise<boolean> {
    if (delivery.kind === "tenant-billing-notification") {
      if (!template || template.kind !== "tenant-billing-notification") return false;
      return this.billingSourceIsValid(client, delivery, template.eventKind);
    }
    if (delivery.kind !== "organization-invitation") return true;
    if (!delivery.tenantId || !delivery.sourceId) return false;
    const result = await client.query<{ valid: boolean }>(
      [
        "SELECT EXISTS (",
        "  SELECT 1 FROM invitation",
        "  WHERE id = $1",
        "    AND organization_id = $2",
        "    AND lower(email) = lower($3)",
        "    AND status = 'pending'",
        "    AND expires_at > now()",
        ") AS valid",
      ].join("\n"),
      [delivery.sourceId, delivery.tenantId, delivery.recipient],
    );
    return result.rows[0]?.valid === true;
  }

  private async billingSourceIsValid(
    client: MailPgClient,
    delivery: DeliveryRow,
    eventKind: Extract<EmailTemplateInput, { kind: "tenant-billing-notification" }>["eventKind"],
  ): Promise<boolean> {
    if (!delivery.tenantId || !delivery.sourceId) return false;
    const sourceParts = delivery.sourceId.split(":");
    const [namespace, sourceEventKind, entityId, revision] = sourceParts;
    if (
      sourceParts.length !== 4 ||
      namespace !== "billing" ||
      sourceEventKind !== eventKind ||
      !z.uuid().safeParse(entityId).success ||
      !revision
    ) {
      return false;
    }

    let query: string;
    let values: readonly unknown[];
    if (eventKind === "clarification_required") {
      if (!z.uuid().safeParse(revision).success) return false;
      query = [
        "SELECT EXISTS (",
        "  SELECT 1 FROM tenant_billing_requests AS request",
        "  JOIN tenant_billing_request_events AS event",
        "    ON event.tenant_id = request.tenant_id AND event.request_id = request.id",
        "  WHERE request.id = $1::uuid AND request.tenant_id = $2",
        "    AND request.status = 'clarification_required'",
        "    AND event.id = $3::uuid AND event.kind = 'status_changed'",
        "    AND event.to_status = 'clarification_required'",
        ") AS valid",
      ].join("\n");
      values = [entityId, delivery.tenantId, revision];
    } else if (eventKind === "offer_published") {
      const numericRevision = positiveRevision(revision);
      if (numericRevision === null) return false;
      query = [
        "SELECT EXISTS (",
        "  SELECT 1 FROM commercial_offers AS offer",
        "  WHERE offer.id = $1::uuid AND offer.tenant_id = $2 AND offer.revision = $3",
        "    AND offer.status = 'published'",
        "    AND (offer.expires_at IS NULL OR offer.expires_at > $4::timestamptz)",
        "    AND NOT EXISTS (SELECT 1 FROM commercial_offer_decisions AS decision",
        "                    WHERE decision.tenant_id = offer.tenant_id AND decision.offer_id = offer.id)",
        "    AND NOT EXISTS (SELECT 1 FROM commercial_offers AS newer",
        "                    WHERE newer.tenant_id = offer.tenant_id",
        "                      AND newer.family_id = offer.family_id",
        "                      AND newer.status = 'published' AND newer.revision > offer.revision)",
        "    AND NOT EXISTS (SELECT 1 FROM commercial_offers AS terminal_revision",
        "                    WHERE terminal_revision.tenant_id = offer.tenant_id",
        "                      AND terminal_revision.family_id = offer.family_id",
        "                      AND terminal_revision.revision > offer.revision",
        "                      AND terminal_revision.status IN ('superseded', 'paid', 'cancelled', 'expired'))",
        ") AS valid",
      ].join("\n");
      values = [entityId, delivery.tenantId, numericRevision, this.clock()];
    } else if (eventKind === "invoice_due_soon") {
      if (revision !== "1") return false;
      query = [
        "SELECT EXISTS (",
        "  SELECT 1 FROM invoices AS invoice",
        "  WHERE invoice.id = $1::uuid AND invoice.tenant_id = $2",
        "    AND invoice.status IN ('issued', 'partially_paid')",
        "    AND (invoice.due_date AT TIME ZONE 'Europe/Moscow')::date >= $3::date",
        "    AND (invoice.due_date AT TIME ZONE 'Europe/Moscow')::date <= ($3::date + 7)",
        ") AS valid",
      ].join("\n");
      values = [entityId, delivery.tenantId, businessDate(this.clock())];
    } else {
      const numericRevision = positiveRevision(revision);
      if (numericRevision === null) return false;
      query = [
        "SELECT EXISTS (",
        "  SELECT 1 FROM billing_acts AS act",
        "  JOIN billing_act_documents AS document",
        "    ON document.tenant_id = act.tenant_id AND document.act_id = act.id",
        "  WHERE act.id = $1::uuid AND act.tenant_id = $2 AND act.status = 'issued'",
        "    AND document.revision = $3 AND document.is_current = true",
        "    AND document.state = 'ready' AND document.ready_at IS NOT NULL",
        ") AS valid",
      ].join("\n");
      values = [entityId, delivery.tenantId, numericRevision];
    }
    const result = await client.query<{ valid: boolean }>(query, values);
    return result.rows[0]?.valid === true;
  }

  private async cancelInvalidDelivery(client: MailPgClient, deliveryId: string): Promise<void> {
    await client.query(
      [
        "UPDATE email_deliveries",
        "SET status = 'canceled',",
        "    encrypted_payload = null, payload_nonce = null, payload_tag = null,",
        "    attempt_id = null, attempt_deadline = null,",
        "    error_category = null, error_code = null, error_text = null,",
        "    terminal_at = now(), updated_at = now()",
        "WHERE id = $1::uuid AND status = 'sending'",
      ].join("\n"),
      [deliveryId],
    );
  }

  private async markRetrying(
    client: MailPgClient,
    deliveryId: string,
    failure: ClassifiedMailFailure,
  ): Promise<void> {
    await this.writeFailure(client, deliveryId, failure, "retrying");
  }

  private async markPermanentFailure(
    client: MailPgClient,
    deliveryId: string,
    failure: ClassifiedMailFailure,
  ): Promise<void> {
    await this.writeFailure(client, deliveryId, failure, "failed");
  }

  private async writeFailure(
    client: MailPgClient,
    deliveryId: string,
    failure: ClassifiedMailFailure,
    status: "retrying" | "failed",
  ): Promise<void> {
    await client.query(
      [
        "UPDATE email_deliveries",
        "SET status = $2::email_delivery_status,",
        "    attempt_id = null, attempt_deadline = null,",
        "    error_category = $3, error_code = $4, error_text = $5,",
        "    terminal_at = CASE WHEN $2 = 'failed' THEN now() ELSE null END,",
        "    updated_at = now()",
        "WHERE id = $1::uuid AND status = 'sending'",
      ].join("\n"),
      [deliveryId, status, failure.category, failure.code, failure.diagnostic],
    );
  }
}

function positiveRevision(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

function businessDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function enqueueStableDelivery(queue: MailQueue, deliveryId: string): Promise<void> {
  await queue.send(
    SEND_EMAIL_DELIVERY_QUEUE,
    { deliveryId },
    { id: deliveryId, singletonKey: "delivery:" + deliveryId },
  );
}

export function classifyMailFailure(error: unknown): ClassifiedMailFailure {
  const details = asErrorDetails(error);
  if (details.code === "EAUTH") return classified("authentication", details.code, false);
  if (details.code === "EMESSAGE" || details.code === "EENVELOPE") {
    return classified("message", details.code, false);
  }
  if (details.responseCode >= 500 && details.responseCode <= 599) {
    return classified("smtp_permanent", String(details.responseCode), false);
  }
  if (details.responseCode >= 400 && details.responseCode <= 499) {
    return classified("smtp_transient", String(details.responseCode), true);
  }
  if (["ECONNECTION", "ECONNRESET", "EAI_AGAIN", "ESOCKET", "ETIMEDOUT"].includes(details.code)) {
    return classified("network", details.code, true);
  }
  return classified("transport_unknown", details.code, true);
}

function classified(
  category: ClassifiedMailFailure["category"],
  code: string,
  transient: boolean,
): ClassifiedMailFailure {
  const safeCode = /^[A-Z0-9_]{1,32}$/.test(code) || /^\d{3}$/.test(code) ? code : "UNKNOWN";
  return {
    category,
    code: safeCode,
    diagnostic: category + ":" + safeCode,
    transient,
  };
}

function asErrorDetails(error: unknown): { code: string; responseCode: number } {
  if (!error || typeof error !== "object") return { code: "UNKNOWN", responseCode: 0 };
  const value = error as { code?: unknown; responseCode?: unknown };
  return {
    code: typeof value.code === "string" ? value.code.toUpperCase() : "UNKNOWN",
    responseCode: typeof value.responseCode === "number" ? value.responseCode : 0,
  };
}
