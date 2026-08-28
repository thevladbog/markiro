import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { tenantBillingRequestAttachmentObjectKey } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import {
  TenantBillingRequestsService,
  validateBillingAttachment,
} from "../src/modules/tenant-billing/tenant-billing-requests.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("tenant billing requests isolated Postgres service", () => {
  const databaseName = `markiro_tenant_billing_requests_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  const storage = {
    putVerified: vi.fn(
      async (_key: string, body: Buffer, _contentType: string, sha256: string) => ({
        byteSize: body.byteLength,
        sha256,
      }),
    ),
    verifyObject: vi.fn(async (): Promise<"verified" | "missing" | "mismatch"> => "verified"),
    deleteConfirmed: vi.fn(async () => undefined),
    presignRead: vi.fn(async () => "https://private.example.test/request-attachment"),
  };

  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let service: TenantBillingRequestsService;

  beforeEach(() => {
    storage.putVerified
      .mockReset()
      .mockImplementation(
        async (_key: string, body: Buffer, _contentType: string, sha256: string) => ({
          byteSize: body.byteLength,
          sha256,
        }),
      );
    storage.verifyObject.mockReset().mockResolvedValue("verified");
    storage.deleteConfirmed.mockReset().mockResolvedValue(undefined);
    storage.presignRead
      .mockReset()
      .mockResolvedValue("https://private.example.test/request-attachment");
  });

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString());
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    tenantA = await createOrganization(db);
    tenantB = await createOrganization(db);
    userA = `billing-request-${randomUUID()}`;
    userB = `billing-request-${randomUUID()}`;
    await db.insert(schema.user).values(
      [userA, userB].map((id) => ({
        id,
        name: "Billing requester",
        email: `${id}@example.invalid`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    service = new TenantBillingRequestsService(db, storage as unknown as ObjectStorageService);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  it("creates one numbered request, initial event, and exact tenant audit fact transactionally", async () => {
    const idempotencyKey = randomUUID();
    const input = {
      type: "capacity_change" as const,
      description: "  Add two lines  ",
      desiredAt: "2026-09-10T03:00:00.000+03:00",
      context: { type: "limit", id: "lines" },
      idempotencyKey,
    };

    const created = await service.create(tenantA, userA, input);
    const replay = await service.create(tenantA, userA, input);
    const crossActorReplay = await service.create(tenantA, userB, input);

    expect(replay.id).toBe(created.id);
    expect(crossActorReplay.id).toBe(created.id);
    expect(created).toMatchObject({
      number: "BR-000001",
      type: "capacity_change",
      status: "new",
      description: "Add two lines",
      desiredAt: "2026-09-10T00:00:00.000Z",
      context: { type: "limit", id: "lines" },
    });
    const events = await db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.tenantId, tenantA),
          eq(schema.tenantBillingRequestEvents.requestId, created.id),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "created",
      actorKind: "tenant_user",
      actorUserId: userA,
      idempotencyKey,
    });
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantA),
          eq(schema.tenantAuditEvents.targetId, created.id),
        ),
      );
    expect(audits).toEqual([
      expect.objectContaining({
        organizationId: tenantA,
        actorUserId: userA,
        action: "billing.request.created",
        outcome: "success",
        targetType: "tenant_billing_request",
        targetId: created.id,
        before: null,
        after: {
          number: "BR-000001",
          type: "capacity_change",
          status: "new",
          desiredAt: "2026-09-10T00:00:00.000Z",
          context: { type: "limit", id: "lines" },
        },
      }),
    ]);
    await expect(
      service.create(tenantA, userA, { ...input, description: "Different" }),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });
  });

  it("serializes concurrent request retries and assigns distinct server sequence numbers", async () => {
    const sharedKey = randomUUID();
    const input = {
      type: "renewal" as const,
      description: "Concurrent renewal",
      idempotencyKey: sharedKey,
    };
    const [first, retry] = await Promise.all([
      service.create(tenantA, userA, input),
      service.create(tenantA, userA, input),
    ]);
    expect(first.id).toBe(retry.id);

    const [left, right] = await Promise.all([
      service.create(tenantA, userA, {
        type: "other",
        description: "Concurrent A",
        idempotencyKey: randomUUID(),
      }),
      service.create(tenantA, userA, {
        type: "other",
        description: "Concurrent B",
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(left.id).not.toBe(right.id);
    expect(left.number).not.toBe(right.number);
  });

  it("returns 404 for foreign request reads and permits idempotent replies only while clarification is required", async () => {
    const request = await service.create(tenantA, userA, {
      type: "other",
      description: "Need help",
      idempotencyKey: randomUUID(),
    });
    await expect(service.detail(tenantB, request.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.reply(tenantA, userA, request.id, {
        message: "Clarification",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      response: { code: "billing_request_not_awaiting_clarification" },
      status: 409,
    });
    await db
      .update(schema.tenantBillingRequests)
      .set({ status: "clarification_required", responsibleSide: "tenant" })
      .where(
        and(
          eq(schema.tenantBillingRequests.tenantId, tenantA),
          eq(schema.tenantBillingRequests.id, request.id),
        ),
      );
    const key = randomUUID();
    const first = await service.reply(tenantA, userA, request.id, {
      message: "  Exact answer  ",
      idempotencyKey: key,
    });
    const replay = await service.reply(tenantA, userA, request.id, {
      message: "  Exact answer  ",
      idempotencyKey: key,
    });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ kind: "tenant_reply", message: "Exact answer" });
    await expect(
      service.reply(tenantA, userA, request.id, {
        message: "Different answer",
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });
  });

  it("stores verified safe attachment metadata and signs only a tenant-owned attachment", async () => {
    const request = await service.create(tenantA, userA, {
      type: "documents",
      description: "Attach evidence",
      idempotencyKey: randomUUID(),
    });
    const body = Buffer.from("%PDF-1.7\nfixture");
    const attachment = await service.attach(tenantA, userA, request.id, randomUUID(), {
      originalname: "../unsafe\r\nname.pdf",
      mimetype: "application/pdf",
      size: body.byteLength,
      buffer: body,
    });
    expect(attachment.fileName).toBe("unsafe__name.pdf");
    expect(attachment).toMatchObject({
      contentType: "application/pdf",
      byteSize: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    const [putKey] = storage.putVerified.mock.calls.at(-1)!;
    expect(putKey).toBe(`tenant-billing/${tenantA}/requests/${request.id}/${attachment.id}`);
    const [stored] = await db
      .select()
      .from(schema.tenantBillingRequestAttachments)
      .where(eq(schema.tenantBillingRequestAttachments.id, attachment.id));
    expect(stored).toMatchObject({ state: "ready" });
    await expect(
      service.downloadAttachment(tenantB, request.id, attachment.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.downloadAttachment(tenantA, request.id, attachment.id)).resolves.toEqual({
      url: "https://private.example.test/request-attachment",
    });
  });

  it("issues and downloads an attachment for an opaque tenant id through the canonical key", async () => {
    const opaqueTenantId = `Производство / линия % ${randomUUID()}`;
    await createOrganization(db, opaqueTenantId);
    const request = await service.create(opaqueTenantId, userA, {
      type: "documents",
      description: "Opaque tenant attachment",
      idempotencyKey: randomUUID(),
    });
    const body = Buffer.from("plain text");

    const attachment = await service.attach(opaqueTenantId, userA, request.id, randomUUID(), {
      originalname: "note.txt",
      mimetype: "text/plain",
      size: body.byteLength,
      buffer: body,
    });

    const expectedKey = tenantBillingRequestAttachmentObjectKey(
      opaqueTenantId,
      request.id,
      attachment.id,
    );
    expect(expectedKey).toMatch(/^tenant-billing\/~u[0-9a-f]+\/requests\//);
    expect(storage.putVerified).toHaveBeenLastCalledWith(
      expectedKey,
      body,
      "text/plain",
      createHash("sha256").update(body).digest("hex"),
    );
    await expect(
      service.downloadAttachment(opaqueTenantId, request.id, attachment.id),
    ).resolves.toEqual({ url: "https://private.example.test/request-attachment" });
    expect(storage.presignRead).toHaveBeenLastCalledWith(expectedKey, 300, {
      downloadFilename: "note.txt",
    });
  });

  it("persists pending intent before PUT and retains it when upload verification is ambiguous", async () => {
    const request = await service.create(tenantA, userA, {
      type: "documents",
      description: "Ambiguous upload",
      idempotencyKey: randomUUID(),
    });
    const timeout = new Error("HEAD timeout after successful PUT");
    storage.putVerified.mockImplementationOnce(async (key) => {
      const attachmentId = key.split("/").at(-1)!;
      const pending = await connection.pool.query<{ state: string }>(
        `select state from tenant_billing_request_attachments
         where tenant_id = $1 and request_id = $2 and id = $3`,
        [tenantA, request.id, attachmentId],
      );
      expect(pending.rows).toEqual([{ state: "pending" }]);
      throw timeout;
    });
    storage.verifyObject.mockRejectedValueOnce(new Error("HEAD still unavailable"));
    const body = Buffer.from("plain text");
    await expect(
      service.attach(tenantA, userA, request.id, randomUUID(), {
        originalname: "note.txt",
        mimetype: "text/plain",
        size: body.byteLength,
        buffer: body,
      }),
    ).rejects.toBe(timeout);
    const [putKey] = storage.putVerified.mock.calls.at(-1)!;
    const attachmentId = putKey.split("/").at(-1)!;
    const pending = await connection.pool.query<{ state: string; object_key: string }>(
      `select state, object_key from tenant_billing_request_attachments where id = $1`,
      [attachmentId],
    );
    expect(pending.rows).toEqual([{ state: "pending", object_key: putKey }]);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    const detail = await service.detail(tenantA, request.id);
    expect(detail.attachments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: attachmentId })]),
    );
    await expect(
      service.downloadAttachment(tenantA, request.id, attachmentId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("marks a mismatched object for cleanup when confirmed deletion fails", async () => {
    const request = await service.create(tenantA, userA, {
      type: "documents",
      description: "Mismatched upload",
      idempotencyKey: randomUUID(),
    });
    const mismatch = new Error("upload verification mismatch");
    storage.putVerified.mockRejectedValueOnce(mismatch);
    storage.verifyObject.mockResolvedValueOnce("mismatch");
    storage.deleteConfirmed.mockRejectedValueOnce(new Error("delete timeout"));
    const body = Buffer.from("plain text");
    await expect(
      service.attach(tenantA, userA, request.id, randomUUID(), {
        originalname: "note.txt",
        mimetype: "text/plain",
        size: body.byteLength,
        buffer: body,
      }),
    ).rejects.toBe(mismatch);
    const [putKey] = storage.putVerified.mock.calls.at(-1)!;
    const attachmentId = putKey.split("/").at(-1)!;
    const state = await connection.pool.query<{ state: string }>(
      `select state from tenant_billing_request_attachments where id = $1`,
      [attachmentId],
    );
    expect(state.rows).toEqual([{ state: "cleanup_required" }]);
    expect(storage.deleteConfirmed).toHaveBeenCalledWith(putKey);
  });

  it("retains a tracked pending object when the ready transaction fails before commit", async () => {
    const request = await service.create(tenantA, userA, {
      type: "documents",
      description: "Ready transition failure",
      idempotencyKey: randomUUID(),
    });
    await connection.pool.query(`
      create function reject_task5_attachment_ready() returns trigger language plpgsql as $$
      begin raise exception 'ready transition rejected'; end $$;
      create trigger reject_task5_attachment_ready before update on tenant_billing_request_attachments
      for each row when (new.state = 'ready') execute function reject_task5_attachment_ready();
    `);
    const body = Buffer.from("plain text");
    await expect(
      service.attach(tenantA, userA, request.id, randomUUID(), {
        originalname: "note.txt",
        mimetype: "text/plain",
        size: body.byteLength,
        buffer: body,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "ready transition rejected" }),
    });
    const [putKey] = storage.putVerified.mock.calls.at(-1)!;
    const attachmentId = putKey.split("/").at(-1)!;
    const state = await connection.pool.query<{ state: string }>(
      `select state from tenant_billing_request_attachments where id = $1`,
      [attachmentId],
    );
    expect(state.rows).toEqual([{ state: "pending" }]);
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    await connection.pool.query(
      `drop trigger reject_task5_attachment_ready on tenant_billing_request_attachments`,
    );
    await connection.pool.query(`drop function reject_task5_attachment_ready()`);
  });

  it("returns committed ready metadata after a lost commit acknowledgement without deleting storage", async () => {
    const request = await service.create(tenantA, userA, {
      type: "documents",
      description: "Lost commit acknowledgement",
      idempotencyKey: randomUUID(),
    });
    let transactionCount = 0;
    const ambiguousDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<Db["transaction"]>[0]) => {
          transactionCount += 1;
          const result = await target.transaction(callback);
          if (transactionCount === 2) throw new Error("lost COMMIT acknowledgement");
          return result;
        };
      },
    });
    const ambiguousService = new TenantBillingRequestsService(
      ambiguousDb,
      storage as unknown as ObjectStorageService,
    );
    const body = Buffer.from("plain text");
    const attachment = await ambiguousService.attach(tenantA, userA, request.id, randomUUID(), {
      originalname: "note.txt",
      mimetype: "text/plain",
      size: body.byteLength,
      buffer: body,
    });
    expect(attachment).toMatchObject({ fileName: "note.txt" });
    const [stored] = await db
      .select()
      .from(schema.tenantBillingRequestAttachments)
      .where(eq(schema.tenantBillingRequestAttachments.id, attachment.id));
    expect(stored).toMatchObject({ state: "ready" });
    expect(storage.deleteConfirmed).not.toHaveBeenCalled();
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantA),
          eq(schema.tenantAuditEvents.targetId, attachment.id),
          eq(schema.tenantAuditEvents.action, "billing.request.attachment_uploaded"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("returns one attachment and one audit fact for an exact browser retry after a lost response", async () => {
    const request = await service.create(tenantA, userA, {
      type: "documents",
      description: "Retry attachment",
      idempotencyKey: randomUUID(),
    });
    const key = randomUUID();
    const body = Buffer.from("same browser file");
    const file = {
      originalname: "proof.txt",
      mimetype: "text/plain",
      size: body.byteLength,
      buffer: body,
    };

    const first = await service.attach(tenantA, userA, request.id, key, file);
    const replay = await service.attach(tenantA, userB, request.id, key, file);

    expect(replay).toEqual(first);
    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    const attachments = await db
      .select()
      .from(schema.tenantBillingRequestAttachments)
      .where(
        and(
          eq(schema.tenantBillingRequestAttachments.tenantId, tenantA),
          eq(schema.tenantBillingRequestAttachments.requestId, request.id),
        ),
      );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ idempotencyKey: key, uploadedByUserId: userA });
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantA),
          eq(schema.tenantAuditEvents.targetId, first.id),
          eq(schema.tenantAuditEvents.action, "billing.request.attachment_uploaded"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(userA);

    const differentBody = Buffer.from("different browser file");
    await expect(
      service.attach(tenantA, userA, request.id, key, {
        ...file,
        buffer: differentBody,
        size: differentBody.byteLength,
      }),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });
    expect(storage.putVerified).toHaveBeenCalledTimes(1);

    const otherRequest = await service.create(tenantA, userA, {
      type: "documents",
      description: "Same file identity in another request",
      idempotencyKey: randomUUID(),
    });
    const independentlyScoped = await service.attach(tenantA, userA, otherRequest.id, key, file);
    expect(independentlyScoped.id).not.toBe(first.id);
    expect(storage.putVerified).toHaveBeenCalledTimes(2);
  });
});

describe("tenant billing attachment content policy", () => {
  it.each([
    ["application/pdf", Buffer.from("not a pdf")],
    ["image/png", Buffer.from("not a png")],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ["text/plain", Buffer.from([0xff, 0xfe, 0x00])],
  ])("rejects claimed %s content whose bytes do not match", (mimetype, buffer) => {
    expect(() =>
      validateBillingAttachment({
        originalname: "attachment",
        mimetype,
        size: buffer.byteLength,
        buffer,
      }),
    ).toThrowError(
      expect.objectContaining({ response: { code: "billing_attachment_content_invalid" } }),
    );
  });

  it("rejects unsupported MIME and the exact over-5-MiB boundary", () => {
    const unsupported = Buffer.from("content");
    expect(() =>
      validateBillingAttachment({
        originalname: "data.json",
        mimetype: "application/json",
        size: unsupported.byteLength,
        buffer: unsupported,
      }),
    ).toThrowError(
      expect.objectContaining({ response: { code: "billing_attachment_type_invalid" } }),
    );
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    expect(() =>
      validateBillingAttachment({
        originalname: "large.txt",
        mimetype: "text/plain",
        size: oversized.byteLength,
        buffer: oversized,
      }),
    ).toThrowError(
      expect.objectContaining({ response: { code: "billing_attachment_size_invalid" } }),
    );
  });
});
