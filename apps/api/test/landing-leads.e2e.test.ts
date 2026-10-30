import { randomUUID } from "node:crypto";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema, type Db } from "@markiro/db";
import type { EmailTemplateInput } from "@markiro/email";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEMO_REQUEST_SUBMISSION_ENABLED,
  DemoRequestSubmissionGuard,
} from "../src/modules/demo-requests/demo-request-submission.guard";
import { DemoRequestRepository } from "../src/modules/demo-requests/demo-request.repository";
import { LandingLeadRepository } from "../src/modules/landing-leads/landing-lead.repository";
import { LandingLeadService } from "../src/modules/landing-leads/landing-lead.service";
import { LandingLeadRateLimiter } from "../src/modules/landing-leads/landing-lead-rate-limiter";
import { LandingLeadsController } from "../src/modules/landing-leads/landing-leads.controller";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import type { EnqueueMailInput } from "../src/modules/mail/mail.types";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(process.env.DATABASE_URL);
const CONSENT = "MKR-PD-02/2026.08/01";
const OPTIONS = {
  recipient: "owner@example.test",
  replyTo: "hello@example.test",
  landingOrigin: "https://markiro.example",
  adminOrigin: "https://admin.markiro.example",
};

describe.skipIf(!ready)("POST /landing-leads pipeline (spec 2026-10-20 §15.3)", () => {
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let crypto: MailCryptoService;
  let app: INestApplication;
  let disabledApp: INestApplication;
  const emails = new Set<string>();

  function email(): string {
    const value = `lead-${randomUUID()}@example.test`;
    emails.add(value);
    return value;
  }

  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      requestId: randomUUID(),
      locale: "ru",
      sourcePath: "/skachat/",
      intent: "download",
      email: email(),
      company: "ООО «Пивоварня»",
      consentVersion: CONSENT,
      website: "",
      captchaToken: "captcha-token-never-persisted",
      utm: { source: "yandex", medium: "cpc" },
      referrer: "https://yandex.ru/search/?text=secret",
      ...overrides,
    };
  }

  async function leadByEmail(address: string) {
    const [lead] = await db
      .select()
      .from(schema.landingLeads)
      .where(eq(schema.landingLeads.email, address.trim().toLowerCase()));
    return lead;
  }

  async function state(address: string) {
    const lead = await leadByEmail(address);
    if (!lead) return { lead: undefined, events: [], notifications: [] };
    const events = await db
      .select()
      .from(schema.landingLeadEvents)
      .where(eq(schema.landingLeadEvents.leadId, lead.id));
    const notifications = await db
      .select()
      .from(schema.leadNotifications)
      .where(eq(schema.leadNotifications.leadId, lead.id));
    return { lead, events, notifications };
  }

  async function deliveries(requestId: string) {
    const rows = await db
      .select()
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.publicRequestId, requestId));
    return rows.map((row) => {
      if (!row.encryptedPayload || !row.payloadNonce || !row.payloadTag) {
        throw new Error("Expected an encrypted mail payload");
      }
      return {
        row,
        template: crypto.decrypt<EmailTemplateInput>(row.id, {
          encryptedPayload: row.encryptedPayload,
          payloadNonce: row.payloadNonce,
          payloadTag: row.payloadTag,
        }),
      };
    });
  }

  function repository(
    mail: Pick<MailDeliveryService, "enqueue"> = new MailDeliveryService(crypto),
  ) {
    return new LandingLeadRepository(db, mail, OPTIONS);
  }

  async function build(enabled: boolean): Promise<INestApplication> {
    const service = new LandingLeadService(
      { enabled },
      new LandingLeadRateLimiter(db, {
        windowMs: 900_000,
        sourceBudget: 100,
        globalBudget: 10_000,
        sourceKeySecret: randomUUID(),
      }),
      repository(),
    );
    const ref = await Test.createTestingModule({
      controllers: [LandingLeadsController],
      providers: [
        { provide: LandingLeadService, useValue: service },
        { provide: DEMO_REQUEST_SUBMISSION_ENABLED, useValue: enabled },
        DemoRequestSubmissionGuard,
      ],
    }).compile();
    const nest = ref.createNestApplication();
    await nest.init();
    await listenOnLoopback(nest);
    return nest;
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    connection = createDb(databaseUrl);
    db = connection.db;
    crypto = new MailCryptoService(Buffer.alloc(32, 23));
    app = await build(true);
    disabledApp = await build(false);
  });

  afterAll(async () => {
    await app?.close();
    await disabledApp?.close();
    if (emails.size > 0) {
      await db
        .delete(schema.emailDeliveries)
        .where(inArray(schema.emailDeliveries.recipient, [...emails]));
      await db.delete(schema.landingLeads).where(inArray(schema.landingLeads.email, [...emails]));
    }
    await connection.pool.end();
  });

  it("stores a download: lead, event, two e-mails and one Telegram outbox row", async () => {
    const form = body({ email: ` ${email().toUpperCase()} ` });
    const response = await request(app.getHttpServer())
      .post("/landing-leads")
      .send(form)
      .expect(202);
    expect(response.body).toEqual({ accepted: true, requestId: form.requestId });

    const address = String(form.email).trim().toLowerCase();
    emails.add(address);
    const { lead, events, notifications } = await state(address);
    expect(lead).toMatchObject({
      email: address,
      company: "ООО «Пивоварня»",
      status: "new",
      locale: "ru",
      firstSourcePath: "/skachat/",
      firstUtm: { source: "yandex", medium: "cpc" },
      firstReferrer: "https://yandex.ru/search/",
      anonymizedAt: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "download",
      publicRequestId: form.requestId,
      actorPlatformUserId: null,
      payload: {
        sourcePath: "/skachat/",
        locale: "ru",
        utm: { source: "yandex", medium: "cpc" },
        referrer: "https://yandex.ru/search/",
      },
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain("@");
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: "new_lead",
        eventId: events[0]?.id,
        status: "pending",
        attempts: 0,
      }),
    ]);

    const mails = await deliveries(String(form.requestId));
    expect(mails.map(({ row }) => [row.kind, row.recipient]).sort()).toEqual([
      ["landing-download-link", address],
      ["landing-lead-notification", "owner@example.test"],
    ]);
    const owner = mails.find(({ row }) => row.kind === "landing-lead-notification")?.template;
    expect(owner).toMatchObject({
      intent: "download",
      firstContact: true,
      leadUrl: `https://admin.markiro.example/leads/${lead?.id}`,
    });
    const visitor = mails.find(({ row }) => row.kind === "landing-download-link")?.template;
    expect(visitor).toMatchObject({
      downloadPageUrl: "https://markiro.example/skachat/?installer=1",
    });
    expect(JSON.stringify(mails.map(({ template }) => template))).not.toContain("captcha-token");
  });

  it.each(["start", "line", "workshop"])(
    "preserves download tariff %s in the durable event and owner notification",
    async (tariffCode) => {
      const form = body({ tariffCode });
      await request(app.getHttpServer()).post("/landing-leads").send(form).expect(202);
      await request(app.getHttpServer()).post("/landing-leads").send(form).expect(202);
      const { events, notifications } = await state(String(form.email));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "download", payload: { tariffCode } });
      expect(notifications).toHaveLength(1);
      const mails = await deliveries(String(form.requestId));
      expect(mails).toHaveLength(2);
      expect(
        mails.find(({ row }) => row.kind === "landing-lead-notification")?.template,
      ).toMatchObject({ intent: "download", tariffCode });
    },
  );

  it("accepts a retried request id once, also under concurrency", async () => {
    const form = body();
    await Promise.all(
      [1, 2, 3].map(() =>
        request(app.getHttpServer()).post("/landing-leads").send(form).expect(202),
      ),
    );
    await request(app.getHttpServer()).post("/landing-leads").send(form).expect(202);
    const { events, notifications } = await state(String(form.email));
    expect(events).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(await deliveries(String(form.requestId))).toHaveLength(2);
  });

  it("fills empty fields of a known e-mail without overwriting filled ones or the status", async () => {
    const address = email();
    const first = body({ email: address, name: "Анна", company: "Первое название" });
    await request(app.getHttpServer()).post("/landing-leads").send(first).expect(202);
    const created = await leadByEmail(address);
    await db
      .update(schema.landingLeads)
      .set({ status: "contacted" })
      .where(eq(schema.landingLeads.id, created!.id));

    const second = body({
      email: address.toUpperCase(),
      intent: "invoice",
      sourcePath: "/stoimost/",
      name: "Другое имя",
      company: "Второе название",
      phone: "+7 999 123-45-67",
      inn: "7707083893",
      tariffCode: "line",
      utm: { source: "google" },
    });
    await request(app.getHttpServer()).post("/landing-leads").send(second).expect(202);

    const { lead, events, notifications } = await state(address);
    expect(lead).toMatchObject({
      id: created!.id,
      name: "Анна",
      company: "Первое название",
      phone: "+79991234567",
      inn: "7707083893",
      status: "contacted",
      firstSourcePath: "/skachat/",
      firstUtm: { source: "yandex", medium: "cpc" },
    });
    expect(events.map((event) => event.kind).sort()).toEqual(["download", "invoice_request"]);
    expect(events.find((event) => event.kind === "invoice_request")?.payload).toMatchObject({
      inn: "7707083893",
      tariffCode: "line",
      sourcePath: "/stoimost/",
    });
    expect(notifications.map((row) => row.kind).sort()).toEqual(["invoice_request", "new_lead"]);
    const mails = await deliveries(String(second.requestId));
    expect(mails.map(({ row }) => row.kind).sort()).toEqual([
      "landing-invoice-request-confirmation",
      "landing-lead-notification",
    ]);
    expect(
      mails.find(({ row }) => row.kind === "landing-lead-notification")?.template,
    ).toMatchObject({ intent: "invoice", firstContact: false, inn: "7707083893" });
  });

  it("stores an invoice request without a company and fills it from a later download", async () => {
    const address = email();
    const invoice = body({
      email: address,
      intent: "invoice",
      sourcePath: "/stoimost/",
      inn: "7707083893",
      tariffCode: "workshop",
    });
    delete invoice.company;
    await request(app.getHttpServer()).post("/landing-leads").send(invoice).expect(202);
    expect((await state(address)).lead).toMatchObject({ company: null, inn: "7707083893" });
    const mails = await deliveries(String(invoice.requestId));
    for (const { template } of mails) expect(template).not.toHaveProperty("company");

    await request(app.getHttpServer())
      .post("/landing-leads")
      .send(body({ email: address, company: "ООО «Квас»" }))
      .expect(202);
    expect((await state(address)).lead).toMatchObject({ company: "ООО «Квас»" });
  });

  it("requires the company on the download form", async () => {
    const form = body();
    delete form.company;
    const response = await request(app.getHttpServer())
      .post("/landing-leads")
      .send(form)
      .expect(400);
    expect(response.body).toEqual({ code: "invalid_request" });
  });

  it.each([
    ["a stale consent", { consentVersion: "MKR-PD-02/2025.01/01" }, 400, "invalid_request"],
    ["a filled honeypot", { website: "https://spam.example" }, 400, "invalid_request"],
    ["an invoice without INN", { intent: "invoice", tariffCode: "line" }, 400, "invalid_request"],
    ["an unknown field", { extra: true }, 400, "invalid_request"],
    ["an unknown page", { sourcePath: "/faq/" }, 400, "invalid_request"],
  ])("refuses %s and stores nothing", async (_case, overrides, status, code) => {
    const form = body(overrides);
    const response = await request(app.getHttpServer())
      .post("/landing-leads")
      .send(form)
      .expect(status);
    expect(response.body).toEqual({ code });
    expect((await state(String(form.email))).lead).toBeUndefined();
    expect(await deliveries(String(form.requestId))).toHaveLength(0);
  });

  it("accepts a download without a captcha token", async () => {
    const form = body();
    delete form.captchaToken;
    const response = await request(app.getHttpServer())
      .post("/landing-leads")
      .send(form)
      .expect(202);
    expect(response.body).toEqual({ accepted: true, requestId: form.requestId });
    expect((await state(String(form.email))).lead).toBeDefined();
  });

  it("answers 404 while public submission is disabled", async () => {
    const form = body();
    const response = await request(disabledApp.getHttpServer())
      .post("/landing-leads")
      .send(form)
      .expect(404);
    expect(response.body).toEqual({ code: "submission_disabled" });
    expect((await state(String(form.email))).lead).toBeUndefined();
  });

  it("rolls the lead and its event back when an e-mail cannot be queued", async () => {
    const real = new MailDeliveryService(crypto);
    let calls = 0;
    const failing = {
      enqueue: vi.fn(
        async (tx: Parameters<MailDeliveryService["enqueue"]>[0], input: EnqueueMailInput) => {
          calls += 1;
          if (calls === 2) throw new Error("forced second enqueue failure");
          return real.enqueue(tx, input);
        },
      ),
    };
    const form = body();
    const { landingLeadBodySchema } =
      await import("../src/modules/landing-leads/landing-lead.schema");
    await expect(repository(failing).accept(landingLeadBodySchema.parse(form))).rejects.toThrow(
      "forced second enqueue failure",
    );
    expect((await state(String(form.email))).lead).toBeUndefined();
    expect(await deliveries(String(form.requestId))).toHaveLength(0);
  });

  it("records the old demo form as a demo_request lead in the same transaction", async () => {
    const address = email();
    const requestId = randomUUID();
    const demo = new DemoRequestRepository(db, new MailDeliveryService(crypto), {
      recipient: "owner@example.test",
      replyTo: "hello@example.test",
    });
    const input = {
      requestId,
      locale: "ru" as const,
      sourcePath: "/" as const,
      consentVersion: CONSENT,
      name: "Анна",
      company: "Сидрерия",
      email: address,
      phone: "+79991234567",
      website: "",
      captchaToken: "token",
    };
    await expect(demo.accept(input)).resolves.toBe("created");
    await expect(demo.accept(input)).resolves.toBe("existing");
    // Mail retention deletes delivery rows after 30 days; the lead event still
    // remembers the request, so a late replay stays a no-op instead of a 503.
    await db
      .delete(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.publicRequestId, requestId));
    await expect(demo.accept(input)).resolves.toBe("existing");
    expect(await deliveries(requestId)).toHaveLength(0);
    const { lead, events, notifications } = await state(address);
    expect(lead).toMatchObject({
      company: "Сидрерия",
      name: "Анна",
      phone: "+79991234567",
      firstSourcePath: "/",
    });
    expect(events).toEqual([
      expect.objectContaining({
        kind: "demo_request",
        publicRequestId: requestId,
        payload: { sourcePath: "/", locale: "ru" },
      }),
    ]);
    expect(notifications.map((row) => row.kind)).toEqual(["new_lead"]);
  });
});
