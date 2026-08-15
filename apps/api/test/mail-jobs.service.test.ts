import { describe, expect, it, vi } from "vitest";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import {
  classifyMailFailure,
  MailJobsService,
  MailRetryError,
  SEND_EMAIL_DELIVERY_QUEUE,
  type MailPgPool,
  type MailQueue,
} from "../src/modules/mail/mail-jobs.service";

interface QueryCall {
  text: string;
  values?: readonly unknown[];
}

const DELIVERY_ID = "44444444-4444-4444-8444-444444444444";
const CONSENT_VERSION_AT_LIMIT = "v".repeat(64);

function fakePool(
  handler: (call: QueryCall) => { rows?: unknown[]; rowCount?: number | null } = () => ({}),
): { pool: MailPgPool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async (text: string, values?: readonly unknown[]) => {
    const call = { text, ...(values ? { values } : {}) };
    calls.push(call);
    const result = handler(call);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
  };
  return {
    calls,
    pool: {
      query,
      connect: async () => ({ query, release: vi.fn() }),
    } as unknown as MailPgPool,
  };
}

function createService(
  pool: MailPgPool,
  overrides: { send?: (recipient: string) => Promise<void> } = {},
) {
  const crypto = new MailCryptoService(Buffer.alloc(32, 9));
  const transport = {
    verify: vi.fn(async () => true),
    send: vi.fn(async (_rendered, recipient: string) => {
      await overrides.send?.(recipient);
    }),
  };
  const renderer = vi.fn(async () => ({
    subject: "subject",
    html: "<p>body</p>",
    text: "body",
  }));
  return {
    crypto,
    renderer,
    transport,
    service: new MailJobsService(
      pool,
      crypto,
      transport,
      renderer,
      () => "33333333-3333-4333-8333-333333333333",
    ),
  };
}

describe("MailJobsService dispatch", () => {
  it("claims unpublished rows with SKIP LOCKED and publishes only delivery id", async () => {
    const { pool, calls } = fakePool(({ text }) =>
      text.includes("FROM email_outbox")
        ? { rows: [{ id: "outbox-1", deliveryId: "11111111-1111-4111-8111-111111111111" }] }
        : {},
    );
    const { service } = createService(pool);
    const queue: MailQueue = { send: vi.fn(async () => "job-1") };

    await service.dispatchOutbox(queue);

    expect(calls.some(({ text }) => text.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    expect(queue.send).toHaveBeenCalledWith(
      SEND_EMAIL_DELIVERY_QUEUE,
      { deliveryId: "11111111-1111-4111-8111-111111111111" },
      {
        id: "11111111-1111-4111-8111-111111111111",
        singletonKey: "delivery:11111111-1111-4111-8111-111111111111",
      },
    );
    const publishedUpdate = calls.find(({ text }) => text.includes("published_at = now()"));
    expect(publishedUpdate?.values).toEqual(["outbox-1"]);
  });

  it("marks a replay published when pg-boss already owns the stable job id", async () => {
    const { pool, calls } = fakePool(({ text }) =>
      text.includes("FROM email_outbox")
        ? { rows: [{ id: "outbox-2", deliveryId: "22222222-2222-4222-8222-222222222222" }] }
        : {},
    );
    const { service } = createService(pool);
    const queue: MailQueue = { send: vi.fn(async () => null) };

    await service.dispatchOutbox(queue);

    expect(calls.some(({ text }) => text.includes("published_at = now()"))).toBe(true);
  });
});

describe("MailJobsService delivery claim", () => {
  it("renders and sends platform activation deliveries", async () => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 9));
    const encrypted = crypto.encrypt(DELIVERY_ID, {
      kind: "platform-user-activation",
      recipientName: "Пользователь",
      actionUrl: "https://saas.example/activate#token=activation-token",
      expiresInMinutes: 60,
    });
    const { pool } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: null,
              userId: null,
              recipient: "platform@example.test",
              kind: "platform-user-activation",
              sourceId: "platform-activation:user-1",
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      return {};
    });
    const { service, renderer, transport } = createService(pool);

    await service.processDelivery(DELIVERY_ID);

    expect(renderer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "platform-user-activation" }),
    );
    expect(transport.send).toHaveBeenCalledWith(expect.anything(), "platform@example.test");
  });

  it("decrypts, validates, renders, and sends a landing notification with Reply-To intact", async () => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 9));
    const encrypted = crypto.encrypt(DELIVERY_ID, {
      kind: "landing-demo-notification",
      locale: "en",
      requestId: "11111111-1111-4111-8111-111111111111",
      receivedAt: "2026-08-14T12:00:00.000Z",
      sourcePath: "/en/",
      consentVersion: CONSENT_VERSION_AT_LIMIT,
      recipientName: "Ada",
      company: "Factory",
      email: "ada@example.test",
      phone: "+12025550114",
    });
    const { pool } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: null,
              userId: null,
              recipient: "hello@v-b.tech",
              kind: "landing-demo-notification",
              sourceId: null,
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      return {};
    });
    const transport = {
      verify: vi.fn(async () => true),
      send: vi.fn(async () => undefined),
    };
    const renderer = vi.fn(async () => ({
      subject: "subject",
      html: "<p>body</p>",
      text: "body",
      replyTo: "ada@example.test",
    }));
    const service = new MailJobsService(
      pool,
      crypto,
      transport,
      renderer,
      () => "33333333-3333-4333-8333-333333333333",
    );

    await service.processDelivery(DELIVERY_ID);

    expect(renderer).toHaveBeenCalledWith({
      kind: "landing-demo-notification",
      locale: "en",
      requestId: "11111111-1111-4111-8111-111111111111",
      receivedAt: new Date("2026-08-14T12:00:00.000Z"),
      sourcePath: "/en/",
      consentVersion: CONSENT_VERSION_AT_LIMIT,
      recipientName: "Ada",
      company: "Factory",
      email: "ada@example.test",
      phone: "+12025550114",
    });
    expect(transport.send).toHaveBeenCalledWith(
      {
        subject: "subject",
        html: "<p>body</p>",
        text: "body",
        replyTo: "ada@example.test",
      },
      "hello@v-b.tech",
    );
  });

  it.each([
    ["blank", " "],
    ["longer than 64 characters", "v".repeat(65)],
  ])("rejects a %s consent version before rendering", async (_case, consentVersion) => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 9));
    const encrypted = crypto.encrypt(DELIVERY_ID, {
      kind: "landing-demo-notification",
      locale: "en",
      requestId: "11111111-1111-4111-8111-111111111111",
      receivedAt: "2026-08-14T12:00:00.000Z",
      sourcePath: "/en/",
      consentVersion,
      recipientName: "Ada",
      company: "Factory",
      email: "ada@example.test",
    });
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: null,
              userId: null,
              recipient: "hello@v-b.tech",
              kind: "landing-demo-notification",
              sourceId: null,
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      return {};
    });
    const { service, renderer, transport } = createService(pool);

    await service.processDelivery(DELIVERY_ID);

    expect(renderer).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    expect(calls.find(({ text }) => text.includes("error_category = $3"))?.values).toEqual([
      DELIVERY_ID,
      "failed",
      "message",
      "RENDER",
      "message:RENDER",
    ]);
  });

  it("holds an advisory lock, revalidates the invitation, sends, and erases payload", async () => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 9));
    const encrypted = crypto.encrypt(DELIVERY_ID, {
      kind: "organization-invitation",
      recipientName: "Ирина",
      organizationName: "Завод",
      inviterName: "Олег",
      actionUrl: "https://cabinet.example/invitations/secret",
      expiresAt: "2026-08-10T00:00:00.000Z",
    });
    let validationCount = 0;
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: "tenant-1",
              userId: null,
              recipient: "admin@example.test",
              kind: "organization-invitation",
              sourceId: "invitation-1",
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      if (text.includes("FROM invitation")) {
        validationCount += 1;
        return { rows: [{ valid: true }] };
      }
      return {};
    });
    const transport = {
      verify: vi.fn(async () => true),
      send: vi.fn(async () => undefined),
    };
    const renderer = vi.fn(async () => ({
      subject: "subject",
      html: "<p>body</p>",
      text: "body",
    }));
    const service = new MailJobsService(
      pool,
      crypto,
      transport,
      renderer,
      () => "33333333-3333-4333-8333-333333333333",
    );

    await service.processDelivery(DELIVERY_ID);

    expect(validationCount).toBe(2);
    expect(renderer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "organization-invitation", expiresAt: expect.any(Date) }),
    );
    expect(transport.send).toHaveBeenCalledWith(
      { subject: "subject", html: "<p>body</p>", text: "body" },
      "admin@example.test",
    );
    expect(
      calls.some(
        ({ text }) =>
          text.includes("status = 'sent'") &&
          text.includes("encrypted_payload = null") &&
          text.includes("payload_nonce = null"),
      ),
    ).toBe(true);
    expect(calls.at(-1)?.text).toContain("pg_advisory_unlock");
  });

  it("does not claim or send when another session owns the advisory lock", async () => {
    const { pool, calls } = fakePool(({ text }) =>
      text.includes("pg_try_advisory_lock") ? { rows: [{ locked: false }] } : {},
    );
    const { service, transport } = createService(pool);

    await expect(service.processDelivery(DELIVERY_ID)).rejects.toBeInstanceOf(MailRetryError);
    expect(transport.send).not.toHaveBeenCalled();
    expect(calls.some(({ text }) => text.includes("UPDATE email_deliveries"))).toBe(false);
  });

  it("cancels and erases an invitation delivery whose source is no longer valid", async () => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 9));
    const encrypted = crypto.encrypt(DELIVERY_ID, {
      kind: "organization-invitation",
      recipientName: "Ирина",
      organizationName: "Завод",
      inviterName: "Олег",
      actionUrl: "https://cabinet.example/invitations/secret",
      expiresAt: "2026-08-10T00:00:00.000Z",
    });
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: "tenant-1",
              userId: null,
              recipient: "admin@example.test",
              kind: "organization-invitation",
              sourceId: "invitation-1",
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      if (text.includes("FROM invitation")) return { rows: [{ valid: false }] };
      return {};
    });
    const { service, transport } = createService(pool);

    await service.processDelivery(DELIVERY_ID);

    expect(transport.send).not.toHaveBeenCalled();
    expect(
      calls.some(
        ({ text }) =>
          text.includes("status = 'canceled'") &&
          text.includes("encrypted_payload = null") &&
          text.includes("error_category = null"),
      ),
    ).toBe(true);
  });

  it("cancels when an invitation becomes invalid after rendering but before send", async () => {
    const crypto = new MailCryptoService(Buffer.alloc(32, 9));
    const encrypted = crypto.encrypt(DELIVERY_ID, {
      kind: "organization-invitation",
      recipientName: "Ирина",
      organizationName: "Завод",
      inviterName: "Олег",
      actionUrl: "https://cabinet.example/invitations/secret",
      expiresAt: "2026-08-10T00:00:00.000Z",
    });
    let validationCount = 0;
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: "tenant-1",
              userId: null,
              recipient: "admin@example.test",
              kind: "organization-invitation",
              sourceId: "invitation-1",
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      if (text.includes("FROM invitation")) {
        validationCount += 1;
        return { rows: [{ valid: validationCount === 1 }] };
      }
      return {};
    });
    const { service, renderer, transport } = createService(pool);

    await service.processDelivery(DELIVERY_ID);

    expect(renderer).toHaveBeenCalledOnce();
    expect(transport.send).not.toHaveBeenCalled();
    expect(calls.some(({ text }) => text.includes("status = 'canceled'"))).toBe(true);
  });

  it("marks a delivery with missing encrypted payload as a data-integrity failure", async () => {
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: null,
              userId: "user-1",
              recipient: "user@example.test",
              kind: "password-reset",
              sourceId: "reset-1",
              attemptCount: 1,
              encryptedPayload: null,
              payloadNonce: null,
              payloadTag: null,
            },
          ],
        };
      }
      return {};
    });
    const { service, renderer, transport } = createService(pool);

    await service.processDelivery(DELIVERY_ID);

    expect(renderer).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    const failureUpdate = calls.find(({ text }) => text.includes("error_category = $3"));
    expect(failureUpdate?.values).toEqual([
      DELIVERY_ID,
      "failed",
      "data_integrity",
      "PAYLOAD_MISSING",
      "data_integrity:PAYLOAD_MISSING",
    ]);
  });

  it("marks a transient transport error retrying and fails the pg-boss attempt", async () => {
    let encrypted = {} as ReturnType<MailCryptoService["encrypt"]>;
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: null,
              userId: "user-1",
              recipient: "user@example.test",
              kind: "password-reset",
              sourceId: "reset-1",
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      return {};
    });
    const created = createService(pool, {
      send: async () => {
        throw Object.assign(new Error("secret"), { code: "ETIMEDOUT" });
      },
    });
    encrypted = created.crypto.encrypt(DELIVERY_ID, {
      kind: "password-reset",
      recipientName: "Ирина",
      actionUrl: "https://cabinet.example/reset/secret",
      expiresInMinutes: 30,
    });

    await expect(created.service.processDelivery(DELIVERY_ID)).rejects.toBeInstanceOf(
      MailRetryError,
    );
    const failureUpdate = calls.find(({ text }) => text.includes("error_category = $3"));
    expect(failureUpdate?.values).toEqual([
      DELIVERY_ID,
      "retrying",
      "network",
      "ETIMEDOUT",
      "network:ETIMEDOUT",
    ]);
  });

  it("fails a transient error permanently after the maximum delivery attempt", async () => {
    let encrypted = {} as ReturnType<MailCryptoService["encrypt"]>;
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: null,
              userId: "user-1",
              recipient: "user@example.test",
              kind: "password-reset",
              sourceId: "reset-1",
              attemptCount: 5,
              ...encrypted,
            },
          ],
        };
      }
      return {};
    });
    const created = createService(pool, {
      send: async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      },
    });
    encrypted = created.crypto.encrypt(DELIVERY_ID, {
      kind: "password-reset",
      recipientName: "Ирина",
      actionUrl: "https://cabinet.example/reset/secret",
      expiresInMinutes: 30,
    });

    await expect(created.service.processDelivery(DELIVERY_ID)).resolves.toBeUndefined();
    const failureUpdate = calls.find(({ text }) => text.includes("error_category = $3"));
    expect(failureUpdate?.values).toEqual([
      DELIVERY_ID,
      "failed",
      "network",
      "ETIMEDOUT",
      "network:ETIMEDOUT",
    ]);
  });

  it("marks a permanent SMTP error failed without retrying the pg-boss job", async () => {
    let encrypted = {} as ReturnType<MailCryptoService["encrypt"]>;
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("RETURNING") && text.includes("email_deliveries")) {
        return {
          rows: [
            {
              id: DELIVERY_ID,
              tenantId: null,
              userId: "user-1",
              recipient: "user@example.test",
              kind: "email-verification",
              sourceId: "verification-1",
              attemptCount: 1,
              ...encrypted,
            },
          ],
        };
      }
      return {};
    });
    const created = createService(pool, {
      send: async () => {
        throw { responseCode: 550 };
      },
    });
    encrypted = created.crypto.encrypt(DELIVERY_ID, {
      kind: "email-verification",
      recipientName: "Ирина",
      actionUrl: "https://cabinet.example/verify/secret",
      expiresInMinutes: 60,
    });

    await created.service.processDelivery(DELIVERY_ID);
    const failureUpdate = calls.find(({ text }) => text.includes("error_category = $3"));
    expect(failureUpdate?.values).toEqual([
      DELIVERY_ID,
      "failed",
      "smtp_permanent",
      "550",
      "smtp_permanent:550",
    ]);
  });
});

describe("MailJobsService reconciliation", () => {
  it("reclaims an expired sending lease only while holding a free delivery lock", async () => {
    const { pool, calls } = fakePool(({ text }) => {
      if (text.includes("FROM email_deliveries")) {
        return { rows: [{ id: DELIVERY_ID, status: "sending" }] };
      }
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (text.includes("SET status = 'retrying'")) return { rowCount: 1 };
      return {};
    });
    const { service } = createService(pool);
    const queue: MailQueue = { send: vi.fn(async () => "job-1") };

    expect(await service.reconcile(queue)).toBe(1);
    expect(calls[0]?.text).toContain("attempt_deadline < now()");
    expect(calls.some(({ text }) => text.includes("pg_try_advisory_lock"))).toBe(true);
    expect(queue.send).toHaveBeenCalledWith(
      SEND_EMAIL_DELIVERY_QUEUE,
      { deliveryId: DELIVERY_ID },
      { id: DELIVERY_ID, singletonKey: "delivery:" + DELIVERY_ID },
    );
  });
});

describe("mail failure classification", () => {
  it("retries network failures and SMTP 4xx without retaining the exception message", () => {
    expect(
      classifyMailFailure(Object.assign(new Error("contains secret"), { code: "ETIMEDOUT" })),
    ).toEqual({
      category: "network",
      code: "ETIMEDOUT",
      diagnostic: "network:ETIMEDOUT",
      transient: true,
    });
    expect(classifyMailFailure({ responseCode: 421 })).toMatchObject({
      category: "smtp_transient",
      code: "421",
      transient: true,
    });
  });

  it("fails SMTP 5xx and authentication errors permanently", () => {
    expect(classifyMailFailure({ responseCode: 550 })).toMatchObject({
      category: "smtp_permanent",
      code: "550",
      transient: false,
    });
    expect(classifyMailFailure({ code: "EAUTH" })).toMatchObject({
      category: "authentication",
      code: "EAUTH",
      transient: false,
    });
  });
});
