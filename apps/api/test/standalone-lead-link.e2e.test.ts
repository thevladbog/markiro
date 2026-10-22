import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import type { LandingLeadStatus } from "@markiro/platform-contracts";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { configureStandaloneLicenseSigning } from "../src/modules/standalone-licenses/standalone-license-keyset";
import { StandaloneSitesService } from "../src/modules/standalone-licenses/standalone-sites.service";
import {
  activationRequest,
  auditRows,
  createTenantWithoutCabinet,
  platformActor,
  setTenantInns,
  signingEnv,
} from "./support/standalone-license-fixture";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const audit = new PlatformAuditService();
const NOW = new Date("2026-10-21T09:00:00.000Z");
const sites = new StandaloneSitesService(
  db,
  audit,
  configureStandaloneLicenseSigning(signingEnv()),
  () => NOW,
);
afterAll(() => connection.pool.end());

/** A fresh valid 10-digit INN, so no lead of another test file shares it. */
function freshInn(): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const digits = Array.from({ length: 9 }, (_, index) =>
    index === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const control =
    (digits.reduce((sum, digit, index) => sum + digit * (weights[index] ?? 0), 0) % 11) % 10;
  return [...digits, control].join("");
}

let leadCount = 0;
async function lead(input: {
  inn: string;
  status?: LandingLeadStatus;
  tenantId?: string;
  anonymized?: boolean;
}) {
  const id = randomUUID();
  // Distinct instants: candidates are ordered by arrival.
  const createdAt = new Date(NOW.getTime() - 86_400_000 + leadCount++ * 1_000);
  await db.insert(schema.landingLeads).values({
    id,
    email: input.anonymized ? null : `${id}@example.invalid`,
    company: "ООО «Пилот»",
    inn: input.inn,
    locale: "ru",
    status: input.status ?? "new",
    statusChangedAt: createdAt,
    tenantId: input.tenantId ?? null,
    firstSourcePath: "/stoimost/",
    anonymizedAt: input.anonymized ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

async function leadRow(id: string) {
  const [row] = await db
    .select({
      status: schema.landingLeads.status,
      tenantId: schema.landingLeads.tenantId,
      statusChangedAt: schema.landingLeads.statusChangedAt,
    })
    .from(schema.landingLeads)
    .where(eq(schema.landingLeads.id, id));
  return row;
}

/**
 * The lead's journal. Events written by one registration share its instant, so they
 * are compared in a canonical order (by kind), not in the random order of their ids.
 */
async function leadEvents(id: string) {
  const rows = await db
    .select({
      kind: schema.landingLeadEvents.kind,
      payload: schema.landingLeadEvents.payload,
      actorPlatformUserId: schema.landingLeadEvents.actorPlatformUserId,
    })
    .from(schema.landingLeadEvents)
    .where(eq(schema.landingLeadEvents.leadId, id))
    .orderBy(asc(schema.landingLeadEvents.createdAt), asc(schema.landingLeadEvents.kind));
  return rows;
}

/** Audit rows of one transaction share its instant: compared by action. */
async function sortedAudit(tenantId: string) {
  return (await auditRows(db, tenantId, { leads: true })).sort((left, right) =>
    left.action.localeCompare(right.action),
  );
}

/** A tenant without a cabinet whose organization INN is the request INN: no warnings. */
async function tenantWith(inn: string) {
  const admin = await platformActor(db);
  const tenantId = await createTenantWithoutCabinet(db);
  await setTenantInns(db, tenantId, { org: inn });
  return { admin, tenantId };
}

async function register(
  admin: Awaited<ReturnType<typeof platformActor>>,
  tenantId: string,
  inn: string,
) {
  return sites.register(admin, tenantId, {
    intent: "create",
    requestId: randomUUID(),
    name: "Пилотный цех",
    request: activationRequest({ inn }),
    acknowledgedWarnings: [],
  });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "landing lead linked by a site's activation request (spec 2026-10-20 §15.6)",
  () => {
    it("links the one lead with the request INN, records the request and moves it to trial, with exact audit", async () => {
      const inn = freshInn();
      const leadId = await lead({ inn });
      const { admin, tenantId } = await tenantWith(inn);
      const requestId = randomUUID();
      const body = {
        intent: "create" as const,
        requestId,
        name: "Пилотный цех",
        request: activationRequest({ inn }),
        acknowledgedWarnings: [],
      };

      const site = await sites.register(admin, tenantId, body);

      expect(site.leadLink).toEqual({ state: "linked", leadIds: [leadId] });
      expect(await leadRow(leadId)).toEqual({
        status: "trial",
        tenantId,
        statusChangedAt: NOW,
      });
      expect(await leadEvents(leadId)).toEqual([
        {
          kind: "activation_request",
          payload: { tenantId, siteId: site.id, hostId: site.hostId, intent: "create" },
          actorPlatformUserId: admin.userId,
        },
        {
          kind: "linked_tenant",
          payload: { tenantId, created: false, previousTenantId: null, via: "activation_request" },
          actorPlatformUserId: admin.userId,
        },
        {
          kind: "status_change",
          payload: { from: "new", to: "trial", via: "activation_request" },
          actorPlatformUserId: admin.userId,
        },
      ]);
      const actor = { actorPlatformUserId: admin.userId, actorRole: "platform_admin", tenantId };
      expect(await sortedAudit(tenantId)).toEqual([
        {
          ...actor,
          action: "landing_lead.status_changed",
          outcome: "success",
          targetType: "landing_lead",
          targetId: leadId,
          reason: "activation_request",
          requestId,
          before: { status: "new" },
          after: { status: "trial" },
        },
        {
          ...actor,
          action: "landing_lead.tenant_linked",
          outcome: "success",
          targetType: "landing_lead",
          targetId: leadId,
          reason: "activation_request",
          requestId,
          before: { tenantId: null },
          after: { tenantId, siteId: site.id },
        },
        {
          ...actor,
          action: "standalone_site.registered",
          outcome: "success",
          targetType: "standalone_site",
          targetId: site.id,
          reason: null,
          requestId,
          before: null,
          after: {
            siteId: site.id,
            hostId: site.hostId,
            name: "Пилотный цех",
            requestInn: inn,
            warnings: [],
            lead: { outcome: "linked", leadId },
          },
        },
      ]);

      // The same registration request replays: no second event, no second audit row.
      expect(await sites.register(admin, tenantId, body)).toEqual(site);
      expect(await leadEvents(leadId)).toHaveLength(3);
      expect(await sortedAudit(tenantId)).toHaveLength(3);
      // The list shows the same link.
      const list = await sites.list(admin, tenantId);
      expect(list.sites.map((entry) => entry.leadLink)).toEqual([
        { state: "linked", leadIds: [leadId] },
      ]);
    });

    it("moves a contacted lead to trial and leaves a lead further on in its status", async () => {
      for (const [from, to] of [
        ["contacted", "trial"],
        ["trial", "trial"],
        ["invoice_sent", "invoice_sent"],
        ["won", "won"],
        ["lost", "lost"],
      ] as const) {
        const inn = freshInn();
        const leadId = await lead({ inn, status: from });
        const { admin, tenantId } = await tenantWith(inn);
        await register(admin, tenantId, inn);
        expect(await leadRow(leadId)).toMatchObject({ status: to, tenantId });
        const kinds = (await leadEvents(leadId)).map((event) => event.kind);
        expect(kinds).toEqual(
          from === to
            ? ["activation_request", "linked_tenant"]
            : ["activation_request", "linked_tenant", "status_change"],
        );
        const actions = (await sortedAudit(tenantId)).map((row) => row.action);
        expect(actions).toEqual(
          from === to
            ? ["landing_lead.tenant_linked", "standalone_site.registered"]
            : [
                "landing_lead.status_changed",
                "landing_lead.tenant_linked",
                "standalone_site.registered",
              ],
        );
      }
    });

    it("records the request on a lead already linked to this tenant, also when a host is rebound", async () => {
      const inn = freshInn();
      const { admin, tenantId } = await tenantWith(inn);
      const leadId = await lead({ inn, status: "invoice_sent", tenantId });
      const site = await register(admin, tenantId, inn);
      const rebound = await sites.register(admin, tenantId, {
        intent: "rebind",
        requestId: randomUUID(),
        siteId: site.id,
        request: activationRequest({ inn }),
        acknowledgedWarnings: [],
      });
      expect(rebound.leadLink).toEqual({ state: "linked", leadIds: [leadId] });
      const events = await leadEvents(leadId);
      expect(events).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining([
          {
            kind: "activation_request",
            payload: { tenantId, siteId: site.id, hostId: site.hostId, intent: "create" },
            actorPlatformUserId: admin.userId,
          },
          {
            kind: "activation_request",
            payload: { tenantId, siteId: site.id, hostId: rebound.hostId, intent: "rebind" },
            actorPlatformUserId: admin.userId,
          },
        ]),
      );
      expect(await leadRow(leadId)).toMatchObject({ status: "invoice_sent", tenantId });
      const rebind = (await sortedAudit(tenantId)).find(
        (row) => row.action === "standalone_site.host_rebound",
      );
      expect(rebind).toMatchObject({
        action: "standalone_site.host_rebound",
        after: { lead: { outcome: "linked", leadId } },
      });
    });

    it("links nothing when several leads share the INN and shows them for the operator", async () => {
      const inn = freshInn();
      const first = await lead({ inn });
      const second = await lead({ inn, status: "contacted" });
      const { admin, tenantId } = await tenantWith(inn);
      const site = await register(admin, tenantId, inn);
      expect(site.leadLink).toEqual({ state: "unresolved", leadIds: [first, second] });
      for (const id of [first, second]) {
        expect(await leadRow(id)).toMatchObject({ tenantId: null });
        expect(await leadEvents(id)).toEqual([]);
      }
      expect((await leadRow(first))?.status).toBe("new");
      expect((await leadRow(second))?.status).toBe("contacted");
      expect(await sortedAudit(tenantId)).toEqual([
        expect.objectContaining({
          action: "standalone_site.registered",
          after: expect.objectContaining({
            lead: { outcome: "unresolved", leadIds: [first, second] },
          }),
        }),
      ]);
    });

    it("does not move a lead linked to another tenant", async () => {
      const inn = freshInn();
      const other = await createTenantWithoutCabinet(db);
      const leadId = await lead({ inn, tenantId: other });
      const { admin, tenantId } = await tenantWith(inn);
      const site = await register(admin, tenantId, inn);
      expect(site.leadLink).toEqual({ state: "unresolved", leadIds: [leadId] });
      expect(await leadRow(leadId)).toMatchObject({ status: "new", tenantId: other });
      expect(await leadEvents(leadId)).toEqual([]);
    });

    it("says so when no lead has the INN, and ignores an anonymized one", async () => {
      const inn = freshInn();
      const anonymized = await lead({ inn, anonymized: true });
      const { admin, tenantId } = await tenantWith(inn);
      const site = await register(admin, tenantId, inn);
      expect(site.leadLink).toEqual({ state: "none", leadIds: [] });
      expect(await leadRow(anonymized)).toMatchObject({ status: "new", tenantId: null });
      expect(await sortedAudit(tenantId)).toEqual([
        expect.objectContaining({
          action: "standalone_site.registered",
          after: expect.objectContaining({ lead: { outcome: "none" } }),
        }),
      ]);
      // A lead that arrives after the registration is shown, not linked behind the operator's back.
      const later = await lead({ inn });
      const list = await sites.list(admin, tenantId);
      expect(list.sites[0]?.leadLink).toEqual({ state: "unresolved", leadIds: [later] });
      expect(await leadRow(later)).toMatchObject({ tenantId: null });
    });

    it("has no key when the request carries no INN", async () => {
      const { admin, tenantId } = await tenantWith(freshInn());
      const request = activationRequest({ inn: "", trialInn: null });
      const inspection = await sites.inspect(admin, tenantId, { request });
      const site = await sites.register(admin, tenantId, {
        intent: "create",
        requestId: randomUUID(),
        name: "Без ИНН",
        request,
        acknowledgedWarnings: inspection.warnings,
      });
      expect(site.leadLink).toBeNull();
      expect((await sortedAudit(tenantId)).map((row) => [row.action, row.after])).toEqual([
        ["standalone_site.registered", expect.objectContaining({ lead: null })],
      ]);
    });

    it("leaves the lead alone when the registration is refused", async () => {
      const inn = freshInn();
      const leadId = await lead({ inn });
      const { tenantId } = await tenantWith(inn);
      const support = await platformActor(db, "support");
      const refused = await register(support, tenantId, inn).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(HttpException);
      expect((refused as HttpException).getStatus()).toBe(403);
      expect(await leadRow(leadId)).toMatchObject({ status: "new", tenantId: null });
      expect(await leadEvents(leadId)).toEqual([]);
    });
  },
);
