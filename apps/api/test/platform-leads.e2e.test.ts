import { randomUUID } from "node:crypto";
import { type INestApplication } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@markiro/db";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { landingLeadBodySchema } from "../src/modules/landing-leads/landing-lead.schema";
import { LandingLeadRepository } from "../src/modules/landing-leads/landing-lead.repository";
import { PlatformLeadsController } from "../src/modules/landing-leads/platform-leads.controller";
import { PlatformLeadsService } from "../src/modules/landing-leads/platform-leads.service";
import { TenantProvisioningService } from "../src/modules/platform-tenants/tenant-provisioning.service";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { PlatformAuthGuard } from "../src/platform-auth/platform-auth.guard";
import { listenOnLoopback } from "./support/listen-loopback";

const url = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!url)("platform leads section (spec 2026-10-20 §15.6)", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost/unavailable");
  const crypto = new MailCryptoService(Buffer.alloc(32, 7));
  const mail = new MailDeliveryService(crypto);
  const audit = new PlatformAuditService();
  const provisioning = new TenantProvisioningService(
    db,
    mail,
    audit,
    "https://cabinet.example",
    "platform-only",
  );
  const service = new PlatformLeadsService(db, audit, provisioning);
  // The service writes at `now`, the public form at the real time: `now` must stay after
  // it, so it is an hour ahead of the run (a fixed date turned into a past one on its day).
  const now = new Date(Math.ceil(Date.now() / 1_000) * 1_000 + 3_600_000);
  service.now = () => now;
  const run = randomUUID().slice(0, 8);
  const users = {
    admin: `leads-admin-${run}`,
    support: `leads-support-${run}`,
    accountant: `leads-accountant-${run}`,
  } as const;
  const admin: PlatformPrincipal = {
    userId: users.admin,
    role: "platform_admin",
    capabilities: platformCapabilitiesForRole.platform_admin,
    twoFactorReady: true,
  };
  const leadIds: string[] = [];
  const tenantIds: string[] = [];
  let app: INestApplication;

  async function lead(overrides: Record<string, unknown> = {}) {
    const input = landingLeadBodySchema.parse({
      requestId: randomUUID(),
      locale: "ru",
      sourcePath: "/stoimost/",
      intent: "invoice",
      email: `lead-${randomUUID()}@example.test`,
      company: `Пивоварня ${run}`,
      consentVersion: "MKR-PD-02/2026.08/01",
      website: "",
      captchaToken: "token",
      inn: "7707083893",
      tariffCode: "line",
      name: "Анна",
      phone: "+79991234567",
      ...overrides,
    });
    await new LandingLeadRepository(db, mail, {
      recipient: "owner@example.test",
      replyTo: "hello@example.test",
      landingOrigin: "https://markiro.example",
      adminOrigin: "https://admin.markiro.example",
    }).accept(input);
    const [row] = await db
      .select()
      .from(schema.landingLeads)
      .where(eq(schema.landingLeads.email, input.email));
    if (!row) throw new Error("lead not stored");
    leadIds.push(row.id);
    return row;
  }

  async function auditFor(leadId: string, action: string) {
    return db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, leadId),
          eq(schema.platformAuditEvents.action, action),
        ),
      );
  }

  beforeAll(async () => {
    await db.insert(schema.platformUsers).values(
      (Object.entries(users) as [keyof typeof users, string][]).map(([role, id]) => ({
        id,
        name: `Тест ${role}`,
        email: `${id}@example.invalid`,
        role: role === "admin" ? ("platform_admin" as const) : role,
        status: "active",
        twoFactorEnabled: true,
      })),
    );
    await db.insert(schema.platformTwoFactors).values(
      Object.values(users).map((userId) => ({
        id: randomUUID(),
        userId,
        secret: "fixture",
        backupCodes: "fixture",
        verified: true,
      })),
    );
    const module = await Test.createTestingModule({
      controllers: [PlatformLeadsController],
      providers: [{ provide: PlatformLeadsService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = /fixture=([\w-]+)/.exec(headers.get("cookie") ?? "")?.[1];
          return id ? { user: { id } } : null;
        },
      },
    };
    app.useGlobalGuards(new PlatformAuthGuard(new Reflector(), auth as never, db, audit));
    await app.init();
    await listenOnLoopback(app);
  });

  beforeEach(() => {
    service.now = () => now;
  });

  afterAll(async () => {
    await app?.close();
    if (leadIds.length > 0)
      await db.delete(schema.landingLeads).where(inArray(schema.landingLeads.id, leadIds));
    // Audit is append-only; tenants and platform users stay referenced by it.
    await pool.end();
  });

  const as = (user: keyof typeof users) => `fixture=${users[user]}`;

  it("lets support read but not write, keeps accountants out and needs a session", async () => {
    const row = await lead();
    const http = request(app.getHttpServer());
    await http.get("/platform/leads").expect(401);
    await http.get("/platform/leads").set("Cookie", as("accountant")).expect(403);
    await http.get("/platform/leads/summary").set("Cookie", as("accountant")).expect(403);
    await http.get(`/platform/leads/${row.id}`).set("Cookie", as("support")).expect(200);
    await http.get("/platform/leads/summary").set("Cookie", as("support")).expect(200);
    for (const [method, path, body] of [
      ["patch", `/platform/leads/${row.id}`, { status: "lost" }],
      ["post", `/platform/leads/${row.id}/contacted`, {}],
      ["post", `/platform/leads/${row.id}/link-tenant`, { tenantId: "x" }],
      ["post", `/platform/leads/${row.id}/create-tenant`, { tenantName: "X", tenantSlug: "x" }],
      ["post", `/platform/leads/${row.id}/anonymize`, {}],
    ] as const) {
      await http[method](path).set("Cookie", as("support")).send(body).expect(403);
    }
    const denied = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.actorPlatformUserId, users.support),
          eq(schema.platformAuditEvents.action, "platform.authorization.denied"),
        ),
      );
    expect(denied.map((entry) => entry.targetId).sort()).toEqual([
      "PlatformLeadsController.anonymize",
      "PlatformLeadsController.contacted",
      "PlatformLeadsController.createTenant",
      "PlatformLeadsController.linkTenant",
      "PlatformLeadsController.update",
    ]);
    const unchanged = await service.detail(row.id);
    expect(unchanged.status).toBe("new");
    await http
      .patch(`/platform/leads/${row.id}`)
      .set("Cookie", as("admin"))
      .send({ status: "contacted" })
      .expect(200);
  });

  it("lists with search, filters and the new-lead badge count", async () => {
    const marker = randomUUID().slice(0, 8);
    const first = await lead({
      company: `Сидрерия ${marker}`,
      intent: "download",
      sourcePath: "/skachat/",
    });
    const second = await lead({ company: `Квас ${marker}`, inn: "500100732259" });
    await service.update(admin, second.id, { status: "trial" });
    const http = request(app.getHttpServer());
    const search = await http
      .get("/platform/leads")
      .query({ search: marker })
      .set("Cookie", as("support"))
      .expect(200);
    expect(search.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    const byInn = await service.list({ page: 1, limit: 50, search: "500100732259" });
    expect(byInn.items.map((item) => item.id)).toContain(second.id);
    const byEmail = await service.list({ page: 1, limit: 50, search: first.email ?? "" });
    expect(byEmail.items.map((item) => item.id)).toEqual([first.id]);
    const trials = await service.list({ page: 1, limit: 50, search: marker, status: "trial" });
    expect(trials.items.map((item) => item.id)).toEqual([second.id]);
    const downloads = await service.list({ page: 1, limit: 50, search: marker, kind: "download" });
    expect(downloads.items.map((item) => item.id)).toEqual([first.id]);
    const invoice = trials.items[0];
    expect(invoice).toMatchObject({ tariffCode: "line", lastEvent: { kind: "status_change" } });
    const future = await service.list({ page: 1, limit: 50, search: marker, from: "2999-01-01" });
    expect(future.total).toBe(0);
    const summary = await service.summary();
    expect(summary.newCount).toBeGreaterThanOrEqual(1);
  });

  it("audits a status change with the exact actor, lead and fields", async () => {
    const row = await lead();
    const detail = await service.update(admin, row.id, { status: "invoice_sent" });
    expect(detail).toMatchObject({ status: "invoice_sent", statusChangedAt: now.toISOString() });
    expect(detail.events[0]).toMatchObject({
      kind: "status_change",
      payload: { from: "new", to: "invoice_sent" },
      actor: { id: users.admin, name: "Тест admin" },
    });
    const [entry, ...rest] = await auditFor(row.id, "landing_lead.status_changed");
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      actorPlatformUserId: users.admin,
      actorRole: "platform_admin",
      action: "landing_lead.status_changed",
      outcome: "success",
      tenantId: null,
      targetType: "landing_lead",
      targetId: row.id,
      reason: null,
      before: { status: "new" },
      after: { status: "invoice_sent" },
    });
    // A note and the next touch are journaled without a second audit row.
    service.now = () => new Date(now.getTime() + 60_000);
    const noted = await service.update(admin, row.id, {
      ownerNote: "Счёт отправлен на buyer@example.test",
      nextTouchAt: "2026-10-24T06:00:00.000Z",
    });
    expect(noted).toMatchObject({
      ownerNote: "Счёт отправлен на buyer@example.test",
      nextTouchAt: "2026-10-24T06:00:00.000Z",
    });
    expect(noted.events[0]).toMatchObject({ kind: "note", payload: { length: 36 } });
    expect(await auditFor(row.id, "landing_lead.status_changed")).toHaveLength(1);
  });

  it("«Написал» moves new to contacted with a touch in three days, and keeps later statuses", async () => {
    const row = await lead();
    const contacted = await service.contacted(admin, row.id, {});
    expect(contacted).toMatchObject({
      status: "contacted",
      nextTouchAt: new Date(now.getTime() + 3 * DAY).toISOString(),
    });
    expect(contacted.events[0]).toMatchObject({
      kind: "status_change",
      payload: {
        from: "new",
        to: "contacted",
        nextTouchAt: new Date(now.getTime() + 3 * DAY).toISOString(),
      },
    });
    // Journal order is by time; give each action its own instant.
    service.now = () => new Date(now.getTime() + 60_000);
    const again = await service.contacted(admin, row.id, {
      nextTouchAt: "2026-10-30T06:00:00.000Z",
    });
    expect(again).toMatchObject({ status: "contacted", nextTouchAt: "2026-10-30T06:00:00.000Z" });
    expect(again.events[0]).toMatchObject({
      kind: "touch",
      payload: { nextTouchAt: "2026-10-30T06:00:00.000Z" },
    });
    service.now = () => new Date(now.getTime() + 120_000);
    await service.update(admin, row.id, { status: "trial" });
    const trial = await service.contacted(admin, row.id, {});
    expect(trial.status).toBe("trial");
    expect(await auditFor(row.id, "landing_lead.status_changed")).toHaveLength(2);
  });

  it("links an existing tenant with an exact audit row and refuses an unknown one", async () => {
    const row = await lead();
    await expect(
      service.linkTenant(admin, row.id, `missing-${randomUUID()}`),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: "lead_tenant_not_found" },
    });
    const tenantId = `lead-tenant-${randomUUID()}`;
    tenantIds.push(tenantId);
    await db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Существующий", slug: tenantId, createdAt: now });
    service.now = () => new Date(Date.now());
    const detail = await service.linkTenant(admin, row.id, tenantId);
    expect(detail.tenant).toEqual({ id: tenantId, name: "Существующий", cabinetAccess: "enabled" });
    expect(detail.events[0]).toMatchObject({
      kind: "linked_tenant",
      payload: { tenantId, created: false, previousTenantId: null },
    });
    const [entry, ...rest] = await auditFor(row.id, "landing_lead.tenant_linked");
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      actorPlatformUserId: users.admin,
      actorRole: "platform_admin",
      outcome: "success",
      tenantId,
      targetType: "landing_lead",
      targetId: row.id,
      reason: "tenant_selected",
      before: { tenantId: null },
      after: { tenantId },
    });
  });

  it("creates a tenant without cabinet from the lead, idempotently by slug", async () => {
    const row = await lead();
    service.now = () => new Date(Date.now());
    const slug = `inn-7707083893-${run}-${randomUUID().slice(0, 6)}`;
    const detail = await service.createTenant(admin, row.id, {
      tenantName: String(row.company),
      tenantSlug: slug,
    });
    expect(detail.tenant).toMatchObject({ name: row.company, cabinetAccess: "none" });
    const tenantId = detail.tenant?.id ?? "";
    tenantIds.push(tenantId);
    const [organization] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId));
    expect(organization).toMatchObject({ slug, cabinetAccess: "none" });
    expect(detail.events[0]).toMatchObject({
      kind: "linked_tenant",
      payload: { tenantId, created: true, previousTenantId: null },
    });
    expect((await auditFor(row.id, "landing_lead.tenant_linked"))[0]).toMatchObject({
      reason: "tenant_created",
      tenantId,
    });
    const retried = await service.createTenant(admin, row.id, {
      tenantName: String(row.company),
      tenantSlug: slug,
    });
    expect(retried.tenant?.id).toBe(tenantId);
    expect(await auditFor(row.id, "landing_lead.tenant_linked")).toHaveLength(1);
  });

  it("refuses to «create» a tenant whose slug already belongs to another tenant", async () => {
    const row = await lead();
    service.now = () => new Date(Date.now());
    const slug = `taken-${run}-${randomUUID().slice(0, 6)}`;
    const other = await provisioning.provision(
      { tenantName: "Чужой клиент", tenantSlug: slug, cabinetAccess: "none" },
      { actor: admin },
    );
    tenantIds.push(other.tenantId);
    await expect(
      service.createTenant(admin, row.id, { tenantName: String(row.company), tenantSlug: slug }),
    ).rejects.toMatchObject({ status: 409, response: { code: "lead_tenant_slug_taken" } });
    expect((await service.detail(row.id)).tenant).toBeNull();
    expect(await auditFor(row.id, "landing_lead.tenant_linked")).toHaveLength(0);
  });

  it("erases personal data on request, audits it once and then refuses a new note", async () => {
    const row = await lead({ inn: "500100732259" });
    await service.update(admin, row.id, { ownerNote: "позвонить" });
    service.now = () => new Date(now.getTime() + 60_000);
    const detail = await service.anonymize(admin, row.id);
    expect(detail).toMatchObject({
      email: null,
      name: null,
      phone: null,
      inn: null,
      ownerNote: null,
      anonymizedAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    expect(detail.events[0]).toMatchObject({ kind: "anonymized", payload: { reason: "manual" } });
    // The sole trader's INN also leaves the journal; the tariff stays for statistics.
    const invoice = detail.events.find((event) => event.kind === "invoice_request");
    expect(invoice?.payload).toMatchObject({ tariffCode: "line", sourcePath: "/stoimost/" });
    expect(invoice?.payload).not.toHaveProperty("inn");
    await service.anonymize(admin, row.id);
    const [entry, ...rest] = await auditFor(row.id, "landing_lead.anonymized");
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      actorPlatformUserId: users.admin,
      actorRole: "platform_admin",
      reason: "manual",
      before: {
        status: "new",
        email: true,
        name: true,
        phone: true,
        ownerNote: true,
        personalInn: true,
      },
      after: { anonymized: true },
    });
    await expect(service.update(admin, row.id, { ownerNote: "снова" })).rejects.toMatchObject({
      status: 409,
      response: { code: "lead_anonymized" },
    });
    const listed = await service.list({ page: 1, limit: 50, search: String(row.company) });
    expect(listed.items.find((item) => item.id === row.id)).toMatchObject({
      email: null,
      anonymized: true,
    });
  });

  it("answers 404 for an unknown lead and 400 for a malformed id", async () => {
    const http = request(app.getHttpServer());
    await http.get(`/platform/leads/${randomUUID()}`).set("Cookie", as("admin")).expect(404);
    await http.get("/platform/leads/not-a-uuid").set("Cookie", as("admin")).expect(400);
  });
});
