import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { buildSscc, canonicalizeKm, kmHash, kmKey } from "@markiro/domain";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { hashDeviceToken } from "../src/pickup/device-token";
import { advanceBoxRegistryVersion } from "../src/modules/boxes/box-registry-version";
import { createTestEmployee, createTestStationDevice, signUpAndActivate } from "./support/auth";
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
  let pickupBadge: string;
  const pagingBoxIds: string[] = [];

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const schemaProbe = await db.execute<{ ready: boolean }>(sql`
      select exists (
        select 1 from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'boxes'
          and column_name = 'registry_version'
      ) as ready
    `);
    if (!schemaProbe.rows[0]?.ready) {
      await setup.pool.end();
      throw new Error(
        "Shared development DB schema drift: migration 0037 is not applied (boxes.registry_version missing); kiosk box registry e2e cannot run safely",
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
    await db
      .insert(schema.boxRegistryVersions)
      .values({ tenantId, currentVersion: 1n })
      .onConflictDoUpdate({
        target: schema.boxRegistryVersions.tenantId,
        set: { currentVersion: 1n },
      });
    token = `registry-${randomUUID()}`;
    kioskId = randomUUID();
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Registry kiosk",
      deviceTokenHash: hashDeviceToken(token),
    });
    const employeeId = randomUUID();
    pickupBadge = `box-badge-${randomUUID()}`;
    await createTestEmployee(
      db,
      { id: employeeId, tenantId, fullName: "Box employee" },
      { limitMode: "unlimited", dayLimit: 5 },
    );
    await db.insert(schema.employeeBadges).values({
      tenantId,
      employeeId,
      badgeCode: pickupBadge,
    });
    stationKey = (await createTestStationDevice(app, agent, "Registry station")).apiKey;

    productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Bottle",
      unitPrice: "17.50",
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
      registryVersion: 1n,
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
      pagingBoxIds.push(
        await createOneMemberBox({ tenantId, shiftId, serial, updatedAt: timestamp }),
      );
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
      registryVersion: 1n,
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
  }): Promise<string> {
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
      registryVersion: 1n,
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
    return boxId;
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

  it("pages tied registry revisions with immutable bounds", async () => {
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
        until: (BigInt(first.body.until as string) + 1n).toString(),
        cursor: first.body.nextCursor,
      })
      .set("x-kiosk-token", token)
      .expect(400);
  });

  it("rejects page 2 after an unpaged box changes and a restart sees the new cut", async () => {
    const first = await request(app!.getHttpServer())
      .get("/kiosk/box-registry?limit=1")
      .set("x-kiosk-token", token)
      .expect(200);
    const targetBoxId = pagingBoxIds.find(
      (boxId) => boxId !== (first.body.items[0] as { boxId?: string } | undefined)?.boxId,
    )!;
    await db.transaction(async (tx) => {
      const changed = await tx
        .update(schema.boxes)
        .set({ disassembledAt: new Date() })
        .where(eq(schema.boxes.id, targetBoxId))
        .returning({ id: schema.boxes.id });
      await advanceBoxRegistryVersion(
        tx,
        tenantId,
        changed.map((box) => box.id),
      );
    });

    const conflict = await request(app!.getHttpServer())
      .get("/kiosk/box-registry")
      .query({ limit: 1, until: first.body.until, cursor: first.body.nextCursor })
      .set("x-kiosk-token", token)
      .expect(409);
    expect(conflict.body).toEqual({ code: "registry_snapshot_changed" });

    const restarted = await request(app!.getHttpServer())
      .get("/kiosk/box-registry?limit=500")
      .set("x-kiosk-token", token)
      .expect(200);
    expect(BigInt(restarted.body.until as string)).toBeGreaterThan(
      BigInt(first.body.until as string),
    );
    expect(restarted.body.items).not.toContainEqual(
      expect.objectContaining({ boxId: targetBoxId }),
    );
  });

  it("does not advertise an uncommitted allocated revision and exposes it after commit", async () => {
    const client = await setup.pool.connect();
    let committed = false;
    try {
      await client.query("begin");
      const revision = await client.query<{ currentVersion: string }>(
        `insert into box_registry_versions (tenant_id, current_version)
         values ($1, 1)
         on conflict (tenant_id) do update
         set current_version = box_registry_versions.current_version + 1,
             updated_at = clock_timestamp()
         returning current_version as "currentVersion"`,
        [tenantId],
      );
      const nextRevision = revision.rows[0]!.currentVersion;
      await client.query(
        `update boxes set registry_version = $1, updated_at = clock_timestamp()
         where tenant_id = $2 and id = $3`,
        [nextRevision, tenantId, eligibleBoxId],
      );

      const beforeCommit = await request(app!.getHttpServer())
        .get("/kiosk/box-registry")
        .query({ since: initialUntil })
        .set("x-kiosk-token", token)
        .expect(200);
      expect(beforeCommit.body.until).toBe(initialUntil);
      expect(beforeCommit.body.items).not.toContainEqual(
        expect.objectContaining({ boxId: eligibleBoxId }),
      );

      await client.query("commit");
      committed = true;
      const afterCommit = await request(app!.getHttpServer())
        .get("/kiosk/box-registry")
        .query({ since: initialUntil })
        .set("x-kiosk-token", token)
        .expect(200);
      expect(BigInt(afterCommit.body.until as string)).toBeGreaterThan(BigInt(initialUntil));
      expect(afterCommit.body.items).toContainEqual(
        expect.objectContaining({ kind: "upsert", boxId: eligibleBoxId }),
      );
    } finally {
      if (!committed) await client.query("rollback");
      client.release();
    }
  });

  it("accepts boxes atomically, expands members, snapshots current price, and replays exactly", async () => {
    const requested = await db
      .select({ sscc: schema.boxes.sscc })
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), isNull(schema.boxes.disassembledAt)));
    const ssccs = requested
      .map((row) => row.sscc)
      .filter((sscc): sscc is string => sscc !== null)
      .slice(0, 3)
      .toReversed();
    const body = {
      deviceSeq: 900,
      badgeCode: pickupBadge,
      reason: "buy" as const,
      items: [],
      boxes: ssccs.map((sscc) => ({ sscc })),
    };
    const first = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", token)
      .send(body)
      .expect(201);
    expect(first.body).toMatchObject({ itemCount: 13, conflicts: [], boxConflicts: [] });
    expect(first.body.acceptedBoxes).toEqual(
      [...ssccs].sort().map((sscc) => ({ sscc, bottleCount: sscc === eligibleSscc ? 12 : 1 })),
    );

    const [order] = await db
      .select({ id: schema.pickupOrders.id, totalPrice: schema.pickupOrders.totalPrice })
      .from(schema.pickupOrders)
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.deviceSeq, 900)),
      );
    expect(order?.totalPrice).toBe("227.50");
    expect(
      await db
        .select({ id: schema.pickupOrderBoxes.id })
        .from(schema.pickupOrderBoxes)
        .where(eq(schema.pickupOrderBoxes.orderId, order!.id)),
    ).toHaveLength(2);
    const expanded = await db
      .select({ orderBoxId: schema.pickupOrderItems.orderBoxId })
      .from(schema.pickupOrderItems)
      .where(eq(schema.pickupOrderItems.orderId, order!.id));
    expect(expanded).toHaveLength(13);
    expect(expanded.every((item) => item.orderBoxId !== null)).toBe(true);

    const replay = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", token)
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);
  });

  it("rejects a whole previously-used box with 422 and creates no empty order", async () => {
    const before = await db
      .select({ id: schema.pickupOrders.id })
      .from(schema.pickupOrders)
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.deviceSeq, 901)),
      );
    expect(before).toEqual([]);

    const response = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", token)
      .send({
        deviceSeq: 901,
        badgeCode: pickupBadge,
        reason: "buy",
        items: [],
        boxes: [{ sscc: eligibleSscc }],
      })
      .expect(422);
    expect(response.body).toEqual({
      code: "order_rejected",
      message: "No submitted order lines were accepted",
      conflicts: [],
      boxConflicts: [{ sscc: eligibleSscc, bottleCount: 12, reason: "duplicate" }],
      acceptedBoxes: [],
    });
    expect(
      await db
        .select({ id: schema.pickupOrders.id })
        .from(schema.pickupOrders)
        .where(
          and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.deviceSeq, 901)),
        ),
    ).toEqual([]);

    const replay = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", token)
      .send({
        deviceSeq: 901,
        badgeCode: pickupBadge,
        reason: "buy",
        items: [],
        boxes: [{ sscc: eligibleSscc }],
      })
      .expect(422);
    expect(replay.body).toEqual(response.body);
  });

  it("makes a foreign-tenant SSCC indistinguishable from an unknown box", async () => {
    const foreignSscc = buildSscc(3, "4600682", 999);
    const response = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", token)
      .send({
        deviceSeq: 902,
        badgeCode: pickupBadge,
        reason: "buy",
        items: [],
        boxes: [{ sscc: foreignSscc }],
      })
      .expect(422);
    expect(response.body.boxConflicts).toEqual([
      { sscc: foreignSscc, bottleCount: null, reason: "unknown_box" },
    ]);
    expect(
      await db
        .select({ id: schema.pickupOrders.id })
        .from(schema.pickupOrders)
        .where(
          and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.deviceSeq, 902)),
        ),
    ).toEqual([]);
  });

  it("replays boxes-empty loose rejection exactly and lets one concurrent rejection win", async () => {
    const body = {
      deviceSeq: 903,
      badgeCode: pickupBadge,
      reason: "buy" as const,
      items: [{ rawKm: "not-a-km" }],
      boxes: [],
    };
    const submit = () =>
      request(app!.getHttpServer()).post("/kiosk/orders").set("x-kiosk-token", token).send(body);
    const [first, concurrent] = await Promise.all([submit(), submit()]);
    expect(first.status).toBe(422);
    expect(concurrent.status).toBe(422);
    expect(concurrent.body).toEqual(first.body);
    expect(first.body).toEqual({
      code: "order_rejected",
      message: "No submitted order lines were accepted",
      conflicts: [{ rawKm: "not-a-km", reason: "not_km" }],
      boxConflicts: [],
      acceptedBoxes: [],
    });
    expect(
      await db
        .select({ id: schema.pickupScanRejections.id })
        .from(schema.pickupScanRejections)
        .where(
          and(
            eq(schema.pickupScanRejections.tenantId, tenantId),
            eq(schema.pickupScanRejections.kioskId, kioskId),
            eq(schema.pickupScanRejections.deviceSeq, 903),
          ),
        ),
    ).toHaveLength(1);
    const replay = await submit();
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual(first.body);
  });

  it("replays a boxes-empty early terminal rejection exactly", async () => {
    const body = {
      deviceSeq: 904,
      badgeCode: `unknown-${randomUUID()}`,
      reason: "buy" as const,
      items: [{ rawKm: "not-a-km" }],
      boxes: [],
    };
    const first = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", token)
      .send(body)
      .expect(422);
    const replay = await request(app!.getHttpServer())
      .post("/kiosk/orders")
      .set("x-kiosk-token", token)
      .send(body)
      .expect(422);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.message).toBe("Unknown or inactive badge");
  });

  it("emits a remove delta after disassembly", async () => {
    await db.transaction(async (tx) => {
      const changed = await tx
        .update(schema.boxes)
        .set({ disassembledAt: new Date() })
        .where(eq(schema.boxes.id, eligibleBoxId))
        .returning({ id: schema.boxes.id });
      await advanceBoxRegistryVersion(
        tx,
        tenantId,
        changed.map((box) => box.id),
      );
    });
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
