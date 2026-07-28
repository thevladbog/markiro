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

  async function openShift(agent: ReturnType<typeof request.agent>): Promise<string> {
    const pid = await createActiveProduct(agent);
    const shift = await agent
      .post("/shifts")
      .send({ productId: pid, mode: "validation" })
      .expect(201);
    const id = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${id}/open`).expect(200);
    return id;
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
