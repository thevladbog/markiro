import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("station-scans e2e", () => {
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

  // A genuinely valid GTIN-14 (same fixture as products.e2e.test.ts's
  // GTIN14_CANONICAL_PADDED): POST /products validates the GS1 check digit
  // via normalizeToGtin14, and the field is `gtin`, not `gtin14`.
  const VALID_GTIN14 = "04006381333931";

  async function openShift(agent: ReturnType<typeof request.agent>): Promise<string> {
    // productGroup + both capacities are required for the product to come
    // back "active" (see ProductsService.computeStatus); a "draft" product
    // is rejected outright by POST /shifts regardless of shift mode.
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
    const shift = await agent
      .post("/shifts")
      .send({ productId: (product.body as { id: string }).id, mode: "validation" })
      .expect(201);
    const id = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  function item(shiftId: string, n: number) {
    return {
      shiftId,
      terminalId: "t1",
      raw: `RAW${n}`,
      verdict: "ok",
      scannedAt: `2026-07-28T10:00:0${n}.000Z`,
      code: { codeHash: `h${n}`.padEnd(64, "0"), gtin14: VALID_GTIN14, serial: `S${n}` },
    };
  }

  it("accepts a batch from a station api-key and stores codes and events", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);

    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:200", items: [item(shiftId, 1), item(shiftId, 2)] })
      .expect(201);

    expect(res.body).toMatchObject({ applied: 2, alreadyApplied: false });
  });

  it("is idempotent: the same batchId applied twice stores one set of rows", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);
    const body = { batchId: "machine-1:200", items: [item(shiftId, 1)] };

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send(body)
      .expect(201);
    const second = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send(body)
      .expect(201);

    expect(second.body).toMatchObject({ applied: 0, alreadyApplied: true });
  });

  it("accepts late data for a closed shift and stamps it", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);
    const shiftId = await openShift(agent);
    // closeShiftSchema requires `reason` (min 3 chars, see shifts/dto.ts),
    // matching the field name shifts.e2e.test.ts uses for this same route.
    await agent.post(`/shifts/${shiftId}/close`).send({ reason: "done shift" }).expect(200);

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:300", items: [item(shiftId, 1)] })
      .expect(201);

    const shift = await agent.get(`/shifts/${shiftId}`).expect(200);
    expect((shift.body as { lateDataAt: string | null }).lateDataAt).not.toBeNull();
  });

  it("rejects a shift id belonging to another tenant", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const apiKey = await deviceKey(agent);

    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const foreignShift = await openShift(other);

    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: "machine-1:400", items: [item(foreignShift, 1)] })
      .expect(400);
  });

  it("rejects an unauthenticated caller", async () => {
    await request(app!.getHttpServer())
      .post("/station/scans")
      .send({ batchId: "machine-1:500", items: [] })
      .expect(401);
  });
});
