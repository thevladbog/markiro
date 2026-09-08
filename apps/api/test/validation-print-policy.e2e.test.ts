import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildDuplicateLabelTemplate,
  PRODUCT_LABEL_PROTOCOL,
  validationPrintPolicySchema,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("validation print policy lifecycle", () => {
  let app: INestApplication;
  let disabled: INestApplication;
  let db: Db;

  async function boot(enabled: boolean) {
    const env = loadEnv({ ...process.env, VALIDATION_DM_DUPLICATE_ENABLED: String(enabled) });
    const setup = setupAuth(env);
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    const instance = module.createNestApplication({ bodyParser: false });
    const server = instance.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await instance.init();
    await listenOnLoopback(instance);
    return { instance, db: setup.db };
  }

  beforeAll(async () => {
    const enabled = await boot(true);
    app = enabled.instance;
    db = enabled.db;
    disabled = (await boot(false)).instance;
  });
  afterAll(async () => {
    await app?.close();
    await disabled?.close();
  });

  async function fixture(instance = app) {
    const agent = request.agent(instance.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: "04600000000015", name: "Кег", status: "active" });
    const templateId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId,
      name: "Дубликат",
      purpose: "product_duplicate",
      spec: buildDuplicateLabelTemplate(),
    });
    const station = await createTestStationDevice(instance, agent, "Station");
    const input = {
      productId,
      mode: "validation",
      validationPrint: { mode: "duplicate_dm", verification: "required", templateId },
    };
    return { agent, tenantId, productId, templateId, station, input };
  }

  it("exposes only the small planning contract to the station and cabinet", async () => {
    const f = await fixture();
    const office = await f.agent
      .get("/shifts/planning-config")
      .query({ productId: f.productId })
      .expect(200);
    const floor = await request(app.getHttpServer())
      .get("/shifts/planning-config")
      .set("x-api-key", f.station.apiKey)
      .query({ productId: f.productId })
      .expect(200);
    expect(floor.body).toEqual(office.body);
    expect(floor.body).toEqual({
      defaultBoxLabelTemplateId: null,
      defaultSource: null,
      validationPrintProtocol: PRODUCT_LABEL_PROTOCOL,
    });
    await request(app.getHttpServer()).get("/shifts/planning-config").expect(401);
  });

  it("keeps legacy shifts working and rejects new policies while rollout is disabled", async () => {
    const f = await fixture(disabled);
    expect(
      (await f.agent.get("/shifts/planning-config").expect(200)).body.validationPrintProtocol,
    ).toBeNull();
    const rejection = await f.agent.post("/shifts").send(f.input).expect(409);
    expect(rejection.body.code).toBe("VALIDATION_PRINT_DISABLED");
    expect(
      await db.select().from(schema.shifts).where(eq(schema.shifts.tenantId, f.tenantId)),
    ).toHaveLength(0);
    const legacy = await f.agent
      .post("/shifts")
      .send({ productId: f.productId, mode: "validation" })
      .expect(201);
    expect(legacy.body.validationPrint).toEqual({
      mode: "none",
      verification: "none",
      templateId: null,
      snapshot: null,
      policyRevision: null,
    });
    await f.agent
      .patch(`/shifts/${legacy.body.id}`)
      .send({ validationPrint: f.input.validationPrint })
      .expect(409);
    await request(disabled.getHttpServer())
      .post(`/shifts/${legacy.body.id}/open`)
      .set("x-api-key", f.station.apiKey)
      .expect(200);
  });

  it.each(["none", "required"])(
    "admin and operator can configure verification %s",
    async (verification) => {
      const f = await fixture();
      const input = { ...f.input, validationPrint: { ...f.input.validationPrint, verification } };
      const office = await f.agent.post("/shifts").send(input).expect(201);
      const floor = await request(app.getHttpServer())
        .post("/shifts")
        .set("x-api-key", f.station.apiKey)
        .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
        .send(input)
        .expect(201);
      const a = validationPrintPolicySchema.parse(office.body.validationPrint);
      const b = validationPrintPolicySchema.parse(floor.body.validationPrint);
      expect(a.mode).toBe("duplicate_dm");
      expect(b).toEqual({ ...a, policyRevision: b.policyRevision });
      expect(floor.body.createdFrom).toBe("station");
      expect(a.policyRevision).not.toBe(b.policyRevision);
    },
  );

  it("rejects old stations before create, participation, activation, or SSCC allocation", async () => {
    const f = await fixture();
    const rejected = await request(app.getHttpServer())
      .post("/shifts")
      .set("x-api-key", f.station.apiKey)
      .send(f.input)
      .expect(409);
    expect(rejected.body.code).toBe("STATION_UPDATE_REQUIRED");
    expect(
      await db.select().from(schema.shifts).where(eq(schema.shifts.tenantId, f.tenantId)),
    ).toHaveLength(0);
    const created = await f.agent.post("/shifts").send(f.input).expect(201);
    for (const route of ["open", "enter"]) {
      const response = await request(app.getHttpServer())
        .post(`/shifts/${created.body.id}/${route}`)
        .set("x-api-key", f.station.apiKey)
        .expect(409);
      expect(response.body.code).toBe("STATION_UPDATE_REQUIRED");
    }
    for (const route of ["bundle", "reference-bundle"]) {
      const response = await request(app.getHttpServer())
        .get(`/shifts/${created.body.id}/${route}`)
        .set("x-api-key", f.station.apiKey)
        .expect(409);
      expect(response.body.code).toBe("STATION_UPDATE_REQUIRED");
    }
    expect((await f.agent.get(`/shifts/${created.body.id}`).expect(200)).body.status).toBe(
      "planned",
    );
    expect(
      await db
        .select()
        .from(schema.shiftDeviceParticipants)
        .where(eq(schema.shiftDeviceParticipants.tenantId, f.tenantId)),
    ).toHaveLength(0);
    const active = await request(app.getHttpServer())
      .post(`/shifts/${created.body.id}/open`)
      .set("x-api-key", f.station.apiKey)
      .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
      .expect(200);
    const bundle = await request(app.getHttpServer())
      .get(`/shifts/${created.body.id}/bundle`)
      .set("x-api-key", f.station.apiKey)
      .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
      .expect(200);
    expect(bundle.body.shift.validationPrint).toEqual(active.body.validationPrint);
    expect(bundle.body.labelTemplate).toBeNull();
    expect(bundle.body.sscc).toBeNull();
    expect(
      await db.select().from(schema.ssccBlocks).where(eq(schema.ssccBlocks.tenantId, f.tenantId)),
    ).toHaveLength(0);
  });

  it("refreshes the snapshot at opening, then preserves it after the library changes or disables", async () => {
    const f = await fixture();
    const created = await f.agent.post("/shifts").send(f.input).expect(201);
    await f.agent
      .patch(`/label-templates/${f.templateId}`)
      .send({ name: "Новая этикетка", spec: { ...buildDuplicateLabelTemplate(), widthMm: 60 } })
      .expect(200);
    const active = await f.agent.post(`/shifts/${created.body.id}/open`).expect(200);
    expect(active.body.validationPrint.snapshot.name).toBe("Новая этикетка");
    expect(active.body.validationPrint.snapshot.spec.widthMm).toBe(60);
    expect(active.body.validationPrint.policyRevision).not.toBe(
      created.body.validationPrint.policyRevision,
    );
    await f.agent
      .patch(`/label-templates/${f.templateId}`)
      .send({ name: "Следующая", enabled: false })
      .expect(200);
    const bundle = await f.agent.get(`/shifts/${created.body.id}/reference-bundle`).expect(200);
    expect(bundle.body.shift.validationPrint).toEqual(active.body.validationPrint);
    const frozen = await f.agent
      .patch(`/shifts/${created.body.id}`)
      .send({ validationPrint: { mode: "none" } })
      .expect(409);
    expect(frozen.body.code).toBe("VALIDATION_PRINT_POLICY_FROZEN");
    // A rollback can hide new mode creation without blocking existing recovery/entry.
    const recovery = await request(disabled.getHttpServer())
      .get(`/shifts/${created.body.id}/reference-bundle`)
      .set("x-api-key", f.station.apiKey)
      .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
      .expect(200);
    expect(recovery.body.shift.validationPrint).toEqual(active.body.validationPrint);
    await request(disabled.getHttpServer())
      .post(`/shifts/${created.body.id}/enter`)
      .set("x-api-key", f.station.apiKey)
      .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
      .expect(200);
  });

  it("preserves omitted policy on PATCH and requires explicit disabling when changing operation", async () => {
    const f = await fixture();
    const created = await f.agent.post("/shifts").send(f.input).expect(201);
    const patched = await f.agent
      .patch(`/shifts/${created.body.id}`)
      .send({ plannedQty: 20 })
      .expect(200);
    expect(patched.body.validationPrint).toEqual(created.body.validationPrint);
    const boxId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: boxId,
      tenantId: f.tenantId,
      name: "Короб",
      purpose: "box",
      spec: buildDuplicateLabelTemplate(),
    });
    const change = { mode: "aggregation", boxCapacity: 1, boxLabelTemplateId: boxId };
    const rejected = await f.agent.patch(`/shifts/${created.body.id}`).send(change).expect(400);
    expect(rejected.body.code).toBe("VALIDATION_PRINT_MODE_INVALID");
    const disabled = await f.agent
      .patch(`/shifts/${created.body.id}`)
      .send({ ...change, validationPrint: { mode: "none" } })
      .expect(200);
    expect(disabled.body.validationPrint.mode).toBe("none");
  });

  it.each(["box", "disabled", "category"])(
    "rejects an ineligible duplicate template: %s",
    async (reason) => {
      const f = await fixture();
      await db
        .update(schema.labelTemplates)
        .set(
          reason === "box"
            ? { purpose: "box" }
            : reason === "disabled"
              ? { enabled: false }
              : { chzProductGroupCodes: [15] },
        )
        .where(
          and(
            eq(schema.labelTemplates.tenantId, f.tenantId),
            eq(schema.labelTemplates.id, f.templateId),
          ),
        );
      const response = await f.agent.post("/shifts").send(f.input).expect(400);
      expect(response.body.code).toBe("PRODUCT_LABEL_TEMPLATE_NOT_ELIGIBLE");
      expect(
        await db.select().from(schema.shifts).where(eq(schema.shifts.tenantId, f.tenantId)),
      ).toHaveLength(0);
    },
  );

  it("does not leak foreign templates and rechecks eligibility before opening", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await f.agent
      .post("/shifts")
      .send({
        ...f.input,
        validationPrint: { ...f.input.validationPrint, templateId: foreign.templateId },
      })
      .expect(404);
    const created = await f.agent.post("/shifts").send(f.input).expect(201);
    await f.agent.patch(`/label-templates/${f.templateId}`).send({ enabled: false }).expect(200);
    const rejected = await f.agent.post(`/shifts/${created.body.id}/open`).expect(400);
    expect(rejected.body.code).toBe("PRODUCT_LABEL_TEMPLATE_NOT_ELIGIBLE");
    expect((await f.agent.get(`/shifts/${created.body.id}`).expect(200)).body.status).toBe(
      "planned",
    );
  });

  it.each(["open", "enter"])("serializes a policy PATCH racing with %s", async (route) => {
    const f = await fixture();
    const created = await f.agent.post("/shifts").send(f.input).expect(201);
    const [patch, start] = await Promise.all([
      f.agent
        .patch(`/shifts/${created.body.id}`)
        .send({ validationPrint: { ...f.input.validationPrint, verification: "none" } }),
      request(app.getHttpServer())
        .post(`/shifts/${created.body.id}/${route}`)
        .set("x-api-key", f.station.apiKey)
        .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL),
    ]);
    expect(start.status).toBe(200);
    expect([200, 409]).toContain(patch.status);
    const final = await f.agent.get(`/shifts/${created.body.id}`).expect(200);
    expect(final.body.validationPrint).toEqual(start.body.validationPrint);
    expect(final.body.validationPrint.verification).toBe(
      patch.status === 200 ? "none" : "required",
    );
    if (patch.status === 409) expect(patch.body.code).toBe("VALIDATION_PRINT_POLICY_FROZEN");
    const [stored] = await db
      .select()
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, f.tenantId), eq(schema.shifts.id, created.body.id)));
    expect(stored?.validationPrintPolicyRevision).toBe(final.body.validationPrint.policyRevision);
  });
});
