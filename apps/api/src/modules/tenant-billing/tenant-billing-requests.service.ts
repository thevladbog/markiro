import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { tenantBillingRequestAttachmentObjectKey } from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import type { CreateBillingRequestDto, RequestReplyDto } from "./dto";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
]);

export interface BillingAttachmentUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class TenantBillingRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  async create(tenantId: string, userId: string, input: CreateBillingRequestDto) {
    return this.db.transaction(async (tx) => {
      await lockIdempotency(tx, tenantId, input.idempotencyKey);
      const [existing] = await tx
        .select()
        .from(schema.tenantBillingRequests)
        .where(
          and(
            eq(schema.tenantBillingRequests.tenantId, tenantId),
            eq(schema.tenantBillingRequests.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (!sameRequestPayload(existing, input)) idempotencyConflict();
        return this.detailWith(tx, tenantId, existing.id);
      }

      const sequence = await tx.execute<{ value: string }>(
        sql`select nextval('tenant_billing_request_number_seq')::text as value`,
      );
      const value = sequence.rows[0]?.value;
      if (!value) throw new Error("billing request sequence did not return a value");
      const number = `BR-${value.padStart(6, "0")}`;
      const description = input.description.trim();
      const desiredAt = input.desiredAt ? new Date(input.desiredAt) : null;
      const context = input.context
        ? { type: input.context.type.trim(), id: input.context.id.trim() }
        : null;
      const [request] = await tx
        .insert(schema.tenantBillingRequests)
        .values({
          tenantId,
          number,
          type: input.type,
          description,
          desiredAt,
          contextType: context?.type ?? null,
          contextId: context?.id ?? null,
          idempotencyKey: input.idempotencyKey,
          createdByUserId: userId,
        })
        .returning();
      if (!request) throw new Error("billing request insert failed");
      await tx.insert(schema.tenantBillingRequestEvents).values({
        tenantId,
        requestId: request.id,
        kind: "created",
        actorKind: "tenant_user",
        actorUserId: userId,
        idempotencyKey: input.idempotencyKey,
        metadata: { type: request.type },
      });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action: "billing.request.created",
        outcome: "success",
        targetType: "tenant_billing_request",
        targetId: request.id,
        before: null,
        after: {
          number,
          type: request.type,
          status: request.status,
          desiredAt: desiredAt?.toISOString() ?? null,
          context,
        },
      });
      return this.detailWith(tx, tenantId, request.id);
    });
  }

  async list(tenantId: string) {
    const rows = await this.db
      .select()
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.tenantId, tenantId))
      .orderBy(desc(schema.tenantBillingRequests.updatedAt), desc(schema.tenantBillingRequests.id));
    return { items: rows.map(requestSource) };
  }

  async detail(tenantId: string, requestId: string) {
    return this.detailWith(this.db, tenantId, requestId);
  }

  async reply(tenantId: string, userId: string, requestId: string, input: RequestReplyDto) {
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(schema.tenantBillingRequests)
        .where(
          and(
            eq(schema.tenantBillingRequests.tenantId, tenantId),
            eq(schema.tenantBillingRequests.id, requestId),
          ),
        )
        .for("update")
        .limit(1);
      if (!request) requestNotFound();
      await lockIdempotency(tx, tenantId, input.idempotencyKey);
      const [existing] = await tx
        .select()
        .from(schema.tenantBillingRequestEvents)
        .where(
          and(
            eq(schema.tenantBillingRequestEvents.tenantId, tenantId),
            eq(schema.tenantBillingRequestEvents.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const message = input.message.trim();
      if (existing) {
        if (
          existing.requestId !== requestId ||
          existing.kind !== "tenant_reply" ||
          existing.message !== message
        ) {
          idempotencyConflict();
        }
        return eventSource(existing);
      }
      if (request.status !== "clarification_required") {
        throw new ConflictException({ code: "billing_request_not_awaiting_clarification" });
      }
      const [event] = await tx
        .insert(schema.tenantBillingRequestEvents)
        .values({
          tenantId,
          requestId,
          kind: "tenant_reply",
          actorKind: "tenant_user",
          actorUserId: userId,
          message,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!event) throw new Error("billing request reply insert failed");
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action: "billing.request.replied",
        outcome: "success",
        targetType: "tenant_billing_request",
        targetId: requestId,
        before: { status: request.status },
        after: { status: request.status, eventId: event.id },
      });
      return eventSource(event);
    });
  }

  async attach(
    tenantId: string,
    userId: string,
    requestId: string,
    idempotencyKey: string,
    file: BillingAttachmentUpload,
  ) {
    validateBillingAttachment(file);
    const fileName = safeFileName(file.originalname);
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const intent = await this.db.transaction(async (tx) => {
      await lockIdempotency(tx, tenantId, `attachment:${requestId}:${idempotencyKey}`);
      const [locked] = await tx
        .select({ id: schema.tenantBillingRequests.id })
        .from(schema.tenantBillingRequests)
        .where(
          and(
            eq(schema.tenantBillingRequests.tenantId, tenantId),
            eq(schema.tenantBillingRequests.id, requestId),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) requestNotFound();
      const [existing] = await tx
        .select()
        .from(schema.tenantBillingRequestAttachments)
        .where(
          and(
            eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
            eq(schema.tenantBillingRequestAttachments.requestId, requestId),
            eq(schema.tenantBillingRequestAttachments.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.fileName !== fileName ||
          existing.contentType !== file.mimetype ||
          existing.byteSize !== file.buffer.byteLength ||
          existing.sha256 !== sha256
        ) {
          idempotencyConflict();
        }
        if (existing.state === "ready") return { attachment: existing, upload: false } as const;
        if (existing.state === "cleanup_required") {
          throw new ConflictException({ code: "billing_attachment_cleanup_required" });
        }
        if (existing.state === "failed") {
          const [pending] = await tx
            .update(schema.tenantBillingRequestAttachments)
            .set({ state: "pending", updatedAt: new Date() })
            .where(
              and(
                eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
                eq(schema.tenantBillingRequestAttachments.requestId, requestId),
                eq(schema.tenantBillingRequestAttachments.id, existing.id),
                eq(schema.tenantBillingRequestAttachments.state, "failed"),
              ),
            )
            .returning();
          if (!pending) throw new Error("billing attachment retry transition failed");
          return { attachment: pending, upload: true } as const;
        }
        return { attachment: existing, upload: true } as const;
      }
      const attachmentId = randomUUID();
      const objectKey = tenantBillingRequestAttachmentObjectKey(tenantId, requestId, attachmentId);
      const [created] = await tx
        .insert(schema.tenantBillingRequestAttachments)
        .values({
          id: attachmentId,
          tenantId,
          requestId,
          idempotencyKey,
          fileName,
          contentType: file.mimetype,
          byteSize: file.buffer.byteLength,
          sha256,
          objectKey,
          state: "pending",
          uploadedByUserId: userId,
        })
        .returning();
      if (!created) throw new Error("billing attachment intent insert failed");
      return { attachment: created, upload: true } as const;
    });
    if (!intent.upload) return attachmentSource(intent.attachment);
    const attachmentId = intent.attachment.id;
    const objectKey = intent.attachment.objectKey;

    try {
      await this.storage.putVerified(objectKey, file.buffer, file.mimetype, sha256);
    } catch (error) {
      let recovered = false;
      try {
        const verification = await this.storage.verifyObject(
          objectKey,
          file.buffer.byteLength,
          sha256,
        );
        if (verification === "verified") {
          recovered = true;
        } else if (verification === "missing") {
          await this.markAttachmentState(tenantId, requestId, attachmentId, "failed");
        } else {
          let state: "failed" | "cleanup_required" = "failed";
          try {
            await this.storage.deleteConfirmed(objectKey);
          } catch {
            state = "cleanup_required";
          }
          await this.markAttachmentState(tenantId, requestId, attachmentId, state);
        }
      } catch {
        // The pending intent is the durable reconciliation record. Never mask
        // the storage error with a second HEAD or database failure.
      }
      if (!recovered) throw error;
    }

    try {
      return await this.finalizeAttachment(tenantId, requestId, attachmentId);
    } catch (error) {
      const committed = await this.readAttachment(tenantId, requestId, attachmentId).catch(
        () => null,
      );
      if (committed?.state === "ready") return attachmentSource(committed);
      if (committed?.state === "pending") {
        try {
          const verification = await this.storage.verifyObject(
            objectKey,
            file.buffer.byteLength,
            sha256,
          );
          if (verification === "verified") {
            try {
              return await this.finalizeAttachment(tenantId, requestId, attachmentId);
            } catch {
              const retried = await this.readAttachment(tenantId, requestId, attachmentId).catch(
                () => null,
              );
              if (retried?.state === "ready") return attachmentSource(retried);
            }
          }
        } catch {
          // Preserve the original transaction failure. The pending row and
          // canonical key are sufficient for a later reconciliation attempt.
        }
      }
      throw error;
    }
  }

  async downloadAttachment(tenantId: string, requestId: string, attachmentId: string) {
    const [attachment] = await this.db
      .select()
      .from(schema.tenantBillingRequestAttachments)
      .where(
        and(
          eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
          eq(schema.tenantBillingRequestAttachments.requestId, requestId),
          eq(schema.tenantBillingRequestAttachments.id, attachmentId),
          eq(schema.tenantBillingRequestAttachments.state, "ready"),
        ),
      )
      .limit(1);
    const expectedKey = tenantBillingRequestAttachmentObjectKey(tenantId, requestId, attachmentId);
    if (!attachment || attachment.objectKey !== expectedKey) attachmentNotFound();
    return {
      url: await this.storage.presignRead(attachment.objectKey, 300, {
        downloadFilename: attachment.fileName,
      }),
    };
  }

  private async finalizeAttachment(tenantId: string, requestId: string, attachmentId: string) {
    return this.db.transaction(async (tx) => {
      const [attachment] = await tx
        .select()
        .from(schema.tenantBillingRequestAttachments)
        .where(
          and(
            eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
            eq(schema.tenantBillingRequestAttachments.requestId, requestId),
            eq(schema.tenantBillingRequestAttachments.id, attachmentId),
          ),
        )
        .for("update")
        .limit(1);
      if (!attachment) attachmentNotFound();
      if (attachment.state === "ready") return attachmentSource(attachment);
      if (attachment.state !== "pending") {
        throw new Error("billing attachment is not pending verification");
      }
      const now = new Date();
      const [ready] = await tx
        .update(schema.tenantBillingRequestAttachments)
        .set({ state: "ready", readyAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
            eq(schema.tenantBillingRequestAttachments.requestId, requestId),
            eq(schema.tenantBillingRequestAttachments.id, attachmentId),
            eq(schema.tenantBillingRequestAttachments.state, "pending"),
          ),
        )
        .returning();
      if (!ready) throw new Error("billing attachment ready transition failed");
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: ready.uploadedByUserId,
        action: "billing.request.attachment_uploaded",
        outcome: "success",
        targetType: "tenant_billing_request_attachment",
        targetId: ready.id,
        before: null,
        after: {
          requestId,
          contentType: ready.contentType,
          byteSize: ready.byteSize,
          sha256: ready.sha256,
        },
      });
      return attachmentSource(ready);
    });
  }

  private async readAttachment(tenantId: string, requestId: string, attachmentId: string) {
    const [attachment] = await this.db
      .select()
      .from(schema.tenantBillingRequestAttachments)
      .where(
        and(
          eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
          eq(schema.tenantBillingRequestAttachments.requestId, requestId),
          eq(schema.tenantBillingRequestAttachments.id, attachmentId),
        ),
      )
      .limit(1);
    return attachment ?? null;
  }

  private async markAttachmentState(
    tenantId: string,
    requestId: string,
    attachmentId: string,
    state: "failed" | "cleanup_required",
  ) {
    await this.db
      .update(schema.tenantBillingRequestAttachments)
      .set({ state, updatedAt: new Date() })
      .where(
        and(
          eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
          eq(schema.tenantBillingRequestAttachments.requestId, requestId),
          eq(schema.tenantBillingRequestAttachments.id, attachmentId),
          eq(schema.tenantBillingRequestAttachments.state, "pending"),
        ),
      );
  }

  private async detailWith(db: Pick<Db, "select">, tenantId: string, requestId: string) {
    const [request] = await db
      .select()
      .from(schema.tenantBillingRequests)
      .where(
        and(
          eq(schema.tenantBillingRequests.tenantId, tenantId),
          eq(schema.tenantBillingRequests.id, requestId),
        ),
      )
      .limit(1);
    if (!request) requestNotFound();
    // `detailWith` also runs inside request-creation transactions. Keep these
    // reads sequential: node-postgres transaction clients do not support
    // overlapping `query()` calls on one connection.
    const events = await db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.tenantId, tenantId),
          eq(schema.tenantBillingRequestEvents.requestId, requestId),
        ),
      )
      .orderBy(
        asc(schema.tenantBillingRequestEvents.createdAt),
        asc(schema.tenantBillingRequestEvents.id),
      );
    const attachments = await db
      .select()
      .from(schema.tenantBillingRequestAttachments)
      .where(
        and(
          eq(schema.tenantBillingRequestAttachments.tenantId, tenantId),
          eq(schema.tenantBillingRequestAttachments.requestId, requestId),
          eq(schema.tenantBillingRequestAttachments.state, "ready"),
        ),
      )
      .orderBy(
        asc(schema.tenantBillingRequestAttachments.createdAt),
        asc(schema.tenantBillingRequestAttachments.id),
      );
    const links = await db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(
        and(
          eq(schema.tenantBillingRequestLinks.tenantId, tenantId),
          eq(schema.tenantBillingRequestLinks.requestId, requestId),
        ),
      )
      .orderBy(
        asc(schema.tenantBillingRequestLinks.createdAt),
        asc(schema.tenantBillingRequestLinks.id),
      );
    return {
      ...requestSource(request),
      events: events.map(eventSource),
      attachments: attachments.map(attachmentSource),
      links: links.map((link) => ({
        id: link.id,
        offerId: link.offerId,
        invoiceId: link.invoiceId,
        paymentId: link.paymentId,
        actId: link.actId,
        orderedServiceId: link.orderedServiceId,
        subscriptionEventId: link.subscriptionEventId,
        createdAt: link.createdAt.toISOString(),
      })),
    };
  }
}

export function validateBillingAttachment(file: BillingAttachmentUpload): void {
  if (
    !Number.isInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_ATTACHMENT_BYTES ||
    file.size !== file.buffer.byteLength
  ) {
    throw new BadRequestException({ code: "billing_attachment_size_invalid" });
  }
  if (!ALLOWED_ATTACHMENT_MIME.has(file.mimetype)) {
    throw new BadRequestException({ code: "billing_attachment_type_invalid" });
  }
  const valid =
    (file.mimetype === "application/pdf" &&
      file.buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) ||
    (file.mimetype === "image/png" &&
      file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (file.mimetype === "image/jpeg" &&
      file.buffer[0] === 0xff &&
      file.buffer[1] === 0xd8 &&
      file.buffer[2] === 0xff &&
      file.buffer.at(-2) === 0xff &&
      file.buffer.at(-1) === 0xd9) ||
    (file.mimetype === "text/plain" && isPlainUtf8(file.buffer));
  if (!valid) throw new BadRequestException({ code: "billing_attachment_content_invalid" });
}

function isPlainUtf8(body: Buffer): boolean {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return !value.includes("\u0000");
  } catch {
    return false;
  }
}

function safeFileName(original: string): string {
  const leaf = original.replaceAll("\\", "/").split("/").at(-1) ?? "attachment";
  const normalized = Array.from(leaf, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? "_" : character;
  })
    .join("")
    .trim()
    .slice(0, 255);
  return normalized || "attachment";
}

async function lockIdempotency(db: Pick<Db, "execute">, tenantId: string, key: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-billing:${tenantId}:${key}`}, 0))`,
  );
}

function sameRequestPayload(
  existing: typeof schema.tenantBillingRequests.$inferSelect,
  input: CreateBillingRequestDto,
) {
  return (
    existing.type === input.type &&
    existing.description === input.description.trim() &&
    (existing.desiredAt?.toISOString() ?? null) ===
      (input.desiredAt ? new Date(input.desiredAt).toISOString() : null) &&
    existing.contextType === (input.context?.type.trim() ?? null) &&
    existing.contextId === (input.context?.id.trim() ?? null)
  );
}

function requestSource(request: typeof schema.tenantBillingRequests.$inferSelect) {
  return {
    id: request.id,
    number: request.number,
    type: request.type,
    status: request.status,
    description: request.description,
    desiredAt: request.desiredAt?.toISOString() ?? null,
    context:
      request.contextType && request.contextId
        ? { type: request.contextType, id: request.contextId }
        : null,
    responsibleSide: request.responsibleSide,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

function eventSource(event: typeof schema.tenantBillingRequestEvents.$inferSelect) {
  return {
    id: event.id,
    kind: event.kind,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actorKind: event.actorKind,
    message: event.message,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  };
}

function attachmentSource(attachment: typeof schema.tenantBillingRequestAttachments.$inferSelect) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    sha256: attachment.sha256,
    createdAt: attachment.createdAt.toISOString(),
  };
}

function idempotencyConflict(): never {
  throw new ConflictException({ code: "idempotency_key_reused" });
}
function requestNotFound(): never {
  throw new NotFoundException({ code: "billing_request_not_found" });
}
function attachmentNotFound(): never {
  throw new NotFoundException({ code: "billing_attachment_not_found" });
}
