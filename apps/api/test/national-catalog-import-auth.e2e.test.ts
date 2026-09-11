import { randomUUID } from "node:crypto";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ROUTE_ACCESS_POLICY } from "../src/authorization/access-policy";
import { ROUTE_SUBSCRIPTION_ACCESS_POLICY } from "../src/subscriptions/subscription-access-policy";
import { NationalCatalogImportController } from "../src/modules/national-catalog/national-catalog-import.controller";
import { NationalCatalogLinkController } from "../src/modules/national-catalog/national-catalog-link.controller";
import { Test } from "@nestjs/testing";
import { Logger, type INestApplication } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { nationalCatalogBodyParser } from "../src/modules/national-catalog/body-parser";
import { PgBossService } from "../src/jobs/jobs.module";
import { NationalCatalogLinkRefreshService } from "../src/modules/national-catalog/national-catalog-link-refresh.service";
import { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import { NationalCatalogJobsService } from "../src/modules/national-catalog/national-catalog-jobs.service";
import { createManagedSubscription } from "./support/subscription-fixtures";
import { listenOnLoopback } from "./support/listen-loopback";
import {
  createTestStationDevice,
  signUpAndActivate,
  setOnlyOrganizationMemberRole,
} from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
describe.skipIf(!ready)("National Catalog actual cabinet HTTP authorization", () => {
  let app: INestApplication;
  let db: Db;
  beforeAll(async () => {
    const env = loadEnv({
      ...process.env,
      SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only",
      NATIONAL_CATALOG_BASE_URL: "https://апи.национальный-каталог.рф",
      NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "true",
      NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "true",
    });
    const setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(NationalCatalogClient)
      .useValue({
        listOwnProducts: vi.fn(() => {
          throw Error("No external HTTP authorized");
        }),
        getFeedProducts: vi.fn(() => {
          throw Error("No external HTTP authorized");
        }),
        getFeedProductsByIds: vi.fn(() => {
          throw Error("No external HTTP authorized");
        }),
      })
      .compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(nationalCatalogBodyParser);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app?.close();
  });
  it("enforces READ versus WRITE and tenant scope through real Better Auth", async () => {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("fixture member missing");
    const sessionId = randomUUID();
    await db.insert(schema.nationalCatalogImportSessions).values({
      id: sessionId,
      tenantId,
      actorId: member.userId,
      mode: "gtins",
      environment: "production",
      startedAt: new Date(),
      throughAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      state: "ready",
      checkpoint: {
        version: 1,
        stepId: randomUUID(),
        runId: null,
        phase: "done",
        work: [],
        failures: [],
        attempts: 0,
        state: "done",
        nextRetryAt: null,
        enqueuePending: false,
      },
    });
    await setOnlyOrganizationMemberRole(db, tenantId, "manager");
    await createManagedSubscription(db, {
      tenantId,
      startsAt: new Date(Date.now() - 86400000),
      endsAt: new Date(Date.now() - 60000),
    });
    const writeResponse = await agent
      .post("/national-catalog/import-sessions")
      .send({ mode: "own_catalog" });
    const readResponse = await agent.get(`/national-catalog/import-sessions/${sessionId}`);
    const foreignSessionResponse = await agent.get(
      `/national-catalog/import-sessions/${randomUUID()}`,
    );
    expect(writeResponse.status).toBe(403);
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.automaticWorkPending).toBe(false);
    expect(foreignSessionResponse.status).toBe(404);
  });
  type Route = {
    method: "get" | "post" | "put" | "delete";
    path: string;
    body?: object;
    write: boolean;
  };
  function routes(sessionId: string = randomUUID(), productId: string = randomUUID()): Route[] {
    const base = `/national-catalog/import-sessions/${sessionId}`;
    const id = randomUUID();
    return [
      { method: "get", path: "/national-catalog/capabilities", write: false },
      {
        method: "post",
        path: "/national-catalog/import-sessions",
        body: { mode: "own_catalog" },
        write: true,
      },
      { method: "get", path: base, write: false },
      { method: "get", path: base + "/items", write: false },
      { method: "post", path: base + "/retries", body: {}, write: true },
      {
        method: "put",
        path: base + "/selection",
        body: { expectedRevision: 1, itemIds: [] },
        write: true,
      },
      {
        method: "post",
        path: base + "/previews",
        body: { requestId: id, itemIds: [id], manualNames: [], categoryChoices: [] },
        write: true,
      },
      { method: "get", path: base + `/preparations/${id}`, write: false },
      { method: "post", path: base + `/preparations/${id}/retries`, body: {}, write: true },
      { method: "get", path: base + `/images/${id}`, write: false },
      { method: "post", path: base + `/previews/${id}/images/${id}`, body: {}, write: true },
      {
        method: "post",
        path: base + "/applies",
        body: {
          requestId: id,
          decisions: [
            { previewId: id, acceptedEntryIds: [], linkAction: "attach", photo: { kind: "keep" } },
          ],
        },
        write: true,
      },
      { method: "get", path: base + `/applies/${id}`, write: false },
      {
        method: "post",
        path: base + `/applies/${id}/retries`,
        body: { previewIds: [id] },
        write: true,
      },
      { method: "post", path: base + "/cancel", body: {}, write: true },
      { method: "get", path: `/products/${productId}/national-catalog/link`, write: false },
      {
        method: "post",
        path: `/products/${productId}/national-catalog/link/refresh`,
        body: {},
        write: true,
      },
      {
        method: "delete",
        path: `/products/${productId}/national-catalog/link`,
        body: { action: "remove", expectedRevision: 1 },
        write: true,
      },
    ];
  }
  function send(agent: ReturnType<typeof request.agent>, route: Route) {
    const req = agent[route.method](route.path);
    return route.body === undefined ? req : req.send(route.body);
  }
  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw Error("fixture member");
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "chestny_znak", settings: { environment: "production" } });
    return { agent, tenantId, userId: member.userId };
  }
  it("denies unauthenticated and valid Station credentials on every new route", async () => {
    const f = await fixture();
    const station = await createTestStationDevice(app, f.agent, "Import auth station");
    const anonymous = request.agent(app.getHttpServer());
    for (const route of routes()) {
      expect((await send(anonymous, route)).status, route.path).toBe(401);
      expect(
        (await send(anonymous, route).set("x-api-key", station.apiKey)).status,
        route.path,
      ).toBe(403);
    }
  });
  it("denies every new route for no-capability and revoked current membership", async () => {
    const f = await fixture();
    await setOnlyOrganizationMemberRole(db, f.tenantId, "member");
    for (const route of routes()) expect((await send(f.agent, route)).status, route.path).toBe(403);
    await db.delete(schema.member).where(eq(schema.member.organizationId, f.tenantId));
    for (const route of routes()) expect((await send(f.agent, route)).status, route.path).toBe(403);
  });
  it("denies every mutation under read-only subscription while exposing safe stored availability", async () => {
    const f = await fixture();
    await setOnlyOrganizationMemberRole(db, f.tenantId, "manager");
    await createManagedSubscription(db, {
      tenantId: f.tenantId,
      startsAt: new Date(Date.now() - 86400000),
      endsAt: new Date(Date.now() - 60000),
    });
    for (const route of routes().filter((r) => r.write)) {
      const response = await send(f.agent, route);
      expect(response.status, route.path).toBe(403);
      expect(response.body).toEqual({ code: "subscription_read_only" });
    }
    const capabilities = await f.agent.get("/national-catalog/capabilities").expect(200);
    expect(capabilities.body).toMatchObject({
      ownCatalog: false,
      connection: { state: "blocked", reason: "token_unavailable" },
    });
    expect(JSON.stringify(capabilities.body)).not.toMatch(/https|encrypted|nonce|bearer/i);
  });
  it("scopes every object route to its authenticated tenant with404", async () => {
    const owner = await fixture();
    const foreign = await fixture();
    const started = await foreign.agent
      .post("/national-catalog/import-sessions")
      .send({ mode: "own_catalog" })
      .expect(200);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: foreign.tenantId,
      name: "Foreign",
      gtin14: "04601234567893",
      boxCapacity: 1,
      palletBoxCapacity: 1,
      status: "active",
    });
    for (const route of routes(started.body.id as string, productId).filter(
      (r) =>
        r.path !== "/national-catalog/capabilities" &&
        r.path !== "/national-catalog/import-sessions",
    ))
      expect((await send(owner.agent, route)).status, route.path).toBe(404);
  });
  it("serves persisted preparation/result and precise stale/invalid/expired statuses", async () => {
    const f = await fixture();
    const start = await f.agent
      .post("/national-catalog/import-sessions")
      .send({ mode: "own_catalog" })
      .expect(200);
    const sessionId = start.body.id as string;
    const base = `/national-catalog/import-sessions/${sessionId}`;
    const itemId = randomUUID();
    await db.insert(schema.nationalCatalogImportItems).values({
      id: itemId,
      tenantId: f.tenantId,
      sessionId,
      gtin14: "04601234567893",
      cardId: "123",
      name: "Ready",
      match: "new",
      selectable: true,
      selected: true,
      source: {},
      sourceHash: "a".repeat(64),
    });
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ loaded: 1, selected: 1, state: "ready" })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await f.agent
      .put(base + "/selection")
      .send({ expectedRevision: 999, itemIds: [itemId] })
      .expect(409);
    await f.agent
      .put(base + "/selection")
      .send({ expectedRevision: 1, itemIds: [randomUUID()] })
      .expect(422);
    const body = {
      requestId: randomUUID(),
      itemIds: [itemId],
      manualNames: [],
      categoryChoices: [],
    };
    const prepared = await f.agent
      .post(base + "/previews")
      .send(body)
      .expect(200);
    const preparationId = prepared.body.preparation.id as string;
    await f.agent.get(base + `/preparations/${preparationId}`).expect(200);
    await f.agent
      .post(base + "/previews")
      .send({ ...body, manualNames: [{ itemId, name: "changed" }] })
      .expect(409);
    const operationId = randomUUID();
    await db.insert(schema.nationalCatalogImportOperations).values({
      id: operationId,
      tenantId: f.tenantId,
      sessionId,
      actorId: f.userId,
      requestId: randomUUID(),
      decisionHash: "a".repeat(64),
      state: "finished",
      enqueuePending: false,
    });
    await f.agent.get(base + `/applies/${operationId}`).expect(200);
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({
        startedAt: new Date(Date.now() - 2 * 86400000),
        expiresAt: new Date(Date.now() - 1000),
      })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await f.agent.get(base + `/preparations/${preparationId}`).expect(410);
    await f.agent.get(base + `/applies/${operationId}`).expect(200);
    await f.agent.get(base + "/items?limit=101").expect(400);
    await f.agent
      .post(base + "/retries")
      .send({ tenantId: f.tenantId })
      .expect(400);
  });
  it("uses the required AppModule refresh dependency to schedule trusted confirmed links", async () => {
    const f = await fixture();
    const productId = randomUUID();
    const linkId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      name: "Freshness",
      gtin14: "04601234567893",
      boxCapacity: 1,
      palletBoxCapacity: 1,
      status: "active",
    });
    await db.insert(schema.nationalCatalogProductLinks).values({
      id: linkId,
      tenantId: f.tenantId,
      productId,
      environment: "production",
      cardId: "1",
      boundGtin14: "04601234567893",
      confirmedBy: f.userId,
      updatedAt: new Date(0),
    });
    await setOnlyOrganizationMemberRole(db, f.tenantId, "member");
    const refresh = app.get(NationalCatalogLinkRefreshService);
    const schedule = vi.spyOn(refresh, "schedule");
    await app.get(PgBossService).runNationalCatalogFreshness();
    expect(schedule).toHaveBeenCalledWith(f.tenantId, productId);
    const [link] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    expect(link?.refreshCheckpoint).toMatchObject({
      actor: { kind: "system" },
      enqueuePending: true,
      attempts: 0,
    });
    expect(app.get(NationalCatalogJobsService)).toBeInstanceOf(NationalCatalogJobsService);
    schedule.mockRestore();
  });

  it("audits queued manual refresh refusal with the current actor once after membership loss", async () => {
    const f = await fixture();
    const productId = randomUUID();
    const linkId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      name: "Manual check",
      gtin14: "04601234567893",
    });
    await db.insert(schema.nationalCatalogProductLinks).values({
      id: linkId,
      tenantId: f.tenantId,
      productId,
      environment: "production",
      cardId: "1",
      boundGtin14: "04601234567893",
      confirmedBy: f.userId,
    });
    await f.agent.post(`/products/${productId}/national-catalog/link/refresh`).send({}).expect(200);
    const [link] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    const cp = link?.refreshCheckpoint as { stepId: string };
    await setOnlyOrganizationMemberRole(db, f.tenantId, "member");
    const payload = { kind: "refresh", tenantId: f.tenantId, workId: linkId, stepId: cp.stepId };
    await app.get(NationalCatalogJobsService).execute(payload);
    await app.get(NationalCatalogJobsService).execute(payload);
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId));
    const failures = audits.filter((a) => a.action === "national_catalog.link.refresh");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      organizationId: f.tenantId,
      actorUserId: f.userId,
      outcome: "failure",
      targetId: productId,
      after: { linkId, stepId: cp.stepId, actorKind: "manual", reason: "access_changed" },
    });
  });
  it("documents every current strict request/response and exact cabinet mutation metadata", () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("National Catalog test").setVersion("1").build(),
    );
    for (const route of routes()) {
      const path = route.path.replace(/\/[0-9a-f-]{36}/g, "/{id}");
      expect(
        Object.keys(doc.paths).some((p) => p.replace(/\{[^}]+\}/g, "{id}") === path),
        route.path,
      ).toBe(true);
    }
    for (const controller of [NationalCatalogImportController, NationalCatalogLinkController]) {
      for (const name of Object.getOwnPropertyNames(controller.prototype).filter(
        (n) => n !== "constructor",
      )) {
        const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)
          ?.value as unknown;
        if (typeof handler !== "function") continue;
        const access = Reflect.getMetadata(ROUTE_ACCESS_POLICY, handler) as {
          mode: string;
          capabilities: string[];
        };
        expect(access.mode).toBe("cabinet");
        if (access.capabilities.includes("operations.write"))
          expect(Reflect.getMetadata(ROUTE_SUBSCRIPTION_ACCESS_POLICY, handler)).toEqual({
            mode: "write",
          });
        else expect(access.capabilities).toEqual(["operations.read"]);
      }
    }
    expect(JSON.stringify(doc.paths["/national-catalog/capabilities"])).toContain(
      "integration_unavailable",
    );
    expect(JSON.stringify(doc.paths["/products/{id}/national-catalog/link"])).toContain(
      "confirmedAt",
    );
    expect(
      JSON.stringify(doc.paths["/national-catalog/import-sessions/{sessionId}/previews"]),
    ).toContain("requestId");
  });
  it("passes actual AppModule max GTIN input and100-position apply beyond generic100KiB", async () => {
    const f = await fixture();
    const response = await f.agent
      .post("/national-catalog/import-sessions")
      .send({
        mode: "gtins",
        text: Array.from({ length: 100000 }, () => "04601234567893").join("\n"),
      })
      .expect(200);
    const body = {
      requestId: randomUUID(),
      decisions: Array.from({ length: 100 }, () => ({
        previewId: randomUUID(),
        acceptedEntryIds: Array.from({ length: 40 }, () => randomUUID()),
        linkAction: "attach",
        photo: { kind: "keep" },
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(100 * 1024);
    await f.agent
      .post(`/national-catalog/import-sessions/${response.body.id}/applies`)
      .send(body)
      .expect(404);
    const expectedErrors: unknown[] = [];
    const originalError = Logger.prototype.error;
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(function (
      this: Logger,
      ...args: Parameters<Logger["error"]>
    ) {
      const error: unknown = args[0];
      if (error instanceof Error && error.message === "request entity too large") {
        expectedErrors.push(error);
        return;
      }
      originalError.apply(this, args);
    });
    try {
      await f.agent
        .post("/national-catalog/import-sessions")
        .send({ mode: "gtins", text: "0".repeat(9_001_024) })
        .expect(413);
      expect(expectedErrors).toEqual([
        expect.objectContaining({
          message: "request entity too large",
          type: "entity.too.large",
          status: 413,
        }),
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });
  it("schedules current links with both enumeration flags off and refuses absent provider configuration", async () => {
    const f = await fixture();
    const productId = randomUUID();
    const linkId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      name: "Independent refresh",
      gtin14: "04601234567893",
    });
    await db.insert(schema.nationalCatalogProductLinks).values({
      id: linkId,
      tenantId: f.tenantId,
      productId,
      environment: "production",
      cardId: "1",
      boundGtin14: "04601234567893",
      confirmedBy: f.userId,
      updatedAt: new Date(0),
    });
    const disabledEnv = loadEnv({
      ...process.env,
      NATIONAL_CATALOG_BASE_URL: "https://апи.национальный-каталог.рф",
      NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
      NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
    });
    const setup = setupAuth(disabledEnv);
    const ref = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({ ...setup, databaseUrl: disabledEnv.DATABASE_URL, env: disabledEnv }),
      ],
    }).compile();
    try {
      const refresh = ref.get(NationalCatalogLinkRefreshService);
      const schedule = vi.spyOn(refresh, "schedule");
      await ref.get(PgBossService).runNationalCatalogFreshness();
      expect(schedule).toHaveBeenCalledWith(f.tenantId, productId);
      const [link] = await db
        .select()
        .from(schema.nationalCatalogProductLinks)
        .where(eq(schema.nationalCatalogProductLinks.id, linkId));
      expect(link?.refreshCheckpoint).toMatchObject({
        actor: { kind: "system" },
        enqueuePending: true,
      });
      schedule.mockRestore();
    } finally {
      await ref.close();
    }
    const unconfiguredEnv = loadEnv({
      ...process.env,
      NATIONAL_CATALOG_BASE_URL: "",
      NATIONAL_CATALOG_OWN_IMPORT_ENABLED: "false",
      NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "false",
    });
    const missingSetup = setupAuth(unconfiguredEnv);
    const missing = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          ...missingSetup,
          databaseUrl: unconfiguredEnv.DATABASE_URL,
          env: unconfiguredEnv,
        }),
      ],
    }).compile();
    try {
      await expect(
        missing.get(NationalCatalogLinkRefreshService).schedule(f.tenantId, productId),
      ).rejects.toMatchObject({ message: "refresh_disabled" });
    } finally {
      await missing.close();
    }
  });
});
