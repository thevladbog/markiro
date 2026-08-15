import { randomUUID } from "node:crypto";
import { createDb, schema, type Db } from "@markiro/db";
import type { EmailTemplateInput } from "@markiro/email";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DemoRequestDto } from "../src/modules/demo-requests/demo-request.schema";
import {
  DemoRequestInvariantError,
  DemoRequestRepository,
} from "../src/modules/demo-requests/demo-request.repository";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import type { EnqueueMailInput } from "../src/modules/mail/mail.types";

const ready = Boolean(process.env.DATABASE_URL);
const RECEIVED_AT = new Date("2026-08-15T08:30:00.000Z");
const requestIds = new Set<string>();

function input(requestId = randomUUID()): DemoRequestDto {
  requestIds.add(requestId);
  return {
    requestId,
    locale: "en",
    sourcePath: "/en/packing-workstation/",
    consentVersion: "2026-08-14",
    name: "Ada",
    company: "Factory",
    email: "ada@example.test",
    phone: "+12025550114",
    website: "",
    captchaToken: "captcha-token-never-persisted",
  };
}

describe.skipIf(!ready)("landing demo request mail pipeline", () => {
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let crypto: MailCryptoService;
  let mail: MailDeliveryService;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required for configured pipeline tests");
    connection = createDb(databaseUrl);
    db = connection.db;
    crypto = new MailCryptoService(Buffer.alloc(32, 17));
    mail = new MailDeliveryService(crypto);
  });

  afterEach(async () => {
    if (requestIds.size === 0) return;
    await db
      .delete(schema.emailDeliveries)
      .where(inArray(schema.emailDeliveries.publicRequestId, [...requestIds]));
    requestIds.clear();
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  function repository(delivery: Pick<MailDeliveryService, "enqueue"> = mail) {
    return new DemoRequestRepository(
      db,
      delivery,
      { recipient: "internal@example.test", replyTo: "contact@example.test" },
      () => RECEIVED_AT,
    );
  }

  async function rowsFor(requestId: string) {
    const deliveries = await db
      .select({
        id: schema.emailDeliveries.id,
        publicRequestId: schema.emailDeliveries.publicRequestId,
        kind: schema.emailDeliveries.kind,
        recipient: schema.emailDeliveries.recipient,
        sourceId: schema.emailDeliveries.sourceId,
        encryptedPayload: schema.emailDeliveries.encryptedPayload,
        payloadNonce: schema.emailDeliveries.payloadNonce,
        payloadTag: schema.emailDeliveries.payloadTag,
      })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.publicRequestId, requestId));
    const outbox = await db
      .select({ deliveryId: schema.emailOutbox.deliveryId })
      .from(schema.emailOutbox)
      .innerJoin(
        schema.emailDeliveries,
        eq(schema.emailDeliveries.id, schema.emailOutbox.deliveryId),
      )
      .where(eq(schema.emailDeliveries.publicRequestId, requestId));
    return { deliveries, outbox };
  }

  it("atomically creates two scoped encrypted deliveries and two outbox rows", async () => {
    const demo = input();

    await expect(repository().accept(demo)).resolves.toBe("created");

    const { deliveries, outbox } = await rowsFor(demo.requestId);
    expect(deliveries).toHaveLength(2);
    expect(outbox).toHaveLength(2);
    expect(deliveries.map((row) => row.kind).sort()).toEqual([
      "landing-demo-confirmation",
      "landing-demo-notification",
    ]);
    expect(deliveries.map((row) => row.recipient).sort()).toEqual([
      "ada@example.test",
      "internal@example.test",
    ]);
    for (const row of deliveries) {
      expect(row).toMatchObject({ publicRequestId: demo.requestId, sourceId: demo.requestId });
      expect(row.encryptedPayload).toBeInstanceOf(Buffer);
      expect(row.payloadNonce).toBeInstanceOf(Buffer);
      expect(row.payloadTag).toBeInstanceOf(Buffer);
      if (!row.encryptedPayload || !row.payloadNonce || !row.payloadTag) {
        throw new Error("Expected an encrypted mail payload");
      }
      expect(row.encryptedPayload.toString("utf8")).not.toContain("captcha-token");
      expect(row.encryptedPayload.toString("utf8")).not.toContain("ada@example.test");
    }

    const templates = deliveries.map((row) => {
      if (!row.encryptedPayload || !row.payloadNonce || !row.payloadTag) {
        throw new Error("Expected an encrypted mail payload");
      }
      return crypto.decrypt<EmailTemplateInput>(row.id, {
        encryptedPayload: row.encryptedPayload,
        payloadNonce: row.payloadNonce,
        payloadTag: row.payloadTag,
      });
    });
    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "landing-demo-notification",
          requestId: demo.requestId,
          receivedAt: RECEIVED_AT.toISOString(),
          consentVersion: "2026-08-14",
          email: demo.email,
        }),
        expect.objectContaining({
          kind: "landing-demo-confirmation",
          requestId: demo.requestId,
          contactEmail: "contact@example.test",
        }),
      ]),
    );
    expect(JSON.stringify(templates)).not.toContain(demo.captchaToken);
    expect(JSON.stringify(templates)).not.toContain("203.0.113.7");
  });

  it("serializes concurrent retries and keeps the exact complete pair", async () => {
    const demo = input();

    const results = await Promise.all([
      repository().accept(demo),
      repository().accept(demo),
      repository().accept(demo),
    ]);

    expect(results.sort()).toEqual(["created", "existing", "existing"]);
    const { deliveries, outbox } = await rowsFor(demo.requestId);
    expect(deliveries).toHaveLength(2);
    expect(outbox).toHaveLength(2);
  });

  it("canonicalizes mixed-case UUID retries before locking and persistence", async () => {
    const canonicalRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const upperRequestId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const upper = input(upperRequestId);
    const lower = input(canonicalRequestId);

    const results = await Promise.all([repository().accept(upper), repository().accept(lower)]);

    expect(results.sort()).toEqual(["created", "existing"]);
    const { deliveries, outbox } = await rowsFor(canonicalRequestId);
    expect(deliveries).toHaveLength(2);
    expect(outbox).toHaveLength(2);
    expect(deliveries.map((row) => row.publicRequestId)).toEqual([
      canonicalRequestId,
      canonicalRequestId,
    ]);
    expect(deliveries.map((row) => row.sourceId)).toEqual([canonicalRequestId, canonicalRequestId]);
    for (const row of deliveries) {
      if (!row.encryptedPayload || !row.payloadNonce || !row.payloadTag) {
        throw new Error("Expected an encrypted mail payload");
      }
      expect(
        crypto.decrypt<{ requestId: string }>(row.id, {
          encryptedPayload: row.encryptedPayload,
          payloadNonce: row.payloadNonce,
          payloadTag: row.payloadTag,
        }).requestId,
      ).toBe(canonicalRequestId);
    }
  });

  it("rolls back the first enqueue when the second enqueue fails", async () => {
    const demo = input();
    let calls = 0;
    const failingDelivery = {
      enqueue: vi.fn(async (tx, enqueueInput: EnqueueMailInput) => {
        calls += 1;
        if (calls === 2) throw new Error("forced second enqueue failure");
        return mail.enqueue(tx, enqueueInput);
      }),
    } satisfies Pick<MailDeliveryService, "enqueue">;

    await expect(repository(failingDelivery).accept(demo)).rejects.toThrow(
      "forced second enqueue failure",
    );

    const { deliveries, outbox } = await rowsFor(demo.requestId);
    expect(deliveries).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it("fails closed on a partial or foreign delivery set", async () => {
    const partial = input();
    await db.transaction((tx) =>
      mail.enqueue(tx, {
        scope: { publicRequestId: partial.requestId },
        recipient: partial.email,
        sourceId: partial.requestId,
        template: {
          kind: "landing-demo-confirmation",
          locale: partial.locale,
          requestId: partial.requestId,
          recipientName: partial.name,
          company: partial.company,
          email: partial.email,
          ...(partial.phone === undefined ? {} : { phone: partial.phone }),
          contactEmail: "contact@example.test",
        },
      }),
    );
    await expect(repository().accept(partial)).rejects.toBeInstanceOf(DemoRequestInvariantError);
    expect((await rowsFor(partial.requestId)).deliveries).toHaveLength(1);

    const foreign = input();
    await db.transaction((tx) =>
      mail.enqueue(tx, {
        scope: { publicRequestId: foreign.requestId },
        recipient: foreign.email,
        sourceId: foreign.requestId,
        template: {
          kind: "email-verification",
          recipientName: foreign.name,
          actionUrl: "https://cabinet.example.test/verify/test-token",
          expiresInMinutes: 60,
        },
      }),
    );
    await expect(repository().accept(foreign)).rejects.toBeInstanceOf(DemoRequestInvariantError);
    expect((await rowsFor(foreign.requestId)).deliveries).toHaveLength(1);
  });
});
