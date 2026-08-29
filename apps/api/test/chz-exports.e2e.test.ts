import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";
import type { InventoryChzStatus } from "@markiro/domain";

import { AppModule } from "../src/app.module";
import { DB } from "../src/auth/auth.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { TrueApiClient } from "../src/modules/chz-exports/true-api.client";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.BETTER_AUTH_SECRET &&
  process.env.BETTER_AUTH_URL &&
  process.env.CHZ_TOKEN_ENCRYPTION_KEY,
);

const FIXTURE_GTIN = "04680089900383";

type Agent = ReturnType<typeof request.agent>;

/**
 * Stands in for the real `TrueApiClient` in this suite. `ChzExportsService.order`
 * enqueues the real `run-chz-export` job onto the real `PgBossService` this
 * suite boots (`AppModule.forRoot`), so without this override the real
 * runner would fire real HTTPS requests -- carrying the fixture's fake
 * bearer token -- at ЧЗ's production `true-api` host the moment a worker
 * picks up an order. Every method answers `unavailable` (the client's own
 * "transient, try again later" outcome), which is enough to exercise the
 * ordering flow (a run simply stays `queued`) without ever reaching for a
 * network call.
 */
function fakeTrueApiClient(): TrueApiClient {
  return {
    createDispenserTask: async () => ({ status: "unavailable" as const }),
    listDispenserTasks: async () => ({ status: "unavailable" as const }),
    listDispenserResults: async () => ({ status: "unavailable" as const }),
    downloadDispenserResult: async () => ({ status: "unavailable" as const }),
  } as unknown as TrueApiClient;
}

describe.skipIf(!ready)("chz-exports cabinet e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let crypto: ChzCryptoService;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const seededTenantIds: string[] = [];

  beforeAll(async () => {
    // Positive proof that no code path in this suite reaches the real
    // network -- not just that the override below exists, but that nothing
    // ever calls through to it. `TrueApiClient`'s production dependencies
    // bind `globalThis.fetch`, so this is the one choke point every possible
    // outbound request from this app instance would have to pass through.
    fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    })
      // `TrueApiClient` is registered in both `ChzExportsModule` (the cabinet
      // HTTP surface) and `JobsModule` (the `run-chz-export` worker); this
      // override applies to the whole compiled module tree, not just one
      // import site, so both get the fake.
      .overrideProvider(TrueApiClient)
      .useValue(fakeTrueApiClient())
      .compile();

    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    db = ref.get(DB);
    crypto = new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY);
  });

  afterAll(async () => {
    // Rows this suite orders (via the fake client above) stay non-terminal
    // forever -- `unavailable` never advances a run. Postgres is shared
    // across every e2e test file (`fileParallelism: false`, one database),
    // and every other file's own `AppModule.forRoot` boot runs
    // `PgBossService`'s `reconcileUnfinishedChzExports`, which re-enqueues
    // *any* non-terminal `chz_export_runs` row against the *real*
    // `TrueApiClient` those files don't override. Leaving these rows behind
    // would reopen exactly the production-traffic exposure this override
    // exists to close, just from a different file's boot. Cleaned up before
    // `app.close()` tears down the DB pool this `db` handle uses.
    if (seededTenantIds.length > 0) {
      await db
        .delete(schema.chzExportRuns)
        .where(inArray(schema.chzExportRuns.tenantId, seededTenantIds));
    }
    await app?.close();
    // Not just "no longer flakes": a real request would have to pass through
    // this exact spy, so a zero call count is direct proof nothing escaped.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  async function seedInventory(agent: Agent): Promise<{ tenantId: string; inventoryId: string }> {
    const tenantId = await signUpAndActivate(agent);
    seededTenantIds.push(tenantId);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: FIXTURE_GTIN,
      name: "ChZ export fixture product",
      status: "active",
    });
    const lineId = randomUUID();
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "ChZ export fixture line" });

    const created = await agent
      .post("/inventories")
      .send({
        productId,
        lineId,
        mode: "check",
        productionDateFrom: "2026-08-01",
        productionDateTo: "2026-08-31",
      })
      .expect(201);
    return { tenantId, inventoryId: (created.body as { id: string }).id };
  }

  /**
   * Satisfies every pre-flight condition: a valid INN, a ChZ product group
   * code on the inventory's product, a paired signer agent and a decryptable
   * True API token. Mirrors ChzExportsService's own unit-test fixture in
   * `chz-exports.service.test.ts`.
   */
  async function satisfyPreflight(tenantId: string, inventoryId: string): Promise<void> {
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, inn: "7707083893" })
      .onConflictDoUpdate({
        target: schema.orgProfiles.tenantId,
        set: { inn: "7707083893", updatedAt: new Date() },
      });
    const [inventory] = await db
      .select({ productId: schema.inventories.productId })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    if (!inventory) throw new Error("Expected inventory fixture");
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: 1 })
      .where(eq(schema.products.id, inventory.productId));
    await db.insert(schema.chzSignerAgents).values({
      tenantId,
      name: "Export fixture agent",
      secretHash: `hash-${randomUUID()}`,
    });
    const encrypted = crypto.encrypt(tenantId, "the-bearer-token");
    await db.insert(schema.chzApiTokens).values({
      tenantId,
      ...encrypted,
      obtainedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }

  /** Marks the run for `status` as failed, the only state `retry` accepts. */
  async function failRun(
    tenantId: string,
    inventoryId: string,
    status: InventoryChzStatus,
  ): Promise<void> {
    await db
      .update(schema.chzExportRuns)
      .set({
        state: "failed",
        errorCode: "CHZ_TASK_FAILED",
        errorMessage: "boom",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chzExportRuns.tenantId, tenantId),
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, status),
        ),
      );
  }

  it("reports the pre-flight blockers instead of ordering", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedInventory(agent);

    const res = await agent.get(`/inventories/${inventoryId}/chz-exports`).expect(200);
    expect(res.body.available).toBe(false);
    expect(res.body.blockedBy).toContain("TOKEN_UNAVAILABLE");
    expect(res.body.runs).toEqual([]);
  });

  it("refuses to order while blocked", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedInventory(agent);

    await agent.post(`/inventories/${inventoryId}/chz-exports`).send({}).expect(422);
  });

  it("orders six runs once every pre-flight condition holds", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, inventoryId } = await seedInventory(agent);

    await satisfyPreflight(tenantId, inventoryId);
    const res = await agent.post(`/inventories/${inventoryId}/chz-exports`).send({}).expect(201);
    expect(res.body.runs).toHaveLength(6);
  });

  it("retries only the named status", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { tenantId, inventoryId } = await seedInventory(agent);

    await satisfyPreflight(tenantId, inventoryId);
    await agent.post(`/inventories/${inventoryId}/chz-exports`).send({}).expect(201);
    await failRun(tenantId, inventoryId, "RETIRED");
    const res = await agent
      .post(`/inventories/${inventoryId}/chz-exports/retry`)
      .send({ status: "RETIRED" })
      .expect(200);
    const retired = res.body.runs.find((run: { status: string }) => run.status === "RETIRED");
    expect(retired).toMatchObject({ state: "queued" });
  });

  it("rejects an unknown status", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedInventory(agent);

    await agent
      .post(`/inventories/${inventoryId}/chz-exports/retry`)
      .send({ status: "NOPE" })
      .expect(400);
  });

  it("requires a cabinet session", async () => {
    const agent = request.agent(app!.getHttpServer());
    const { inventoryId } = await seedInventory(agent);

    await request(app!.getHttpServer()).get(`/inventories/${inventoryId}/chz-exports`).expect(401);
  });
});
