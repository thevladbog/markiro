import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
    delete: vi.fn(async () => undefined),
    presignRead: vi.fn(async () => "https://private.example.test/request-attachment"),
  };

  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let service: TenantBillingRequestsService;

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
    const attachment = await service.attach(tenantA, userA, request.id, {
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
    await expect(
      service.downloadAttachment(tenantB, request.id, attachment.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.downloadAttachment(tenantA, request.id, attachment.id)).resolves.toEqual({
      url: "https://private.example.test/request-attachment",
    });
  });

  it("deletes a verified object best-effort when attachment metadata insertion fails", async () => {
    const request = await service.create(tenantA, userA, {
      type: "documents",
      description: "Trigger compensation",
      idempotencyKey: randomUUID(),
    });
    await connection.pool.query(`
      create function reject_task5_attachment() returns trigger language plpgsql as $$
      begin raise exception 'metadata rejected'; end $$;
      create trigger reject_task5_attachment before insert on tenant_billing_request_attachments
      for each row execute function reject_task5_attachment();
    `);
    const original = new Error("sentinel");
    storage.delete.mockRejectedValueOnce(original);
    const body = Buffer.from("plain text");
    let metadataError: unknown;
    try {
      await service.attach(tenantA, userA, request.id, {
        originalname: "note.txt",
        mimetype: "text/plain",
        size: body.byteLength,
        buffer: body,
      });
    } catch (error) {
      metadataError = error;
    }
    expect(metadataError).toMatchObject({
      message: expect.stringContaining('insert into "tenant_billing_request_attachments"'),
      cause: expect.objectContaining({ message: "metadata rejected" }),
    });
    expect(storage.delete).toHaveBeenCalledOnce();
    await connection.pool.query(
      `drop trigger reject_task5_attachment on tenant_billing_request_attachments`,
    );
    await connection.pool.query(`drop function reject_task5_attachment()`);
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
