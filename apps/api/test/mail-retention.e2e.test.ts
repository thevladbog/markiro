import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { MailRetentionService } from "../src/modules/mail/mail-retention.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("MailRetentionService", () => {
  let setup: AuthSetup;
  let db: Db;
  let service: MailRetentionService;
  const userId = "mail-retention-" + randomUUID();

  beforeAll(async () => {
    setup = setupAuth(loadEnv());
    db = setup.db;
    service = new MailRetentionService(setup.pool);
    await db.insert(schema.user).values({
      id: userId,
      name: "Mail Retention",
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

  it("erases terminal payloads after 24h and applies 30/90-day metadata retention", async () => {
    const sentOld = randomUUID();
    const failedOld = randomUUID();
    const failedPayloadExpired = randomUUID();
    const failedFresh = randomUUID();
    const payload = Buffer.from("encrypted");
    const nonce = Buffer.alloc(12, 1);
    const tag = Buffer.alloc(16, 2);

    await db.insert(schema.emailDeliveries).values([
      {
        id: sentOld,
        userId,
        recipient: "retention@example.test",
        kind: "email-verification",
        status: "sent",
        terminalAt: new Date(Date.now() - 31 * 86_400_000),
        encryptedPayload: payload,
        payloadNonce: nonce,
        payloadTag: tag,
      },
      {
        id: failedOld,
        userId,
        recipient: "retention@example.test",
        kind: "email-verification",
        status: "failed",
        terminalAt: new Date(Date.now() - 91 * 86_400_000),
        encryptedPayload: payload,
        payloadNonce: nonce,
        payloadTag: tag,
      },
      {
        id: failedPayloadExpired,
        userId,
        recipient: "retention@example.test",
        kind: "email-verification",
        status: "failed",
        terminalAt: new Date(Date.now() - 25 * 3_600_000),
        encryptedPayload: payload,
        payloadNonce: nonce,
        payloadTag: tag,
      },
      {
        id: failedFresh,
        userId,
        recipient: "retention@example.test",
        kind: "email-verification",
        status: "failed",
        terminalAt: new Date(Date.now() - 60_000),
        encryptedPayload: payload,
        payloadNonce: nonce,
        payloadTag: tag,
      },
    ]);

    await service.prune();

    const oldRows = await db
      .select({ id: schema.emailDeliveries.id })
      .from(schema.emailDeliveries)
      .where(inArray(schema.emailDeliveries.id, [sentOld, failedOld]));
    expect(oldRows).toHaveLength(0);

    const retained = await db
      .select({
        id: schema.emailDeliveries.id,
        encryptedPayload: schema.emailDeliveries.encryptedPayload,
      })
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.userId, userId),
          inArray(schema.emailDeliveries.id, [failedPayloadExpired, failedFresh]),
        ),
      );
    expect(retained.find((row) => row.id === failedPayloadExpired)?.encryptedPayload).toBeNull();
    expect(retained.find((row) => row.id === failedFresh)?.encryptedPayload).toEqual(payload);
  });
});
