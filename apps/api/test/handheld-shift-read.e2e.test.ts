import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const HANDHELD_CAPABILITIES = "handheld-v1,subscription-state-v1,station-recovery-v1";

describe.skipIf(!ready)("handheld shift reads", () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    db = setup.db;
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600000000015",
      name: "Вода",
      status: "active",
    });
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Линия 2" }).returning();
    const [otherLine] = await db
      .insert(schema.lines)
      .values({ tenantId, name: "Линия 3" })
      .returning();
    const participant = await createTestStationDevice(app, agent, "ТСД 1", { kind: "handheld" });
    const stranger = await createTestStationDevice(app, agent, "ТСД 2", { kind: "handheld" });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "validation", lineId: line!.id, plannedQty: 10 })
      .expect(201);
    return {
      agent,
      tenantId,
      shiftId: created.body.id as string,
      line: line!,
      otherLine: otherLine!,
      participant,
      stranger,
    };
  }

  it("lets a participating device read the shift summary and refuses a stranger", async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .post(`/shifts/${f.shiftId}/enter`)
      .set("x-api-key", f.participant.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(200);

    const summary = await request(app.getHttpServer())
      .get(`/shifts/${f.shiftId}/summary`)
      .set("x-api-key", f.participant.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(200);
    expect(summary.body.output).toEqual({ mode: "validation", acceptedUnits: 0 });
    expect(Array.isArray(summary.body.participants)).toBe(true);

    const refused = await request(app.getHttpServer())
      .get(`/shifts/${f.shiftId}/summary`)
      .set("x-api-key", f.stranger.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(403);
    expect(refused.body.message).toBe("Device is not a participant of this shift");

    // The cabinet keeps reading it.
    await f.agent.get(`/shifts/${f.shiftId}/summary`).expect(200);
  });

  it("lets a device list the tenant's lines", async () => {
    const f = await fixture();
    const lines = await request(app.getHttpServer())
      .get("/lines")
      .set("x-api-key", f.participant.apiKey)
      .set("x-station-capabilities", HANDHELD_CAPABILITIES)
      .expect(200);
    const names = (lines.body.items as { name: string }[]).map((item) => item.name).sort();
    expect(names).toEqual(["Линия 2", "Линия 3"]);
  });
});
