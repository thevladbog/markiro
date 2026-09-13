import { z } from "zod";
import { INVENTORY_CHZ_STATUSES } from "@markiro/domain";
import { fixInventorySnapshotSchema } from "../src/modules/inventories/dto";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DB } from "../src/auth/auth.module";
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

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
afterAll(() => connection.pool.end());
describe.skipIf(!process.env.DATABASE_URL)("public inventory durable owners", () => {
  async function fixture() {
    const db = connection.db;
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 10,
      maxStations: 10,
      maxKiosks: 10,
      maxCabinetUsers: 10,
      publicApiEnabled: true,
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
    await db.insert(schema.entitlementSources).values({
      id: sourceId,
      versionId: sourceId,
      tenantId: managed.tenantId,
      subscriptionId: managed.subscriptionId,
      kind: "compatibility",
      effects: [{ key: "inventory", featureEnabled: true }],
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
        scopes: ["inventory.prepare", "inventory.start", "inventory.read"],
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
      providers: [
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
  it("serializes create replay and persists original API actor after secret deletion", async () => {
    const f = await fixture(),
      key = randomUUID();
    const ctx = await f.requests.prepare(f.principal, "inventory.create", key, f.input);
    const [one, two] = await Promise.all([
      f.inventories.create(f.tenantId, ctx.actor, f.input, ctx),
      f.inventories.create(f.tenantId, ctx.actor, f.input, ctx),
    ]);
    expect(two).toEqual(one);
    const rows = await connection.db
      .select()
      .from(schema.inventories)
      .where(eq(schema.inventories.tenantId, f.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdByUserId: null, createdByPublicKeyId: f.keyId });
    const audits = await connection.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: null,
      action: "inventory.created",
      targetId: one.id,
      outcome: "success",
      after: expect.objectContaining({
        actorDomain: "api_key",
        actorId: f.keyId,
        inventoryId: one.id,
      }),
    });
    await expect(
      f.requests.prepare(f.principal, "inventory.create", key, { ...f.input, mode: "repack" }),
    ).rejects.toBeInstanceOf(ConflictException);
    await connection.db.delete(schema.apikey).where(eq(schema.apikey.id, f.keyId));
    expect(
      await connection.db
        .select()
        .from(schema.publicApiKeyIdentities)
        .where(eq(schema.publicApiKeyIdentities.keyId, f.keyId)),
    ).toHaveLength(1);
    await expect(f.inventories.create(f.tenantId, ctx.actor, f.input, ctx)).rejects.toThrow();
  });
  it("preserves cabinet creation and refuses an API actor without an admitted owner request", async () => {
    const f = await fixture();
    const old = await f.inventories.create(f.tenantId, f.userId, f.input);
    const [row] = await connection.db
      .select()
      .from(schema.inventories)
      .where(eq(schema.inventories.id, old.id));
    expect(row).toMatchObject({ createdByUserId: f.userId, createdByPublicKeyId: null });
    await expect(
      f.inventories.create(f.tenantId, { domain: "api_key", keyId: f.keyId }, f.input),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("rechecks scopes and entitlement at the owner boundary", async () => {
    const f = await fixture();
    const ctx = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
    await connection.db
      .update(schema.apikey)
      .set({ metadata: JSON.stringify({ kind: "public", scopes: [] }) })
      .where(eq(schema.apikey.id, f.keyId));
    await expect(f.inventories.create(f.tenantId, ctx.actor, f.input, ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(
      await connection.db
        .select()
        .from(schema.inventories)
        .where(eq(schema.inventories.tenantId, f.tenantId)),
    ).toHaveLength(0);
  });
  it("binds raw import bytes and keeps exact replay receipt", async () => {
    const f = await fixture();
    const create = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
    const inventory = await f.inventories.create(f.tenantId, create.actor, f.input, create);
    const file = {
      originalName: "introduced.csv",
      mimeType: "text/csv",
      bytes: readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv")),
    };
    const payload = {
      inventoryId: inventory.id,
      declaredStatus: "INTRODUCED",
      originalName: file.originalName,
      mimeType: file.mimeType,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    };
    const ctx = await f.requests.prepare(f.principal, "inventory.import", randomUUID(), payload);
    const first = await f.inventories.importEvidence(
      f.tenantId,
      ctx.actor,
      inventory.id,
      "INTRODUCED",
      file,
      undefined,
      ctx,
    );
    expect(
      await f.inventories.importEvidence(
        f.tenantId,
        ctx.actor,
        inventory.id,
        "INTRODUCED",
        file,
        undefined,
        ctx,
      ),
    ).toEqual(first);
    const [row] = await connection.db
      .select()
      .from(schema.inventoryImports)
      .where(eq(schema.inventoryImports.id, first.id));
    expect(row).toMatchObject({ createdByUserId: null, createdByPublicKeyId: f.keyId });
    expect(f.storage.delete).not.toHaveBeenCalled();
  });
  it("attributes selected imports, frozen snapshot and start to the key with exact retries", async () => {
    const f = await fixture();
    const ctx = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
    const inventory = await f.inventories.create(f.tenantId, ctx.actor, f.input, ctx);
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
      const file = { originalName: `${status}.csv`, mimeType: "text/csv", bytes };
      const request = await f.requests.prepare(f.principal, "inventory.import", randomUUID(), {
        inventoryId: inventory.id,
        declaredStatus: status,
        originalName: file.originalName,
        mimeType: file.mimeType,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const imported = await f.inventories.importEvidence(
        f.tenantId,
        request.actor,
        inventory.id,
        status,
        file,
        undefined,
        request,
      );
      expect(imported.result).toBe("succeeded");
      imports[status] = imported.id;
    }
    const input = fixInventorySnapshotSchema.parse({ imports });
    const fixed = await f.requests.prepare(f.principal, "inventory.snapshot", randomUUID(), {
      inventoryId: inventory.id,
      imports: input.imports,
    });
    const snapshot = await f.inventories.fixSnapshot(
      f.tenantId,
      fixed.actor,
      inventory.id,
      input,
      fixed,
    );
    expect(
      await f.inventories.fixSnapshot(f.tenantId, fixed.actor, inventory.id, input, fixed),
    ).toEqual(snapshot);
    const start = await f.requests.prepare(f.principal, "inventory.start", randomUUID(), {
      inventoryId: inventory.id,
    });
    const manifest = await f.lifecycle.start(f.tenantId, start.actor, inventory.id, start);
    expect(await f.lifecycle.start(f.tenantId, start.actor, inventory.id, start)).toEqual(manifest);
    const [storedSnapshot] = await connection.db
      .select()
      .from(schema.inventorySnapshots)
      .where(eq(schema.inventorySnapshots.id, snapshot.id));
    const [stored] = await connection.db
      .select()
      .from(schema.inventories)
      .where(eq(schema.inventories.id, inventory.id));
    expect(storedSnapshot).toMatchObject({ fixedByUserId: null, fixedByPublicKeyId: f.keyId });
    expect(stored).toMatchObject({
      startedByUserId: null,
      startedByPublicKeyId: f.keyId,
      stationManifest: manifest,
    });
    expect(stored?.startedAt).toBeInstanceOf(Date);
  });
  it("retains completed receipts during scope revocation and commercial downgrade", async () => {
    const f = await fixture();
    const ctx = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
    const result = await f.inventories.create(f.tenantId, ctx.actor, f.input, ctx);
    const metadata = JSON.stringify({ kind: "public", scopes: f.principal.scopes });
    await connection.db
      .update(schema.apikey)
      .set({ metadata: JSON.stringify({ kind: "public", scopes: [] }) })
      .where(eq(schema.apikey.id, f.keyId));
    await expect(f.inventories.create(f.tenantId, ctx.actor, f.input, ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await connection.db
      .update(schema.apikey)
      .set({ metadata })
      .where(eq(schema.apikey.id, f.keyId));
    await connection.db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired" })
      .where(eq(schema.tenantSubscriptions.id, f.subscriptionId));
    await expect(f.inventories.create(f.tenantId, ctx.actor, f.input, ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const receipts = await connection.db
      .select()
      .from(schema.publicApiRequestReceipts)
      .where(eq(schema.publicApiRequestReceipts.tenantId, f.tenantId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ state: "completed", response: result });
    await connection.db
      .update(schema.tenantSubscriptions)
      .set({ status: "active" })
      .where(eq(schema.tenantSubscriptions.id, f.subscriptionId));
    expect(await f.inventories.create(f.tenantId, ctx.actor, f.input, ctx)).toEqual(result);
    expect(
      await connection.db
        .select()
        .from(schema.inventories)
        .where(eq(schema.inventories.tenantId, f.tenantId)),
    ).toHaveLength(1);
  });
  it("recovers an import after commit response loss without deleting or duplicating its object", async () => {
    const f = await fixture();
    const c = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
    const inventory = await f.inventories.create(f.tenantId, c.actor, f.input, c);
    const file = {
      originalName: "introduced.csv",
      mimeType: "text/csv",
      bytes: readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv")),
    };
    const payload = {
      inventoryId: inventory.id,
      declaredStatus: "INTRODUCED",
      originalName: file.originalName,
      mimeType: file.mimeType,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    };
    const ctx = await f.requests.prepare(f.principal, "inventory.import", randomUUID(), payload);
    const put = f.storage.putVerified.getMockImplementation();
    if (!put) throw new Error("Storage mock implementation missing");
    const transact = connection.db.transaction.bind(connection.db);
    let restore: () => void = () => {};
    f.storage.putVerified.mockImplementationOnce(async (...args) => {
      const result = await put(...args);
      const spy = vi
        .spyOn(connection.db, "transaction")
        .mockImplementationOnce(async (work, config) => {
          await transact(work, config);
          throw new Error("lost committed response");
        });
      restore = () => spy.mockRestore();
      return result;
    });
    try {
      const imported = await f.inventories.importEvidence(
        f.tenantId,
        ctx.actor,
        inventory.id,
        "INTRODUCED",
        file,
        undefined,
        ctx,
      );
      expect(imported.result).toBe("succeeded");
      expect(
        await connection.db
          .select()
          .from(schema.inventoryImports)
          .where(eq(schema.inventoryImports.inventoryId, inventory.id)),
      ).toHaveLength(1);
      expect(f.storage.delete).not.toHaveBeenCalled();
      expect(
        (
          await connection.db
            .select()
            .from(schema.publicApiRequestReceipts)
            .where(eq(schema.publicApiRequestReceipts.effectId, ctx.effectId))
        )[0],
      ).toMatchObject({ state: "completed", response: imported });
    } finally {
      restore();
    }
  });
  it("retains a staged pending import on storage failure and retries the same durable effect", async () => {
    const f = await fixture();
    const c = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
    const inventory = await f.inventories.create(f.tenantId, c.actor, f.input, c);
    const file = {
      originalName: "introduced.csv",
      mimeType: "text/csv",
      bytes: readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv")),
    };
    const ctx = await f.requests.prepare(f.principal, "inventory.import", randomUUID(), {
      inventoryId: inventory.id,
      declaredStatus: "INTRODUCED",
      originalName: file.originalName,
      mimeType: file.mimeType,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
    f.storage.putVerified.mockRejectedValueOnce(new Error("storage interrupted"));
    await expect(
      f.inventories.importEvidence(
        f.tenantId,
        ctx.actor,
        inventory.id,
        "INTRODUCED",
        file,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("storage interrupted");
    const [receipt] = await connection.db
      .select()
      .from(schema.publicApiRequestReceipts)
      .where(eq(schema.publicApiRequestReceipts.effectId, ctx.effectId));
    expect(receipt).toMatchObject({ state: "pending", response: null });
    expect(receipt?.stagedObjectKey).toBeTypeOf("string");
    const imported = await f.inventories.importEvidence(
      f.tenantId,
      ctx.actor,
      inventory.id,
      "INTRODUCED",
      file,
      undefined,
      ctx,
    );
    expect(imported.id).toBe(ctx.effectId);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });
  it("rolls back an effect when the key expires during owner work", async () => {
    const f = await fixture();
    const expiresAt = new Date(Date.now() + 60000);
    await connection.db
      .update(schema.apikey)
      .set({ expiresAt })
      .where(eq(schema.apikey.id, f.keyId));
    const ctx = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
    const now = vi.spyOn(Date, "now");
    try {
      await expect(
        connection.db.transaction((tx) =>
          ctx.run(tx, z.object({ done: z.boolean() }).parse, async () => {
            await tx.insert(schema.tenantAuditEvents).values({
              organizationId: f.tenantId,
              actorUserId: null,
              action: "test.public.expiry",
              outcome: "success",
              targetType: "inventory",
              targetId: ctx.effectId,
              after: { actorDomain: "api_key", actorId: f.keyId },
            });
            now.mockReturnValue(expiresAt.getTime() + 1);
            return { done: true };
          }),
        ),
      ).rejects.toThrow();
    } finally {
      now.mockRestore();
    }
    expect(
      await connection.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId)),
    ).toHaveLength(0);
    expect(
      (
        await connection.db
          .select()
          .from(schema.publicApiRequestReceipts)
          .where(eq(schema.publicApiRequestReceipts.effectId, ctx.effectId))
      )[0],
    ).toMatchObject({ state: "pending", response: null });
  });
  it.each(["key", "subscription"] as const)(
    "serializes a concurrent %s revocation behind the admitted effect",
    async (kind) => {
      const f = await fixture();
      const ctx = await f.requests.prepare(f.principal, "inventory.create", randomUUID(), f.input);
      const entered = deferred(),
        release = deferred();
      const work = connection.db.transaction((tx) =>
        ctx.run(tx, z.object({ done: z.boolean() }).parse, async () => {
          entered.resolve();
          await release.promise;
          await tx.insert(schema.tenantAuditEvents).values({
            organizationId: f.tenantId,
            actorUserId: null,
            action: "test.public.race",
            outcome: "success",
            targetType: "inventory",
            targetId: ctx.effectId,
            after: { actorDomain: "api_key", actorId: f.keyId },
          });
          return { done: true };
        }),
      );
      await entered.promise;
      const change =
        kind === "key"
          ? connection.db.delete(schema.apikey).where(eq(schema.apikey.id, f.keyId)).execute()
          : connection.db
              .update(schema.tenantSubscriptions)
              .set({ status: "expired" })
              .where(eq(schema.tenantSubscriptions.id, f.subscriptionId))
              .execute();
      release.resolve();
      expect(await work).toEqual({ done: true });
      await change;
      await expect(ctx.replay(z.object({ done: z.boolean() }).parse)).rejects.toThrow();
      expect(
        (
          await connection.db
            .select()
            .from(schema.publicApiRequestReceipts)
            .where(eq(schema.publicApiRequestReceipts.effectId, ctx.effectId))
        )[0],
      ).toMatchObject({ state: "completed", response: { done: true } });
    },
  );
  it.each(["staged", "committed"] as const)(
    "cabinet failure cleanup cannot delete %s public evidence",
    async (phase) => {
      const f = await fixture();
      const inventory = await f.inventories.create(f.tenantId, f.userId, f.input);
      const file = {
        originalName: "introduced.csv",
        mimeType: "text/csv",
        bytes: readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv")),
      };
      const ctx = await f.requests.prepare(f.principal, "inventory.import", randomUUID(), {
        inventoryId: inventory.id,
        declaredStatus: "INTRODUCED",
        originalName: file.originalName,
        mimeType: file.mimeType,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      });
      const cabinetUploaded = deferred(),
        failCabinet = deferred(),
        publicUploaded = deferred(),
        releasePublic = deferred();
      const put = f.storage.putVerified.getMockImplementation();
      if (!put) throw new Error("Missing put implementation");
      let cabinetKey = "",
        publicKey = "";
      f.storage.putVerified.mockImplementationOnce(async (...args) => {
        cabinetKey = args[0];
        await put(...args);
        cabinetUploaded.resolve();
        await failCabinet.promise;
        throw new Error("cabinet publication interrupted");
      });
      const cabinet = f.inventories.importEvidence(
        f.tenantId,
        f.userId,
        inventory.id,
        "INTRODUCED",
        file,
      );
      const cabinetRejected = expect(cabinet).rejects.toThrow("cabinet publication interrupted");
      await cabinetUploaded.promise;
      f.storage.putVerified.mockImplementationOnce(async (...args) => {
        publicKey = args[0];
        const result = await put(...args);
        publicUploaded.resolve();
        if (phase === "staged") await releasePublic.promise;
        return result;
      });
      const publicWork = f.inventories.importEvidence(
        f.tenantId,
        ctx.actor,
        inventory.id,
        "INTRODUCED",
        file,
        undefined,
        ctx,
      );
      try {
        await publicUploaded.promise;
        if (phase === "committed") await publicWork;
        failCabinet.resolve();
        await cabinetRejected;
        expect(f.storage.delete).toHaveBeenCalledWith(cabinetKey);
        await expect(f.storage.get(publicKey)).resolves.toMatchObject({ body: file.bytes });
        expect(publicKey).not.toBe(cabinetKey);
      } finally {
        failCabinet.resolve();
        releasePublic.resolve();
        await cabinetRejected;
        await publicWork;
      }
      const [row] = await connection.db
        .select()
        .from(schema.inventoryImports)
        .where(eq(schema.inventoryImports.id, ctx.effectId));
      expect(row?.objectKey).toBe(publicKey);
      expect(
        await f.inventories.importEvidence(
          f.tenantId,
          ctx.actor,
          inventory.id,
          "INTRODUCED",
          file,
          undefined,
          ctx,
        ),
      ).toMatchObject({ id: ctx.effectId, result: "succeeded" });
      await expect(f.storage.get(publicKey)).resolves.toMatchObject({ body: file.bytes });
    },
  );
  it.each([false, true])(
    "preserves cabinet winner through failed attempt cleanup, public replay and snapshot (legacy=%s)",
    async (legacy) => {
      const f = await fixture();
      const inventory = await f.inventories.create(f.tenantId, f.userId, f.input);
      const source = readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv"), "utf8");
      const file = {
        originalName: "introduced.csv",
        mimeType: "text/csv",
        bytes: Buffer.from(source),
      };
      const uploaded = deferred(),
        fail = deferred();
      const put = f.storage.putVerified.getMockImplementation();
      if (!put) throw new Error("Missing storage implementation");
      let losingKey = "";
      f.storage.putVerified.mockImplementationOnce(async (...args) => {
        losingKey = args[0];
        await put(...args);
        uploaded.resolve();
        await fail.promise;
        throw new Error("cabinet A failed");
      });
      const losing = expect(
        f.inventories.importEvidence(f.tenantId, f.userId, inventory.id, "INTRODUCED", file),
      ).rejects.toThrow("cabinet A failed");
      await uploaded.promise;
      try {
        const winner = await f.inventories.importEvidence(
          f.tenantId,
          f.userId,
          inventory.id,
          "INTRODUCED",
          file,
        );
        const ctx = await f.requests.prepare(f.principal, "inventory.import", randomUUID(), {
          inventoryId: inventory.id,
          declaredStatus: "INTRODUCED",
          originalName: file.originalName,
          mimeType: file.mimeType,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        });
        const replay = () =>
          f.inventories.importEvidence(
            f.tenantId,
            ctx.actor,
            inventory.id,
            "INTRODUCED",
            file,
            undefined,
            ctx,
          );
        expect(await replay()).toEqual(winner);
        expect(await replay()).toEqual(winner);
        fail.resolve();
        await losing;
        const [row] = await connection.db
          .select()
          .from(schema.inventoryImports)
          .where(eq(schema.inventoryImports.id, winner.id));
        if (!row) throw new Error("Missing winner");
        expect(f.storage.delete).toHaveBeenCalledWith(losingKey);
        await expect(f.storage.get(row.objectKey)).resolves.toMatchObject({ body: file.bytes });
        expect(row.objectKey).not.toBe(losingKey);
        expect(row.createdByUserId).toBe(f.userId);
        expect(row.createdByPublicKeyId).toBeNull();
        expect(await replay()).toEqual(winner);
        const imports: Record<string, string> = { INTRODUCED: winner.id };
        const [filter = "", header = ""] = source.split(/\r?\n/);
        for (const status of INVENTORY_CHZ_STATUSES) {
          if (status === "INTRODUCED") continue;
          const bytes = Buffer.from(
            `${filter.replaceAll("INTRODUCED", status)}\n${header}\nerrors\n5: Коды маркировки не найдены\n`,
          );
          const imported = await f.inventories.importEvidence(
            f.tenantId,
            f.userId,
            inventory.id,
            status,
            { originalName: `${status}.csv`, mimeType: "text/csv", bytes },
          );
          imports[status] = imported.id;
        }
        if (legacy) {
          for (const id of Object.values(imports)) {
            const [stored] = await connection.db
              .select()
              .from(schema.inventoryImports)
              .where(eq(schema.inventoryImports.id, id));
            if (!stored) throw new Error("Missing historical import");
            const key = `tenants/${f.tenantId}/inventories/${inventory.id}/imports/${stored.declaredStatus}/${stored.sha256}.${stored.containerKind}`;
            const object = await f.storage.get(stored.objectKey);
            await put(key, object.body, "text/csv", stored.sha256);
            await connection.db
              .update(schema.inventoryImports)
              .set({ objectKey: key })
              .where(eq(schema.inventoryImports.id, id));
          }
        }
        const input = fixInventorySnapshotSchema.parse({ imports });
        const snapshot = await f.requests.prepare(f.principal, "inventory.snapshot", randomUUID(), {
          inventoryId: inventory.id,
          imports: input.imports,
        });
        await expect(
          f.inventories.fixSnapshot(f.tenantId, snapshot.actor, inventory.id, input, snapshot),
        ).resolves.toMatchObject({ inventoryId: inventory.id });
      } finally {
        fail.resolve();
        await losing;
      }
    },
  );
});
