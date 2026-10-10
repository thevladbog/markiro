import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema, type Db } from "@markiro/db";
import {
  canonicalizeKm,
  kmHash,
  warehouseBoxTemplate,
  buildDuplicateLabelTemplate,
} from "@markiro/domain";
import express from "express";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { mountAuth, setupAuth } from "../../src/auth/auth.setup";
import { loadEnv } from "../../src/env";
import { hashSecret } from "../../src/lib/pin-hash";
import { createTestEmployee, createTestStationDevice, signUpAndActivate } from "./auth";
import { listenOnLoopback } from "./listen-loopback";

export const WAREHOUSE_TEST_SSCC = "346006820000000014";
export const WAREHOUSE_TEST_KM = "010460068200001321abcDEF1234567\u001d93crypto";

type WarehouseTestDevice = Awaited<ReturnType<typeof createTestStationDevice>> & {
  tenantId: string;
  operatorId: string;
  cabinet: ReturnType<typeof request.agent>;
};
interface WarehouseApiHarness {
  app: INestApplication;
  db: Db;
  a: WarehouseTestDevice;
  b: WarehouseTestDevice;
  boxId: string;
  shiftId: string;
  codeHash: string;
  boxTemplateId: string;
  unitTemplateId: string;
  disabledTemplateId: string;
  lookup: (apiKey: string, operatorId: string, raw: string) => request.Test;
  close: () => Promise<void>;
}
export async function setupWarehouseApi(): Promise<WarehouseApiHarness> {
  const env = loadEnv();
  const setup = setupAuth(env);
  const db: Db = setup.db;
  const ref = await Test.createTestingModule({
    imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
  }).compile();
  const app = ref.createNestApplication({ bodyParser: false });
  const server = app.getHttpAdapter().getInstance();
  mountAuth(server, setup.auth);
  server.use(express.json());
  await app.init();
  await listenOnLoopback(app);
  const seed = async (name: string) => {
    const cabinet = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(cabinet);
    const operatorId = randomUUID();
    await createTestEmployee(db, {
      id: operatorId,
      tenantId,
      fullName: `Operator ${name}`,
      role: "operator",
    });
    await db.insert(schema.operatorCredentials).values({
      tenantId,
      employeeId: operatorId,
      login: randomUUID(),
      pinHash: await hashSecret(randomUUID()),
    });
    const device = await createTestStationDevice(app, cabinet, name);
    return { tenantId, operatorId, cabinet, ...device };
  };
  const a = await seed("A");
  const b = await seed("B");
  const productId = randomUUID();
  const shiftId = randomUUID();
  const boxId = randomUUID();
  await db.insert(schema.products).values({
    id: productId,
    tenantId: a.tenantId,
    gtin14: "04600682000013",
    name: "Warehouse syrup",
    shelfLifeDays: 100,
    status: "active",
  });
  await db.insert(schema.shifts).values({
    id: shiftId,
    tenantId: a.tenantId,
    productId,
    status: "closed",
    mode: "validation",
    numberMonthKey: "OCT26",
    numberSeq: 1,
    productionDate: "2026-10-08",
    closedAt: new Date("2026-10-08T12:00:00Z"),
  });
  const km = canonicalizeKm(WAREHOUSE_TEST_KM);
  const codeHash = kmHash(km);
  const scannedAt = new Date("2026-10-08T10:00:00Z");
  await db
    .insert(schema.codeRegistry)
    .values({ tenantId: a.tenantId, codeHash, shiftId, terminalId: randomUUID(), scannedAt });
  await db.insert(schema.codes).values({
    tenantId: a.tenantId,
    codeHash,
    shiftId,
    gtin14: km.gtin14,
    serial: km.serial,
    canonicalRaw: km.raw,
    scannedAt,
  });
  await db.insert(schema.boxes).values({
    id: boxId,
    tenantId: a.tenantId,
    shiftId,
    deviceBoxId: "legacy-other-station-box",
    terminalId: randomUUID(),
    sscc: WAREHOUSE_TEST_SSCC,
    closedAt: new Date("2026-10-08T12:00:00Z"),
    operatorId: a.operatorId,
  });
  await db
    .insert(schema.boxItems)
    .values({ tenantId: a.tenantId, boxId, codeHash, addedAt: scannedAt });
  const boxTemplateId = randomUUID();
  const unitTemplateId = randomUUID();
  const disabledTemplateId = randomUUID();
  await db.insert(schema.labelTemplates).values([
    {
      id: boxTemplateId,
      tenantId: a.tenantId,
      name: "Box",
      purpose: "box",
      spec: warehouseBoxTemplate().spec,
    },
    {
      id: unitTemplateId,
      tenantId: a.tenantId,
      name: "Unit",
      purpose: "product_duplicate",
      spec: buildDuplicateLabelTemplate(203),
    },
    {
      id: disabledTemplateId,
      tenantId: a.tenantId,
      name: "Disabled",
      purpose: "box",
      enabled: false,
      spec: warehouseBoxTemplate().spec,
    },
  ]);
  const lookup = (apiKey: string, operatorId: string, raw: string) =>
    request(app.getHttpServer())
      .post("/station/warehouse-reprint/lookup")
      .set("x-api-key", apiKey)
      .send({ protocol: "warehouse-label-reprint-v1", operatorId, raw });
  return {
    app,
    db,
    a,
    b,
    boxId,
    shiftId,
    codeHash,
    boxTemplateId,
    unitTemplateId,
    disabledTemplateId,
    lookup,
    close: () => app.close(),
  };
}
