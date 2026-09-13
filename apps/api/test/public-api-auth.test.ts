import { createHash, randomUUID } from "node:crypto";
import { createDb, schema, type Db } from "@markiro/db";
import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PublicApiAuthService } from "../src/modules/public-api/public-api-auth.service";

const ready = Boolean(process.env.DATABASE_URL);
describe.skipIf(!ready)("public API authentication", () => {
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let auth: PublicApiAuthService;
  beforeAll(() => {
    connection = createDb(process.env.DATABASE_URL!, { max: 1 });
    db = connection.db;
    auth = new PublicApiAuthService(db);
  });
  afterAll(async () => {
    await connection?.pool.end();
  });
  async function key(overrides: Partial<typeof schema.apikey.$inferInsert> = {}) {
    const raw = `mk_${randomUUID()}`;
    const row = {
      id: randomUUID(),
      configId: "public",
      referenceId: randomUUID(),
      key: createHash("sha256").update(raw).digest("base64url"),
      enabled: true,
      metadata: JSON.stringify({ kind: "public", scopes: ["inventory.start"] }),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    await db.insert(schema.apikey).values(row);
    return { raw, row };
  }
  it("authenticates only the public purpose and retains explicit tenant/scopes", async () => {
    const { raw, row } = await key();
    expect(await auth.authenticate(raw)).toEqual({
      kind: "public_api",
      tenantId: row.referenceId,
      keyId: row.id,
      scopes: ["inventory.start"],
    });
  });
  it.each([
    { configId: "station" },
    { enabled: false },
    { expiresAt: new Date(0) },
    { metadata: null },
    { metadata: '{"kind":"station"}' },
    { metadata: '{"kind":"public","scopes":["*"]}' },
    { metadata: '{"kind":"public","scopes":["inventory.start","inventory.start"]}' },
    { metadata: "broken" },
  ])("rejects invalid key state %j", async (overrides) => {
    const { raw } = await key(overrides);
    await expect(auth.authenticate(raw)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it("legacy keys have zero scopes; deleted keys fail", async () => {
    const { raw, row } = await key({ metadata: '{"kind":"public"}' });
    expect((await auth.authenticate(raw)).scopes).toEqual([]);
    await db.delete(schema.apikey).where(eq(schema.apikey.id, row.id));
    await expect(auth.authenticate(raw)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it("locks/revalidates in the caller transaction without consuming another request", async () => {
    const { raw, row } = await key();
    const principal = await auth.authenticate(raw);
    await db.transaction(async (tx) => {
      await auth.assertCurrent(tx, principal, "inventory.start");
    });
    const [current] = await db.select().from(schema.apikey).where(eq(schema.apikey.id, row.id));
    expect(current?.requestCount).toBe(1);
    await expect(
      db.transaction((tx) =>
        auth.assertCurrent(tx, { ...principal, tenantId: randomUUID() }, "inventory.start"),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await db
      .update(schema.apikey)
      .set({ metadata: '{"kind":"public","scopes":[]}' })
      .where(eq(schema.apikey.id, row.id));
    await expect(
      db.transaction((tx) => auth.assertCurrent(tx, principal, "inventory.start")),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("revalidation rejects deletion and expiry after initial authentication", async () => {
    const { raw, row } = await key();
    const principal = await auth.authenticate(raw);
    await db
      .update(schema.apikey)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.apikey.id, row.id));
    await expect(
      db.transaction((tx) => auth.assertCurrent(tx, principal, "inventory.start")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await db.delete(schema.apikey).where(eq(schema.apikey.id, row.id));
    await expect(
      db.transaction((tx) => auth.assertCurrent(tx, principal, "inventory.start")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it("honors finite usage quota and due refill without double-consumption", async () => {
    const { raw, row } = await key({ remaining: 1 });
    const principal = await auth.authenticate(raw);
    await db.transaction((tx) => auth.assertCurrent(tx, principal, "inventory.start"));
    await expect(auth.authenticate(raw)).rejects.toMatchObject({ status: 429 });
    await db
      .update(schema.apikey)
      .set({ refillInterval: 1000, refillAmount: 2, lastRefillAt: new Date(0) })
      .where(eq(schema.apikey.id, row.id));
    await expect(auth.authenticate(raw)).resolves.toMatchObject({ keyId: row.id });
    const [current] = await db.select().from(schema.apikey).where(eq(schema.apikey.id, row.id));
    expect(current?.remaining).toBe(1);
  });
  it("honors tighter persisted limits and longer windows", async () => {
    const { raw, row } = await key({ rateLimitMax: 5, rateLimitTimeWindow: 120_000 });
    for (let i = 0; i < 5; i++) await auth.authenticate(raw);
    await expect(auth.authenticate(raw)).rejects.toMatchObject({ status: 429 });
    await db
      .update(schema.apikey)
      .set({ lastRequest: new Date(Date.now() - 61_000) })
      .where(eq(schema.apikey.id, row.id));
    await expect(auth.authenticate(raw)).rejects.toMatchObject({ status: 429 });
    await db
      .update(schema.apikey)
      .set({ lastRequest: new Date(Date.now() - 121_000) })
      .where(eq(schema.apikey.id, row.id));
    await expect(auth.authenticate(raw)).resolves.toMatchObject({ keyId: row.id });
  });
  it("honors wider persisted limits and shorter windows", async () => {
    const { raw, row } = await key({
      rateLimitMax: 100,
      rateLimitTimeWindow: 30_000,
      requestCount: 60,
      lastRequest: new Date(),
    });
    await expect(auth.authenticate(raw)).resolves.toMatchObject({ keyId: row.id });
    await db
      .update(schema.apikey)
      .set({ requestCount: 100, lastRequest: new Date(Date.now() - 31_000) })
      .where(eq(schema.apikey.id, row.id));
    await expect(auth.authenticate(raw)).resolves.toMatchObject({ keyId: row.id });
    const [current] = await db.select().from(schema.apikey).where(eq(schema.apikey.id, row.id));
    expect(current?.requestCount).toBe(1);
  });
  it("disabled rate limits leave counters unchanged but consume finite usage once", async () => {
    const lastRequest = new Date(Date.now() - 1000);
    const { raw, row } = await key({
      rateLimitEnabled: false,
      requestCount: 100,
      lastRequest,
      remaining: 2,
    });
    const principal = await auth.authenticate(raw);
    const [authenticated] = await db
      .select()
      .from(schema.apikey)
      .where(eq(schema.apikey.id, row.id));
    expect(authenticated).toMatchObject({ requestCount: 100, remaining: 1 });
    expect(authenticated?.lastRequest?.getTime()).toBeGreaterThan(lastRequest.getTime());
    await db.transaction((tx) => auth.assertCurrent(tx, principal, "inventory.start"));
    const [revalidated] = await db.select().from(schema.apikey).where(eq(schema.apikey.id, row.id));
    expect(revalidated).toEqual(authenticated);
    await auth.authenticate(raw);
    await expect(auth.authenticate(raw)).rejects.toMatchObject({ status: 429 });
  });
  it.each([{ rateLimitMax: null }, { rateLimitTimeWindow: null }])(
    "preserves plugin null-policy skip semantics %j",
    async (overrides) => {
      const lastRequest = new Date();
      const { raw, row } = await key({ ...overrides, requestCount: 100, lastRequest });
      await expect(auth.authenticate(raw)).resolves.toMatchObject({ keyId: row.id });
      const [current] = await db.select().from(schema.apikey).where(eq(schema.apikey.id, row.id));
      expect(current).toMatchObject({ requestCount: 100, lastRequest });
    },
  );
  it.each([
    { rateLimitMax: 0 },
    { rateLimitMax: -1 },
    { rateLimitTimeWindow: 0 },
    { rateLimitTimeWindow: -1 },
    { requestCount: -1 },
  ])("invalid active policy fails closed %j", async (overrides) => {
    const { raw } = await key(overrides);
    await expect(auth.authenticate(raw)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it("enforces the issued public default of 60 requests and resets after inactivity", async () => {
    const { raw, row } = await key({ rateLimitMax: 60, rateLimitTimeWindow: 60_000 });
    for (let i = 0; i < 60; i++) await auth.authenticate(raw);
    await expect(auth.authenticate(raw)).rejects.toMatchObject({ status: 429 });
    await db
      .update(schema.apikey)
      .set({ lastRequest: new Date(Date.now() - 61_000) })
      .where(eq(schema.apikey.id, row.id));
    await expect(auth.authenticate(raw)).resolves.toMatchObject({ keyId: row.id });
  });
});

it("database outage remains unavailable", async () => {
  const db = {
    transaction: vi.fn().mockRejectedValue(new Error("connection unavailable")),
  } as unknown as Db;
  await expect(new PublicApiAuthService(db).authenticate("mk_test")).rejects.toBeInstanceOf(
    ServiceUnavailableException,
  );
});

import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { PublicApiGuard, RequirePublicApiScope } from "../src/modules/public-api/public-api.guard";
import type { RequestWithPublicApiPrincipal } from "../src/modules/public-api/public-api.types";

class PublicTestController {
  @RequirePublicApiScope("inventory.start")
  start() {}
  undeclared() {}
}
function contextFor(headers: Record<string, string>, declared = true) {
  const req = { headers } as RequestWithPublicApiPrincipal;
  const context = {
    getHandler: () =>
      declared ? PublicTestController.prototype.start : PublicTestController.prototype.undeclared,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { req, context };
}
describe("public API guard", () => {
  const principal = {
    kind: "public_api" as const,
    tenantId: "tenant",
    keyId: "key",
    scopes: ["inventory.start" as const],
  };
  it("accepts explicit public key only and stores verified principal", async () => {
    const authenticate = vi.fn().mockResolvedValue(principal);
    const guard = new PublicApiGuard(
      { authenticate } as unknown as PublicApiAuthService,
      new Reflector(),
    );
    const { req, context } = contextFor({ "x-api-key": "mk_public" });
    expect(await guard.canActivate(context)).toBe(true);
    expect(req.publicApiPrincipal).toEqual(principal);
    expect(authenticate).toHaveBeenCalledExactlyOnceWith("mk_public");
  });
  it.each([{ cookie: "session=cabinet" }, { authorization: "Bearer kiosk" }, {}])(
    "never falls back to other credentials %j",
    async (headers) => {
      const authenticate = vi.fn();
      const guard = new PublicApiGuard(
        { authenticate } as unknown as PublicApiAuthService,
        new Reflector(),
      );
      await expect(guard.canActivate(contextFor(headers).context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(authenticate).not.toHaveBeenCalled();
    },
  );
  it("fails closed for undeclared scope and zero-scope keys", async () => {
    const authenticate = vi.fn().mockResolvedValue({ ...principal, scopes: [] });
    const guard = new PublicApiGuard(
      { authenticate } as unknown as PublicApiAuthService,
      new Reflector(),
    );
    await expect(
      guard.canActivate(contextFor({ "x-api-key": "mk_public" }, false).context),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authenticate).not.toHaveBeenCalled();
    const { req, context } = contextFor({ "x-api-key": "mk_public" });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(req.publicApiPrincipal).toBeUndefined();
  });
});
