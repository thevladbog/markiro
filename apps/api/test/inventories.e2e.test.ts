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
import { InventoriesService } from "../src/modules/inventories/inventories.service";
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
  boxLabelTemplate: { id: string; name: string } | null;
};

describe.skipIf(!ready)("tenant-admin inventories e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let inventories: InventoriesService;
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
    inventories = app.get(InventoriesService);
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

  function uploadNamed(
    agent: Agent,
    inventoryId: string,
    status: string,
    bytes: Buffer,
    filename: string,
    contentType = "text/csv",
  ) {
    return agent
      .post(`/inventories/${inventoryId}/imports/${status}`)
      .attach("file", bytes, { filename, contentType });
  }

  function upload(agent: Agent, inventoryId: string, status: string, bytes = INTRODUCED_BYTES) {
    const filename = bytes === EMPTY_APPLIED_BYTES ? "applied.csv" : "introduced.csv";
    return uploadNamed(agent, inventoryId, status, bytes, filename);
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
      boxLabelTemplate: null,
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
    expect(repack.boxLabelTemplate).toEqual({ id: firstTemplateId, name: "First template" });
    const repackDetail = await agent.get(`/inventories/${repack.id}`).expect(200);
    expect(repackDetail.body.boxLabelTemplate).toEqual({
      id: firstTemplateId,
      name: "First template",
    });
    const repackList = await agent.get("/inventories").expect(200);
    expect(
      repackList.body.items.find((item: { id: string }) => item.id === repack.id).boxLabelTemplate,
    ).toEqual({ id: firstTemplateId, name: "First template" });

    const secondTemplateId = await seedTemplate(tenantId, "Second template");
    await setDefaultTemplate(tenantId, secondTemplateId);
    const patched = await agent
      .patch(`/inventories/${repack.id}`)
      .send({ productionDateTo: "2026-09-01" })
      .expect(200);
    expect(patched.body.boxLabelTemplateId).toBe(secondTemplateId);
    expect(patched.body.boxLabelTemplate).toEqual({
      id: secondTemplateId,
      name: "Second template",
    });

    await setDefaultTemplate(tenantId, null);
    await agent.delete(`/label-templates/${secondTemplateId}`).expect(409, {
      message:
        "Label template is referenced by an organization default, product, shift, or inventory",
      error: "Conflict",
      statusCode: 409,
    });

    const check = await createInventory(agent, activeProductId, lineId, "check");
    expect(check.boxLabelTemplateId).toBeNull();
    expect(check.boxLabelTemplate).toBeNull();
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
        includedGtin14: FIXTURE_GTIN,
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
      parsedStatus: "INTRODUCED",
      result: "failed",
      rowCount: 0,
      errorCount: 1,
      duplicateCount: 0,
      sha256: INTRODUCED_DIGEST,
      diagnostics: [{ code: "CHZ_FILTER_STATUS_MISMATCH", rowNumber: 1 }],
    });
    expect(JSON.stringify(statusMismatch.body)).not.toMatch(/SYNTHETIC|objectKey|fileName|cause/i);

    const [storedFailure] = await db
      .select({
        parsedStatus: schema.inventoryImports.parsedStatus,
        includedGtin14: schema.inventoryImports.includedGtin14,
      })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.id, statusMismatch.body.id as string),
        ),
      );
    expect(storedFailure).toEqual({
      parsedStatus: "INTRODUCED",
      includedGtin14: FIXTURE_GTIN,
    });

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
        parsedStatus: "INTRODUCED",
        includedGtin14: FIXTURE_GTIN,
        rowCount: 0,
        errorCount: 1,
        duplicateCount: 0,
        sha256: INTRODUCED_DIGEST,
        errorCode: "CHZ_FILTER_STATUS_MISMATCH",
        errorRowNumber: 1,
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/SYNTHETIC|objectKey|fileName|credential|secret/i);

    const repeatedFailure = await upload(agent, inventory.id, "EMITTED").expect(422);
    expect(repeatedFailure.body).toEqual(statusMismatch.body);
    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    const repeatedImports = await db
      .select({ id: schema.inventoryImports.id })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, inventory.id),
          eq(schema.inventoryImports.declaredStatus, "EMITTED"),
          eq(schema.inventoryImports.sha256, INTRODUCED_DIGEST),
        ),
      );
    expect(repeatedImports).toHaveLength(1);
    const repeatedAudits = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.import.processed"),
          eq(schema.tenantAuditEvents.targetId, statusMismatch.body.id as string),
        ),
      );
    expect(repeatedAudits).toHaveLength(1);

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

  it("keeps filter facts null when parsing fails before the filter is decoded", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);
    const bytes = Buffer.from([0xff]);

    const response = await uploadNamed(
      agent,
      inventory.id,
      "INTRODUCED",
      bytes,
      "invalid.csv",
    ).expect(422);
    expect(response.body).toMatchObject({
      parsedStatus: null,
      result: "failed",
      diagnostics: [{ code: "CHZ_INVALID_UTF8" }],
    });
    const [stored] = await db
      .select({
        parsedStatus: schema.inventoryImports.parsedStatus,
        includedGtin14: schema.inventoryImports.includedGtin14,
      })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.id, response.body.id as string),
        ),
      );
    expect(stored).toEqual({ parsedStatus: null, includedGtin14: null });
    const [audit] = await db
      .select({ after: schema.tenantAuditEvents.after })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, response.body.id as string),
        ),
      );
    expect(audit?.after).toMatchObject({ parsedStatus: null, includedGtin14: null });
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

  it("checks digest idempotency before retry filename classification but rejects a new unsupported container", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const priorInventory = await createInventory(agent, productId, lineId);
    const unsupportedInventory = await createInventory(agent, productId, lineId);
    const prior = await upload(agent, priorInventory.id, "INTRODUCED").expect(201);

    const retried = await uploadNamed(
      agent,
      priorInventory.id,
      "INTRODUCED",
      INTRODUCED_BYTES,
      "retry.unsupported",
      "application/octet-stream",
    ).expect(201);
    expect(retried.body).toEqual(prior.body);
    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    const auditsBeforeUnsupported = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.import.processed"),
        ),
      );

    await uploadNamed(
      agent,
      unsupportedInventory.id,
      "INTRODUCED",
      Buffer.from("new unsupported evidence"),
      "new.unsupported",
      "application/octet-stream",
    ).expect(415, { code: "CHZ_UNSUPPORTED_CONTAINER" });
    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    const unsupportedImports = await db
      .select({ id: schema.inventoryImports.id })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, unsupportedInventory.id),
        ),
      );
    expect(unsupportedImports).toEqual([]);
    const unsupportedAudits = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.import.processed"),
        ),
      );
    expect(unsupportedAudits).toEqual(auditsBeforeUnsupported);
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

  it("rejects multipart fields and extra parts before storage or evidence persistence", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);

    await agent
      .post(`/inventories/${inventory.id}/imports/INTRODUCED`)
      .field("unexpected", "value")
      .attach("file", INTRODUCED_BYTES, { filename: "introduced.csv", contentType: "text/csv" })
      .expect(400);
    await agent
      .post(`/inventories/${inventory.id}/imports/INTRODUCED`)
      .attach("file", INTRODUCED_BYTES, { filename: "one.csv", contentType: "text/csv" })
      .attach("file", INTRODUCED_BYTES, { filename: "two.csv", contentType: "text/csv" })
      .expect(400);
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

  it("reconciles a committed deterministic object when transaction acknowledgement is lost", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);
    const userId = await actorUserId(tenantId);
    const realTransaction: Db["transaction"] = db.transaction.bind(db);
    const commitThenThrow: Db["transaction"] = async (callback, config) => {
      if (config === undefined) await realTransaction(callback);
      else await realTransaction(callback, config);
      throw new Error("simulated lost transaction acknowledgement");
    };
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementationOnce(commitThenThrow);

    try {
      const result = await inventories.importEvidence(
        tenantId,
        userId,
        inventory.id,
        "INTRODUCED",
        {
          originalName: "introduced.csv",
          mimeType: "text/csv",
          bytes: INTRODUCED_BYTES,
        },
      );
      expect(result).toMatchObject({ result: "succeeded", sha256: INTRODUCED_DIGEST });
    } finally {
      transactionSpy.mockRestore();
    }

    const expectedKey = `tenants/${tenantId}/inventories/${inventory.id}/imports/INTRODUCED/${INTRODUCED_DIGEST}.csv`;
    expect([...objects.keys()]).toEqual([expectedKey]);
    expect(storage.delete).not.toHaveBeenCalled();
    const retry = await upload(agent, inventory.id, "INTRODUCED").expect(201);
    expect(retry.body.sha256).toBe(INTRODUCED_DIGEST);
    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    expect([...objects.keys()]).toEqual([expectedKey]);
  });

  it("preserves an ambiguous object when reconciliation is unavailable and safely reuses its key", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, productId, lineId } = await seedPreparation(agent);
    const inventory = await createInventory(agent, productId, lineId);
    const expectedKey = `tenants/${tenantId}/inventories/${inventory.id}/imports/INTRODUCED/${INTRODUCED_DIGEST}.csv`;
    const ambiguousError = new Error("simulated ambiguous transaction outcome");
    const realTransaction: Db["transaction"] = db.transaction.bind(db);
    const reconciliationSelectSpy = vi.spyOn(db, "select");
    const rollbackThenLoseReconciliation: Db["transaction"] = async (callback, config) => {
      try {
        if (config === undefined) {
          return await realTransaction(async (tx) => {
            await callback(tx);
            throw ambiguousError;
          });
        }
        return await realTransaction(async (tx) => {
          await callback(tx);
          throw ambiguousError;
        }, config);
      } catch {
        reconciliationSelectSpy.mockImplementationOnce(() => {
          throw new Error("simulated reconciliation read unavailable");
        });
        throw ambiguousError;
      }
    };
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce(rollbackThenLoseReconciliation);

    try {
      const first = await upload(agent, inventory.id, "INTRODUCED").expect(500);
      expect(first.body).toEqual({ statusCode: 500, message: "Internal server error" });
      expect(JSON.stringify(first.body)).not.toMatch(/objectKey|fileName|tenants\//i);
    } finally {
      transactionSpy.mockRestore();
      reconciliationSelectSpy.mockRestore();
    }

    expect(storage.putVerified).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();
    expect([...objects.keys()]).toEqual([expectedKey]);
    const importsBeforeRetry = await db
      .select({ id: schema.inventoryImports.id })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, inventory.id),
          eq(schema.inventoryImports.declaredStatus, "INTRODUCED"),
          eq(schema.inventoryImports.sha256, INTRODUCED_DIGEST),
        ),
      );
    expect(importsBeforeRetry).toEqual([]);
    const auditsBeforeRetry = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.import.processed"),
        ),
      );
    expect(auditsBeforeRetry).toEqual([]);

    const retry = await upload(agent, inventory.id, "INTRODUCED").expect(201);
    expect(retry.body).toMatchObject({
      declaredStatus: "INTRODUCED",
      parsedStatus: "INTRODUCED",
      result: "succeeded",
      sha256: INTRODUCED_DIGEST,
    });
    expect(JSON.stringify(retry.body)).not.toMatch(/objectKey|fileName|tenants\//i);
    expect(storage.putVerified).toHaveBeenCalledTimes(2);
    expect(storage.putVerified.mock.calls.map(([key]) => key)).toEqual([expectedKey, expectedKey]);
    expect(storage.delete).not.toHaveBeenCalled();
    expect([...objects.keys()]).toEqual([expectedKey]);

    const storedImports = await db
      .select({
        id: schema.inventoryImports.id,
        tenantId: schema.inventoryImports.tenantId,
        inventoryId: schema.inventoryImports.inventoryId,
        declaredStatus: schema.inventoryImports.declaredStatus,
        sha256: schema.inventoryImports.sha256,
        objectKey: schema.inventoryImports.objectKey,
      })
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, inventory.id),
          eq(schema.inventoryImports.declaredStatus, "INTRODUCED"),
          eq(schema.inventoryImports.sha256, INTRODUCED_DIGEST),
        ),
      );
    expect(storedImports).toEqual([
      {
        id: retry.body.id,
        tenantId,
        inventoryId: inventory.id,
        declaredStatus: "INTRODUCED",
        sha256: INTRODUCED_DIGEST,
        objectKey: expectedKey,
      },
    ]);
    const audits = await db
      .select({
        targetId: schema.tenantAuditEvents.targetId,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.import.processed"),
          eq(schema.tenantAuditEvents.targetId, retry.body.id as string),
        ),
      );
    expect(audits).toEqual([
      {
        targetId: retry.body.id,
        after: expect.objectContaining({
          tenantId,
          inventoryId: inventory.id,
          importId: retry.body.id,
          result: "succeeded",
          declaredStatus: "INTRODUCED",
          parsedStatus: "INTRODUCED",
          includedGtin14: FIXTURE_GTIN,
          sha256: INTRODUCED_DIGEST,
        }),
      },
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/objectKey|fileName|tenants\//i);
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
