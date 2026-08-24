import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { setOnlyOrganizationMemberRole, signUpAndActivate } from "./support/auth";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const INTRODUCED_BYTES = readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv"));
const EMPTY_APPLIED_BYTES = readFileSync(
  join(__dirname, "fixtures/inventory/chz-empty-applied.csv"),
);
const INTRODUCED_DIGEST = createHash("sha256").update(INTRODUCED_BYTES).digest("hex");
const APPLIED_DIGEST = createHash("sha256").update(EMPTY_APPLIED_BYTES).digest("hex");
const FIXTURE_GTIN = "04680089900383";

type Agent = ReturnType<typeof request.agent>;

type InventoryBody = {
  id: string;
  number: string;
  status: string;
  mode: string;
  productId: string;
  gtin14: string;
  productName: string;
  lineId: string;
  lineName: string;
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplateId: string | null;
};

describe.skipIf(!ready)("tenant-admin inventories e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  const objects = new Map<string, Buffer>();
  const storage = {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    putVerified: vi.fn(async (key: string, body: Buffer, _contentType: string, sha256: string) => {
      objects.set(key, Buffer.from(body));
      return { byteSize: body.byteLength, sha256 };
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();

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

  beforeEach(() => {
    objects.clear();
    vi.clearAllMocks();
  });

  async function seedProduct(
    tenantId: string,
    overrides: Partial<typeof schema.products.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.products).values({
      id,
      tenantId,
      gtin14: FIXTURE_GTIN,
      name: "Inventory Water",
      status: "active",
      ...overrides,
    });
    return id;
  }

  async function seedLine(tenantId: string, name = "Inventory line"): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.lines).values({ id, tenantId, name });
    return id;
  }

  async function seedTemplate(tenantId: string, name = "Inventory box label"): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id,
      tenantId,
      name,
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    return id;
  }

  async function setDefaultTemplate(tenantId: string, templateId: string | null): Promise<void> {
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, defaultBoxLabelTemplateId: templateId })
      .onConflictDoUpdate({
        target: schema.orgProfiles.tenantId,
        set: { defaultBoxLabelTemplateId: templateId, updatedAt: new Date() },
      });
  }

  async function actorUserId(tenantId: string): Promise<string> {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected tenant owner fixture");
    return member.userId;
  }

  async function seedPreparation(agent: Agent, options: { mode?: "check" | "repack" } = {}) {
    const tenantId = await signUpAndActivate(agent);
    const productId = await seedProduct(tenantId);
    const lineId = await seedLine(tenantId);
    let templateId: string | null = null;
    if (options.mode === "repack") {
      templateId = await seedTemplate(tenantId);
      await setDefaultTemplate(tenantId, templateId);
    }
    return { tenantId, productId, lineId, templateId };
  }

  function createBody(productId: string, lineId: string, mode: "check" | "repack" = "check") {
    return {
      productId,
      lineId,
      mode,
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
    };
  }

  async function createInventory(
    agent: Agent,
    productId: string,
    lineId: string,
    mode: "check" | "repack" = "check",
  ): Promise<InventoryBody> {
    const response = await agent
      .post("/inventories")
      .send(createBody(productId, lineId, mode))
      .expect(201);
    return response.body as InventoryBody;
  }

  function upload(agent: Agent, inventoryId: string, status: string, bytes = INTRODUCED_BYTES) {
    const filename = bytes === EMPTY_APPLIED_BYTES ? "applied.csv" : "introduced.csv";
    return agent
      .post(`/inventories/${inventoryId}/imports/${status}`)
      .attach("file", bytes, { filename, contentType: "text/csv" });
  }

  async function markReady(tenantId: string, inventoryId: string): Promise<void> {
    const userId = await actorUserId(tenantId);
    const [snapshot] = await db
      .insert(schema.inventorySnapshots)
      .values({
        tenantId,
        inventoryId,
        combinedDigest: "a".repeat(64),
        emittedCount: 0,
        introducedCount: 0,
        appliedCount: 0,
        retiredCount: 0,
        writtenOffCount: 0,
        disaggregationCount: 0,
        protectedCount: 0,
        expectedCount: 0,
        packageCount: 0,
        looseCount: 0,
        fixedByUserId: userId,
      })
      .returning({ id: schema.inventorySnapshots.id });
    if (!snapshot) throw new Error("Expected inventory snapshot fixture");
    await db
      .update(schema.inventories)
      .set({ status: "ready", activeSnapshotId: snapshot.id, updatedAt: new Date() })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
  }

  it("requires cabinet operations permissions and gives read routes no mutation capability", async () => {
    await request(app!.getHttpServer()).get("/inventories").expect(401);
    await request(app!.getHttpServer()).post("/inventories").send({}).expect(401);

    const agent = request.agent(app!.getHttpServer());
    const { tenantId } = await seedPreparation(agent);
    await setOnlyOrganizationMemberRole(db, tenantId, "member");
    await agent.get("/inventories").expect(403);
    await agent.post("/inventories").send({}).expect(403);
  });

  it("creates tenant-sequential immutable numbers and lists/reads only the tenant rows", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);

    const [first, second] = await Promise.all([
      agent.post("/inventories").send(createBody(productId, lineId)).expect(201),
      agent.post("/inventories").send(createBody(productId, lineId)).expect(201),
    ]);
    const numbers = [first.body.number as string, second.body.number as string].sort();
    expect(numbers).toEqual(["ИНВ-00001", "ИНВ-00002"]);
    expect(first.body).toMatchObject({
      status: "draft",
      mode: "check",
      productId,
      gtin14: FIXTURE_GTIN,
      productName: "Inventory Water",
      lineId,
      lineName: "Inventory line",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplateId: null,
    });
    expect(first.body).not.toHaveProperty("tenantId");

    const list = await agent.get("/inventories").expect(200);
    expect(list.body.items).toHaveLength(2);
    const detail = await agent.get(`/inventories/${first.body.id as string}`).expect(200);
    expect(detail.body.id).toBe(first.body.id);

    const rows = await db
      .select({ tenantId: schema.inventories.tenantId, number: schema.inventories.number })
      .from(schema.inventories)
      .where(eq(schema.inventories.tenantId, tenantId));
    expect(rows.map((row) => row.number).sort()).toEqual(numbers);
  });

  it("returns not found for cross-tenant inventory ids before read, update, or upload side effects", async () => {
    const owner = request.agent(app!.getHttpServer());
    const ownerSeed = await seedPreparation(owner);
    const inventory = await createInventory(owner, ownerSeed.productId, ownerSeed.lineId);

    const other = request.agent(app!.getHttpServer());
    await seedPreparation(other);
    await other.get(`/inventories/${inventory.id}`).expect(404);
    await other
      .patch(`/inventories/${inventory.id}`)
      .send({ productionDateTo: "2026-09-01" })
      .expect(404);
    await upload(other, inventory.id, "INTRODUCED").expect(404);
    expect(storage.putVerified).not.toHaveBeenCalled();
  });

  it("rejects malformed inventory ids before tenant-scoped UUID queries or storage", async () => {
    const agent = request.agent(app!.getHttpServer());
    await seedPreparation(agent);

    await agent.get("/inventories/not-a-uuid").expect(400);
    await agent
      .patch("/inventories/not-a-uuid")
      .send({ productionDateTo: "2026-09-01" })
      .expect(400);
    await upload(agent, "not-a-uuid", "INTRODUCED").expect(400);
    expect(storage.putVerified).not.toHaveBeenCalled();
  });

  it("allows reads but blocks create, update, and upload after a managed subscription becomes read-only", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    const subscription = await createManagedSubscription(db, { tenantId, planVersionId });
    const inventory = await createInventory(agent, productId, lineId);
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired", endsAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(schema.tenantSubscriptions.id, subscription.subscriptionId));

    await agent.get("/inventories").expect(200);
    await agent.get(`/inventories/${inventory.id}`).expect(200);
    await agent
      .post("/inventories")
      .send(createBody(productId, lineId))
      .expect(403, { code: "subscription_read_only" });
    await agent
      .patch(`/inventories/${inventory.id}`)
      .send({ productionDateTo: "2026-09-01" })
      .expect(403, { code: "subscription_read_only" });
    await upload(agent, inventory.id, "INTRODUCED").expect(403, {
      code: "subscription_read_only",
    });
  });

  it("validates active same-tenant product, assigned line, mode/date range, and current repack template", async () => {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const activeProductId = await seedProduct(tenantId);
    const draftProductId = await seedProduct(tenantId, {
      gtin14: "04680089900390",
      name: "Draft product",
      status: "draft",
    });
    const lineId = await seedLine(tenantId);

    await agent
      .post("/inventories")
      .send(createBody(draftProductId, lineId))
      .expect(422, { code: "INVENTORY_PRODUCT_INACTIVE" });
    await agent
      .post("/inventories")
      .send(createBody(activeProductId, randomUUID()))
      .expect(400, { code: "INVENTORY_LINE_INVALID" });
    await agent
      .post("/inventories")
      .send({ ...createBody(activeProductId, lineId), mode: "other" })
      .expect(400);
    await agent
      .post("/inventories")
      .send({
        ...createBody(activeProductId, lineId),
        productionDateFrom: "2026-09-01",
        productionDateTo: "2026-08-31",
      })
      .expect(400, { code: "INVENTORY_DATE_RANGE_INVALID" });
    await agent
      .post("/inventories")
      .send(createBody(activeProductId, lineId, "repack"))
      .expect(422, { code: "INVENTORY_BOX_LABEL_TEMPLATE_REQUIRED" });

    const firstTemplateId = await seedTemplate(tenantId, "First template");
    await setDefaultTemplate(tenantId, firstTemplateId);
    const repack = await createInventory(agent, activeProductId, lineId, "repack");
    expect(repack.boxLabelTemplateId).toBe(firstTemplateId);

    const secondTemplateId = await seedTemplate(tenantId, "Second template");
    await setDefaultTemplate(tenantId, secondTemplateId);
    const patched = await agent
      .patch(`/inventories/${repack.id}`)
      .send({ productionDateTo: "2026-09-01" })
      .expect(200);
    expect(patched.body.boxLabelTemplateId).toBe(secondTemplateId);

    const check = await createInventory(agent, activeProductId, lineId, "check");
    expect(check.boxLabelTemplateId).toBeNull();
  });

  it("locks editable state, permits draft/preparing updates, and rejects ready inventory mutations", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);

    await agent
      .patch(`/inventories/${inventory.id}`)
      .send({ productionDateFrom: "2026-08-02", productionDateTo: "2026-08-30" })
      .expect(200);
    await upload(agent, inventory.id, "APPLIED", EMPTY_APPLIED_BYTES).expect(201);
    const preparing = await agent
      .patch(`/inventories/${inventory.id}`)
      .send({ productionDateTo: "2026-08-29" })
      .expect(200);
    expect(preparing.body).toMatchObject({ status: "preparing", productionDateTo: "2026-08-29" });

    await markReady(tenantId, inventory.id);
    await agent
      .patch(`/inventories/${inventory.id}`)
      .send({ productionDateTo: "2026-08-28" })
      .expect(409, { code: "INVENTORY_NOT_EDITABLE" });
    await upload(agent, inventory.id, "INTRODUCED").expect(409, {
      code: "INVENTORY_NOT_EDITABLE",
    });
  });

  it("stores zero-row evidence privately and returns only sanitized successful diagnostics", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);
    const response = await upload(agent, inventory.id, "APPLIED", EMPTY_APPLIED_BYTES).expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      declaredStatus: "APPLIED",
      parsedStatus: "APPLIED",
      result: "succeeded",
      rowCount: 0,
      errorCount: 0,
      duplicateCount: 0,
      sha256: APPLIED_DIGEST,
      diagnostics: [],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/objectKey|fileName|credential|SYNTHETIC/i);

    const [row] = await db
      .select()
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.id, response.body.id as string),
        ),
      );
    expect(row).toMatchObject({
      tenantId,
      inventoryId: inventory.id,
      declaredStatus: "APPLIED",
      parseOutcome: "succeeded",
      rowCount: 0,
      sha256: APPLIED_DIGEST,
    });
    expect(objects.get(row!.objectKey)).toEqual(EMPTY_APPLIED_BYTES);
    expect(row!.objectKey).toContain(
      `tenants/${tenantId}/inventories/${inventory.id}/imports/APPLIED/`,
    );

    const [audit] = await db
      .select({
        organizationId: schema.tenantAuditEvents.organizationId,
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, response.body.id as string),
        ),
      );
    const userId = await actorUserId(tenantId);
    expect(audit).toEqual({
      organizationId: tenantId,
      actorUserId: userId,
      action: "inventory.import.processed",
      outcome: "success",
      targetType: "inventory_import",
      targetId: response.body.id,
      after: {
        tenantId,
        actorUserId: userId,
        inventoryId: inventory.id,
        importId: response.body.id,
        result: "succeeded",
        declaredStatus: "APPLIED",
        parsedStatus: "APPLIED",
        rowCount: 0,
        errorCount: 0,
        duplicateCount: 0,
        sha256: APPLIED_DIGEST,
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/objectKey|fileName|credential|secret/i);
  });

  it("sanitizes status and GTIN parse failures while persisting exact failure audit evidence", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);

    const statusMismatch = await upload(agent, inventory.id, "EMITTED").expect(422);
    expect(statusMismatch.body).toEqual({
      id: expect.any(String),
      declaredStatus: "EMITTED",
      parsedStatus: null,
      result: "failed",
      rowCount: 0,
      errorCount: 1,
      duplicateCount: 0,
      sha256: INTRODUCED_DIGEST,
      diagnostics: [{ code: "CHZ_FILTER_STATUS_MISMATCH", rowNumber: 1 }],
    });
    expect(JSON.stringify(statusMismatch.body)).not.toMatch(/SYNTHETIC|objectKey|fileName|cause/i);

    const [audit] = await db
      .select({
        organizationId: schema.tenantAuditEvents.organizationId,
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, statusMismatch.body.id as string),
        ),
      );
    expect(audit).toEqual({
      organizationId: tenantId,
      actorUserId: await actorUserId(tenantId),
      action: "inventory.import.processed",
      outcome: "failure",
      targetType: "inventory_import",
      targetId: statusMismatch.body.id,
      after: {
        tenantId,
        actorUserId: await actorUserId(tenantId),
        inventoryId: inventory.id,
        importId: statusMismatch.body.id,
        result: "failed",
        declaredStatus: "EMITTED",
        parsedStatus: null,
        rowCount: 0,
        errorCount: 1,
        duplicateCount: 0,
        sha256: INTRODUCED_DIGEST,
        errorCode: "CHZ_FILTER_STATUS_MISMATCH",
        errorRowNumber: 1,
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/SYNTHETIC|objectKey|fileName|credential|secret/i);

    const wrongProductId = await seedProduct(tenantId, {
      gtin14: "04680089900390",
      name: "Different GTIN",
    });
    const wrongInventory = await createInventory(agent, wrongProductId, lineId);
    const gtinMismatch = await upload(agent, wrongInventory.id, "INTRODUCED").expect(422);
    expect(gtinMismatch.body.diagnostics).toEqual([
      { code: "CHZ_FILTER_GTIN_MISMATCH", rowNumber: 1 },
    ]);
  });

  it("deduplicates concurrent same-file requests only within tenant, inventory, and status", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const firstInventory = await createInventory(agent, productId, lineId);
    const secondInventory = await createInventory(agent, productId, lineId);

    const [first, repeated] = await Promise.all([
      upload(agent, firstInventory.id, "INTRODUCED").expect(201),
      upload(agent, firstInventory.id, "INTRODUCED").expect(201),
    ]);
    expect(repeated.body).toEqual(first.body);
    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    const deduplicatedRows = await db
      .select({ id: schema.inventoryImports.id })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, firstInventory.id),
          eq(schema.inventoryImports.declaredStatus, "INTRODUCED"),
          eq(schema.inventoryImports.sha256, INTRODUCED_DIGEST),
        ),
      );
    expect(deduplicatedRows).toHaveLength(1);

    await upload(agent, firstInventory.id, "EMITTED").expect(422);
    await upload(agent, secondInventory.id, "INTRODUCED").expect(201);
    expect(storage.putVerified).toHaveBeenCalledTimes(3);
  });

  it("rejects an oversized multipart file before storage or evidence persistence", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);

    await upload(agent, inventory.id, "INTRODUCED", Buffer.alloc(8 * 1024 * 1024 + 1)).expect(413, {
      message: "File too large",
      error: "Payload Too Large",
      statusCode: 413,
    });
    expect(storage.putVerified).not.toHaveBeenCalled();
    const attempts = await db
      .select({ id: schema.inventoryImports.id })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, inventory.id),
        ),
      );
    expect(attempts).toEqual([]);
  });

  it("removes a newly published object when the database/audit transaction rolls back", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);
    const functionName = `test_inventory_audit_fail_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;

    await setup.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.action = 'inventory.import.processed' and new.organization_id = '${tenantId}' then
          raise exception 'sensitive audit transaction failure';
        end if;
        return new;
      end
      $$
    `);
    await setup.pool.query(
      `create trigger ${triggerName} before insert on tenant_audit_events for each row execute function ${functionName}()`,
    );

    try {
      const response = await upload(agent, inventory.id, "INTRODUCED").expect(500);
      expect(JSON.stringify(response.body)).not.toContain("sensitive audit transaction failure");
      expect(storage.putVerified).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(objects.size).toBe(0);
      const imports = await db
        .select({ id: schema.inventoryImports.id })
        .from(schema.inventoryImports)
        .where(
          and(
            eq(schema.inventoryImports.tenantId, tenantId),
            eq(schema.inventoryImports.inventoryId, inventory.id),
          ),
        );
      expect(imports).toEqual([]);
    } finally {
      await setup.pool.query(`drop trigger ${triggerName} on tenant_audit_events`);
      await setup.pool.query(`drop function ${functionName}()`);
    }
  });
});
