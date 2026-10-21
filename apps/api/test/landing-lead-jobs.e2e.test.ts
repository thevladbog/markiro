import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import type { EmailTemplateInput } from "@markiro/email";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { landingLeadBodySchema } from "../src/modules/landing-leads/landing-lead.schema";
import { LandingLeadRepository } from "../src/modules/landing-leads/landing-lead.repository";
import {
  LandingLeadJobsService,
  LEAD_NOTIFICATION_MAX_ATTEMPTS,
  digestRequestId,
} from "../src/modules/landing-leads/landing-lead-jobs.service";
import {
  TelegramSendError,
  type TelegramSender,
} from "../src/modules/landing-leads/telegram.client";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  closeFixturePool,
  dropFixtureDatabase,
  tolerateAdminShutdown,
} from "./support/fixture-pool";

const ready = Boolean(process.env.DATABASE_URL);
const ADMIN = "https://admin.markiro.example";

/**
 * The outbox and the digest read every pending row, so this suite owns a scratch
 * database: rows left by other suites in the shared one would change the counts.
 */
describe.skipIf(!ready)("landing lead jobs (spec 2026-10-20 §15.2, §15.4, §15.5)", () => {
  const name = `landing_lead_jobs_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const maintenance = createDb(url.toString());
  url.pathname = `/${name}`;
  url.search = "";
  const connection = createDb(url.toString());
  tolerateAdminShutdown(maintenance.pool);
  tolerateAdminShutdown(connection.pool);
  const db: Db = connection.db;
  const crypto = new MailCryptoService(Buffer.alloc(32, 41));
  const mail = new MailDeliveryService(crypto);
  const audit = new PlatformAuditService();
  let created = false;
  let clock = new Date("2026-10-21T06:00:00.000Z");
  const sent: string[] = [];
  let failure: TelegramSendError | null = null;
  const telegram: TelegramSender = {
    sendMessage: vi.fn(async (text: string) => {
      if (failure) throw failure;
      sent.push(text);
    }),
  };

  function jobs(sender: TelegramSender | null = telegram, recipient = "owner@example.test") {
    return new LandingLeadJobsService(
      db,
      mail,
      audit,
      sender,
      { recipient, adminOrigin: ADMIN, retentionMonths: 12 },
      () => clock,
    );
  }

  async function submit(overrides: Record<string, unknown> = {}, at = clock) {
    const input = landingLeadBodySchema.parse({
      requestId: randomUUID(),
      locale: "ru",
      sourcePath: "/skachat/",
      intent: "download",
      email: `lead-${randomUUID()}@example.test`,
      company: "ООО «Пивоварня»",
      consentVersion: "MKR-PD-02/2026.08/01",
      website: "",
      captchaToken: "token",
      name: "Анна Петрова",
      phone: "+7 999 123-45-67",
      productGroup: "пиво и сидр",
      linesBucket: "1",
      utm: { source: "yandex", medium: "cpc" },
      ...overrides,
    });
    await new LandingLeadRepository(
      db,
      mail,
      {
        recipient: "owner@example.test",
        replyTo: "hello@example.test",
        landingOrigin: "https://markiro.example",
        adminOrigin: ADMIN,
      },
      () => at,
    ).accept(input);
    const [lead] = await db
      .select()
      .from(schema.landingLeads)
      .where(eq(schema.landingLeads.email, input.email));
    if (!lead) throw new Error("lead was not stored");
    return lead;
  }

  async function notifications() {
    return db.select().from(schema.leadNotifications);
  }

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
  }, 120_000);

  afterAll(async () => {
    await closeFixturePool(connection.pool);
    if (created) await dropFixtureDatabase(maintenance.pool, name);
    await closeFixturePool(maintenance.pool);
  });

  beforeEach(async () => {
    await db.delete(schema.leadNotifications);
    await db.delete(schema.landingLeads);
    await db.delete(schema.emailOutbox);
    await db.delete(schema.emailDeliveries);
    sent.length = 0;
    failure = null;
    clock = new Date("2026-10-21T06:00:00.000Z");
    vi.mocked(telegram.sendMessage).mockClear();
  });

  describe("Telegram outbox", () => {
    it("sends the alert once, without e-mail, phone or name, and marks it sent", async () => {
      const lead = await submit();
      await expect(jobs().dispatchNotifications()).resolves.toBe(1);
      await expect(jobs().dispatchNotifications()).resolves.toBe(0);
      expect(sent).toEqual([
        [
          "Новый лид · скачивание",
          "ООО «Пивоварня» · пиво и сидр · 1 линия",
          "Источник: /skachat/ · utm: yandex / cpc",
          `${ADMIN}/leads/${lead.id}`,
        ].join("\n"),
      ]);
      for (const secret of [lead.email ?? "", "Анна", "Петрова", "999", "123-45-67", "@"]) {
        expect(sent[0]).not.toContain(secret);
      }
      expect(await notifications()).toEqual([
        expect.objectContaining({
          status: "sent",
          attempts: 1,
          lastErrorCode: null,
          sentAt: clock,
        }),
      ]);
    });

    it("titles a later invoice request of the same e-mail as a repeat with its tariff", async () => {
      const lead = await submit();
      await submit({
        email: lead.email,
        intent: "invoice",
        sourcePath: "/stoimost/",
        inn: "7707083893",
        tariffCode: "line",
      });
      await jobs().dispatchNotifications();
      expect(sent).toHaveLength(2);
      const invoice = sent.find((text) => text.includes("запрос счёта"));
      expect(invoice).toContain("Повторное обращение · запрос счёта");
      expect(invoice).toContain("Тариф: line");
      expect(invoice).not.toContain("7707083893");
    });

    it("retries a transient failure with backoff and gives up after eight attempts", async () => {
      await submit();
      failure = new TelegramSendError("telegram_unavailable", true);
      for (let attempt = 1; attempt <= LEAD_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
        await expect(jobs().dispatchNotifications()).resolves.toBe(0);
        const [row] = await notifications();
        expect(row).toMatchObject({ attempts: attempt, lastErrorCode: "telegram_unavailable" });
        if (attempt < LEAD_NOTIFICATION_MAX_ATTEMPTS) {
          expect(row?.status).toBe("pending");
          const delay = (row?.nextAttemptAt.getTime() ?? 0) - clock.getTime();
          expect(delay).toBe(Math.min(30 * 2 ** (attempt - 1), 3600) * 1000);
          // Not due yet: nothing is attempted before the backoff ends.
          await jobs().dispatchNotifications();
          expect(telegram.sendMessage).toHaveBeenCalledTimes(attempt);
          clock = new Date(row!.nextAttemptAt.getTime());
        } else {
          expect(row?.status).toBe("failed");
        }
      }
      clock = new Date(clock.getTime() + 86_400_000);
      await jobs().dispatchNotifications();
      expect(telegram.sendMessage).toHaveBeenCalledTimes(LEAD_NOTIFICATION_MAX_ATTEMPTS);
    });

    it("fails a rejected message at once", async () => {
      await submit();
      failure = new TelegramSendError("telegram_rejected_401", false);
      await jobs().dispatchNotifications();
      expect(await notifications()).toEqual([
        expect.objectContaining({
          status: "failed",
          attempts: 1,
          lastErrorCode: "telegram_rejected_401",
        }),
      ]);
    });

    it("skips rows while Telegram is off, so turning it on later sends no backlog", async () => {
      await submit();
      await expect(jobs(null).dispatchNotifications()).resolves.toBe(0);
      expect(await notifications()).toEqual([
        expect.objectContaining({
          status: "skipped",
          attempts: 0,
          lastErrorCode: "telegram_disabled",
        }),
      ]);
      await jobs().dispatchNotifications();
      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("daily digest", () => {
    async function seedDigestLeads() {
      const day = 86_400_000;
      const fresh = await submit({ company: "Свежий" }, new Date(clock.getTime() - 3_600_000));
      const old = await submit({ company: "Старый новый" }, new Date(clock.getTime() - 2 * day));
      const day3 = await submit({ company: "Третий день" }, new Date(clock.getTime() - 3 * day));
      const day10 = await submit({ company: "Десятый день" }, new Date(clock.getTime() - 10 * day));
      const unpaid = await submit({ company: "Счёт висит" }, new Date(clock.getTime() - 20 * day));
      const postponed = await submit({ company: "Отложен" }, new Date(clock.getTime() - 3 * day));
      const won = await submit({ company: "Купил" }, new Date(clock.getTime() - 3 * day));
      await db
        .update(schema.landingLeads)
        .set({ status: "contacted" })
        .where(eq(schema.landingLeads.id, day3.id));
      await db
        .update(schema.landingLeads)
        .set({ status: "trial" })
        .where(eq(schema.landingLeads.id, day10.id));
      await db
        .update(schema.landingLeads)
        .set({ status: "invoice_sent", statusChangedAt: new Date(clock.getTime() - 8 * day) })
        .where(eq(schema.landingLeads.id, unpaid.id));
      await db
        .update(schema.landingLeads)
        .set({ status: "contacted", nextTouchAt: new Date(clock.getTime() + 2 * day) })
        .where(eq(schema.landingLeads.id, postponed.id));
      await db
        .update(schema.landingLeads)
        .set({ status: "won" })
        .where(eq(schema.landingLeads.id, won.id));
      return { fresh, old, day3, day10, unpaid, postponed, won };
    }

    it("writes one digest per day with its e-mail and Telegram text, by the §15.5 sections", async () => {
      const leads = await seedDigestLeads();
      await expect(jobs().sendDailyDigest()).resolves.toBe("sent");
      await expect(jobs().sendDailyDigest()).resolves.toBe("exists");

      const digest = (await notifications()).filter((row) => row.kind === "daily_digest");
      expect(digest).toHaveLength(1);
      expect(digest[0]).toMatchObject({
        digestDate: "2026-10-21",
        leadId: null,
        status: "pending",
      });
      expect(digest[0]?.payload).toEqual({
        sections: {
          new_uncontacted: [leads.old.id, leads.day10.id, leads.unpaid.id].filter(
            // day10 and unpaid are no longer `new`; only the old new lead stays.
            (id) => id === leads.old.id,
          ),
          day_3: [leads.day3.id],
          day_10: [leads.day10.id],
          touch_due: [],
          invoice_unpaid: [leads.unpaid.id],
        },
      });

      const [delivery] = await db
        .select()
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.publicRequestId, digestRequestId("2026-10-21")));
      expect(delivery).toMatchObject({
        kind: "landing-lead-digest",
        recipient: "owner@example.test",
        sourceId: "lead-digest:2026-10-21",
      });
      const template = crypto.decrypt<EmailTemplateInput>(delivery!.id, {
        encryptedPayload: delivery!.encryptedPayload!,
        payloadNonce: delivery!.payloadNonce!,
        payloadTag: delivery!.payloadTag!,
      });
      expect(JSON.stringify(template)).not.toMatch(/example\.test|Анна|999/);
      expect(template).toMatchObject({
        kind: "landing-lead-digest",
        digestDate: "2026-10-21",
        sections: [
          { section: "new_uncontacted", leads: [{ company: "Старый новый" }] },
          { section: "day_3", leads: [{ company: "Третий день" }] },
          { section: "day_10", leads: [{ company: "Десятый день" }] },
          { section: "invoice_unpaid", leads: [{ company: "Счёт висит" }] },
        ],
      });

      await jobs().dispatchNotifications();
      const text = sent.find((entry) => entry.startsWith("Кому пора написать"));
      expect(text).toContain("Третий день");
      expect(text).toContain(`${ADMIN}/leads/${leads.unpaid.id}`);
      expect(text).not.toMatch(/Свежий|Отложен|Купил|@|Анна/);
    });

    it("sends nothing when no section has a lead", async () => {
      await submit({ company: "Свежий" }, new Date(clock.getTime() - 3_600_000));
      await expect(jobs().sendDailyDigest()).resolves.toBe("empty");
      expect((await notifications()).filter((row) => row.kind === "daily_digest")).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.emailDeliveries)
          .where(eq(schema.emailDeliveries.kind, "landing-lead-digest")),
      ).toHaveLength(0);
    });
  });

  describe("anonymization", () => {
    it("clears contacts of lost and inactive leads with one exact audit row each", async () => {
      const day = 86_400_000;
      const lost = await submit({ inn: "500100732259" });
      const lostRecently = await submit();
      const inactive = await submit({}, new Date("2025-09-01T06:00:00.000Z"));
      const active = await submit({}, new Date("2026-10-01T06:00:00.000Z"));
      await db
        .update(schema.landingLeads)
        .set({
          status: "lost",
          statusChangedAt: new Date(clock.getTime() - 31 * day),
          ownerNote: "звонить Анне",
        })
        .where(eq(schema.landingLeads.id, lost.id));
      await db
        .update(schema.landingLeads)
        .set({ status: "lost", statusChangedAt: new Date(clock.getTime() - 5 * day) })
        .where(eq(schema.landingLeads.id, lostRecently.id));

      await expect(jobs().anonymizeStale()).resolves.toBe(2);
      await expect(jobs().anonymizeStale()).resolves.toBe(0);

      const rows = await db.select().from(schema.landingLeads);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of [lost.id, inactive.id]) {
        expect(byId.get(id)).toMatchObject({
          email: null,
          name: null,
          phone: null,
          ownerNote: null,
          anonymizedAt: clock,
          company: "ООО «Пивоварня»",
        });
      }
      expect(byId.get(lost.id)?.inn).toBeNull();
      expect(byId.get(lostRecently.id)?.email).not.toBeNull();
      expect(byId.get(active.id)?.email).not.toBeNull();

      const events = await db
        .select()
        .from(schema.landingLeadEvents)
        .where(eq(schema.landingLeadEvents.kind, "anonymized"));
      expect(events.map((event) => [event.leadId, event.payload]).sort()).toEqual(
        [
          [lost.id, { reason: "lost" }],
          [inactive.id, { reason: "inactive" }],
        ].sort(),
      );
      const auditRows = await db
        .select()
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.action, "landing_lead.anonymized"));
      expect(auditRows).toHaveLength(2);
      expect(auditRows.find((row) => row.targetId === lost.id)).toMatchObject({
        actorPlatformUserId: null,
        actorRole: null,
        action: "landing_lead.anonymized",
        outcome: "success",
        tenantId: null,
        targetType: "landing_lead",
        targetId: lost.id,
        reason: "lost",
        before: {
          status: "lost",
          email: true,
          name: true,
          phone: true,
          ownerNote: true,
          personalInn: true,
        },
        after: { anonymized: true },
      });
      expect(JSON.stringify(auditRows)).not.toMatch(/example\.test|Анна|500100732259/);
    });
  });
});
