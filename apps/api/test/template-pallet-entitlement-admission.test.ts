import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";
import { LabelTemplatesService } from "../src/modules/label-templates/label-templates.service";
import { createLabelTemplateSchema } from "../src/modules/label-templates/dto";
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import {
  EntitlementAdmissionService,
  admissionScopeDigest,
} from "../src/subscriptions/entitlement-admission.service";
import { listenOnLoopback } from "./support/listen-loopback";
import {
  createTestStationDevice,
  signUpAndActivate,
  setOnlyOrganizationMemberRole,
} from "./support/auth";

const ready = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);
const spec = {
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  language: "zpl",
  elements: [{ kind: "text", id: "t1", xMm: 2, yMm: 2, text: "Pallet", fontSizePt: 12 }],
};
describe.skipIf(!ready)("template and pallet admission actual HTTP owners", () => {
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
  async function fixture(labelEditorEnabled = true) {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 20,
      maxStations: 20,
      maxKiosks: 20,
      maxCabinetUsers: 20,
      labelEditorEnabled,
      palletsEnabled: true,
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
    const [member] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Fixture membership missing");
    return { agent, tenantId, userId: member.userId, planVersionId };
  }
  const rows = (tenantId: string) =>
    db
      .select()
      .from(schema.entitlementShadowObservations)
      .where(eq(schema.entitlementShadowObservations.tenantId, tenantId));
  it("observes template create/update/delete with exact cabinet scope, excludes identical patch and reads", async () => {
    const f = await fixture();
    const created = await f.agent
      .post("/label-templates")
      .send({ name: "Observed", spec })
      .expect(201);
    const id = created.body.id as string;
    expect(await rows(f.tenantId)).toHaveLength(1);
    expect((await rows(f.tenantId))[0]).toMatchObject({
      tenantId: f.tenantId,
      actorType: "cabinet",
      actorId: f.userId,
      operationId: "labelEditor.template.write.v1",
      outcome: "allow",
      reasonCodes: [],
      resourceScope: {
        digest: admissionScopeDigest({
          action: "create",
          templateId: id,
          name: "Observed",
          purpose: "box",
          spec,
          enabled: true,
          chzProductGroupCodes: null,
        }),
      },
    });
    await f.agent.patch(`/label-templates/${id}`).send({ name: "Observed" }).expect(200);
    await f.agent.get(`/label-templates/${id}`).expect(200);
    expect(await rows(f.tenantId)).toHaveLength(1);
    await f.agent.patch(`/label-templates/${id}`).send({ name: "Updated" }).expect(200);
    await f.agent.delete(`/label-templates/${id}`).expect(204);
    const observed = await rows(f.tenantId);
    expect(observed).toHaveLength(3);
    expect(
      observed.find(
        (r) =>
          r.resourceScope.digest ===
          admissionScopeDigest({ action: "update", templateId: id, changes: { name: "Updated" } }),
      ),
    ).toMatchObject({
      actorType: "cabinet",
      actorId: f.userId,
      tenantId: f.tenantId,
      operationId: "labelEditor.template.write.v1",
      outcome: "allow",
    });
    expect(
      observed.find(
        (r) =>
          r.resourceScope.digest === admissionScopeDigest({ action: "delete", templateId: id }),
      ),
    ).toMatchObject({
      actorType: "cabinet",
      actorId: f.userId,
      tenantId: f.tenantId,
      operationId: "labelEditor.template.write.v1",
      outcome: "allow",
    });
  });
  it("observes pallet configure and planned start, excludes active device re-entry and box-only work", async () => {
    const f = await fixture();
    const productId = randomUUID(),
      boxId = randomUUID(),
      palletId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900383",
      name: "Pallet owner",
      status: "active",
      boxCapacity: 20,
      palletBoxCapacity: 12,
    });
    await db.insert(schema.labelTemplates).values([
      { id: boxId, tenantId: f.tenantId, name: "Box", purpose: "box", spec },
      { id: palletId, tenantId: f.tenantId, name: "Pallet", purpose: "pallet", spec },
    ]);
    const create = (palletsEnabled: boolean) =>
      f.agent
        .post("/shifts")
        .send({
          productId,
          mode: "aggregation",
          boxLabelTemplateId: boxId,
          palletsEnabled,
          ...(palletsEnabled ? { palletLabelTemplateId: palletId } : {}),
        })
        .expect(201);
    const box = await create(false);
    await f.agent.post(`/shifts/${box.body.id}/open`).expect(200);
    expect(await rows(f.tenantId)).toHaveLength(0);
    const created = await create(true);
    const id = created.body.id as string;
    expect((await rows(f.tenantId)).map((r) => r.operationId)).toEqual([
      "pallets.shift.configure.v1",
    ]);
    await f.agent.patch(`/shifts/${id}`).send({ palletBoxCapacity: 12 }).expect(200);
    expect(await rows(f.tenantId)).toHaveLength(1);
    await f.agent.patch(`/shifts/${id}`).send({ palletBoxCapacity: 15 }).expect(200);
    expect(await rows(f.tenantId)).toHaveLength(2);
    const device = await createTestStationDevice(app, f.agent, "Pallet observation device");
    await request(app.getHttpServer())
      .post(`/shifts/${id}/enter`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/shifts/${id}/enter`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    const observed = await rows(f.tenantId);
    expect(observed).toHaveLength(3);
    expect(observed.find((r) => r.operationId === "pallets.shift.start.v1")).toMatchObject({
      tenantId: f.tenantId,
      actorType: "station_device",
      actorId: device.deviceId,
      outcome: "allow",
      resourceScope: { digest: admissionScopeDigest({ action: "start", shiftId: id }) },
    });
  });
  it("keeps foreign tenant, capability rejection and referenced/default mutations outside observations", async () => {
    const f = await fixture(),
      foreign = await fixture();
    const created = await f.agent
      .post("/label-templates")
      .send({ name: "Retained", spec })
      .expect(201);
    const id = created.body.id as string;
    await foreign.agent.patch(`/label-templates/${id}`).send({ name: "Foreign" }).expect(404);
    await foreign.agent.delete(`/label-templates/${id}`).expect(404);
    expect(await rows(foreign.tenantId)).toEqual([]);
    await f.agent.put("/org/profile").send({ defaultBoxLabelTemplateId: id }).expect(200);
    await f.agent.delete(`/label-templates/${id}`).expect(409);
    await f.agent.patch(`/label-templates/${id}`).send({ enabled: false }).expect(409);
    expect(await rows(f.tenantId)).toHaveLength(1);
    const [stored] = await db
      .select()
      .from(schema.labelTemplates)
      .where(eq(schema.labelTemplates.id, id));
    expect(stored).toMatchObject({ name: "Retained", spec, enabled: true });
    await setOnlyOrganizationMemberRole(db, f.tenantId, "viewer");
    await f.agent.post("/label-templates").send({ name: "Forbidden", spec }).expect(403);
    expect(await rows(f.tenantId)).toHaveLength(1);
  });
  it("stale facts stay unknown and failed observation inserts do not poison template owner transactions", async () => {
    const f = await fixture();
    const admission = app.get(EntitlementAdmissionService);
    const capture = admission.capture.bind(admission);
    const captureSpy = vi.spyOn(admission, "capture").mockImplementationOnce(async (tenantId) => {
      const facts = await capture(tenantId);
      await db.insert(schema.lines).values({ tenantId, name: "Proof drift" });
      return facts;
    });
    try {
      await f.agent.post("/label-templates").send({ name: "Stale", spec }).expect(201);
    } finally {
      captureSpy.mockRestore();
    }
    expect((await rows(f.tenantId))[0]).toMatchObject({
      outcome: "unknown",
      reasonCodes: ["shadow_snapshot_stale"],
    });
    const fn = `task3_shadow_${randomUUID().replaceAll("-", "")}`;
    await db.execute(
      sql.raw(
        `create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'synthetic shadow failure'; end $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `create trigger ${fn} before insert on entitlement_shadow_observations for each row execute function ${fn}()`,
      ),
    );
    const observation = vi.spyOn(admission, "observe");
    try {
      const created = await f.agent
        .post("/label-templates")
        .send({ name: "Survives", spec })
        .expect(201);
      const id = created.body.id as string;
      await f.agent.patch(`/label-templates/${id}`).send({ name: "Survives update" }).expect(200);
      await f.agent.delete(`/label-templates/${id}`).expect(204);
      expect(await rows(f.tenantId)).toHaveLength(1);
      for (const result of observation.mock.results)
        expect(await result.value).toMatchObject({
          decision: "unknown",
          reasons: ["shadow_persistence_failed"],
          observationId: null,
        });
    } finally {
      observation.mockRestore();
      await db.execute(sql.raw(`drop trigger ${fn} on entitlement_shadow_observations`));
      await db.execute(sql.raw(`drop function ${fn}()`));
    }
  });

  it("keeps real shadow denial observational while existing HTTP subscription feature denial remains authoritative", async () => {
    const f = await fixture(false);
    await f.agent.post("/label-templates").send({ name: "Guard denied", spec }).expect(403);
    expect(await rows(f.tenantId)).toEqual([]);
    // Direct owner is invoked after security by its caller; commercial observations never replace that guard.
    const created = await app
      .get(LabelTemplatesService)
      .createLabelTemplate(
        f.tenantId,
        createLabelTemplateSchema.parse({ name: "Shadow denied", spec }),
        f.userId,
      );
    expect(created.spec).toEqual(spec);
    expect((await rows(f.tenantId))[0]).toMatchObject({
      tenantId: f.tenantId,
      actorType: "cabinet",
      actorId: f.userId,
      operationId: "labelEditor.template.write.v1",
      outcome: "deny",
      reasonCodes: ["feature_not_included"],
    });
  });
  it("separates station configuration, cabinet start, enable-from-default and existing production-date audit", async () => {
    const f = await fixture(),
      productId = randomUUID(),
      boxId = randomUUID(),
      palletId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900383",
      name: "Pallet owner",
      status: "active",
      boxCapacity: 20,
      palletBoxCapacity: 12,
    });
    await db.insert(schema.labelTemplates).values([
      { id: boxId, tenantId: f.tenantId, name: "Box", purpose: "box", spec },
      { id: palletId, tenantId: f.tenantId, name: "Pallet", purpose: "pallet", spec },
    ]);
    await f.agent.put("/org/profile").send({ defaultPalletLabelTemplateId: palletId }).expect(200);
    expect(await rows(f.tenantId)).toEqual([]);
    const body = { productId, mode: "aggregation", boxLabelTemplateId: boxId };
    const planned = await f.agent.post("/shifts").send(body).expect(201);
    const id = planned.body.id as string;
    const updated = await f.agent
      .patch(`/shifts/${id}`)
      .send({ palletsEnabled: true, productionDate: "2026-09-12" })
      .expect(200);
    expect(updated.body.palletLabelTemplateId).toBe(palletId);
    expect((await rows(f.tenantId))[0]).toMatchObject({
      tenantId: f.tenantId,
      actorType: "cabinet",
      actorId: f.userId,
      operationId: "pallets.shift.configure.v1",
      resourceScope: {
        digest: admissionScopeDigest({
          action: "update",
          shiftId: id,
          mode: "aggregation",
          palletsEnabled: true,
          boxCapacity: 20,
          palletBoxCapacity: 12,
          palletLabelTemplateId: palletId,
        }),
      },
    });
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId));
    expect(audits.filter((row) => row.action === "shift.production_date.changed")).toMatchObject([
      {
        organizationId: f.tenantId,
        actorUserId: f.userId,
        action: "shift.production_date.changed",
        outcome: "success",
        targetType: "shift",
        targetId: id,
        before: { productionDate: null },
        after: { productionDate: "2026-09-12", reason: "changed" },
        requestId: null,
      },
    ]);
    await f.agent.post(`/shifts/${id}/open`).expect(200);
    await f.agent.post(`/shifts/${id}/open`).expect(409);
    expect(
      (await rows(f.tenantId)).find((r) => r.operationId === "pallets.shift.start.v1"),
    ).toMatchObject({
      actorType: "cabinet",
      actorId: f.userId,
      tenantId: f.tenantId,
      outcome: "allow",
    });
    const before = await rows(f.tenantId);
    await f.agent.patch(`/shifts/${id}`).send({ palletBoxCapacity: 16 }).expect(409);
    expect(await rows(f.tenantId)).toEqual(before);
    const device = await createTestStationDevice(app, f.agent, "Station create owner");
    const station = await request(app.getHttpServer())
      .post("/shifts")
      .set("x-api-key", device.apiKey)
      .send({ ...body, palletsEnabled: true })
      .expect(201);
    expect(
      (await rows(f.tenantId)).find((r) => r.operationId === "pallets.shift.configure.station.v1"),
    ).toMatchObject({
      tenantId: f.tenantId,
      actorType: "station_device",
      actorId: device.deviceId,
      outcome: "allow",
      resourceScope: {
        digest: admissionScopeDigest({
          action: "create",
          shiftId: station.body.id,
          productId,
          mode: "aggregation",
          palletsEnabled: true,
          boxCapacity: 20,
          palletBoxCapacity: 12,
          palletLabelTemplateId: palletId,
        }),
      },
    });
    expect(
      (await rows(f.tenantId)).some(
        (r) =>
          r.operationId === "handheld.work.start.v1" || r.operationId === "publicApi.request.v1",
      ),
    ).toBe(false);
  });
  it("linearizes concurrent template deletion to one observation and a not-found loser", async () => {
    const f = await fixture();
    const created = await f.agent
      .post("/label-templates")
      .send({ name: "Delete race", spec })
      .expect(201);
    const id = created.body.id as string;
    const admission = app.get(EntitlementAdmissionService);
    const capture = admission.capture.bind(admission);
    let captured = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(admission, "capture").mockImplementation(async (tenantId) => {
      const facts = await capture(tenantId);
      if (++captured === 2) release();
      await barrier;
      return facts;
    });
    try {
      const replies = await Promise.all([
        f.agent.delete(`/label-templates/${id}`),
        f.agent.delete(`/label-templates/${id}`),
      ]);
      expect(replies.map((r) => r.status).sort()).toEqual([204, 404]);
      expect(await rows(f.tenantId)).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("isolates pallet observation failure at create, configure and start while retaining exact business facts", async () => {
    const f = await fixture(),
      productId = randomUUID(),
      boxId = randomUUID(),
      palletId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900383",
      name: "Pallet isolation",
      status: "active",
      boxCapacity: 20,
      palletBoxCapacity: 12,
    });
    await db.insert(schema.labelTemplates).values([
      { id: boxId, tenantId: f.tenantId, name: "Box", purpose: "box", spec },
      { id: palletId, tenantId: f.tenantId, name: "Pallet", purpose: "pallet", spec },
    ]);
    const body = {
      productId,
      mode: "aggregation",
      boxLabelTemplateId: boxId,
      palletLabelTemplateId: palletId,
      palletsEnabled: true,
    };
    const device = await createTestStationDevice(app, f.agent, "Pallet failure owner");
    const fn = `task3_pallet_shadow_${randomUUID().replaceAll("-", "")}`;
    await db.execute(
      sql.raw(
        `create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'synthetic shadow failure'; end $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `create trigger ${fn} before insert on entitlement_shadow_observations for each row execute function ${fn}()`,
      ),
    );
    const observation = vi.spyOn(app.get(EntitlementAdmissionService), "observe");
    try {
      const created = await f.agent.post("/shifts").send(body).expect(201);
      const id = created.body.id as string;
      await f.agent.patch(`/shifts/${id}`).send({ palletBoxCapacity: 17 }).expect(200);
      await f.agent.post(`/shifts/${id}/open`).expect(200);
      const station = await request(app.getHttpServer())
        .post("/shifts")
        .set("x-api-key", device.apiKey)
        .send(body)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/shifts/${station.body.id}/enter`)
        .set("x-api-key", device.apiKey)
        .expect(200);
      const [stored] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, id));
      expect(stored).toMatchObject({
        tenantId: f.tenantId,
        status: "active",
        palletsEnabled: true,
        palletBoxCapacity: 17,
        palletLabelTemplateId: palletId,
      });
      expect(await rows(f.tenantId)).toEqual([]);
      expect(observation.mock.calls).toHaveLength(5);
      for (const result of observation.mock.results)
        expect(await result.value).toMatchObject({
          decision: "unknown",
          reasons: ["shadow_persistence_failed"],
        });
    } finally {
      observation.mockRestore();
      await db.execute(sql.raw(`drop trigger ${fn} on entitlement_shadow_observations`));
      await db.execute(sql.raw(`drop function ${fn}()`));
    }
    // Real snapshot, with a deliberately unavailable commercial source set: shadow denial must not block the existing enabled owner policy.
    const admission = app.get(EntitlementAdmissionService);
    const capture = admission.capture.bind(admission);
    const spy = vi.spyOn(admission, "capture").mockImplementationOnce(async (tenantId) => {
      const facts = await capture(tenantId);
      if (!facts.snapshot) throw new Error("Expected actual managed snapshot");
      return { ...facts, snapshot: { ...facts.snapshot, sources: [] } };
    });
    try {
      await f.agent.post("/shifts").send(body).expect(201);
    } finally {
      spy.mockRestore();
    }
    expect((await rows(f.tenantId))[0]).toMatchObject({
      tenantId: f.tenantId,
      actorType: "cabinet",
      actorId: f.userId,
      operationId: "pallets.shift.configure.v1",
      outcome: "deny",
      reasonCodes: ["feature_not_included"],
    });
  });
  it("observes independent pallet box-capacity and template changes, but excludes successful disable and unrelated edits", async () => {
    const f = await fixture(),
      productId = randomUUID(),
      boxId = randomUUID(),
      palletId = randomUUID(),
      replacementId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900383",
      name: "Pallet branches",
      status: "active",
      boxCapacity: 20,
      palletBoxCapacity: 12,
    });
    await db.insert(schema.labelTemplates).values([
      { id: boxId, tenantId: f.tenantId, name: "Box", purpose: "box", spec },
      { id: palletId, tenantId: f.tenantId, name: "Pallet", purpose: "pallet", spec },
      { id: replacementId, tenantId: f.tenantId, name: "Replacement", purpose: "pallet", spec },
    ]);
    const created = await f.agent
      .post("/shifts")
      .send({
        productId,
        mode: "aggregation",
        boxLabelTemplateId: boxId,
        palletLabelTemplateId: palletId,
        palletsEnabled: true,
      })
      .expect(201);
    const id = created.body.id as string;
    for (const [changes, expectedTemplateId] of [
      [{ boxCapacity: 24 }, palletId],
      [{ palletLabelTemplateId: replacementId }, replacementId],
      [{ palletLabelTemplateId: null }, null],
    ] as const) {
      const before = await rows(f.tenantId);
      const updated = await f.agent.patch(`/shifts/${id}`).send(changes).expect(200);
      expect(updated.body).toMatchObject({ id, ...changes });
      const observed = await rows(f.tenantId);
      expect(observed).toHaveLength(before.length + 1);
      const added = observed.filter((row) => !before.some((old) => old.id === row.id));
      expect(added).toMatchObject([
        {
          tenantId: f.tenantId,
          actorType: "cabinet",
          actorId: f.userId,
          operationId: "pallets.shift.configure.v1",
          outcome: "allow",
          reasonCodes: [],
          resourceScope: {
            digest: admissionScopeDigest({
              action: "update",
              shiftId: id,
              mode: "aggregation",
              palletsEnabled: true,
              boxCapacity: 24,
              palletBoxCapacity: 12,
              palletLabelTemplateId: expectedTemplateId,
            }),
          },
        },
      ]);
      const [stored] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, id));
      expect(stored).toMatchObject({
        tenantId: f.tenantId,
        palletsEnabled: true,
        boxCapacity: 24,
        palletBoxCapacity: 12,
        palletLabelTemplateId: expectedTemplateId,
      });
    }
    const observed = await rows(f.tenantId);
    await f.agent.patch(`/shifts/${id}`).send({ plannedQty: 345 }).expect(200);
    expect(await rows(f.tenantId)).toEqual(observed);
    const [planned] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, id));
    expect(planned).toMatchObject({ plannedQty: 345, palletsEnabled: true });
    await f.agent.patch(`/shifts/${id}`).send({ palletsEnabled: false }).expect(200);
    expect(await rows(f.tenantId)).toEqual(observed);
    const [disabled] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, id));
    expect(disabled).toMatchObject({
      tenantId: f.tenantId,
      plannedQty: 345,
      palletsEnabled: false,
      boxCapacity: 24,
      palletBoxCapacity: 12,
      palletLabelTemplateId: null,
    });
  });
  it("rejects foreign pallet owners and configuration references without observations or business mutations", async () => {
    const f = await fixture(),
      foreign = await fixture(),
      productId = randomUUID(),
      boxId = randomUUID(),
      palletId = randomUUID(),
      foreignTemplateId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900383",
      name: "Pallet tenant boundary",
      status: "active",
      boxCapacity: 20,
      palletBoxCapacity: 12,
    });
    await db.insert(schema.labelTemplates).values([
      { id: boxId, tenantId: f.tenantId, name: "Box", purpose: "box", spec },
      { id: palletId, tenantId: f.tenantId, name: "Pallet", purpose: "pallet", spec },
      {
        id: foreignTemplateId,
        tenantId: foreign.tenantId,
        name: "Foreign pallet",
        purpose: "pallet",
        spec,
      },
    ]);
    const body = {
      productId,
      mode: "aggregation",
      boxLabelTemplateId: boxId,
      palletLabelTemplateId: palletId,
      palletsEnabled: true,
    };
    const created = await f.agent.post("/shifts").send(body).expect(201);
    const id = created.body.id as string;
    const device = await createTestStationDevice(app, foreign.agent, "Foreign pallet device");
    const businessBefore = await db.select().from(schema.shifts).where(eq(schema.shifts.id, id));
    const ownBefore = await rows(f.tenantId),
      foreignBefore = await rows(foreign.tenantId);
    await foreign.agent.patch(`/shifts/${id}`).send({ boxCapacity: 30 }).expect(404);
    await foreign.agent.post(`/shifts/${id}/open`).expect(404);
    await request(app.getHttpServer())
      .post(`/shifts/${id}/enter`)
      .set("x-api-key", device.apiKey)
      .expect(404);
    await f.agent
      .patch(`/shifts/${id}`)
      .send({ palletLabelTemplateId: foreignTemplateId })
      .expect(400);
    await foreign.agent.post("/shifts").send(body).expect(400);
    expect(await rows(f.tenantId)).toEqual(ownBefore);
    expect(await rows(foreign.tenantId)).toEqual(foreignBefore);
    expect(await db.select().from(schema.shifts).where(eq(schema.shifts.id, id))).toEqual(
      businessBefore,
    );
    expect(
      await db.select().from(schema.shifts).where(eq(schema.shifts.tenantId, foreign.tenantId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.shiftDeviceParticipants)
        .where(eq(schema.shiftDeviceParticipants.shiftId, id)),
    ).toEqual([]);
  });
});
