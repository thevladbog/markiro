import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { renderEmail, type EmailTemplateInput, type RenderedEmail } from "@markiro/email";
import { z } from "zod";
import { MailCryptoService } from "./mail-crypto.service";
import type { EncryptedMailPayload, MailTransport } from "./mail.types";

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
  release(): void;
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

interface OutboxRow {
  id: string;
  deliveryId: string;
}

interface DeliveryRow extends EncryptedMailPayload {
  id: string;
  tenantId: string | null;
  userId: string | null;
  recipient: string;
  kind: string;
  sourceId: string | null;
  attemptCount: number;
}

export interface ClassifiedMailFailure {
  category:
    | "authentication"
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
      kind: z.literal("email-verification"),
      recipientName: z.string().min(1),
      actionUrl: httpUrl,
      expiresInMinutes: z.number().int().positive(),
    })
    .strict(),
]);

@Injectable()
export class MailJobsService {
  readonly #logger = new Logger(MailJobsService.name);

  constructor(
    private readonly pool: MailPgPool,
    private readonly crypto: MailCryptoService,
    private readonly transport: MailTransport,
    private readonly renderer: MailRenderer = renderEmail,
    private readonly createId: IdFactory = randomUUID,
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

      if (!(await this.sourceIsValid(client, delivery))) {
        await this.cancelInvalidDelivery(client, delivery.id);
        return;
      }

      let template: EmailTemplateInput;
      let rendered: RenderedEmail;
      try {
        template = emailTemplateSchema.parse(this.crypto.decrypt(delivery.id, delivery));
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

      if (!(await this.sourceIsValid(client, delivery))) {
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

  private async sourceIsValid(client: MailPgClient, delivery: DeliveryRow): Promise<boolean> {
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
