import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalizeKm, kmHash } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

/**
 * Task 1 (sell-at-register plan): `GET /boxes/sell-codes` -- the cabinet-only
 * read that hands a cashier's phone a closed box's raw KM payloads so it can
 * render DataMatrix codes for scanning at the register. Fixtures are built
 * ONCE in `beforeAll` through the same `/station/scans` ingest path
 * boxes.e2e.test.ts uses -- there is no other way to create a `boxes` row --
 * and every `it` below is a read-only assertion against them.
 */
describe.skipIf(!ready)("box-sell-codes e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  let agent: ReturnType<typeof request.agent>;
  let stationKey: string;
  let productId: string;
  let operatorId: string;

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

    agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const station = await deviceKey(agent);
    stationKey = station.apiKey;
    productId = await createActiveProduct(agent);
    const operatorRes = await agent
      .post("/employees")
      .send({ fullName: "Operator One" })
      .expect(201);
    operatorId = (operatorRes.body as { id: string }).id;

    // closedBox: two live items in one closed box.
    const closedShiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [
      scan(closedShiftId, "aa", "t1", "2026-07-01T10:00:00.000Z", "sell1"),
      scan(closedShiftId, "bb", "t1", "2026-07-01T10:00:01.000Z", "sell1"),
    ]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "sell1",
          shiftId: closedShiftId,
          terminalId: "t1",
          sscc: "123456789012345675",
          closedAt: "2026-01-01T00:00:00.000Z",
          operatorId,
        },
      ],
    );

    // disassembledBox: closed, then disassembled.
    const disassembledShiftId = await openShiftForProduct(agent, productId);
    await postBatch(stationKey, [
      scan(disassembledShiftId, "dd", "t1", "2026-07-01T10:00:00.000Z", "sell3"),
    ]);
    await postBatch(
      stationKey,
      [],
      [
        {
          boxId: "sell3",
          shiftId: disassembledShiftId,
          terminalId: "t1",
          sscc: "123456789012345682",
          closedAt: "2026-01-01T00:00:00.000Z",
          operatorId,
        },
      ],
    );
    await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", stationKey)
      .send({
        batchId: `disassemble-batch-${randomUUID()}`,
        items: [],
        boxes: [],
        exceptions: [
          {
            kind: "disassemble",
            boxId: "sell3",
            codeHash: null,
            shiftId: disassembledShiftId,
            terminalId: "t1",
            operatorId: null,
            reason: "packed for wrong customer",
            occurredAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201);

    // otherTenant: a second tenant's own closed box, never resolvable here.
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const { apiKey: otherKey } = await deviceKey(other);
    const otherProductId = await createActiveProduct(other);
    const otherShiftId = await openShiftForProduct(other, otherProductId);
    await postBatch(otherKey, [
      scan(otherShiftId, "zz", "t1", "2026-07-01T10:00:00.000Z", "sell9"),
    ]);
    await postBatch(
      otherKey,
      [],
      [
        {
          boxId: "sell9",
          shiftId: otherShiftId,
          terminalId: "t1",
          sscc: "123456789012345699",
          closedAt: "2026-01-01T00:00:00.000Z",
          operatorId: null,
        },
      ],
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  async function deviceKey(
    a: ReturnType<typeof request.agent>,
  ): Promise<{ apiKey: string; deviceId: string }> {
    return createTestStationDevice(app!, a, "Line 1");
  }

  // Same fixture as conflicts.e2e.test.ts / station-scans.e2e.test.ts.
  const VALID_GTIN14 = "04006381333931";

  async function createActiveProduct(a: ReturnType<typeof request.agent>): Promise<string> {
    const product = await a
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
    a: ReturnType<typeof request.agent>,
    productId: string,
  ): Promise<string> {
    const shift = await a.post("/shifts").send({ productId, mode: "validation" }).expect(201);
    const id = (shift.body as { id: string }).id;
    await a.post(`/shifts/${id}/open`).expect(200);
    return id;
  }

  function scan(
    shiftId: string,
    codeLabel: string,
    terminalId: string,
    scannedAt: string,
    boxId: string | null,
  ): ScanItemDto {
    const raw = `01${VALID_GTIN14}21S-${codeLabel}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId,
      terminalId,
      raw,
      verdict: "ok",
      scannedAt,
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId,
      operatorId: null,
    };
  }

  interface ClosureFixture {
    boxId: string;
    shiftId: string;
    terminalId: string | null;
    sscc: string;
    closedAt: string;
    operatorId: string | null;
  }

  async function postBatch(apiKey: string, items: ScanItemDto[], boxes: ClosureFixture[] = []) {
    return request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: `boxes-batch-${randomUUID()}`, items, boxes })
      .expect(201);
  }

  it("returns the closed box's active codes with rawKm", async () => {
    const res = await agent.get("/boxes/sell-codes?sscc=123456789012345675").expect(200);
    const body = res.body as {
      boxId: string;
      sscc: string;
      productName: string;
      itemCount: number;
      items: { codeHash: string; rawKm: string; gtin14: string; serial: string }[];
    };
    expect(body.sscc).toBe("00123456789012345675");
    expect(body.productName).toBe("Cola");
    expect(body.itemCount).toBe(2);
    const serials = body.items.map((item) => item.serial).sort();
    expect(serials).toEqual(["S-aa", "S-bb"]);
    for (const item of body.items) {
      expect(item.rawKm).toContain(`01${VALID_GTIN14}21`);
      expect(item.gtin14).toBe(VALID_GTIN14);
      expect(item.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("accepts scanner-decorated SSCC input (AI 00 prefix)", async () => {
    const res = await agent.get("/boxes/sell-codes?sscc=00123456789012345675").expect(200);
    expect((res.body as { boxId: string }).boxId).toBeTruthy();
  });

  it("rejects a malformed sscc with 400", async () => {
    await agent.get("/boxes/sell-codes?sscc=not-an-sscc").expect(400);
  });

  it("404s an unknown sscc", async () => {
    const res = await agent.get("/boxes/sell-codes?sscc=999999999999999995").expect(404);
    expect((res.body as { code?: string }).code).toBe("box_not_found");
  });

  it("409s a disassembled box", async () => {
    const res = await agent.get("/boxes/sell-codes?sscc=123456789012345682").expect(409);
    expect((res.body as { code?: string }).code).toBe("box_disassembled");
  });

  it("does not resolve another tenant's box (404, not 403/409)", async () => {
    const res = await agent.get("/boxes/sell-codes?sscc=123456789012345699").expect(404);
    expect((res.body as { code?: string }).code).toBe("box_not_found");
  });

  // Cabinet-only route: контроллер помечен `RequirePermissions(OPERATIONS_READ)`
  // в режиме "cabinet", поэтому станционный api-key (который TenantGuard
  // принимает для резолва тенанта) обязан получить 403 -- тот же паттерн, что
  // описан в doc-комментарии BoxesController.
  it("rejects a station api-key with 403", async () => {
    await request(app!.getHttpServer())
      .get("/boxes/sell-codes?sscc=123456789012345675")
      .set("x-api-key", stationKey)
      .expect(403);
  });

  it("audit-logs each successful read", async () => {
    const audit = app!.get(SecurityAuditService);
    const spy = vi.spyOn(audit, "sensitiveRead");
    await agent.get("/boxes/sell-codes?sscc=123456789012345675").expect(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "boxes.sell_codes.read" }),
    );
    spy.mockRestore();
  });
});
