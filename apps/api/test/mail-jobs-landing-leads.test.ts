import { describe, expect, it, vi } from "vitest";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailJobsService, type MailPgPool } from "../src/modules/mail/mail-jobs.service";

const DELIVERY_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const TEMPLATES = {
  "landing-download-link": {
    kind: "landing-download-link",
    locale: "ru",
    company: "ООО «Пивоварня»",
    downloadPageUrl: "https://markiro.app/skachat/",
    contactEmail: "hello@v-b.tech",
  },
  "landing-invoice-request-confirmation": {
    kind: "landing-invoice-request-confirmation",
    locale: "ru",
    company: "ООО «Пивоварня»",
    inn: "7707083893",
    tariffCode: "line",
    email: "buyer@example.test",
    contactEmail: "hello@v-b.tech",
  },
  "landing-lead-notification": {
    kind: "landing-lead-notification",
    intent: "invoice",
    locale: "ru",
    requestId: REQUEST_ID,
    receivedAt: "2026-10-21T09:00:00.000Z",
    sourcePath: "/stoimost/",
    consentVersion: "MKR-PD-02/2026.08/01",
    company: "ООО «Пивоварня»",
    email: "buyer@example.test",
    inn: "7707083893",
    tariffCode: "line",
    utm: { source: "yandex", medium: "cpc" },
    firstContact: true,
    leadUrl: "https://saas.example/leads/22222222-2222-4222-8222-222222222222",
  },
  "landing-lead-digest": {
    kind: "landing-lead-digest",
    digestDate: "2026-10-21",
    leadsUrl: "https://saas.example/leads",
    sections: [
      {
        section: "new_uncontacted",
        leads: [
          {
            company: "ООО «Пивоварня»",
            leadUrl: "https://saas.example/leads/22222222-2222-4222-8222-222222222222",
          },
        ],
      },
    ],
  },
} as const;

function harness(
  kind: keyof typeof TEMPLATES,
  owner: { platformUserId?: string; publicRequestId?: string | null } = {},
) {
  const crypto = new MailCryptoService(Buffer.alloc(32, 9));
  const encrypted = crypto.encrypt(DELIVERY_ID, TEMPLATES[kind]);
  const calls: string[] = [];
  const query = async (text: string) => {
    calls.push(text);
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (text.includes("RETURNING") && text.includes("UPDATE email_deliveries")) {
      return {
        rows: [
          {
            id: DELIVERY_ID,
            tenantId: null,
            userId: null,
            platformUserId: owner.platformUserId ?? null,
            publicRequestId:
              owner.publicRequestId === undefined ? REQUEST_ID : owner.publicRequestId,
            recipient: "owner@example.test",
            kind,
            sourceId: REQUEST_ID,
            attemptCount: 1,
            ...encrypted,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: vi.fn() }),
  } as unknown as MailPgPool;
  const transport = { verify: vi.fn(async () => true), send: vi.fn(async () => undefined) };
  const service = new MailJobsService(pool, crypto, transport, undefined, undefined, undefined, {
    profile: "platform-only",
    platformOrigin: "https://saas.example",
    platformAuthUrl: "https://api.example",
  });
  return { service, transport, calls };
}

describe("landing lead mail in the platform-only profile (spec §15.3)", () => {
  it.each(Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[])(
    "renders and sends %s",
    async (kind) => {
      const { service, transport, calls } = harness(kind);
      await service.processDelivery(DELIVERY_ID);
      expect(transport.send).toHaveBeenCalledOnce();
      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({ subject: expect.any(String), html: expect.any(String) }),
        "owner@example.test",
      );
      expect(calls.some((text) => text.includes("status = 'sent'"))).toBe(true);
      expect(calls.some((text) => text.includes("server_profile_disabled"))).toBe(false);
    },
  );

  it.each(Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[])(
    "cancels %s owned by a platform user instead of a public request",
    async (kind) => {
      const { service, transport, calls } = harness(kind, {
        platformUserId: "platform-user",
        publicRequestId: null,
      });
      await service.processDelivery(DELIVERY_ID);
      expect(transport.send).not.toHaveBeenCalled();
      expect(calls.some((text) => text.includes("server_profile_disabled"))).toBe(true);
    },
  );
});
