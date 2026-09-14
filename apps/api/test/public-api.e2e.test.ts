import { TenantGuard } from "../src/tenancy/tenant.guard";
import { StationOnlyGuard } from "../src/tenancy/station-only.guard";
import { SubscriptionAccessGuard } from "../src/subscriptions/subscription-access.guard";
import { SUBSCRIPTION_ENFORCEMENT_MODE } from "../src/subscriptions/entitlements.service";
import { StationInventoriesController } from "../src/modules/inventories/station-inventories.controller";
import { StationInventoryAccessService } from "../src/modules/inventories/station-inventory-access.service";
import { StationInventoryBundleService } from "../src/modules/inventories/station-inventory-bundle.service";
import { StationInventorySyncService } from "../src/modules/inventories/station-inventory-sync.service";
import { SsccService } from "../src/modules/sscc/sscc.service";
import request from "supertest";
import { listenOnLoopback } from "./support/listen-loopback";
import type { INestApplication } from "@nestjs/common";
import { PublicProductsController } from "../src/modules/public-api/public-products.controller";
import { PublicInventoriesController } from "../src/modules/public-api/public-inventories.controller";
import { PublicApiReadService } from "../src/modules/public-api/public-api-read.service";
import { PublicApiGuard } from "../src/modules/public-api/public-api.guard";
import { InventoryReconciliationService } from "../src/modules/inventories/inventory-reconciliation.service";
import { INVENTORY_CHZ_STATUSES } from "@markiro/domain";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AUTH, DB } from "../src/auth/auth.module";
import { InventoriesService } from "../src/modules/inventories/inventories.service";
import { InventorySnapshotService } from "../src/modules/inventories/inventory-snapshot.service";
import { InventoryLifecycleService } from "../src/modules/inventories/inventory-lifecycle.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { EntitlementAdmissionService } from "../src/subscriptions/entitlement-admission.service";
import { PublicApiAuthService } from "../src/modules/public-api/public-api-auth.service";
import { PublicApiAdmissionService } from "../src/modules/public-api/public-api-admission.service";
import { PublicApiRequestService } from "../src/modules/public-api/public-api-request.service";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const apps: INestApplication[] = [];
afterAll(async () => {
  for (const app of apps) await app.close();
  await connection.pool.end();
});
describe.skipIf(!process.env.DATABASE_URL)("public API HTTP", () => {
  async function fixture(options: { publicApi?: boolean; inventory?: true | "unknown" } = {}) {
    const db = connection.db;
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 10,
      maxStations: 10,
      maxKiosks: 10,
      maxCabinetUsers: 10,
      publicApiEnabled: options.publicApi ?? true,
    });
    const managed = await createManagedSubscription(db, { planVersionId });
    const userId = randomUUID();
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Original cabinet", email: `${userId}@example.invalid` });
    const platformUserId = randomUUID();
    await db.insert(schema.platformUsers).values({
      id: platformUserId,
      email: `${platformUserId}@example.invalid`,
      name: "Public fixture",
      role: "platform_admin",
      status: "active",
    });
    const sourceId = randomUUID();
    if (options.inventory !== "unknown")
      await db.insert(schema.entitlementSources).values({
        id: sourceId,
        versionId: sourceId,
        tenantId: managed.tenantId,
        subscriptionId: managed.subscriptionId,
        kind: "compatibility",
        effects: [{ key: "inventory", featureEnabled: options.inventory ?? true }],
        operationIds: [
          "public.inventory.read.v1",
          "public.inventory.create.v1",
          "public.inventory.import.v1",
          "public.inventory.snapshot.v1",
          "public.inventory.start.v1",
        ],
        startsAt: new Date(Date.now() - 60000),
        endsAt: new Date(Date.now() + 600000),
        reason: "Public fixture",
        decisionReference: "TEST",
        requestId: randomUUID(),
        createdByPlatformUserId: platformUserId,
      });
    const keyId = randomUUID(),
      raw = randomUUID();
    await db.insert(schema.apikey).values({
      id: keyId,
      referenceId: managed.tenantId,
      configId: "public",
      key: createHash("sha256").update(raw).digest("base64url"),
      enabled: true,
      rateLimitEnabled: false,
      metadata: JSON.stringify({
        kind: "public",
        scopes: ["catalog.products.read", "inventory.prepare", "inventory.start", "inventory.read"],
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const productId = randomUUID(),
      lineId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: managed.tenantId,
      gtin14: "04680089900383",
      name: "Public product",
      boxCapacity: 12,
      status: "active",
    });
    await db
      .insert(schema.lines)
      .values({ id: lineId, tenantId: managed.tenantId, name: "Public line" });
    const objects = new Map<string, Buffer>();
    const storage = {
      putVerified: vi.fn(async (key: string, bytes: Buffer, _mime: string, sha256: string) => {
        objects.set(key, Buffer.from(bytes));
        return { byteSize: bytes.length, sha256 };
      }),
      get: vi.fn(async (key: string) => {
        const body = objects.get(key);
        if (!body) throw new Error("Missing object");
        return { body, contentType: "text/csv" };
      }),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
    };
    const entitlements = new EntitlementsService(db, "managed_only");
    const module = await Test.createTestingModule({
      controllers: [
        PublicProductsController,
        PublicInventoriesController,
        StationInventoriesController,
      ],
      providers: [
        TenantGuard,
        StationOnlyGuard,
        SubscriptionAccessGuard,
        StationInventoryAccessService,
        StationInventoryBundleService,
        { provide: AUTH, useValue: { api: { getSession: async () => null } } },
        { provide: SUBSCRIPTION_ENFORCEMENT_MODE, useValue: "managed_only" },
        { provide: StationInventorySyncService, useValue: {} },
        { provide: SsccService, useValue: {} },
        PublicApiGuard,
        PublicApiReadService,
        InventoryReconciliationService,
        { provide: DB, useValue: db },
        { provide: ObjectStorageService, useValue: storage },
        { provide: EntitlementsService, useValue: entitlements },
        EntitlementAdmissionService,
        InventorySnapshotService,
        InventoriesService,
        InventoryLifecycleService,
        PublicApiAuthService,
        PublicApiAdmissionService,
        PublicApiRequestService,
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    apps.push(app);
    await listenOnLoopback(app);
    const principal = await module.get(PublicApiAuthService).authenticate(raw);
    const input = {
      productId,
      lineId,
      mode: "check" as const,
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplateId: null,
    };
    return {
      ...managed,
      app,
      raw,
      productId,
      lineId,
      userId,
      keyId,
      sourceId,
      principal,
      input,
      storage,
      requests: module.get(PublicApiRequestService),
      inventories: module.get(InventoriesService),
      lifecycle: module.get(InventoryLifecycleService),
    };
  }

  it("prepares and starts inventory over HTTP without a cabinet cookie", async () => {
    const f = await fixture();
    const http = request(f.app.getHttpServer());
    await http.get("/public/v1/products").set("x-api-key", f.raw).expect(200);
    const create = () =>
      http
        .post("/public/v1/inventories")
        .set("x-api-key", f.raw)
        .set("Idempotency-Key", "create-1")
        .send(f.input);
    const created = await create().expect(201);
    expect((await create().expect(201)).body).toEqual(created.body);
    const id = created.body.id as string;
    const source = readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv"), "utf8");
    const [filter = "", header = ""] = source.split(/\r?\n/);
    const imports: Record<string, string> = {};
    for (const status of INVENTORY_CHZ_STATUSES) {
      const bytes =
        status === "INTRODUCED"
          ? Buffer.from(source)
          : Buffer.from(
              `${filter.replaceAll("INTRODUCED", status)}\n${header}\nerrors\n5: Коды маркировки не найдены\n`,
            );
      const imported = await http
        .post(`/public/v1/inventories/${id}/imports/${status}`)
        .set("x-api-key", f.raw)
        .set("Idempotency-Key", status)
        .attach("file", bytes, { filename: `${status}.csv`, contentType: "text/csv" })
        .expect(201);
      imports[status] = imported.body.id;
    }
    const fixed = await http
      .post(`/public/v1/inventories/${id}/snapshots`)
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "fix-1")
      .send({ imports })
      .expect(201);
    expect(fixed.body).toMatchObject({ inventoryId: id });
    const start = () =>
      http
        .post(`/public/v1/inventories/${id}/start`)
        .set("x-api-key", f.raw)
        .set("Idempotency-Key", "start-1")
        .send({});
    const started = await start().expect(201);
    expect((await start().expect(201)).body).toEqual(started.body);
    expect(started.body).toEqual({ inventoryId: id, snapshotId: fixed.body.id, status: "running" });
    const detail = await http
      .get(`/public/v1/inventories/${id}`)
      .set("x-api-key", f.raw)
      .expect(200);
    expect(detail.body.status).toBe("running");
    const progress = await http
      .get(`/public/v1/inventories/${id}/progress`)
      .set("x-api-key", f.raw)
      .expect(200);
    expect(progress.body.inventoryId).toBe(id);
    const results = await http
      .get(`/public/v1/inventories/${id}/results`)
      .set("x-api-key", f.raw)
      .expect(200);
    expect(results.body.items).toEqual([]);
    const deviceId = randomUUID(),
      operatorId = randomUUID(),
      stationKeyId = randomUUID(),
      stationRaw = randomUUID();
    await connection.db.insert(schema.apikey).values({
      id: stationKeyId,
      referenceId: f.tenantId,
      configId: "station",
      key: createHash("sha256").update(stationRaw).digest("base64url"),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await connection.db.insert(schema.stationDevices).values({
      id: deviceId,
      tenantId: f.tenantId,
      name: "Native private device",
      lineId: f.input.lineId,
      apiKeyId: stationKeyId,
    });
    await connection.db
      .insert(schema.employees)
      .values({ id: operatorId, tenantId: f.tenantId, fullName: "Private operator" });
    await connection.db.insert(schema.inventoryScanBatches).values({
      tenantId: f.tenantId,
      inventoryId: id,
      deviceId,
      batchId: "public-results",
      payloadDigest: "a".repeat(64),
      sequenceCeiling: 2n,
      outcome: "applied",
      result: {},
    });
    const events = [randomUUID(), randomUUID()];
    await connection.db.insert(schema.inventoryScanEvents).values(
      events.map((eventId, index) => ({
        eventId,
        tenantId: f.tenantId,
        inventoryId: id,
        deviceId,
        operatorId,
        batchId: "public-results",
        deviceSequence: BigInt(index + 1),
        scannedAt: new Date(1720000000000 + index),
        kind: "old_box" as const,
        normalizedIdentity: `old_box:04600000000000001${index}`,
        rawPayload: `04600000000000001${index}`,
        snapshotRevision: 1,
        localVerdict: "old_box",
        authoritativeVerdict: "old_box",
      })),
    );
    const page1 = await http
      .get(`/public/v1/inventories/${id}/results?limit=1`)
      .set("x-api-key", f.raw)
      .expect(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTypeOf("string");
    const cursor = encodeURIComponent(page1.body.nextCursor);
    const page2 = await http
      .get(`/public/v1/inventories/${id}/results?limit=1&cursor=${cursor}`)
      .set("x-api-key", f.raw)
      .expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].eventId).not.toBe(page1.body.items[0].eventId);
    expect(page2.body.nextCursor).toBeNull();
    expect(JSON.stringify([page1.body, page2.body])).not.toMatch(
      /Private|operator|deviceId|terminal|rawPayload|tenantId|actions|credential/i,
    );
    for (const suffix of [
      `?cursor=invalid`,
      `?limit=2&cursor=${cursor}`,
      `?limit=1&classification=unknown&cursor=${cursor}`,
    ])
      await http
        .get(`/public/v1/inventories/${id}/results${suffix}`)
        .set("x-api-key", f.raw)
        .expect(400);
    await http
      .get(`/public/v1/inventories/${randomUUID()}/results?limit=1&cursor=${cursor}`)
      .set("x-api-key", f.raw)
      .expect(400);
    const other = await fixture();
    await http
      .get(`/public/v1/inventories/${id}/results?limit=1&cursor=${cursor}`)
      .set("x-api-key", other.raw)
      .expect(400);
    await http.get(`/public/v1/inventories/${id}`).set("x-api-key", other.raw).expect(404);
    await http.get(`/public/v1/products/${f.productId}`).set("x-api-key", other.raw).expect(404);
    await http.get("/public/v1/products").set("x-api-key", stationRaw).expect(401);
    await http.get("/station/inventory-tasks").set("x-api-key", f.raw).expect(401);
    const downgradedPlan = await createPublishedPlan(connection.db, {
      maxLines: 10,
      maxStations: 10,
      maxKiosks: 10,
      maxCabinetUsers: 10,
      publicApiEnabled: false,
    });
    await connection.db
      .update(schema.tenantSubscriptions)
      .set({ planVersionId: downgradedPlan })
      .where(eq(schema.tenantSubscriptions.id, f.subscriptionId));
    await http.get(`/public/v1/inventories/${id}`).set("x-api-key", f.raw).expect(403);
    const native = await http
      .get("/station/inventory-tasks")
      .set("x-api-key", stationRaw)
      .expect(200);
    expect(native.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ inventoryId: id })]),
    );

    expect(
      JSON.stringify([
        created.body,
        fixed.body,
        started.body,
        detail.body,
        progress.body,
        results.body,
      ]),
    ).not.toMatch(
      /operator|credential|pin|badge|objectKey|rawPayload|stationManifest|labelTemplate|tenantId|deviceId/i,
    );
    const audits = await connection.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId));
    expect(audits.find((x) => x.action === "inventory.created")).toMatchObject({
      actorUserId: null,
      targetId: id,
      outcome: "success",
      after: expect.objectContaining({ actorDomain: "api_key", actorId: f.keyId }),
    });
  });
  it("requires a public credential, explicit scopes and stable idempotency payloads", async () => {
    const f = await fixture();
    const http = request(f.app.getHttpServer());
    await http.get("/public/v1/products").expect(401);
    await http.get("/public/v1/products").set("Cookie", "untrusted=cabinet").expect(401);
    await http.post("/public/v1/inventories").set("x-api-key", f.raw).send(f.input).expect(400);
    await http
      .post("/public/v1/inventories")
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "x".repeat(201))
      .send(f.input)
      .expect(400);
    const created = await http
      .post("/public/v1/inventories")
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "same")
      .send(f.input)
      .expect(201);
    await http
      .post("/public/v1/inventories")
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "same")
      .send({ ...f.input, mode: "repack" })
      .expect(409);
    await http
      .post("/public/v1/inventories")
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "actor")
      .send({ ...f.input, tenantId: f.tenantId, actor: { domain: "cabinet", userId: f.userId } })
      .expect(400);
    await http
      .post(`/public/v1/inventories/${created.body.id}/start`)
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "start")
      .send({ actor: "injected" })
      .expect(400);

    const source = readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv"));
    const badImport = () =>
      http
        .post(`/public/v1/inventories/${created.body.id}/imports/EMITTED`)
        .set("x-api-key", f.raw)
        .set("Idempotency-Key", "bad-source")
        .attach("file", source, { filename: "source.csv", contentType: "text/csv" });
    const failed = await badImport().expect(422);
    expect((await badImport().expect(422)).body).toEqual(failed.body);
    expect(failed.body.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CHZ_FILTER_STATUS_MISMATCH" })]),
    );
    expect(JSON.stringify(failed.body)).not.toMatch(/objectKey|tenantId|actor|rawPayload/);
    await http
      .post(`/public/v1/inventories/${created.body.id}/imports/INTRODUCED`)
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "extra-part")
      .field("tenantId", f.tenantId)
      .attach("file", source, { filename: "source.csv", contentType: "text/csv" })
      .expect(400);
    const draftId = randomUUID();
    await connection.db.insert(schema.products).values({
      id: draftId,
      tenantId: f.tenantId,
      gtin14: "04680089900390",
      name: "Public draft",
      status: "draft",
      boxCapacity: null,
    });
    const draft = await http
      .get(`/public/v1/products/${draftId}`)
      .set("x-api-key", f.raw)
      .expect(200);
    expect(draft.body.boxCapacity).toBeNull();
    await connection.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, draftId));
    await http.get(`/public/v1/products/${draftId}`).set("x-api-key", f.raw).expect(404);
    const products = await http
      .get("/public/v1/products?search=Public&status=active")
      .set("x-api-key", f.raw)
      .expect(200);
    expect(products.body.items.map((item: { id: string }) => item.id)).toEqual([f.productId]);
    const all = ["catalog.products.read", "inventory.read", "inventory.prepare", "inventory.start"];
    for (const scope of all) {
      await connection.db
        .update(schema.apikey)
        .set({
          metadata: JSON.stringify({ kind: "public", scopes: all.filter((x) => x !== scope) }),
        })
        .where(eq(schema.apikey.id, f.keyId));
      const path =
        scope === "catalog.products.read"
          ? "/public/v1/products"
          : scope === "inventory.read"
            ? "/public/v1/inventories"
            : scope === "inventory.prepare"
              ? "/public/v1/inventories"
              : `/public/v1/inventories/${created.body.id}/start`;
      const call = scope.endsWith("read")
        ? http.get(path)
        : http
            .post(path)
            .set("Idempotency-Key", "scope")
            .send(scope === "inventory.prepare" ? f.input : {});
      await call.set("x-api-key", f.raw).expect(403);
    }
    await connection.db
      .update(schema.apikey)
      .set({ metadata: JSON.stringify({ kind: "public", scopes: [] }) })
      .where(eq(schema.apikey.id, f.keyId));
    await http
      .post("/public/v1/inventories")
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "same")
      .send(f.input)
      .expect(403);
    await connection.db
      .update(schema.apikey)
      .set({ metadata: JSON.stringify({ kind: "public", scopes: all }) })
      .where(eq(schema.apikey.id, f.keyId));
    expect(
      (
        await http
          .post("/public/v1/inventories")
          .set("x-api-key", f.raw)
          .set("Idempotency-Key", "same")
          .send(f.input)
          .expect(201)
      ).body,
    ).toEqual(created.body);
    for (const kind of ["station", "kiosk", "handheld", "signer"]) {
      const raw = randomUUID();
      await connection.db.insert(schema.apikey).values({
        id: randomUUID(),
        referenceId: f.tenantId,
        configId: kind,
        key: createHash("sha256").update(raw).digest("base64url"),
        metadata: JSON.stringify({ kind, scopes: all }),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await http.get("/public/v1/products").set("x-api-key", raw).expect(401);
    }
  });
  it.each([
    { publicApi: false, inventory: true as const },
    { publicApi: true, inventory: "unknown" as const },
  ])("enforces public and inventory modules on reads and mutations %j", async (options) => {
    const f = await fixture(options);
    const http = request(f.app.getHttpServer());
    await http.get("/public/v1/inventories").set("x-api-key", f.raw).expect(403);
    await http
      .post("/public/v1/inventories")
      .set("x-api-key", f.raw)
      .set("Idempotency-Key", "denied")
      .send(f.input)
      .expect(403);
    await http
      .get("/public/v1/products")
      .set("x-api-key", f.raw)
      .expect(options.publicApi ? 200 : 403);
    expect(
      await connection.db
        .select()
        .from(schema.inventories)
        .where(eq(schema.inventories.tenantId, f.tenantId)),
    ).toHaveLength(0);
  });
});
