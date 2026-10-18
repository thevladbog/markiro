import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { configureStandaloneLicenseSigning } from "../src/modules/standalone-licenses/standalone-license-keyset";
import { StandaloneSitesService } from "../src/modules/standalone-licenses/standalone-sites.service";
import { createOrganization } from "./support/subscription-fixtures";
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
const NOW = new Date("2026-10-20T09:00:00.000Z");
const sites = new StandaloneSitesService(
  db,
  new PlatformAuditService(),
  configureStandaloneLicenseSigning(signingEnv()),
  () => NOW,
);
afterAll(() => connection.pool.end());

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConflictException);
  return error instanceof ConflictException ? error.getResponse() : null;
}

async function siteRows(tenantId: string) {
  return db
    .select()
    .from(schema.standaloneSites)
    .where(eq(schema.standaloneSites.tenantId, tenantId));
}

describe.skipIf(!process.env.DATABASE_URL)("standalone sites (plan ЛЦ-0)", () => {
  it("registers a site from an activation request with an exact audit row and replays the same request", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893", billing: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const body = {
      intent: "create" as const,
      requestId: randomUUID(),
      name: "Цех розлива",
      request: { ...request, supportToken: "MKS1.test.ABC" },
      acknowledgedWarnings: [],
    };

    const site = await sites.register(admin, tenantId, body);

    expect(site).toMatchObject({
      tenantId,
      hostId: request.hostId,
      name: "Цех розлива",
      requestInn: "7707083893",
      usage: { stations: 1, cabinetUsers: 1, lines: 1 },
      lastIssuedSequence: 0,
      latestIssuance: null,
      renewalDue: false,
      createdAt: NOW.toISOString(),
    });
    expect(site.hostHistory).toEqual([
      {
        hostId: request.hostId,
        requestInn: "7707083893",
        requestId: body.requestId,
        boundAt: NOW.toISOString(),
        boundByPlatformUserId: admin.userId,
      },
    ]);
    expect(await sites.register(admin, tenantId, body)).toEqual(site);
    expect(await siteRows(tenantId)).toHaveLength(1);
    expect((await siteRows(tenantId))[0]?.lastActivationRequest).toEqual(request);
    expect(await auditRows(db, tenantId)).toEqual([
      {
        actorPlatformUserId: admin.userId,
        actorRole: "platform_admin",
        tenantId,
        action: "standalone_site.registered",
        outcome: "success",
        targetType: "standalone_site",
        targetId: site.id,
        reason: null,
        requestId: body.requestId,
        before: null,
        after: {
          siteId: site.id,
          hostId: request.hostId,
          name: "Цех розлива",
          requestInn: "7707083893",
          warnings: [],
        },
      },
    ]);
    expect(await sites.list(admin, tenantId)).toEqual({
      tenantId,
      signingConfigured: true,
      issuanceSource: "subscription",
      sites: [site],
    });
  });

  it("refuses unacknowledged INN warnings without writing, then registers with exactly those acknowledged", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893", billing: "7728168971" });
    const request = activationRequest({ inn: "7736207543" });

    const inspection = await sites.inspect(admin, tenantId, { request });
    expect(inspection).toMatchObject({
      hostId: request.hostId,
      innFacts: {
        requestInn: "7736207543",
        orgInn: "7707083893",
        billingInn: "7728168971",
        trialInn: "7736207543",
      },
      warnings: ["request_inn_differs_billing", "request_inn_differs_org"],
      blocking: null,
      registeredSite: null,
    });
    expect(
      await refusal(
        sites.register(admin, tenantId, {
          intent: "create",
          requestId: randomUUID(),
          name: "Склад",
          request,
          acknowledgedWarnings: ["request_inn_differs_org"],
        }),
      ),
    ).toEqual({ code: "standalone_site_warnings_unacknowledged" });
    expect(await siteRows(tenantId)).toEqual([]);
    expect(await auditRows(db, tenantId)).toEqual([]);

    const site = await sites.register(admin, tenantId, {
      intent: "create",
      requestId: randomUUID(),
      name: "Склад",
      request,
      acknowledgedWarnings: ["request_inn_differs_org", "request_inn_differs_billing"],
    });
    expect((await auditRows(db, tenantId)).map((row) => row.after)).toEqual([
      {
        siteId: site.id,
        hostId: request.hostId,
        name: "Склад",
        requestInn: "7736207543",
        warnings: ["request_inn_differs_billing", "request_inn_differs_org"],
      },
    ]);
  });

  it("keeps tenants apart: another tenant neither sees, takes nor rebinds the site", async () => {
    const admin = await platformActor(db);
    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    await setTenantInns(db, tenantA, { org: "7707083893" });
    await setTenantInns(db, tenantB, { org: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const site = await sites.register(admin, tenantA, {
      intent: "create",
      requestId: randomUUID(),
      name: "A",
      request,
      acknowledgedWarnings: [],
    });

    expect((await sites.list(admin, tenantB)).sites).toEqual([]);
    expect(await sites.inspect(admin, tenantB, { request })).toMatchObject({
      blocking: "host_taken",
      registeredSite: null,
    });
    expect(await sites.inspect(admin, tenantA, { request })).toMatchObject({
      blocking: "host_registered",
      registeredSite: { id: site.id, name: "A" },
    });
    expect(
      await refusal(
        sites.register(admin, tenantB, {
          intent: "create",
          requestId: randomUUID(),
          name: "B",
          request,
          acknowledgedWarnings: [],
        }),
      ),
    ).toEqual({ code: "standalone_site_host_taken" });
    await expect(
      sites.register(admin, tenantB, {
        intent: "rebind",
        requestId: randomUUID(),
        siteId: site.id,
        request: activationRequest({ inn: "7707083893" }),
        acknowledgedWarnings: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await refusal(
        sites.register(admin, tenantA, {
          intent: "create",
          requestId: randomUUID(),
          name: "A2",
          request,
          acknowledgedWarnings: [],
        }),
      ),
    ).toEqual({ code: "standalone_site_host_registered" });
    expect(await siteRows(tenantB)).toEqual([]);
    expect(await auditRows(db, tenantB)).toEqual([]);
    expect((await auditRows(db, tenantA)).map((row) => row.action)).toEqual([
      "standalone_site.registered",
    ]);
    await expect(sites.list(admin, `missing-${randomUUID()}`)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("binds a new host id to the same site, keeps the history and audits the change once", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const first = activationRequest({ inn: "7707083893" });
    const site = await sites.register(admin, tenantId, {
      intent: "create",
      requestId: randomUUID(),
      name: "Цех",
      request: first,
      acknowledgedWarnings: [],
    });
    const second = activationRequest({
      inn: "7707083893",
      usage: { stations: 3, cabinetUsers: 2, lines: 2 },
    });
    const rebind = {
      intent: "rebind" as const,
      requestId: randomUUID(),
      siteId: site.id,
      request: second,
      acknowledgedWarnings: [],
    };

    const rebound = await sites.register(admin, tenantId, rebind);

    expect(rebound).toMatchObject({
      id: site.id,
      hostId: second.hostId,
      usage: { stations: 3, cabinetUsers: 2, lines: 2 },
      lastIssuedSequence: 0,
    });
    expect(rebound.hostHistory.map((entry) => entry.hostId)).toEqual([first.hostId, second.hostId]);
    expect(await sites.register(admin, tenantId, rebind)).toEqual(rebound);
    expect(
      await refusal(sites.register(admin, tenantId, { ...rebind, requestId: randomUUID() })),
    ).toEqual({ code: "standalone_site_host_unchanged" });
    const rows = await auditRows(db, tenantId);
    expect(rows.map((row) => row.action)).toEqual([
      "standalone_site.registered",
      "standalone_site.host_rebound",
    ]);
    expect(rows[1]).toEqual({
      actorPlatformUserId: admin.userId,
      actorRole: "platform_admin",
      tenantId,
      action: "standalone_site.host_rebound",
      outcome: "success",
      targetType: "standalone_site",
      targetId: site.id,
      reason: null,
      requestId: rebind.requestId,
      before: { hostId: first.hostId, requestInn: "7707083893" },
      after: { siteId: site.id, hostId: second.hostId, requestInn: "7707083893", warnings: [] },
    });
  });

  it("registers a site for a tenant without a cabinet and lists it on the offline path, its cabinet untouched", async () => {
    const admin = await platformActor(db);
    const tenantId = await createTenantWithoutCabinet(db);
    await setTenantInns(db, tenantId, { billing: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });

    const site = await sites.register(admin, tenantId, {
      intent: "create",
      requestId: randomUUID(),
      name: "Офлайн-цех",
      request,
      acknowledgedWarnings: [],
    });

    expect(await sites.list(admin, tenantId)).toEqual({
      tenantId,
      signingConfigured: true,
      issuanceSource: "offline",
      sites: [site],
    });
    const [tenant] = await db
      .select({ cabinetAccess: schema.organization.cabinetAccess })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId));
    expect(tenant).toEqual({ cabinetAccess: "none" });
  });

  it("replays a request id only for the administrator and host that made it", async () => {
    const admin = await platformActor(db);
    const other = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const first = activationRequest({ inn: "7707083893" });
    const create = {
      intent: "create" as const,
      requestId: randomUUID(),
      name: "Цех",
      request: first,
      acknowledgedWarnings: [],
    };
    const site = await sites.register(admin, tenantId, create);
    const rebind = {
      intent: "rebind" as const,
      requestId: randomUUID(),
      siteId: site.id,
      request: activationRequest({ inn: "7707083893" }),
      acknowledgedWarnings: [],
    };
    const rebound = await sites.register(admin, tenantId, rebind);

    // Thunks: each replay starts only when awaited, so no rejection goes unhandled.
    for (const replay of [
      () => sites.register(other, tenantId, create),
      () =>
        sites.register(admin, tenantId, {
          ...create,
          request: activationRequest({ inn: "7707083893" }),
        }),
      () => sites.register(other, tenantId, rebind),
      () =>
        sites.register(admin, tenantId, {
          ...rebind,
          request: activationRequest({ inn: "7707083893" }),
        }),
      () =>
        sites.register(admin, tenantId, { ...rebind, requestId: create.requestId, request: first }),
    ]) {
      expect(await refusal(replay())).toEqual({ code: "standalone_site_request_conflict" });
    }
    // The create still replays after the site moved to its new host.
    expect(await sites.register(admin, tenantId, create)).toEqual(rebound);
    expect(await siteRows(tenantId)).toHaveLength(1);
    expect((await auditRows(db, tenantId)).map((row) => row.action)).toEqual([
      "standalone_site.registered",
      "standalone_site.host_rebound",
    ]);
  });

  it("writes one site for one request confirmed twice at once, and one site for one host raced by two tenants", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const body = {
      intent: "create" as const,
      requestId: randomUUID(),
      name: "Цех",
      request: activationRequest({ inn: "7707083893" }),
      acknowledgedWarnings: [],
    };
    const [a, b] = await Promise.all([
      sites.register(admin, tenantId, body),
      sites.register(admin, tenantId, body),
    ]);
    expect(b).toEqual(a);
    expect(await siteRows(tenantId)).toHaveLength(1);
    expect(await auditRows(db, tenantId)).toHaveLength(1);

    const tenantA = await createOrganization(db);
    const tenantB = await createOrganization(db);
    await setTenantInns(db, tenantA, { org: "7707083893" });
    await setTenantInns(db, tenantB, { org: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const results = await Promise.allSettled(
      [tenantA, tenantB].map((tenant) =>
        sites.register(admin, tenant, {
          intent: "create",
          requestId: randomUUID(),
          name: "Гонка",
          request,
          acknowledgedWarnings: [],
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0] instanceof ConflictException ? rejected[0].getResponse() : null).toEqual({
      code: "standalone_site_host_taken",
    });
    expect([...(await siteRows(tenantA)), ...(await siteRows(tenantB))]).toHaveLength(1);
  });

  it("shows no request date for an activation request whose createdAt is not a calendar instant", async () => {
    const admin = await platformActor(db);
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const site = await sites.register(admin, tenantId, {
      intent: "create",
      requestId: randomUUID(),
      name: "Цех",
      request: { ...activationRequest({ inn: "7707083893" }), createdAt: "2026-13-45T09:00:00Z" },
      acknowledgedWarnings: [],
    });
    expect(site.requestCreatedAt).toBeNull();
  });

  it("denies a suspended administrator and one whose two-factor flag is off", async () => {
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const suspended = await platformActor(db);
    await db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, suspended.userId));
    const noFactor = await platformActor(db);
    await db
      .update(schema.platformUsers)
      .set({ twoFactorEnabled: false })
      .where(eq(schema.platformUsers.id, noFactor.userId));
    for (const actor of [suspended, noFactor]) {
      await expect(sites.list(actor, tenantId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        sites.register(actor, tenantId, {
          intent: "create",
          requestId: randomUUID(),
          name: "Цех",
          request,
          acknowledgedWarnings: [],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(await siteRows(tenantId)).toEqual([]);
  });

  it("denies support, accountant and an administrator without a verified factor, writing nothing", async () => {
    const tenantId = await createOrganization(db);
    await setTenantInns(db, tenantId, { org: "7707083893" });
    const request = activationRequest({ inn: "7707083893" });
    const body = {
      intent: "create" as const,
      requestId: randomUUID(),
      name: "Цех",
      request,
      acknowledgedWarnings: [],
    };
    for (const actor of [
      await platformActor(db, "support"),
      await platformActor(db, "accountant"),
      await platformActor(db, "platform_admin", { verified: false }),
      undefined,
    ]) {
      await expect(sites.list(actor, tenantId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sites.inspect(actor, tenantId, { request })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(sites.register(actor, tenantId, body)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    expect(await siteRows(tenantId)).toEqual([]);
    expect(await auditRows(db, tenantId)).toEqual([]);
  });
});
