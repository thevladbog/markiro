import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("conflicts e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpWithInactiveOrg(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
      .expect(200);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);

    return org.body.id as string;
  }

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const orgId = await signUpWithInactiveOrg(agent);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  async function deviceKey(agent: ReturnType<typeof request.agent>): Promise<string> {
    const device = await agent.post("/station-devices").send({ name: "Line 1" }).expect(201);
    return (device.body as { apiKey: string }).apiKey;
  }

  // Same fixture as station-scans.e2e.test.ts / products.e2e.test.ts.
  const VALID_GTIN14 = "04006381333931";

  async function createActiveProduct(agent: ReturnType<typeof request.agent>): Promise<string> {
    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        productGroup: "Beverages",
        boxCapacity: 10,
        palletCapacity: 5,
      })
      .expect(201);
    return (product.body as { id: string }).id;
  }

  async function openShiftForProduct(
    agent: ReturnType<typeof request.agent>,
    productId: string,
  ): Promise<string> {
    const shift = await agent.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  async function openShift(agent: ReturnType<typeof request.agent>): Promise<string> {
    const pid = await createActiveProduct(agent);
    return openShiftForProduct(agent, pid);
  }

  function item(shiftId: string, n: number, overrides: Partial<ScanItemDto> = {}): ScanItemDto {
    return {
      shiftId,
      terminalId: "t1",
      raw: `RAW${n}`,
      verdict: "ok",
      scannedAt: `2026-07-28T10:00:0${n}.000Z`,
      code: { codeHash: `h${n}`.padEnd(64, "0"), gtin14: VALID_GTIN14, serial: `S${n}` },
      ...overrides,
    };
  }

  it("lists a conflict for a shift and marks it reviewed", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const first = { ...item(shiftId, 1), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:50", items: [first] })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "m1:51",
        items: [
          {
            ...first,
            terminalId: "t2",
            scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
          },
        ],
      })
      .expect(201);

    const list = await agent.get(`/conflicts?shiftId=${shiftId}`).expect(200);
    const items = (list.body as { items: { id: string; reviewedAt: string | null }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.reviewedAt).toBeNull();

    const reviewed = await agent.post(`/conflicts/${items[0]!.id}/review`).expect(200);
    expect((reviewed.body as { reviewedAt: string | null }).reviewedAt).not.toBeNull();

    // The mutation's own response is application code and could report a
    // fabricated timestamp without ever writing it -- a fresh GET (a
    // separate request, so it cannot be served from anything the POST
    // handler held onto) is what actually proves the review persisted.
    const relisted = await agent.get(`/conflicts?shiftId=${shiftId}`).expect(200);
    const relistedItems = (relisted.body as { items: { id: string; reviewedAt: string | null }[] })
      .items;
    expect(relistedItems[0]!.reviewedAt).toBe((reviewed.body as { reviewedAt: string }).reviewedAt);
  });

  // Guards `ConflictsService.listConflicts`'s `shiftId` predicate itself: two
  // shifts in the *same* tenant, each with its own conflict, so that
  // scoping to shift A only reads as correct if shift B's conflict is
  // actually excluded -- a single-shift tenant (as in the test above) would
  // pass this assertion even with the predicate deleted entirely, since
  // there'd be nothing else in the tenant to wrongly include.
  it("scopes the list to the given shift, excluding another shift's conflict in the same tenant", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const productId = await createActiveProduct(agent);
    const shiftA = await openShiftForProduct(agent, productId);
    const shiftB = await openShiftForProduct(agent, productId);

    const firstA = { ...item(shiftA, 2), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:60", items: [firstA] })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "m1:61",
        items: [
          {
            ...firstA,
            terminalId: "t2",
            scannedAt: new Date(Date.parse(firstA.scannedAt) + 5000).toISOString(),
          },
        ],
      })
      .expect(201);

    const firstB = { ...item(shiftB, 3), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:62", items: [firstB] })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "m1:63",
        items: [
          {
            ...firstB,
            terminalId: "t2",
            scannedAt: new Date(Date.parse(firstB.scannedAt) + 5000).toISOString(),
          },
        ],
      })
      .expect(201);

    const scopedToA = await agent.get(`/conflicts?shiftId=${shiftA}`).expect(200);
    const itemsA = (scopedToA.body as { items: { losingShiftId: string }[] }).items;
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0]!.losingShiftId).toBe(shiftA);

    const scopedToB = await agent.get(`/conflicts?shiftId=${shiftB}`).expect(200);
    const itemsB = (scopedToB.body as { items: { losingShiftId: string }[] }).items;
    expect(itemsB).toHaveLength(1);
    expect(itemsB[0]!.losingShiftId).toBe(shiftB);
  });

  it("filters the list by reviewed status", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const first = { ...item(shiftId, 1), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:70", items: [first] })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "m1:71",
        items: [
          {
            ...first,
            terminalId: "t2",
            scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
          },
        ],
      })
      .expect(201);

    const unreviewedOnly = await agent
      .get(`/conflicts?shiftId=${shiftId}&reviewed=false`)
      .expect(200);
    const unreviewedItems = (unreviewedOnly.body as { items: { id: string }[] }).items;
    expect(unreviewedItems).toHaveLength(1);

    const reviewedOnlyBefore = await agent
      .get(`/conflicts?shiftId=${shiftId}&reviewed=true`)
      .expect(200);
    expect((reviewedOnlyBefore.body as { items: unknown[] }).items).toEqual([]);

    await agent.post(`/conflicts/${unreviewedItems[0]!.id}/review`).expect(200);

    const reviewedOnlyAfter = await agent
      .get(`/conflicts?shiftId=${shiftId}&reviewed=true`)
      .expect(200);
    expect((reviewedOnlyAfter.body as { items: { id: string }[] }).items).toHaveLength(1);

    const unreviewedOnlyAfter = await agent
      .get(`/conflicts?shiftId=${shiftId}&reviewed=false`)
      .expect(200);
    expect((unreviewedOnlyAfter.body as { items: unknown[] }).items).toEqual([]);
  });

  it("rejects a station api-key: conflicts are cabinet-only", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);

    await request(app!.getHttpServer()).get("/conflicts").set("x-api-key", apiKey).expect(403);
  });

  // `TenantGuard`+`SessionOnlyGuard` are applied at the controller (class)
  // level, so today one `@UseGuards` protects both routes -- but that's an
  // implementation detail, not a guarantee. Without this test, a refactor to
  // per-method guards that dropped `SessionOnlyGuard` from just the review
  // route would leave the GET-only test above green while silently opening
  // a manager-only mutation to any station device.
  it("rejects a station api-key on the review route too: conflicts are cabinet-only", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const first = { ...item(shiftId, 1), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:90", items: [first] })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "m1:91",
        items: [
          {
            ...first,
            terminalId: "t2",
            scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
          },
        ],
      })
      .expect(201);

    const list = await agent.get(`/conflicts?shiftId=${shiftId}`).expect(200);
    const conflictId = (list.body as { items: { id: string }[] }).items[0]!.id;

    await request(app!.getHttpServer())
      .post(`/conflicts/${conflictId}/review`)
      .set("x-api-key", apiKey)
      .expect(403);
  });

  it("does not expose another tenant's conflicts", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);

    const list = await other.get("/conflicts").expect(200);
    expect((list.body as { items: unknown[] }).items).toEqual([]);
  });

  // Same shape as employees.e2e.test.ts's "isolates employees across
  // tenants": a real id from tenant A, called by tenant B, must 404 -- and
  // must leave tenant A's row untouched -- proving the tenant scope in the
  // `UPDATE ... WHERE` is genuine authorization, not just an id lookup that
  // happens to 404 on a made-up id.
  it("does not let a foreign tenant mark another tenant's conflict reviewed", async () => {
    const owner = request.agent(app!.getHttpServer());
    await signUpAndActivate(owner);
    const apiKey = await deviceKey(owner);
    const shiftId = await openShift(owner);

    const first = { ...item(shiftId, 1), terminalId: "t1" };
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "m1:80", items: [first] })
      .expect(201);
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({
        batchId: "m1:81",
        items: [
          {
            ...first,
            terminalId: "t2",
            scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
          },
        ],
      })
      .expect(201);

    const list = await owner.get(`/conflicts?shiftId=${shiftId}`).expect(200);
    const conflictId = (list.body as { items: { id: string }[] }).items[0]!.id;

    const intruder = request.agent(app!.getHttpServer());
    await signUpAndActivate(intruder);
    await intruder.post(`/conflicts/${conflictId}/review`).expect(404);

    const relisted = await owner.get(`/conflicts?shiftId=${shiftId}`).expect(200);
    expect(
      (relisted.body as { items: { id: string; reviewedAt: string | null }[] }).items[0]!
        .reviewedAt,
    ).toBeNull();
  });
});
