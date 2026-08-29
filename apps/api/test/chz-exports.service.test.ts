import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { ChzExportsService } from "../src/modules/chz-exports/chz-exports.service";
import type { PgBossService } from "../src/jobs/jobs.module";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);
const GTIN = "04600000000015";

describe.skipIf(!ready)("ChzExportsService", () => {
  const databaseName = `markiro_chz_exports_service_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  const key = randomBytes(32);
  let crypto: ChzCryptoService;
  let tokens: ChzTokenService;
  let service: ChzExportsService;

  let tenantId: string;
  let actorUserId: string;
  let productId: string;
  let inventoryId: string;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    crypto = new ChzCryptoService(key);
    tokens = new ChzTokenService(db, crypto);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  beforeEach(async () => {
    tenantId = await createOrganization(db);
    actorUserId = randomUUID();
    productId = randomUUID();
    const lineId = randomUUID();
    inventoryId = randomUUID();

    await db.insert(schema.user).values({
      id: actorUserId,
      name: "Export fixture operator",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    // No `chzProductGroupCode`, no `org_profiles` row, no signer agent, no
    // token -- every pre-flight condition starts unmet so each test opts in
    // to exactly the fixtures it needs via `satisfyPreflight()`.
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Export fixture product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Export fixture line" });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: actorUserId,
    });

    const jobs = {
      enqueueChzExportOrder: vi.fn().mockResolvedValue("job-id"),
    } as unknown as PgBossService;
    service = new ChzExportsService(db, tokens, jobs);
  });

  async function satisfyPreflight(): Promise<void> {
    await db.insert(schema.orgProfiles).values({ tenantId, inn: "7707083893" });
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: 1 })
      .where(eq(schema.products.id, productId));
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

  it("reports every unmet pre-flight condition at once, not the first one", async () => {
    // Tenant with no INN, product with no group code, no agent, no token.
    const state = await service.getState(tenantId, inventoryId);
    expect(state.available).toBe(false);
    expect([...state.blockedBy].sort()).toEqual([
      "AGENT_NOT_PAIRED",
      "INN_MISSING",
      "PRODUCT_GROUP_MISSING",
      "TOKEN_UNAVAILABLE",
    ]);
  });

  it("refuses to order while a pre-flight condition is unmet", async () => {
    await expect(service.order(tenantId, actorUserId, inventoryId)).rejects.toMatchObject({
      status: 422,
    });
  });

  it("creates exactly six queued runs attributed to the operator", async () => {
    await satisfyPreflight();
    const state = await service.order(tenantId, actorUserId, inventoryId);
    expect(state.runs).toHaveLength(6);
    expect(state.runs.every((run) => run.state === "queued")).toBe(true);
    const rows = await db
      .select()
      .from(schema.chzExportRuns)
      .where(eq(schema.chzExportRuns.inventoryId, inventoryId));
    expect(rows.every((row) => row.orderedByUserId === actorUserId)).toBe(true);
  });

  it("does not re-order statuses that are already in flight or imported", async () => {
    await satisfyPreflight();
    await service.order(tenantId, actorUserId, inventoryId);

    // The check constraint on `chz_export_runs` requires an `imported` row to
    // carry a non-null dispenser task id and result id alongside `importId`
    // (Task 1's `chz_export_runs_state_consistency_check`), so the fixture
    // sets those too rather than only `importId`/`completedAt`.
    const importId = randomUUID();
    await db.insert(schema.inventoryImports).values({
      id: importId,
      tenantId,
      inventoryId,
      declaredStatus: "EMITTED",
      fileName: "emitted.csv",
      containerKind: "csv",
      byteSize: 0,
      sha256: "0".repeat(64),
      objectKey: `tenants/${tenantId}/chz-exports/emitted.csv`,
      parsedStatus: "EMITTED",
      includedGtin14: GTIN,
      parseOutcome: "succeeded",
      createdByUserId: actorUserId,
    });
    // Scoped by inventoryId, not just status: the scratch database
    // accumulates `chz_export_runs` rows from every test in this file, and an
    // unscoped `status` filter would also match other tests' fixture rows.
    await db
      .update(schema.chzExportRuns)
      .set({
        state: "imported",
        dispenserTaskId: "task-1",
        resultId: "result-1",
        importId,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "EMITTED"),
        ),
      );

    await service.order(tenantId, actorUserId, inventoryId);
    const [emitted] = await db
      .select()
      .from(schema.chzExportRuns)
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "EMITTED"),
        ),
      );
    // Re-ordering an arrived export would burn the daily quota for nothing.
    expect(emitted!.state).toBe("imported");
  });

  it("resets a failed run subtractively, keeping attempts and the actor", async () => {
    await satisfyPreflight();
    await service.order(tenantId, actorUserId, inventoryId);
    // Scoped by inventoryId for the same reason as above: other tests in this
    // file leave their own RETIRED rows behind in the shared scratch database.
    await db
      .update(schema.chzExportRuns)
      .set({
        state: "failed",
        dispenserTaskId: "task-9",
        resultId: "result-9",
        errorCode: "CHZ_TASK_FAILED",
        errorMessage: "boom",
        attempts: 3,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "RETIRED"),
        ),
      );

    await service.retry(tenantId, actorUserId, inventoryId, "RETIRED");

    const [row] = await db
      .select()
      .from(schema.chzExportRuns)
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "RETIRED"),
        ),
      );
    expect(row).toMatchObject({
      state: "queued",
      dispenserTaskId: null,
      resultId: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      // Kept: it is the record of how much quota this status has already cost.
      attempts: 3,
    });
  });

  it("refuses to retry a run that has not failed", async () => {
    await satisfyPreflight();
    await service.order(tenantId, actorUserId, inventoryId);
    await expect(
      service.retry(tenantId, actorUserId, inventoryId, "RETIRED"),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "CHZ_EXPORT_NOT_FAILED" },
    });
  });

  it("refuses to retry a run already at the creation-attempt cap, distinctly from a plain conflict", async () => {
    await satisfyPreflight();
    await service.order(tenantId, actorUserId, inventoryId);
    // Mirrors what `ChzExportRunnerService.orderQueuedRuns` writes once a
    // `queued` run hits `MAX_CREATE_ATTEMPTS` (10): failed, with that same
    // errorCode, and `attempts` left at the cap.
    await db
      .update(schema.chzExportRuns)
      .set({
        state: "failed",
        errorCode: "CHZ_CREATE_ATTEMPTS_EXHAUSTED",
        attempts: 10,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "RETIRED"),
        ),
      );

    await expect(
      service.retry(tenantId, actorUserId, inventoryId, "RETIRED"),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "CHZ_EXPORT_RETRY_EXHAUSTED" },
    });

    // Refused, not reset: a `queued` run at the cap would only be failed
    // again on the very next pass, so the row must stay exactly as it was.
    const [row] = await db
      .select()
      .from(schema.chzExportRuns)
      .where(
        and(
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, "RETIRED"),
        ),
      );
    expect(row).toMatchObject({ state: "failed", errorCode: "CHZ_CREATE_ATTEMPTS_EXHAUSTED" });
  });
});
