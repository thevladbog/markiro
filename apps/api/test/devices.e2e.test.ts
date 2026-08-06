import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("unified devices read model e2e", () => {
  let app: INestApplication | undefined;
  let db: Db;
  let cabinet: ReturnType<typeof request.agent>;
  let tenantId: string;

  const ids = {
    kioskAwaiting: randomUUID(),
    stationAwaiting: randomUUID(),
    kioskOffline: randomUUID(),
    stationOffline: randomUUID(),
    kioskRevoked: randomUUID(),
    stationRevoked: randomUUID(),
    kioskOnline: randomUUID(),
    stationOnline: randomUUID(),
  };

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    cabinet = request.agent(app!.getHttpServer());
    tenantId = await signUpAndActivate(cabinet);

    const [line] = await db
      .insert(schema.lines)
      .values({ tenantId, name: "Assembly line" })
      .returning({ id: schema.lines.id });
    if (!line) throw new Error("Expected device test line to persist");

    const now = Date.now();
    const onlineAt = new Date(now - 30_000);
    const offlineAt = new Date(now - 3 * 60_000);
    const offlineTokenHash = hashDeviceToken(`device-read-offline-${randomUUID()}`);
    const revokedTokenHash = hashDeviceToken(`device-read-revoked-${randomUUID()}`);
    const onlineTokenHash = hashDeviceToken(`device-read-online-${randomUUID()}`);

    await db.insert(schema.stationDevices).values([
      { id: ids.stationAwaiting, tenantId, name: "Bravo station", lineId: line.id },
      {
        id: ids.stationOffline,
        tenantId,
        name: "Alpha station",
        lineId: line.id,
        apiKeyId: randomUUID(),
        pairedAt: offlineAt,
        lastSeenAt: offlineAt,
      },
      {
        id: ids.stationRevoked,
        tenantId,
        name: "Bravo revoked station",
        lineId: line.id,
        pairedAt: offlineAt,
        revokedAt: offlineAt,
      },
      {
        id: ids.stationOnline,
        tenantId,
        name: "Bravo online station",
        lineId: line.id,
        apiKeyId: randomUUID(),
        pairedAt: onlineAt,
        lastSeenAt: onlineAt,
      },
    ]);
    await db.insert(schema.kiosks).values([
      { id: ids.kioskAwaiting, tenantId, name: "Alpha kiosk", location: "Lobby" },
      {
        id: ids.kioskOffline,
        tenantId,
        name: "Bravo offline kiosk",
        location: "Warehouse",
        deviceTokenHash: offlineTokenHash,
        lastSeenAt: offlineAt,
      },
      {
        id: ids.kioskRevoked,
        tenantId,
        name: "Alpha revoked kiosk",
        location: "Gate",
        // Task 7 will scrub this old token. The Task 6 read model must still
        // present an archived kiosk as revoked and unpaired in the meantime.
        deviceTokenHash: revokedTokenHash,
        status: "archived",
        lastSeenAt: onlineAt,
      },
      {
        id: ids.kioskOnline,
        tenantId,
        name: "Alpha online kiosk",
        location: "Reception",
        deviceTokenHash: onlineTokenHash,
        lastSeenAt: onlineAt,
      },
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns only the documented fields in actionable lifecycle order with the default page", async () => {
    const response = await cabinet.get("/devices").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({ page: 1, pageSize: 8, total: 8, items: expect.any(Array) }),
    );
    expect(Object.keys(response.body).sort()).toEqual(["items", "page", "pageSize", "total"]);
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
      ids.kioskAwaiting,
      ids.stationAwaiting,
      ids.stationOffline,
      ids.kioskOffline,
      ids.kioskRevoked,
      ids.stationRevoked,
      ids.kioskOnline,
      ids.stationOnline,
    ]);
    expect(response.body.items[0]).toEqual({
      id: ids.kioskAwaiting,
      type: "kiosk",
      name: "Alpha kiosk",
      place: { id: null, name: "Lobby" },
      status: "awaiting_pairing",
      lastSeenAt: null,
      paired: false,
    });
    expect(response.body.items[2]).toMatchObject({
      id: ids.stationOffline,
      type: "station",
      place: { id: expect.any(String), name: "Assembly line" },
      status: "offline",
      paired: true,
      lastSeenAt: expect.any(String),
    });
    expect(response.body.items[4]).toMatchObject({
      id: ids.kioskRevoked,
      status: "revoked",
      paired: false,
    });
    for (const item of response.body.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual([
        "id",
        "lastSeenAt",
        "name",
        "paired",
        "place",
        "status",
        "type",
      ]);
      expect(item).not.toHaveProperty("apiKeyId");
      expect(item).not.toHaveProperty("deviceTokenHash");
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("quota");
    }
  });

  it("filters before counting and pages the combined result", async () => {
    const response = await cabinet
      .get("/devices")
      .query({ type: "kiosk", status: "offline", page: 1, pageSize: 1 })
      .expect(200);

    expect(response.body).toEqual({
      items: [
        {
          id: ids.kioskOffline,
          type: "kiosk",
          name: "Bravo offline kiosk",
          place: { id: null, name: "Warehouse" },
          status: "offline",
          lastSeenAt: expect.any(String),
          paired: true,
        },
      ],
      page: 1,
      pageSize: 1,
      total: 1,
    });
  });

  it("rejects pages outside the documented bounds", async () => {
    await cabinet.get("/devices").query({ page: 0 }).expect(400);
    await cabinet.get("/devices").query({ pageSize: 51 }).expect(400);
    await cabinet.get("/devices").query({ type: "printer" }).expect(400);
  });

  it("does not expose another tenant's devices", async () => {
    const otherCabinet = request.agent(app!.getHttpServer());
    const otherTenantId = await signUpAndActivate(otherCabinet);
    await db.insert(schema.kiosks).values({
      tenantId: otherTenantId,
      name: "Other tenant kiosk",
      location: "Elsewhere",
    });

    const response = await cabinet.get("/devices").expect(200);
    expect(response.body.total).toBe(8);
    expect(response.body.items.map((item: { name: string }) => item.name)).not.toContain(
      "Other tenant kiosk",
    );
  });

  it("rejects a real station key", async () => {
    const station = await createTestStationDevice(app!, cabinet, "Denied devices station");
    await request(app!.getHttpServer())
      .get("/devices")
      .set("x-api-key", station.apiKey)
      .expect(403);
  });
});
