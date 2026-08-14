import { schema } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import type { MailWriteTransaction } from "../src/modules/mail/mail.types";

describe("MailDeliveryService", () => {
  it("inserts encrypted tenant delivery and outbox rows through the caller transaction", async () => {
    const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = {
      insert: vi.fn((table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          writes.push({ table, values });
        },
      })),
    };
    const service = new MailDeliveryService(
      new MailCryptoService(Buffer.alloc(32, 3)),
      () => "11111111-1111-4111-8111-111111111111",
    );

    const deliveryId = await service.enqueue(tx as unknown as MailWriteTransaction, {
      scope: { tenantId: "tenant-1" },
      recipient: "  Admin@Example.TEST ",
      sourceId: "invitation-1",
      template: {
        kind: "organization-invitation",
        recipientName: "Ирина",
        organizationName: "Завод",
        inviterName: "Олег",
        actionUrl: "https://cabinet.example/invitations/secret",
        expiresAt: new Date("2026-08-10T00:00:00Z"),
      },
    });

    expect(deliveryId).toBe("11111111-1111-4111-8111-111111111111");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.table).toBe(schema.emailDeliveries);
    expect(writes[0]?.values).toMatchObject({
      id: deliveryId,
      tenantId: "tenant-1",
      userId: null,
      platformUserId: null,
      recipient: "admin@example.test",
      kind: "organization-invitation",
      sourceId: "invitation-1",
      status: "queued",
    });
    expect(writes[0]?.values.encryptedPayload).toBeInstanceOf(Buffer);
    expect(String(writes[0]?.values.encryptedPayload)).not.toContain("secret");
    expect(writes[1]).toEqual({
      table: schema.emailOutbox,
      values: { deliveryId },
    });
  });

  it("stores global account mail under user scope only", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const tx = {
      insert: vi.fn(() => ({
        values: async (values: Record<string, unknown>) => {
          writes.push(values);
        },
      })),
    };
    const service = new MailDeliveryService(
      new MailCryptoService(Buffer.alloc(32, 4)),
      () => "22222222-2222-4222-8222-222222222222",
    );

    await service.enqueue(tx as unknown as MailWriteTransaction, {
      scope: { userId: "user-1" },
      recipient: "user@example.test",
      template: {
        kind: "email-verification",
        recipientName: "Ирина",
        actionUrl: "https://cabinet.example/verify/secret",
        expiresInMinutes: 60,
      },
    });

    expect(writes[0]).toMatchObject({ tenantId: null, userId: "user-1", platformUserId: null });
  });

  it("stores platform activation mail under platform-user scope only", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const tx = {
      insert: vi.fn(() => ({
        values: async (values: Record<string, unknown>) => {
          writes.push(values);
        },
      })),
    };
    const service = new MailDeliveryService(
      new MailCryptoService(Buffer.alloc(32, 5)),
      () => "33333333-3333-4333-8333-333333333333",
    );

    await service.enqueue(tx as unknown as MailWriteTransaction, {
      scope: { platformUserId: "platform-user-1" },
      recipient: "platform@example.test",
      template: {
        kind: "platform-user-activation",
        recipientName: "Платформа",
        actionUrl: "https://saas.example/activate#token=secret",
        expiresInMinutes: 60,
      },
    });

    expect(writes[0]).toMatchObject({
      tenantId: null,
      userId: null,
      platformUserId: "platform-user-1",
    });
  });

  it("stores landing demo mail under public-request scope only", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const tx = {
      insert: vi.fn(() => ({
        values: async (values: Record<string, unknown>) => {
          writes.push(values);
        },
      })),
    };
    const service = new MailDeliveryService(
      new MailCryptoService(Buffer.alloc(32, 6)),
      () => "44444444-4444-4444-8444-444444444444",
    );

    await service.enqueue(tx as unknown as MailWriteTransaction, {
      scope: { publicRequestId: "11111111-1111-4111-8111-111111111111" },
      recipient: " Lead@Example.TEST ",
      template: {
        kind: "email-verification",
        recipientName: "Ada",
        actionUrl: "https://cabinet.example/verify/secret",
        expiresInMinutes: 60,
      },
    });

    expect(writes[0]).toMatchObject({
      tenantId: null,
      userId: null,
      platformUserId: null,
      publicRequestId: "11111111-1111-4111-8111-111111111111",
      recipient: "lead@example.test",
      kind: "email-verification",
    });
    expect(String(writes[0]?.encryptedPayload)).not.toContain("secret");
  });
});
