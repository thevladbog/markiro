import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildSscc, canonicalizeKm, kmHash, kmKey } from "@markiro/domain";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04006381333931";
const GS = "\u001d";

describe.skipIf(!ready)("kiosk box registry e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let agent: ReturnType<typeof request.agent>;
  let tenantId: string;
  let token: string;
  let kioskId: string;
  let stationKey: string;
  let eligibleSscc: string;
  let eligibleBoxId: string;
  let productId: string;
  let initialUntil: string;
  let memberKey: string;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const schemaProbe = await db.execute<{ ready: boolean }>(sql`
      select exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'boxes'
          and column_name = 'updated_at'
      ) as ready
    `);
    if (!schemaProbe.rows[0]?.ready) {
      await setup.pool.end();
      throw new Error(
        "Shared development DB schema drift: migration 0037 is not applied (boxes.updated_at missing); kiosk box registry e2e cannot run safely",
      );
    }

    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);

    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    token = `registry-${randomUUID()}`;
    kioskId = randomUUID();
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Registry kiosk",
      deviceTokenHash: hashDeviceToken(token),
    });
    stationKey = (await createTestStationDevice(app, agent, "Registry station")).apiKey;

    productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Bottle",
    });
    const shiftId = randomUUID();
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId,
      mode: "aggregation",
    });
    const timestamp = new Date(Date.now() - 60_000);
    const closure = new Date(timestamp.getTime() - 10_000);
    eligibleBoxId = randomUUID();
    eligibleSscc = buildSscc(3, "4600682", 101);
    await db.insert(schema.boxes).values({
      id: eligibleBoxId,
      tenantId,
      shiftId,
      deviceBoxId: `box-${randomUUID()}`,
      sscc: eligibleSscc,
      closedAt: closure,
      closureReceivedAt: closure,
      updatedAt: timestamp,
    });
    await ensurePartitions(db, [closure]);
    for (let index = 0; index < 12; index += 1) {
      const raw = `01${GTIN}21BOX-${index}${GS}91secret${GS}92crypto-${index}`;
      const km = canonicalizeKm(raw);
      const hash = kmHash(km);
      const scannedAt = new Date(closure.getTime() - 20_000 + index);
      if (index === 0) memberKey = kmKey(km);
      await db.insert(schema.codes).values({
        tenantId,
        codeHash: hash,
        shiftId,
        gtin14: km.gtin14,
        serial: km.serial,
        canonicalRaw: km.raw,
        scannedAt,
      });
      await db.insert(schema.codeRegistry).values({
        tenantId,
        codeHash: hash,
        shiftId,
        scannedAt,
        updatedAt: scannedAt,
      });
      await db.insert(schema.boxItems).values({
        tenantId,
        boxId: eligibleBoxId,
        codeHash: hash,
        addedAt: scannedAt,
      });
    }

    // Same updatedAt, different UUIDs: paging must use the id tie-breaker.
    for (const serial of [102, 103]) {
      await createOneMemberBox({ tenantId, shiftId, serial, updatedAt: timestamp });
    }

    // Foreign tenant data must never appear, even though the kioskProducts
    // allowlist is deliberately irrelevant to this tenant-wide endpoint.
    const foreignAgent = request.agent(app.getHttpServer());
    const foreignTenantId = await signUpAndActivate(foreignAgent);
    const foreignProductId = randomUUID();
    await db.insert(schema.products).values({
      id: foreignProductId,
      tenantId: foreignTenantId,
      gtin14: GTIN,
      name: "Foreign",
    });
    const foreignShiftId = randomUUID();
    await db.insert(schema.shifts).values({
      id: foreignShiftId,
      tenantId: foreignTenantId,
      productId: foreignProductId,
      mode: "aggregation",
    });
    await db.insert(schema.boxes).values({
      tenantId: foreignTenantId,
      shiftId: foreignShiftId,
      deviceBoxId: `foreign-${randomUUID()}`,
      sscc: buildSscc(3, "4600682", 999),
      closedAt: closure,
      closureReceivedAt: closure,
      updatedAt: timestamp,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  async function createOneMemberBox(input: {
    tenantId: string;
    shiftId: string;
    serial: number;
    updatedAt: Date;
  }): Promise<void> {
    const boxId = randomUUID();
    const closure = new Date(input.updatedAt.getTime() - 10_000);
    const scannedAt = new Date(closure.getTime() - input.serial);
    const km = canonicalizeKm(
      `01${GTIN}21PAGE-${input.serial}${GS}91secret${GS}92crypto-${input.serial}`,
    );
    const hash = kmHash(km);
    await db.insert(schema.boxes).values({
      id: boxId,
      tenantId: input.tenantId,
      shiftId: input.shiftId,
      deviceBoxId: `page-${input.serial}-${randomUUID()}`,
      sscc: buildSscc(3, "4600682", input.serial),
      closedAt: closure,
      closureReceivedAt: closure,
      updatedAt: input.updatedAt,
    });
    await db.insert(schema.codes).values({
      tenantId: input.tenantId,
      codeHash: hash,
      shiftId: input.shiftId,
      gtin14: km.gtin14,
      serial: km.serial,
      canonicalRaw: km.raw,
      scannedAt,
    });
    await db.insert(schema.codeRegistry).values({
      tenantId: input.tenantId,
      codeHash: hash,
      shiftId: input.shiftId,
      scannedAt,
      updatedAt: scannedAt,
    });
    await db.insert(schema.boxItems).values({
      tenantId: input.tenantId,
      boxId,
      codeHash: hash,
      addedAt: scannedAt,
    });
  }

  it("returns a tenant-only 12-bottle upsert without raw KM crypto material", async () => {
    const response = await request(app!.getHttpServer())
      .get("/kiosk/box-registry?limit=500")
      .set("x-kiosk-token", token)
      .expect(200);
    initialUntil = response.body.until as string;
    expect(response.body.items).toContainEqual(
      expect.objectContaining({
        kind: "upsert",
        boxId: eligibleBoxId,
        sscc: eligibleSscc,
        productId,
        bottleCount: 12,
        contentKeys: expect.arrayContaining([memberKey]),
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(JSON.stringify(response.body)).not.toContain("crypto-");
    expect(JSON.stringify(response.body)).not.toContain(buildSscc(3, "4600682", 999));
  });

  it("pages tied timestamps with immutable bounds", async () => {
    const first = await request(app!.getHttpServer())
      .get("/kiosk/box-registry?limit=2")
      .set("x-kiosk-token", token)
      .expect(200);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app!.getHttpServer())
      .get("/kiosk/box-registry")
      .query({ limit: 1, until: first.body.until, cursor: first.body.nextCursor })
      .set("x-kiosk-token", token)
      .expect(200);
    expect(second.body.until).toBe(first.body.until);
    expect(second.body.items[0].boxId).not.toBe(first.body.items.at(-1).boxId);
    await request(app!.getHttpServer())
      .get("/kiosk/box-registry")
      .query({
        until: new Date(Date.parse(first.body.until) + 1).toISOString(),
        cursor: first.body.nextCursor,
      })
      .set("x-kiosk-token", token)
      .expect(400);
  });

  it("emits a remove delta after disassembly", async () => {
    await db
      .update(schema.boxes)
      .set({ disassembledAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.boxes.id, eligibleBoxId));
    const response = await request(app!.getHttpServer())
      .get("/kiosk/box-registry")
      .query({ since: initialUntil })
      .set("x-kiosk-token", token)
      .expect(200);
    expect(response.body.items).toContainEqual(
      expect.objectContaining({ kind: "remove", sscc: eligibleSscc }),
    );
  });

  it("denies cabinet cookies, station keys, unknown tokens, and archived kiosks", async () => {
    await agent.get("/kiosk/box-registry").expect(401);
    await request(app!.getHttpServer())
      .get("/kiosk/box-registry")
      .set("x-api-key", stationKey)
      .expect(401);
    await request(app!.getHttpServer())
      .get("/kiosk/box-registry")
      .set("x-kiosk-token", "unknown")
      .expect(401);
    await db.update(schema.kiosks).set({ status: "archived" }).where(eq(schema.kiosks.id, kioskId));
    await request(app!.getHttpServer())
      .get("/kiosk/box-registry")
      .set("x-kiosk-token", token)
      .expect(401);
  });
});
