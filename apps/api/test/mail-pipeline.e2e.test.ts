import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import {
  MailJobsService,
  MailRetryError,
  SEND_EMAIL_DELIVERY_QUEUE,
  type MailQueue,
} from "../src/modules/mail/mail-jobs.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("durable mail pipeline", () => {
  let setup: AuthSetup;
  let db: Db;
  const userId = "mail-pipeline-" + randomUUID();

  beforeAll(async () => {
    setup = setupAuth(loadEnv());
    db = setup.db;
    await db.insert(schema.user).values({
      id: userId,
      name: "Mail Pipeline",
      email: userId + "@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await setup.pool.end();
  });

  it("commits outbox, publishes the stable job, sends, and erases encrypted data", async () => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 6));
    const deliveries = new MailDeliveryService(crypto);
    const transport = {
      verify: vi.fn(async () => true),
      send: vi.fn(async () => undefined),
    };
    const renderer = vi.fn(async () => ({
      subject: "Подтвердите email — Маркиро",
      html: "<p>Подтвердите email</p>",
      text: "Подтвердите email",
    }));
    const jobs = new MailJobsService(setup.pool, crypto, transport, renderer);
    const queue: MailQueue = { send: vi.fn(async () => randomUUID()) };

    const deliveryId = await db.transaction((tx) =>
      deliveries.enqueue(tx, {
        scope: { userId },
        recipient: "Pipeline@Example.TEST",
        sourceId: "verification-1",
        template: {
          kind: "email-verification",
          recipientName: "Ирина",
          actionUrl: "https://cabinet.example/verify/secret-token",
          expiresInMinutes: 60,
        },
      }),
    );

    expect(await jobs.dispatchOutbox(queue)).toBe(1);
    expect(queue.send).toHaveBeenCalledWith(
      SEND_EMAIL_DELIVERY_QUEUE,
      { deliveryId },
      { id: deliveryId, singletonKey: "delivery:" + deliveryId },
    );

    await jobs.processDelivery(deliveryId);

    const [row] = await db
      .select({
        status: schema.emailDeliveries.status,
        recipient: schema.emailDeliveries.recipient,
        attemptCount: schema.emailDeliveries.attemptCount,
        encryptedPayload: schema.emailDeliveries.encryptedPayload,
        payloadNonce: schema.emailDeliveries.payloadNonce,
        payloadTag: schema.emailDeliveries.payloadTag,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, deliveryId));
    expect(row).toEqual({
      status: "sent",
      recipient: "pipeline@example.test",
      attemptCount: 1,
      encryptedPayload: null,
      payloadNonce: null,
      payloadTag: null,
    });
    expect(renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "email-verification",
        actionUrl: "https://cabinet.example/verify/secret-token",
      }),
    );
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it("persists a transient SMTP failure as retrying with a cleared lease", async () => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 8));
    const deliveries = new MailDeliveryService(crypto);
    const jobs = new MailJobsService(
      setup.pool,
      crypto,
      {
        verify: vi.fn(async () => true),
        send: vi.fn(async () => {
          throw Object.assign(new Error("must not be stored"), { code: "ETIMEDOUT" });
        }),
      },
      vi.fn(async () => ({ subject: "subject", html: "<p>body</p>", text: "body" })),
    );
    const deliveryId = await db.transaction((tx) =>
      deliveries.enqueue(tx, {
        scope: { userId },
        recipient: "retry@example.test",
        sourceId: "reset-1",
        template: {
          kind: "password-reset",
          recipientName: "Ирина",
          actionUrl: "https://cabinet.example/reset/secret-token",
          expiresInMinutes: 30,
        },
      }),
    );

    await expect(jobs.processDelivery(deliveryId)).rejects.toBeInstanceOf(MailRetryError);

    const [row] = await db
      .select({
        status: schema.emailDeliveries.status,
        attemptId: schema.emailDeliveries.attemptId,
        attemptDeadline: schema.emailDeliveries.attemptDeadline,
        errorCategory: schema.emailDeliveries.errorCategory,
        errorCode: schema.emailDeliveries.errorCode,
        errorText: schema.emailDeliveries.errorText,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, deliveryId));
    expect(row).toEqual({
      status: "retrying",
      attemptId: null,
      attemptDeadline: null,
      errorCategory: "network",
      errorCode: "ETIMEDOUT",
      errorText: "network:ETIMEDOUT",
    });
  });
});
